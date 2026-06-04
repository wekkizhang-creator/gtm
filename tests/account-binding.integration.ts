import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import http from 'node:http';
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
  return { port, messages, close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())) };
}

async function startSmsProvider(): Promise<{ url: string; messages: any[]; close: () => Promise<void> }> {
  const messages: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/sms') {
        messages.push({ ...(raw ? JSON.parse(raw) : {}), auth: req.headers.authorization });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  const port = await new Promise<number>((resolvePromise, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolvePromise(typeof addr === 'object' && addr ? addr.port : 0);
    });
    server.on('error', reject);
  });
  return { url: `http://127.0.0.1:${port}/sms`, messages, close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())) };
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
  return body ? JSON.parse(body) : null;
}

async function req(base: string, path: string, init: RequestInit & { cookie?: string } = {}): Promise<{ res: Response; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) };
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await fetch(`${base}${path}`, { ...init, headers });
  return { res, body: await json(res) };
}

async function requestCode(base: string, email: string, purpose: string, smtpMessages: string[]): Promise<{ challengeId: string; code: string }> {
  const start = smtpMessages.length;
  const challenge = await req(base, '/api/auth/verification-codes', {
    method: 'POST',
    body: JSON.stringify({ type: 'email', identifier: email, purpose }),
  });
  assert(challenge.res.status === 201, `verification code failed: ${challenge.res.status} ${JSON.stringify(challenge.body)}`);
  for (let i = 0; i < 20 && smtpMessages.length === start; i++) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const code = (smtpMessages.at(-1) ?? '').match(/\b\d{6}\b/)?.[0];
  assert(code, 'SMTP message did not include a code');
  return { challengeId: challenge.body.challengeId, code };
}

async function requestSmsCode(base: string, phone: string, purpose: string, smsMessages: any[]): Promise<{ challengeId: string; code: string }> {
  const start = smsMessages.length;
  const challenge = await req(base, '/api/auth/verification-codes', {
    method: 'POST',
    body: JSON.stringify({ type: 'phone', identifier: phone, purpose }),
  });
  assert(challenge.res.status === 201, `SMS verification code failed: ${challenge.res.status} ${JSON.stringify(challenge.body)}`);
  for (let i = 0; i < 20 && smsMessages.length === start; i++) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const code = smsMessages.at(-1)?.code;
  assert(/^\d{6}$/.test(code), `SMS provider did not receive a 6-digit code: ${JSON.stringify(smsMessages.at(-1))}`);
  return { challengeId: challenge.body.challengeId, code };
}

async function login(base: string, email: string, smtpMessages: string[]): Promise<{ cookie: string; userId: string }> {
  const challenge = await requestCode(base, email, 'login', smtpMessages);
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      code: challenge.code,
      agreedToTerms: true,
      device: { deviceId: `account-bind-${email}`, deviceName: 'Account binding test', platform: 'Web', appVersion: 'test' },
    }),
  });
  const body = await json(loginRes);
  assert(loginRes.status === 201 || loginRes.status === 200, `login failed: ${loginRes.status}`);
  return { cookie: cookiesFrom(loginRes), userId: body.user.id };
}

async function loginWithPhone(base: string, phone: string, smsMessages: any[]): Promise<{ cookie: string; userId: string }> {
  const challenge = await requestSmsCode(base, phone, 'login', smsMessages);
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      code: challenge.code,
      agreedToTerms: true,
      device: { deviceId: `account-bind-phone-${phone}`, deviceName: 'Account binding phone test', platform: 'Web', appVersion: 'test' },
    }),
  });
  const body = await json(loginRes);
  assert(loginRes.status === 201 || loginRes.status === 200, `phone login failed: ${loginRes.status}`);
  return { cookie: cookiesFrom(loginRes), userId: body.user.id };
}

