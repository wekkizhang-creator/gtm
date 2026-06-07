import { loginByEmailPassword } from './auth-test-helper';
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

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `countdowns-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_SECURE: 'false',
    SMTP_STARTTLS: 'false',
    SMTP_FROM: 'test@example.com',
    SMTP_HELO: 'localhost',
    AUTH_TOKEN_SECRET: 'countdowns-token-secret',
    AUTH_IDENTIFIER_SECRET: 'countdowns-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  await waitForHealth(base);

  try {
    const alice = await loginByEmailPassword(base, 'countdowns-alice@example.com', smtp.messages);
    const bob = await loginByEmailPassword(base, 'countdowns-bob@example.com', smtp.messages);

    const first = await req(base, '/api/countdowns', {
      method: 'POST',
      cookie: alice.cookie,
      body: JSON.stringify({ title: 'First date', targetDate: '2030-01-01' }),
    });
    const second = await req(base, '/api/countdowns', {
      method: 'POST',
      cookie: alice.cookie,
      body: JSON.stringify({ title: 'Second date', targetDate: '2030-01-02' }),
    });
    const third = await req(base, '/api/countdowns', {
      method: 'POST',
      cookie: alice.cookie,
      body: JSON.stringify({ title: 'Third date', targetDate: '2030-01-03' }),
    });
    assert(first.res.status === 201 && second.res.status === 201 && third.res.status === 201, 'countdowns should be created through HTTP');

    const reordered = await req(base, '/api/countdowns/reorder', {
      method: 'POST',
      cookie: alice.cookie,
      body: JSON.stringify({ orderedIds: [third.body.countdown.id, first.body.countdown.id, second.body.countdown.id] }),
    });
    assert(reordered.res.status === 200, `reorder failed: ${reordered.res.status} ${JSON.stringify(reordered.body)}`);
    assert(
      reordered.body.countdowns.map((item: any) => item.id).join('|') ===
        [third.body.countdown.id, first.body.countdown.id, second.body.countdown.id].join('|'),
      'reorder response should return manual countdown order',
    );

    const listed = await req(base, '/api/countdowns', { cookie: alice.cookie });
    assert(
      listed.body.countdowns.map((item: any) => item.id).join('|') === reordered.body.countdowns.map((item: any) => item.id).join('|'),
      'list should keep persisted manual order',
    );

    const bobReorder = await req(base, '/api/countdowns/reorder', {
      method: 'POST',
      cookie: bob.cookie,
      body: JSON.stringify({ orderedIds: [third.body.countdown.id] }),
    });
    assert(bobReorder.res.status === 404, `other-account reorder should be 404, got ${bobReorder.res.status}`);
    assert(bobReorder.body.error.code === 'countdown_not_found', 'other-account reorder should return countdown_not_found');

    const invalidReorder = await req(base, '/api/countdowns/reorder', {
      method: 'POST',
      cookie: alice.cookie,
      body: JSON.stringify({ orderedIds: [first.body.countdown.id, first.body.countdown.id] }),
    });
    assert(invalidReorder.res.status === 400, `duplicate reorder should be 400, got ${invalidReorder.res.status}`);
    assert(invalidReorder.body.error.code === 'invalid_countdown_order', 'duplicate reorder should return invalid_countdown_order');

    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare('SELECT title, sort_order FROM countdowns WHERE user_id = ? ORDER BY sort_order ASC').all(alice.userId) as {
        title: string;
        sort_order: number;
      }[];
      assert(rows.map((row) => row.title).join('|') === 'Third date|First date|Second date', 'SQLite sort_order should persist manual order');
      assert(rows.map((row) => row.sort_order).join('|') === '1|2|3', 'SQLite sort_order should be rewritten contiguously');
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
