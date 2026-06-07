import { TEST_PASSWORD, loginCookie, waitForEmailCode } from './auth-test-helper';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => resolvePromise(typeof addr === 'object' && addr ? addr.port : 0));
    });
    s.on('error', reject);
  });
}

async function startSmtp(): Promise<{ port: number; messages: string[]; close: () => Promise<void> }> {
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    let mode: 'line' | 'data' = 'line';
    let data = '';
    socket.write('220 test.smtp.local ESMTP\r\n');
    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (mode === 'data') {
        data += text;
        if (data.includes('\r\n.\r\n')) {
          messages.push(data.slice(0, data.indexOf('\r\n.\r\n')));
          data = '';
          mode = 'line';
          socket.write('250 queued\r\n');
        }
        return;
      }
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) socket.write('250-test\r\n250 AUTH PLAIN\r\n');
        else if (cmd.startsWith('MAIL FROM')) socket.write('250 sender ok\r\n');
        else if (cmd.startsWith('RCPT TO')) socket.write('250 recipient ok\r\n');
        else if (cmd === 'DATA') {
          mode = 'data';
          socket.write('354 end with dot\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('250 ok\r\n');
      }
    });
  });
  const port = await new Promise<number>((resolvePromise, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolvePromise(typeof addr === 'object' && addr ? addr.port : 0);
    });
    server.on('error', reject);
  });
  return {
    port,
    messages,
    close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())),
  };
}

async function waitForHealth(base: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    }
  }
  throw new Error('server did not become healthy');
}

function cookiesFrom(res: Response): string {
  const h: any = res.headers as any;
  const all: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  const joined = all.join(', ');
  const found = joined.match(/el_(?:access|refresh)=[^;,\s]+/g) ?? [];
  assert(found.length >= 2, `expected auth cookies, got ${joined}`);
  return found.join('; ');
}

async function json(res: Response): Promise<any> {
  const body = await res.text();
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    throw new Error(`invalid JSON ${res.status}: ${body}`);
  }
}

async function req(base: string, path: string, init: RequestInit & { cookie?: string } = {}): Promise<{ res: Response; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) };
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await fetch(`${base}${path}`, { ...init, headers });
  return { res, body: await json(res) };
}

async function requestRegistrationCode(base: string, email: string, smtpMessages: string[]): Promise<{ challengeId: string; code: string }> {
  const start = smtpMessages.length;
  const challenge = await req(base, '/api/auth/register/start', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  assert(challenge.res.status === 201, `registration code failed: ${challenge.res.status} ${JSON.stringify(challenge.body)}`);
  return { challengeId: challenge.body.challengeId, code: await waitForEmailCode(smtpMessages, start) };
}

async function requestPasswordResetCode(base: string, email: string, smtpMessages: string[]): Promise<{ challengeId: string; code: string }> {
  const start = smtpMessages.length;
  const challenge = await req(base, '/api/auth/password-reset/start', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  assert(challenge.res.status === 201, `password reset code failed: ${challenge.res.status} ${JSON.stringify(challenge.body)}`);
  return { challengeId: challenge.body.challengeId, code: await waitForEmailCode(smtpMessages, start) };
}

function identifierHash(type: string, identifier: string): string {
  return createHmac('sha256', process.env.AUTH_IDENTIFIER_SECRET ?? process.env.AUTH_TOKEN_SECRET ?? 'development-auth-token-secret-change-me')
    .update(`${type}:${identifier}`)
    .digest('hex');
}

function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  const visible = name.slice(0, Math.min(2, name.length));
  return `${visible}${'*'.repeat(Math.max(2, name.length - visible.length))}@${domain}`;
}

function insertLegacyEmailAccount(dbPath: string, email: string): string {
  const normalized = email.trim().toLowerCase();
  const masked = maskEmail(normalized);
  const userId = randomUUID();
  const identityId = randomUUID();
  const ts = new Date().toISOString();
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      `INSERT INTO users (id, nickname, avatar_url, phone_masked, email_masked, status, registered_at, last_login_at)
       VALUES (?, NULL, NULL, NULL, ?, 'normal', ?, ?)`,
    ).run(userId, masked, ts, ts);
    db.prepare(
      `INSERT INTO auth_identities (id, user_id, type, provider, identifier_hash, display_identifier, is_primary, verified_at, bound_at, unbound_at)
       VALUES (?, ?, 'email', NULL, ?, ?, 1, ?, ?, NULL)`,
    ).run(identityId, userId, identifierHash('email', normalized), masked, ts, ts);
    return userId;
  } finally {
    db.close();
  }
}