async function main() {
  const smtp = await startSmtp();
  const sms = await startSmsProvider();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `account-bind-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    SMS_PROVIDER_URL: sms.url,
    SMS_PROVIDER_TOKEN: 'sms-test-token',
    AUTH_TOKEN_SECRET: 'account-bind-token-secret',
    AUTH_IDENTIFIER_SECRET: 'account-bind-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const alice = await login(base, 'bind-alice@example.com', smtp.messages);
    const before = await req(base, '/api/account/identities', { cookie: alice.cookie });
    assert(before.body.identities.length === 1, `expected one initial identity, got ${before.body.identities.length}`);

    const bindCode = await requestCode(base, 'bind-alice-new@example.com', 'account_bind', smtp.messages);
    const bound = await req(base, '/api/account/email/bind', {
      method: 'POST',
      cookie: alice.cookie,
      body: JSON.stringify(bindCode),
    });
    assert(bound.res.status === 200, `bind failed: ${bound.res.status} ${JSON.stringify(bound.body)}`);
    assert(bound.body.identities.length === 2, `expected two identities after binding, got ${bound.body.identities.length}`);
    const primary = bound.body.identities.find((i: any) => i.isPrimary);
    assert(primary?.displayIdentifier === bound.body.user.emailMasked, 'new email should be primary account email');
    assert(bound.body.user.emailMasked !== before.body.identities[0].displayIdentifier, 'primary email should change after binding');

    const aliceNew = await login(base, 'bind-alice-new@example.com', smtp.messages);
    assert(aliceNew.userId === alice.userId, 'new bound email should log into the same user');

    const bob = await login(base, 'bind-bob@example.com', smtp.messages);
    const bobCode = await requestCode(base, 'bind-bob@example.com', 'account_bind', smtp.messages);
    const conflict = await req(base, '/api/account/email/bind', {
      method: 'POST',
      cookie: alice.cookie,
      body: JSON.stringify(bobCode),
    });
    assert(conflict.res.status === 409, `binding Bob email to Alice should be 409, got ${conflict.res.status}`);

    const phoneCode = await requestSmsCode(base, '+15551230000', 'account_bind', sms.messages);
    const phone = await req(base, '/api/account/phone/bind', {
      method: 'POST',
      cookie: alice.cookie,
      body: JSON.stringify(phoneCode),
    });
    assert(phone.res.status === 200, `phone binding failed: ${phone.res.status} ${JSON.stringify(phone.body)}`);
    assert(phone.body.user.phoneMasked === '+15****0000', `phone mask mismatch: ${phone.body.user.phoneMasked}`);
    assert(phone.body.identities.some((i: any) => i.type === 'phone'), 'bound phone identity missing');
    assert(sms.messages.at(-1).to === '+15551230000', 'SMS provider did not receive normalized phone');
    assert(sms.messages.at(-1).purpose === 'account_bind', 'SMS provider did not receive purpose');
    assert(sms.messages.at(-1).auth === 'Bearer sms-test-token', 'SMS provider did not receive bearer token');

    const smsBeforeLoginAttempt = sms.messages.length;
    const phoneLoginAttempt = await req(base, '/api/auth/verification-codes', {
      method: 'POST',
      body: JSON.stringify({ type: 'phone', identifier: '+15551230000', purpose: 'login' }),
    });
    assert(phoneLoginAttempt.res.status === 400, `phone login should be blocked by email-only policy, got ${phoneLoginAttempt.res.status}`);
    assert(phoneLoginAttempt.body.error.code === 'email_login_only', 'phone login should return email_login_only');
    assert(sms.messages.length === smsBeforeLoginAttempt, 'blocked phone login must not send an SMS code');

    const bobPhoneCode = await requestSmsCode(base, '+15551230000', 'account_bind', sms.messages);
    const phoneConflict = await req(base, '/api/account/phone/bind', {
      method: 'POST',
      cookie: bob.cookie,
      body: JSON.stringify(bobPhoneCode),
    });
    assert(phoneConflict.res.status === 409, `binding Alice phone to Bob should be 409, got ${phoneConflict.res.status}`);

    const oldEmail = bound.body.identities.find((i: any) => i.displayIdentifier === before.body.identities[0].displayIdentifier);
    assert(oldEmail, 'old email identity missing before unbind');
    const unbound = await req(base, `/api/account/identities/${oldEmail.id}`, { method: 'DELETE', cookie: alice.cookie });
    assert(unbound.res.status === 200, `unbind old email failed: ${unbound.res.status}`);
    assert(unbound.body.identities.length === 2, `expected two Alice identities after unbind, got ${unbound.body.identities.length}`);

    const onlyIdentity = (await req(base, '/api/account/identities', { cookie: bob.cookie })).body.identities[0];
    const lastUnbind = await req(base, `/api/account/identities/${onlyIdentity.id}`, { method: 'DELETE', cookie: bob.cookie });
    assert(lastUnbind.res.status === 409, `unbinding last identity should be 409, got ${lastUnbind.res.status}`);

    const db = new DatabaseSync(dbPath);
    try {
      const active = db.prepare('SELECT COUNT(*) c FROM auth_identities WHERE user_id = ? AND unbound_at IS NULL').get(alice.userId) as { c: number };
      assert(active.c === 2, `expected two active Alice identities after one unbind, got ${active.c}`);
      const unboundCount = db.prepare('SELECT COUNT(*) c FROM auth_identities WHERE user_id = ? AND unbound_at IS NOT NULL').get(alice.userId) as {
        c: number;
      };
      assert(unboundCount.c === 1, `expected one unbound Alice identity, got ${unboundCount.c}`);
    } finally {
      db.close();
    }
  } finally {
    await new Promise((resolvePromise) => server.close(() => resolvePromise(null)));
    const dbModule = await import(pathToFileURL(resolve(root, 'server', 'src', 'db.ts')).href);
    dbModule.db.close();
    await smtp.close();
    await sms.close();
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
