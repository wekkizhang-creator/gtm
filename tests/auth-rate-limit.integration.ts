import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
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

async function json(res: Response): Promise<any> {
  const body = await res.text();
  return body ? JSON.parse(body) : null;
}

async function req(base: string, path: string, body: Record<string, unknown>): Promise<{ res: Response; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, body: await json(res) };
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `auth-rate-limit-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'rate-limit-token-secret',
    AUTH_IDENTIFIER_SECRET: 'rate-limit-identifier-secret',
    AUTH_CODE_IDENTIFIER_WINDOW_SEC: '3600',
    AUTH_CODE_IDENTIFIER_MAX_PER_WINDOW: '100',
    AUTH_CODE_IP_WINDOW_SEC: '3600',
    AUTH_CODE_IP_MAX_PER_WINDOW: '100',
    AUTH_CODE_DEVICE_WINDOW_SEC: '3600',
    AUTH_CODE_DEVICE_MAX_PER_WINDOW: '100',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);

    const sameIdentifier1 = await req(base, '/api/auth/register/start', {
      email: 'same-identifier@example.com',
      device: { deviceId: 'identifier-device', platform: 'Web' },
    });
    assert(sameIdentifier1.res.status === 201, `first identifier request should pass, got ${sameIdentifier1.res.status}`);
    assert(smtp.messages.length === 1, 'first identifier request should send one email');

    const sameIdentifier2 = await req(base, '/api/auth/register/start', {
      email: 'same-identifier@example.com',
      device: { deviceId: 'identifier-device-2', platform: 'Web' },
    });
    assert(sameIdentifier2.res.status === 429, `identifier resend should be 429, got ${sameIdentifier2.res.status}`);
    assert(sameIdentifier2.body.error.code === 'rate_limited', 'identifier resend should return rate_limited');
    assert(smtp.messages.length === 1, 'identifier resend must not send another email');

    process.env.AUTH_CODE_DEVICE_MAX_PER_WINDOW = '1';
    const device1 = await req(base, '/api/auth/register/start', {
      email: 'device-a@example.com',
      device: { deviceId: 'shared-device', platform: 'Web' },
    });
    assert(device1.res.status === 201, `first device request should pass, got ${device1.res.status}`);
    assert(smtp.messages.length === 2, 'first device request should send one more email');

    const device2 = await req(base, '/api/auth/register/start', {
      email: 'device-b@example.com',
      device: { deviceId: 'shared-device', platform: 'Web' },
    });
    assert(device2.res.status === 429, `device rate limit should be 429, got ${device2.res.status}`);
    assert(device2.body.error.code === 'rate_limited', 'device rate limit should return rate_limited');
    assert(smtp.messages.length === 2, 'device-limited request must not send an email');

    const db = new DatabaseSync(dbPath);
    const rowsBeforeIp = db.prepare('SELECT COUNT(*) c FROM verification_codes').get() as { c: number };
    process.env.AUTH_CODE_DEVICE_MAX_PER_WINDOW = '100';
    process.env.AUTH_CODE_IP_MAX_PER_WINDOW = String(rowsBeforeIp.c + 1);

    const ip1 = await req(base, '/api/auth/register/start', { email: 'ip-a@example.com' });
    assert(ip1.res.status === 201, `first IP-window request should pass, got ${ip1.res.status}`);
    assert(smtp.messages.length === 3, 'first IP-window request should send one more email');

    const ip2 = await req(base, '/api/auth/register/start', { email: 'ip-b@example.com' });
    assert(ip2.res.status === 429, `IP rate limit should be 429, got ${ip2.res.status}`);
    assert(ip2.body.error.code === 'rate_limited', 'IP rate limit should return rate_limited');
    assert(smtp.messages.length === 3, 'IP-limited request must not send an email');

    const summary = db.prepare(
      `SELECT
         COUNT(*) total,
         SUM(CASE WHEN requester_ip_hash IS NOT NULL THEN 1 ELSE 0 END) ip_hashes,
         SUM(CASE WHEN requester_device_hash IS NOT NULL THEN 1 ELSE 0 END) device_hashes
       FROM verification_codes`,
    ).get() as { total: number; ip_hashes: number; device_hashes: number };
    db.close();
    assert(summary.total === 3, `only successful sends should be persisted, got ${summary.total}`);
    assert(summary.ip_hashes === 3, `all successful sends should store an IP hash, got ${summary.ip_hashes}`);
    assert(summary.device_hashes === 2, `device sends should store device hashes, got ${summary.device_hashes}`);
  } finally {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await smtp.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