async function login(
  base: string,
  email: string,
  smtpMessages: string[],
  device: { deviceId: string; deviceName?: string; platform?: string; appVersion?: string } = {
    deviceId: `test-${email}`,
    deviceName: 'Integration test',
    platform: 'Web',
    appVersion: 'test',
  },
): Promise<string> {
  return loginCookie(base, email, smtpMessages, device);
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `auth-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'integration-token-secret',
    AUTH_IDENTIFIER_SECRET: 'integration-identifier-secret',
    AUTH_RISK_BLOCKED_IDENTIFIERS: 'risk-blocked@example.com',
    AUTH_RISK_BLOCKED_DEVICE_IDS: 'blocked-device',
    AUTH_RISK_SUPPORT_CONTACT: 'security@example.com',
    AUTH_CODE_MAX_FAILED_ATTEMPTS: '2',
    AUTH_CODE_LOCK_SEC: '3600',
    AUTH_PASSWORD_MAX_FAILED_ATTEMPTS: '2',
    AUTH_PASSWORD_LOCK_SEC: '3600',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);

    const unauth = await req(base, '/api/tasks?view=today');
    assert(unauth.res.status === 401, `expected unauthenticated tasks to be 401, got ${unauth.res.status}`);

    const savedSmtpHost = process.env.SMTP_HOST;
    const savedSmtpFrom = process.env.SMTP_FROM;
    try {
      delete process.env.SMTP_HOST;
      delete process.env.SMTP_FROM;
      const missingSmtp = await req(base, '/api/auth/register/start', {
        method: 'POST',
        body: JSON.stringify({ email: 'missing-smtp@example.com' }),
      });
      assert(missingSmtp.res.status === 501, `missing SMTP should be 501, got ${missingSmtp.res.status}`);
      assert(missingSmtp.body.error.code === 'auth_delivery_not_configured', 'missing SMTP should return auth_delivery_not_configured');
      const db = new DatabaseSync(dbPath);
      try {
        const codeRows = db.prepare('SELECT COUNT(*) c FROM verification_codes').get() as { c: number };
        assert(codeRows.c === 0, `failed SMTP delivery should delete verification code rows, got ${codeRows.c}`);
      } finally {
        db.close();
      }
    } finally {
      if (savedSmtpHost) process.env.SMTP_HOST = savedSmtpHost;
      if (savedSmtpFrom) process.env.SMTP_FROM = savedSmtpFrom;
    }

    const phoneLogin = await req(base, '/api/auth/verification-codes', {
      method: 'POST',
      body: JSON.stringify({ type: 'phone', identifier: '+15550001111', purpose: 'login' }),
    });
    assert(phoneLogin.res.status === 400, `phone login should be blocked by email-only policy, got ${phoneLogin.res.status}`);
    assert(phoneLogin.body.error.code === 'password_login_required', 'phone login should return password_login_required');

    const legacyLogin = await req(base, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: 'legacy-login-disabled',
        code: '000000',
        agreedToTerms: true,
        device: { deviceId: 'legacy-login-device', platform: 'Web' },
      }),
    });
    assert(legacyLogin.res.status === 400, `legacy code login should be blocked, got ${legacyLogin.res.status}`);
    assert(legacyLogin.body.error.code === 'password_login_required', 'legacy code login should return password_login_required');

    const riskMessages = smtp.messages.length;
    const blockedIdentifier = await req(base, '/api/auth/register/start', {
      method: 'POST',
      body: JSON.stringify({ email: 'risk-blocked@example.com' }),
    });
    assert(blockedIdentifier.res.status === 423, `blocked identifier should be 423, got ${blockedIdentifier.res.status}`);
    assert(blockedIdentifier.body.error.code === 'auth_risk_restricted', 'blocked identifier should return auth_risk_restricted');
    assert(blockedIdentifier.body.error.message.includes('security@example.com'), 'risk error should include support contact');
    assert(smtp.messages.length === riskMessages, 'blocked identifier must not send a verification email');

    const deviceChallengeStart = smtp.messages.length;
    const deviceChallenge = await req(base, '/api/auth/register/start', {
      method: 'POST',
      body: JSON.stringify({ email: 'device-risk@example.com' }),
    });
    assert(deviceChallenge.res.status === 201, `device risk challenge should be created, got ${deviceChallenge.res.status}`);
    const deviceCode = await waitForEmailCode(smtp.messages, deviceChallengeStart);
    const blockedDeviceLogin = await req(base, '/api/auth/register/complete', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: deviceChallenge.body.challengeId,
        code: deviceCode,
        password: TEST_PASSWORD,
        agreedToTerms: true,
        device: { deviceId: 'blocked-device', deviceName: 'Blocked device', platform: 'Web', appVersion: 'test' },
      }),
    });
    assert(blockedDeviceLogin.res.status === 423, `blocked device registration should be 423, got ${blockedDeviceLogin.res.status}`);
    assert(blockedDeviceLogin.body.error.code === 'auth_risk_restricted', 'blocked device registration should return auth_risk_restricted');

    let userACookie = await login(base, 'alice@example.com', smtp.messages);
    const duplicateRegistration = await req(base, '/api/auth/register/start', {
      method: 'POST',
      body: JSON.stringify({ email: 'alice@example.com' }),
    });
    assert(duplicateRegistration.res.status === 409, `duplicate registration should be 409, got ${duplicateRegistration.res.status}`);
    assert(duplicateRegistration.body.error.code === 'email_already_registered', 'duplicate registration should return email_already_registered');

    const weakPasswordChallenge = await requestRegistrationCode(base, 'weak-password@example.com', smtp.messages);
    const weakPasswordComplete = await req(base, '/api/auth/register/complete', {
      method: 'POST',
      body: JSON.stringify({
        ...weakPasswordChallenge,
        password: 'short',
        agreedToTerms: true,
        device: { deviceId: 'weak-password-device', platform: 'Web' },
      }),
    });
    assert(weakPasswordComplete.res.status === 400, `weak password should fail, got ${weakPasswordComplete.res.status}`);
    assert(weakPasswordComplete.body.error.code === 'invalid_password', 'weak password should return invalid_password');

    const codeLockChallenge = await requestRegistrationCode(base, 'code-lock@example.com', smtp.messages);
    const codeWrong1 = await req(base, '/api/auth/register/complete', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: codeLockChallenge.challengeId,
        code: '000000' === codeLockChallenge.code ? '000001' : '000000',
        password: TEST_PASSWORD,
        agreedToTerms: true,
        device: { deviceId: 'code-lock-wrong-1', platform: 'Web' },
      }),
    });
    assert(codeWrong1.res.status === 400, `first wrong verification code should be 400, got ${codeWrong1.res.status}`);
    assert(codeWrong1.body.error.code === 'invalid_code', 'first wrong verification code should return invalid_code');
    const codeWrong2 = await req(base, '/api/auth/register/complete', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: codeLockChallenge.challengeId,
        code: '111111' === codeLockChallenge.code ? '111112' : '111111',
        password: TEST_PASSWORD,
        agreedToTerms: true,
        device: { deviceId: 'code-lock-wrong-2', platform: 'Web' },
      }),
    });
    assert(codeWrong2.res.status === 423, `second wrong verification code should lock with 423, got ${codeWrong2.res.status}`);
    assert(codeWrong2.body.error.code === 'verification_code_locked', 'second wrong verification code should return verification_code_locked');
    const codeCorrectWhileLocked = await req(base, '/api/auth/register/complete', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: codeLockChallenge.challengeId,
        code: codeLockChallenge.code,
        password: TEST_PASSWORD,
        agreedToTerms: true,
        device: { deviceId: 'code-lock-correct-while-locked', platform: 'Web' },
      }),
    });
    assert(codeCorrectWhileLocked.res.status === 423, `correct verification code during lock should be 423, got ${codeCorrectWhileLocked.res.status}`);
    assert(codeCorrectWhileLocked.body.error.code === 'verification_code_locked', 'correct verification code during lock should stay verification_code_locked');

    const wrongPassword = await req(base, '/api/auth/login/password', {
      method: 'POST',
      body: JSON.stringify({
        email: 'alice@example.com',
        password: 'WrongPass123!',
        device: { deviceId: 'alice-wrong-password', platform: 'Web' },
      }),
    });
    assert(wrongPassword.res.status === 401, `wrong password should fail, got ${wrongPassword.res.status}`);
    assert(wrongPassword.body.error.code === 'invalid_credentials', 'wrong password should return invalid_credentials');

    const refresh = await req(base, '/api/auth/refresh', { method: 'POST', cookie: userACookie });
    assert(refresh.res.status === 200 && refresh.body.user.emailMasked, `refresh failed: ${refresh.res.status}`);
    userACookie = cookiesFrom(refresh.res);
    const onboardingBeforeTask = await req(base, '/api/account/onboarding', { cookie: userACookie });
    assert(onboardingBeforeTask.res.status === 200, `onboarding before task failed: ${onboardingBeforeTask.res.status}`);
    assert(onboardingBeforeTask.body.onboarding.firstTaskCreated === false, 'new account should not have firstTaskCreated');
    assert(onboardingBeforeTask.body.onboarding.showFirstTaskGuide === true, 'new account should show first task guide');
    assert(onboardingBeforeTask.body.onboarding.totalTaskCount === 0, 'new account should have zero total tasks');
    assert(onboardingBeforeTask.body.onboarding.activeTaskCount === 0, 'new account should have zero active tasks');
    const createTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie: userACookie,
      body: JSON.stringify({ title: 'Alice private task', priority: 2 }),
    });
    assert(createTask.res.status === 201, `create task failed: ${createTask.res.status} ${JSON.stringify(createTask.body)}`);
    const onboardingAfterTask = await req(base, '/api/account/onboarding', { cookie: userACookie });
    assert(onboardingAfterTask.res.status === 200, `onboarding after task failed: ${onboardingAfterTask.res.status}`);
    assert(onboardingAfterTask.body.onboarding.firstTaskCreated === true, 'account should have firstTaskCreated after real task insert');
    assert(onboardingAfterTask.body.onboarding.showFirstTaskGuide === false, 'account should hide first task guide after real task insert');
    assert(onboardingAfterTask.body.onboarding.totalTaskCount === 1, 'account should have one total task after create');
    assert(onboardingAfterTask.body.onboarding.activeTaskCount === 1, 'account should have one active task after create');

    const userATasks = await req(base, '/api/tasks?view=active', { cookie: userACookie });
    assert(userATasks.body.tasks.length === 1, `expected Alice to see one task, got ${userATasks.body.tasks.length}`);

    const userASecondCookie = await login(base, 'alice@example.com', smtp.messages, {
      deviceId: 'alice-phone',
      deviceName: 'Alice Phone',
      platform: 'iOS',
      appVersion: 'test',
    });
    const sessionsBeforeRevoke = await req(base, '/api/account/sessions', { cookie: userACookie });
    assert(sessionsBeforeRevoke.res.status === 200, `session list failed: ${sessionsBeforeRevoke.res.status}`);
    assert(sessionsBeforeRevoke.body.sessions.length === 2, `expected Alice to have two sessions, got ${sessionsBeforeRevoke.body.sessions.length}`);
    const currentAliceSession = sessionsBeforeRevoke.body.sessions.find((item: any) => item.isCurrentDevice);
    const remoteAliceSession = sessionsBeforeRevoke.body.sessions.find((item: any) => item.deviceId === 'alice-phone');
    assert(currentAliceSession?.deviceId === 'test-alice@example.com', 'session list should mark the requesting cookie as current');
    assert(remoteAliceSession && !remoteAliceSession.isCurrentDevice && !remoteAliceSession.revokedAt, 'remote Alice device should be active before revoke');
    const revokeRemote = await req(base, `/api/account/sessions/${remoteAliceSession.id}`, { method: 'DELETE', cookie: userACookie });
    assert(revokeRemote.res.status === 204, `remote session revoke failed: ${revokeRemote.res.status}`);
    const revokedRemoteAccess = await req(base, '/api/auth/session', { cookie: userASecondCookie });
    assert(revokedRemoteAccess.res.status === 401, `revoked remote cookie should be 401, got ${revokedRemoteAccess.res.status}`);
    const sessionsAfterRevoke = await req(base, '/api/account/sessions', { cookie: userACookie });
    const revokedRemoteSession = sessionsAfterRevoke.body.sessions.find((item: any) => item.id === remoteAliceSession.id);
    assert(revokedRemoteSession?.revokedAt, 'revoked remote session should keep revokedAt in the session list');

    const userBCookie = await login(base, 'bob@example.com', smtp.messages);
    const onboardingB = await req(base, '/api/account/onboarding', { cookie: userBCookie });
    assert(onboardingB.res.status === 200, `Bob onboarding failed: ${onboardingB.res.status}`);
    assert(onboardingB.body.onboarding.showFirstTaskGuide === true, 'Bob should still see first task guide');
    assert(onboardingB.body.onboarding.totalTaskCount === 0, 'Bob should have zero total tasks');
    const userBTasks = await req(base, '/api/tasks?view=active', { cookie: userBCookie });
    assert(userBTasks.body.tasks.length === 0, `expected Bob to see zero Alice tasks, got ${userBTasks.body.tasks.length}`);
    const bobRevokeAlice = await req(base, `/api/account/sessions/${currentAliceSession.id}`, { method: 'DELETE', cookie: userBCookie });
    assert(bobRevokeAlice.res.status === 404, `Bob should not revoke Alice session, got ${bobRevokeAlice.res.status}`);
    const aliceStillActive = await req(base, '/api/auth/session', { cookie: userACookie });
    assert(aliceStillActive.res.status === 200, `Alice current session should remain active, got ${aliceStillActive.res.status}`);

    const lockEmail = 'lockout@example.com';
    await login(base, lockEmail, smtp.messages, {
      deviceId: 'lockout-initial-device',
      deviceName: 'Lockout Initial',
      platform: 'Web',
    });
    const lockoutFail1 = await req(base, '/api/auth/login/password', {
      method: 'POST',
      body: JSON.stringify({
        email: lockEmail,
        password: 'WrongPass123!',
        device: { deviceId: 'lockout-wrong-1', platform: 'Web' },
      }),
    });
    assert(lockoutFail1.res.status === 401, `first wrong password should be 401, got ${lockoutFail1.res.status}`);
    assert(lockoutFail1.body.error.code === 'invalid_credentials', 'first wrong password should return invalid_credentials');
    const lockoutFail2 = await req(base, '/api/auth/login/password', {
      method: 'POST',
      body: JSON.stringify({
        email: lockEmail,
        password: 'StillWrong123!',
        device: { deviceId: 'lockout-wrong-2', platform: 'Web' },
      }),
    });
    assert(lockoutFail2.res.status === 423, `second wrong password should lock login with 423, got ${lockoutFail2.res.status}`);
    assert(lockoutFail2.body.error.code === 'password_login_locked', 'second wrong password should return password_login_locked');
    const correctWhileLocked = await req(base, '/api/auth/login/password', {
      method: 'POST',
      body: JSON.stringify({
        email: lockEmail,
        password: TEST_PASSWORD,
        device: { deviceId: 'lockout-correct-while-locked', platform: 'Web' },
      }),
    });
    assert(correctWhileLocked.res.status === 423, `correct password during lock should remain 423, got ${correctWhileLocked.res.status}`);
    assert(correctWhileLocked.body.error.code === 'password_login_locked', 'correct password during lock should return password_login_locked');
    const lockResetChallenge = await requestPasswordResetCode(base, lockEmail, smtp.messages);
    const lockReset = await req(base, '/api/auth/password-reset/complete', {
      method: 'POST',
      body: JSON.stringify({
        ...lockResetChallenge,
        password: 'UnlockedPass123!',
        device: { deviceId: 'lockout-reset-device', platform: 'Web' },
      }),
    });
    assert(lockReset.res.status === 200, `password reset should unlock account, got ${lockReset.res.status}`);
    cookiesFrom(lockReset.res);
    const loginAfterUnlock = await req(base, '/api/auth/login/password', {
      method: 'POST',
      body: JSON.stringify({
        email: lockEmail,
        password: 'UnlockedPass123!',
        device: { deviceId: 'lockout-after-reset-login', platform: 'Web' },
      }),
    });
    assert(loginAfterUnlock.res.status === 200, `login after reset should succeed, got ${loginAfterUnlock.res.status}`);
    cookiesFrom(loginAfterUnlock.res);

    const exportA = await req(base, '/api/settings/export', { cookie: userACookie });
    const exportB = await req(base, '/api/settings/export', { cookie: userBCookie });
    assert(exportA.body.tasks.length === 1, `expected Alice export to include one task`);
    assert(exportB.body.tasks.length === 0, `expected Bob export to include zero tasks`);

    const legacyEmail = 'legacy-code-account@example.com';
    const legacyUserId = insertLegacyEmailAccount(dbPath, legacyEmail);
    const legacyPasswordLoginBefore = await req(base, '/api/auth/login/password', {
      method: 'POST',
      body: JSON.stringify({
        email: legacyEmail,
        password: TEST_PASSWORD,
        device: { deviceId: 'legacy-before-password', platform: 'Web' },
      }),
    });
    assert(legacyPasswordLoginBefore.res.status === 409, `legacy account without password should be 409, got ${legacyPasswordLoginBefore.res.status}`);
    assert(legacyPasswordLoginBefore.body.error.code === 'password_not_set', 'legacy account should return password_not_set before migration');
    const legacyChallenge = await requestRegistrationCode(base, legacyEmail, smtp.messages);
    const legacyComplete = await req(base, '/api/auth/register/complete', {
      method: 'POST',
      body: JSON.stringify({
        ...legacyChallenge,
        password: TEST_PASSWORD,
        agreedToTerms: true,
        device: { deviceId: 'legacy-password-set', deviceName: 'Legacy Password Set', platform: 'Web' },
      }),
    });
    assert(legacyComplete.res.status === 200, `legacy password set should return 200, got ${legacyComplete.res.status} ${JSON.stringify(legacyComplete.body)}`);
    assert(legacyComplete.body.user.id === legacyUserId, 'legacy password setup should keep the original user id');
    cookiesFrom(legacyComplete.res);

    const unknownReset = await req(base, '/api/auth/password-reset/start', {
      method: 'POST',
      body: JSON.stringify({ email: 'unknown-reset@example.com' }),
    });
    assert(unknownReset.res.status === 404, `unknown password reset should be 404, got ${unknownReset.res.status}`);
    assert(unknownReset.body.error.code === 'email_not_registered', 'unknown password reset should return email_not_registered');
    const resetChallenge = await requestPasswordResetCode(base, 'alice@example.com', smtp.messages);
    const reset = await req(base, '/api/auth/password-reset/complete', {
      method: 'POST',
      body: JSON.stringify({
        ...resetChallenge,
        password: 'NewPassword123!',
        device: { deviceId: 'alice-reset-device', deviceName: 'Alice Reset', platform: 'Web' },
      }),
    });
    assert(reset.res.status === 200, `password reset failed: ${reset.res.status} ${JSON.stringify(reset.body)}`);
    cookiesFrom(reset.res);
    const oldPasswordAfterReset = await req(base, '/api/auth/login/password', {
      method: 'POST',
      body: JSON.stringify({
        email: 'alice@example.com',
        password: TEST_PASSWORD,
        device: { deviceId: 'alice-old-password-after-reset', platform: 'Web' },
      }),
    });
    assert(oldPasswordAfterReset.res.status === 401, `old password should fail after reset, got ${oldPasswordAfterReset.res.status}`);
    const newPasswordAfterReset = await req(base, '/api/auth/login/password', {
      method: 'POST',
      body: JSON.stringify({
        email: 'alice@example.com',
        password: 'NewPassword123!',
        device: { deviceId: 'alice-new-password-after-reset', deviceName: 'Alice New Password', platform: 'Web' },
      }),
    });
    assert(newPasswordAfterReset.res.status === 200, `new password should login after reset, got ${newPasswordAfterReset.res.status}`);
    cookiesFrom(newPasswordAfterReset.res);

    const wrongCurrentPasswordChange = await req(base, '/api/account/password', {
      method: 'PUT',
      cookie: userACookie,
      body: JSON.stringify({ currentPassword: 'WrongCurrent123!', newPassword: 'ChangedPass123!' }),
    });
    assert(wrongCurrentPasswordChange.res.status === 401, `wrong current password change should be 401, got ${wrongCurrentPasswordChange.res.status}`);
    assert(wrongCurrentPasswordChange.body.error.code === 'invalid_credentials', 'wrong current password change should return invalid_credentials');

    const weakAccountPasswordChange = await req(base, '/api/account/password', {
      method: 'PUT',
      cookie: userACookie,
      body: JSON.stringify({ currentPassword: 'NewPassword123!', newPassword: 'short' }),
    });
    assert(weakAccountPasswordChange.res.status === 400, `weak account password change should be 400, got ${weakAccountPasswordChange.res.status}`);
    assert(weakAccountPasswordChange.body.error.code === 'invalid_password', 'weak account password change should return invalid_password');

    const accountPasswordChange = await req(base, '/api/account/password', {
      method: 'PUT',
      cookie: userACookie,
      body: JSON.stringify({ currentPassword: 'NewPassword123!', newPassword: 'ChangedPass123!' }),
    });
    assert(accountPasswordChange.res.status === 200, `account password change should succeed, got ${accountPasswordChange.res.status}`);
    assert(accountPasswordChange.body.user.id === aliceStillActive.body.user.id, 'account password change should keep the same user id');

    const oldChangedPasswordLogin = await req(base, '/api/auth/login/password', {
      method: 'POST',
      body: JSON.stringify({
        email: 'alice@example.com',
        password: 'NewPassword123!',
        device: { deviceId: 'alice-old-changed-password', platform: 'Web' },
      }),
    });
    assert(oldChangedPasswordLogin.res.status === 401, `old changed password should fail, got ${oldChangedPasswordLogin.res.status}`);
    assert(oldChangedPasswordLogin.body.error.code === 'invalid_credentials', 'old changed password should return invalid_credentials');

    const newChangedPasswordLogin = await req(base, '/api/auth/login/password', {
      method: 'POST',
      body: JSON.stringify({
        email: 'alice@example.com',
        password: 'ChangedPass123!',
        device: { deviceId: 'alice-new-changed-password', platform: 'Web' },
      }),
    });
    assert(newChangedPasswordLogin.res.status === 200, `changed password should login, got ${newChangedPasswordLogin.res.status}`);
    cookiesFrom(newChangedPasswordLogin.res);

    const logout = await req(base, '/api/auth/logout', { method: 'POST', cookie: userACookie });
    assert(logout.res.status === 204, `logout failed: ${logout.res.status}`);
    const afterLogout = await req(base, '/api/tasks?view=active', { cookie: userACookie });
    assert(afterLogout.res.status === 401, `expected old cookie after logout to be 401, got ${afterLogout.res.status}`);

    const db = new DatabaseSync(dbPath);
    try {
      const users = db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number };
      const tasks = db.prepare('SELECT COUNT(*) c FROM tasks').get() as { c: number };
      const consumedCodes = db.prepare('SELECT COUNT(*) c FROM verification_codes WHERE consumed_at IS NOT NULL').get() as { c: number };
      const sessions = db.prepare('SELECT COUNT(*) c FROM login_sessions').get() as { c: number };
      const revokedSessions = db.prepare('SELECT COUNT(*) c FROM login_sessions WHERE revoked_at IS NOT NULL').get() as { c: number };
      const passwordCredentials = db.prepare('SELECT COUNT(*) c FROM auth_password_credentials').get() as { c: number };
      const lockCredential = db
        .prepare(
          `SELECT pc.failed_attempt_count, pc.locked_until, pc.last_failed_at
           FROM auth_password_credentials pc
           JOIN auth_identities ai ON ai.user_id = pc.user_id
           WHERE ai.type = 'email' AND ai.identifier_hash = ?`,
        )
        .get(identifierHash('email', lockEmail)) as { failed_attempt_count: number; locked_until: string | null; last_failed_at: string | null };
      const aliceCredential = db
        .prepare(
          `SELECT pc.failed_attempt_count, pc.locked_until, pc.last_failed_at
           FROM auth_password_credentials pc
           JOIN auth_identities ai ON ai.user_id = pc.user_id
           WHERE ai.type = 'email' AND ai.identifier_hash = ?`,
        )
        .get(identifierHash('email', 'alice@example.com')) as { failed_attempt_count: number; locked_until: string | null; last_failed_at: string | null };
      const codeLockRow = db.prepare('SELECT attempts, locked_until, consumed_at FROM verification_codes WHERE id = ?').get(codeLockChallenge.challengeId) as {
        attempts: number;
        locked_until: string | null;
        consumed_at: string | null;
      };
      const blockedIdentifierRows = db
        .prepare("SELECT COUNT(*) c FROM verification_codes WHERE display_identifier = 'ri**********@example.com'")
        .get() as { c: number };
      const auditRiskRows = db.prepare("SELECT COUNT(*) c FROM security_audit_logs WHERE action LIKE 'auth_risk_%'").get() as { c: number };
      const codeLockAuditRows = db.prepare("SELECT COUNT(*) c FROM security_audit_logs WHERE action = 'verification_code_locked'").get() as { c: number };
      const passwordLockAuditRows = db.prepare("SELECT COUNT(*) c FROM security_audit_logs WHERE action = 'password_login_locked'").get() as { c: number };
      const passwordChangeAuditRows = db.prepare("SELECT COUNT(*) c FROM security_audit_logs WHERE action = 'account_password_changed'").get() as { c: number };
      assert(users.c === 4, `expected 4 users in DB, got ${users.c}`);
      assert(tasks.c === 1, `expected 1 task in DB, got ${tasks.c}`);
      assert(consumedCodes.c === 6, `expected 6 consumed codes, got ${consumedCodes.c}`);
      assert(sessions.c === 10, `expected 10 login sessions, got ${sessions.c}`);
      assert(revokedSessions.c === 2, `expected 2 revoked sessions, got ${revokedSessions.c}`);
      assert(passwordCredentials.c === 4, `expected 4 password credentials, got ${passwordCredentials.c}`);
      assert(lockCredential.failed_attempt_count === 0, 'password reset should clear failed password attempts');
      assert(lockCredential.locked_until === null, 'password reset should clear password login lock');
      assert(lockCredential.last_failed_at === null, 'password reset should clear last failed password timestamp');
      assert(aliceCredential.failed_attempt_count === 0, 'successful account password change and login should clear Alice failed attempts');
      assert(aliceCredential.locked_until === null, 'account password change should leave Alice password unlocked');
      assert(aliceCredential.last_failed_at === null, 'successful changed-password login should clear Alice last failed timestamp');
      assert(codeLockRow.attempts === 2, `locked verification code should keep two failed attempts, got ${codeLockRow.attempts}`);
      assert(!!codeLockRow.locked_until, 'locked verification code should persist locked_until');
      assert(codeLockRow.consumed_at === null, 'locked verification code must not be consumed');
      assert(blockedIdentifierRows.c === 0, 'blocked identifier should not create verification code rows');
      assert(auditRiskRows.c === 2, `expected 2 risk audit rows, got ${auditRiskRows.c}`);
      assert(codeLockAuditRows.c === 1, `expected one verification code lock audit row, got ${codeLockAuditRows.c}`);
      assert(passwordLockAuditRows.c === 1, `expected one password lock audit row, got ${passwordLockAuditRows.c}`);
      assert(passwordChangeAuditRows.c === 1, `expected one password change audit row, got ${passwordChangeAuditRows.c}`);
    } finally {
      db.close();
    }
  } finally {
    await new Promise((resolvePromise) => server.close(() => resolvePromise(null)));
    const dbModule = await import(pathToFileURL(resolve(root, 'server', 'src', 'db.ts')).href);
    dbModule.db.close();
    await smtp.close();
    for (const suffix of ['', '-shm', '-wal']) {
      const p = dbPath + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
