import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
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
  const codeStart = smtpMessages.length;
  const challenge = await req(base, '/api/auth/verification-codes', {
    method: 'POST',
    body: JSON.stringify({ type: 'email', identifier: email, purpose: 'login' }),
  });
  assert(challenge.res.status === 201, `verification code failed: ${challenge.res.status} ${JSON.stringify(challenge.body)}`);
  for (let i = 0; i < 20 && smtpMessages.length === codeStart; i++) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const message = smtpMessages.at(-1) ?? '';
  const code = message.match(/\b\d{6}\b/)?.[0];
  assert(code, `SMTP message did not include a code: ${message}`);
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.body.challengeId,
      code,
      agreedToTerms: true,
      device,
    }),
  });
  const body = await json(loginRes);
  assert(loginRes.status === 201 || loginRes.status === 200, `login failed: ${loginRes.status} ${JSON.stringify(body)}`);
  return cookiesFrom(loginRes);
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
    const noSms = await req(base, '/api/auth/verification-codes', {
      method: 'POST',
      body: JSON.stringify({ type: 'phone', identifier: '+15550001111', purpose: 'login' }),
    });
    assert(noSms.res.status === 501, `phone login without SMS provider should be 501, got ${noSms.res.status}`);

    const riskMessages = smtp.messages.length;
    const blockedIdentifier = await req(base, '/api/auth/verification-codes', {
      method: 'POST',
      body: JSON.stringify({ type: 'email', identifier: 'risk-blocked@example.com', purpose: 'login' }),
    });
    assert(blockedIdentifier.res.status === 423, `blocked identifier should be 423, got ${blockedIdentifier.res.status}`);
    assert(blockedIdentifier.body.error.code === 'auth_risk_restricted', 'blocked identifier should return auth_risk_restricted');
    assert(blockedIdentifier.body.error.message.includes('security@example.com'), 'risk error should include support contact');
    assert(smtp.messages.length === riskMessages, 'blocked identifier must not send a verification email');

    const deviceChallengeStart = smtp.messages.length;
    const deviceChallenge = await req(base, '/api/auth/verification-codes', {
      method: 'POST',
      body: JSON.stringify({ type: 'email', identifier: 'device-risk@example.com', purpose: 'login' }),
    });
    assert(deviceChallenge.res.status === 201, `device risk challenge should be created, got ${deviceChallenge.res.status}`);
    for (let i = 0; i < 20 && smtp.messages.length === deviceChallengeStart; i++) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    const deviceCode = (smtp.messages.at(-1) ?? '').match(/\b\d{6}\b/)?.[0];
    assert(deviceCode, 'device risk SMTP message did not include a code');
    const blockedDeviceLogin = await req(base, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: deviceChallenge.body.challengeId,
        code: deviceCode,
        agreedToTerms: true,
        device: { deviceId: 'blocked-device', deviceName: 'Blocked device', platform: 'Web', appVersion: 'test' },
      }),
    });
    assert(blockedDeviceLogin.res.status === 423, `blocked device login should be 423, got ${blockedDeviceLogin.res.status}`);
    assert(blockedDeviceLogin.body.error.code === 'auth_risk_restricted', 'blocked device login should return auth_risk_restricted');

    let userACookie = await login(base, 'alice@example.com', smtp.messages);
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

    const exportA = await req(base, '/api/settings/export', { cookie: userACookie });
    const exportB = await req(base, '/api/settings/export', { cookie: userBCookie });
    assert(exportA.body.tasks.length === 1, `expected Alice export to include one task`);
    assert(exportB.body.tasks.length === 0, `expected Bob export to include zero tasks`);

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
      const blockedIdentifierRows = db
        .prepare("SELECT COUNT(*) c FROM verification_codes WHERE display_identifier = 'ri**********@example.com'")
        .get() as { c: number };
      const auditRiskRows = db.prepare("SELECT COUNT(*) c FROM security_audit_logs WHERE action LIKE 'auth_risk_%'").get() as { c: number };
      assert(users.c === 2, `expected 2 users in DB, got ${users.c}`);
      assert(tasks.c === 1, `expected 1 task in DB, got ${tasks.c}`);
      assert(consumedCodes.c === 3, `expected 3 consumed codes, got ${consumedCodes.c}`);
      assert(sessions.c === 3, `expected 3 login sessions, got ${sessions.c}`);
      assert(revokedSessions.c === 2, `expected 2 revoked sessions, got ${revokedSessions.c}`);
      assert(blockedIdentifierRows.c === 0, 'blocked identifier should not create verification code rows');
      assert(auditRiskRows.c === 2, `expected 2 risk audit rows, got ${auditRiskRows.c}`);
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
