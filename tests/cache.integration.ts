import { loginCookie } from './auth-test-helper';
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
    socket.write('220 cache.smtp.local ESMTP\r\n');
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

async function login(base: string, email: string, smtpMessages: string[]): Promise<string> {
  return loginCookie(base, email, smtpMessages);
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `cache-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'cache-token-secret',
    AUTH_IDENTIFIER_SECRET: 'cache-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const alice = await login(base, 'cache-alice@example.com', smtp.messages);
    const bob = await login(base, 'cache-bob@example.com', smtp.messages);

    const aliceCache = await req(base, '/api/focus/sounds/rain/cache', { method: 'POST', cookie: alice });
    assert(aliceCache.body.sound.cacheStatus === 'cached', 'Alice sound cache was not stored');
    const bobCache = await req(base, '/api/focus/sounds/cafe/cache', { method: 'POST', cookie: bob });
    assert(bobCache.body.sound.cacheStatus === 'cached', 'Bob sound cache was not stored');

    const preview = await req(base, '/api/account/local-cache', { cookie: alice });
    assert(preview.res.status === 200, `cache preview failed: ${preview.res.status}`);
    assert(preview.body.cache.soundCacheCount === 1, `expected one cached sound, got ${preview.body.cache.soundCacheCount}`);
    assert(preview.body.cache.attachmentCacheCount === 0, 'attachment cache count should be explicit zero until local attachment cache exists');

    const cleared = await req(base, '/api/account/local-cache/clear', { method: 'POST', cookie: alice });
    assert(cleared.res.status === 200, `cache clear failed: ${cleared.res.status}`);
    assert(cleared.body.cache.soundCacheCleared === 1, `expected one cleared sound, got ${cleared.body.cache.soundCacheCleared}`);
    assert(cleared.body.cache.soundCacheCount === 0, 'sound cache summary should be zero after clear');

    const after = await req(base, '/api/account/local-cache', { cookie: alice });
    assert(after.body.cache.soundCacheCount === 0, 'Alice cache should remain cleared');
    const bobSounds = await req(base, '/api/focus/sounds', { cookie: bob });
    assert(bobSounds.body.sounds.find((sound: any) => sound.id === 'cafe')?.cacheStatus === 'cached', 'clearing Alice cache should not clear Bob cache');

    const db = new DatabaseSync(dbPath);
    try {
      const aliceRows = db.prepare("SELECT COUNT(*) c FROM user_sound_cache WHERE local_path = 'cache://rain'").get() as { c: number };
      assert(aliceRows.c === 0, 'Alice sound cache row should be deleted');
      const bobRows = db.prepare("SELECT COUNT(*) c FROM user_sound_cache WHERE local_path = 'cache://cafe'").get() as { c: number };
      assert(bobRows.c === 1, 'Bob sound cache row should remain');
      const event = db.prepare("SELECT COUNT(*) c FROM analytics_events WHERE event_name = 'auth_cache_clear'").get() as { c: number };
      assert(event.c === 1, 'cache clear analytics event was not recorded');
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
