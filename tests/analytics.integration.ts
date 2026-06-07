import { TEST_PASSWORD, waitForEmailCode } from './auth-test-helper';
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
    socket.write('220 analytics.smtp.local ESMTP\r\n');
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

async function requestRegistrationCode(base: string, email: string, smtpMessages: string[]): Promise<{ challengeId: string; code: string }> {
  const start = smtpMessages.length;
  const challenge = await req(base, '/api/auth/register/start', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  assert(challenge.res.status === 201, `registration code failed: ${challenge.res.status}`);
  const code = await waitForEmailCode(smtpMessages, start);
  return { challengeId: challenge.body.challengeId, code };
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `analytics-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'analytics-token-secret',
    AUTH_IDENTIFIER_SECRET: 'analytics-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);

    const pageView = await req(base, '/api/analytics/events', {
      method: 'POST',
      body: JSON.stringify({
        events: [
          {
            name: 'auth_page_view',
            anonymousId: 'anon-test',
            deviceId: 'device-test',
            properties: {
              entry: 'direct',
              platform: 'web',
              is_offline: false,
              email: 'analytics-user@example.com',
              code: '123456',
              accessToken: 'secret-token-value-that-should-not-be-stored',
              nested: { phone: '+15550001111', safe: 'kept' },
            },
          },
        ],
      }),
    });
    assert(pageView.res.status === 202 && pageView.body.accepted === 1, 'unauth analytics event was not accepted');

    const challenge = await requestRegistrationCode(base, 'analytics-user@example.com', smtp.messages);
    const badRegistration = await req(base, '/api/auth/register/complete', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        code: '000000',
        password: TEST_PASSWORD,
        agreedToTerms: true,
        device: { deviceId: 'analytics-device', platform: 'Web' },
      }),
    });
    assert(badRegistration.res.status === 400, `bad code should fail, got ${badRegistration.res.status}`);

    const login = await req(base, '/api/auth/register/complete', {
      method: 'POST',
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        code: challenge.code,
        password: TEST_PASSWORD,
        agreedToTerms: true,
        device: { deviceId: 'analytics-device', deviceName: 'Analytics test', platform: 'Web' },
      }),
    });
    assert(login.res.status === 201, `login failed: ${login.res.status} ${JSON.stringify(login.body)}`);
    const cookie = cookiesFrom(login.res);
    const userId = login.body.user.id;

    const badPasswordLogin = await req(base, '/api/auth/login/password', {
      method: 'POST',
      body: JSON.stringify({
        email: 'analytics-user@example.com',
        password: 'WrongPass123!',
        device: { deviceId: 'analytics-device-wrong', platform: 'Web' },
      }),
    });
    assert(badPasswordLogin.res.status === 401, `bad password should fail, got ${badPasswordLogin.res.status}`);

    const authed = await req(base, '/api/analytics/events', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        events: [
          {
            name: 'setting_page_view',
            properties: {
              entry: 'settings_button',
              apiKey: 'sk-analytics-secret-key-that-should-not-be-stored',
              provider: 'openai',
            },
          },
        ],
      }),
    });
    assert(authed.res.status === 202 && authed.body.accepted === 1, 'authed analytics event was not accepted');

    const exported = (await req(base, '/api/settings/export', { cookie })).body;
    assert(exported.analyticsEvents.some((event: any) => event.event_name === 'setting_page_view'), 'export should include account analytics events');

    const logout = await req(base, '/api/auth/logout', { method: 'POST', cookie });
    assert(logout.res.status === 204, `logout failed: ${logout.res.status}`);

    const db = new DatabaseSync(dbPath);
    try {
      const events = db.prepare('SELECT event_name, user_id, session_id, anonymous_id, device_id, properties_json FROM analytics_events ORDER BY received_at ASC').all() as Array<{
        event_name: string;
        user_id: string | null;
        session_id: string | null;
        anonymous_id: string | null;
        device_id: string | null;
        properties_json: string;
      }>;
      const names = events.map((event) => event.event_name);
      for (const name of [
        'auth_page_view',
        'auth_code_send',
        'auth_code_verify',
        'auth_register_result',
        'auth_register_success',
        'auth_login_result',
        'auth_login_success',
        'setting_page_view',
        'auth_logout_success',
      ]) {
        assert(names.includes(name), `missing analytics event ${name}; saw ${names.join(',')}`);
      }
      const first = events.find((event) => event.event_name === 'auth_page_view')!;
      assert(first.user_id === null && first.session_id === null, 'unauth page view should not have user/session');
      assert(first.anonymous_id === 'anon-test' && first.device_id === 'device-test', 'anonymous/device ids did not persist');
      assert(!first.properties_json.includes('analytics-user@example.com'), 'raw email leaked into analytics properties');
      assert(!first.properties_json.includes('123456'), 'raw code leaked into analytics properties');
      assert(!first.properties_json.includes('secret-token'), 'raw token leaked into analytics properties');
      assert(!first.properties_json.includes('+15550001111'), 'raw phone leaked into analytics properties');
      assert(JSON.parse(first.properties_json).nested.safe === 'kept', 'safe nested analytics property was dropped');

      const send = events.find((event) => event.event_name === 'auth_code_send')!;
      const sendProps = JSON.parse(send.properties_json);
      assert(
        sendProps.method === 'email' && sendProps.success === true && sendProps.purpose === 'register' && sendProps.is_new_identifier === true,
        'auth_code_send props mismatch',
      );

      const failedRegistration = events.find((event) => event.event_name === 'auth_register_result')!;
      assert(JSON.parse(failedRegistration.properties_json).fail_reason === 'invalid_code', 'missing failed registration event');
      const codeVerifyEvents = events.filter((event) => event.event_name === 'auth_code_verify');
      assert(codeVerifyEvents.length >= 2, `expected failed and successful code verify events, got ${codeVerifyEvents.length}`);
      const failedVerify = codeVerifyEvents.find((event) => JSON.parse(event.properties_json).success === false)!;
      const failedVerifyProps = JSON.parse(failedVerify.properties_json);
      assert(
        failedVerifyProps.method === 'email' && failedVerifyProps.purpose === 'register' && failedVerifyProps.fail_reason === 'invalid_code',
        'failed code verify event should include method, purpose, and fail_reason',
      );
      const successfulVerify = codeVerifyEvents.find((event) => JSON.parse(event.properties_json).success === true)!;
      const successfulVerifyProps = JSON.parse(successfulVerify.properties_json);
      assert(
        successfulVerify.user_id === userId &&
          !!successfulVerify.session_id &&
          successfulVerifyProps.method === 'email' &&
          successfulVerifyProps.purpose === 'register',
        'successful code verify event should be user/session scoped with method and purpose',
      );
      const failedLogin = events.find((event) => event.event_name === 'auth_login_result')!;
      assert(JSON.parse(failedLogin.properties_json).fail_reason === 'invalid_credentials', 'missing failed password login event');

      const loginEvent = events.find((event) => event.event_name === 'auth_login_success')!;
      assert(loginEvent.user_id === userId && !!loginEvent.session_id, 'login analytics should be user/session scoped');

      const settingEvent = events.find((event) => event.event_name === 'setting_page_view')!;
      assert(settingEvent.user_id === userId, 'authenticated analytics event should be user-scoped');
      assert(!settingEvent.properties_json.includes('sk-analytics-secret'), 'raw API key leaked into analytics properties');

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
