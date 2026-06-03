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
    socket.write('220 task.filter.smtp.local ESMTP\r\n');
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
  const start = smtpMessages.length;
  const challenge = await req(base, '/api/auth/verification-codes', {
    method: 'POST',
    body: JSON.stringify({ type: 'email', identifier: email, purpose: 'login' }),
  });
  assert(challenge.res.status === 201, `verification code failed: ${challenge.res.status}`);
  for (let i = 0; i < 20 && smtpMessages.length === start; i++) await new Promise((r) => setTimeout(r, 50));
  const code = (smtpMessages.at(-1) ?? '').match(/\b\d{6}\b/)?.[0];
  assert(code, 'SMTP message did not include code');
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.body.challengeId,
      code,
      agreedToTerms: true,
      device: { deviceId: `task-filter-${email}`, deviceName: 'Task filter test', platform: 'Web', appVersion: 'test' },
    }),
  });
  await json(loginRes);
  assert(loginRes.status === 201 || loginRes.status === 200, `login failed: ${loginRes.status}`);
  return cookiesFrom(loginRes);
}

function queryString(query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value != null && value !== '') params.set(key, String(value));
  }
  return params.toString();
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `task-filter-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'task-filter-token-secret',
    AUTH_IDENTIFIER_SECRET: 'task-filter-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const cookie = await login(base, 'task-filter@example.com', smtp.messages);
    const work = await req(base, '/api/lists', { method: 'POST', cookie, body: JSON.stringify({ name: 'Work' }) });
    const launch = await req(base, '/api/tags', { method: 'POST', cookie, body: JSON.stringify({ name: 'Launch' }) });
    const dayStart = '2030-01-02T00:00:00.000Z';
    const dayEnd = '2030-01-02T23:59:59.999Z';

    const target = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Launch brief', listId: work.body.list.id, priority: 3, status: 'doing', dueDate: '2030-01-02T09:00:00.000Z', isAllDay: false }),
    });
    const lowPriority = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Launch errands', listId: work.body.list.id, priority: 1, status: 'doing', dueDate: '2030-01-02T10:00:00.000Z', isAllDay: false }),
    });
    const wrongDate = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Launch brief tomorrow', listId: work.body.list.id, priority: 3, status: 'doing', dueDate: '2030-01-03T09:00:00.000Z', isAllDay: false }),
    });
    const undated = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Launch undated', listId: work.body.list.id, priority: 3, status: 'todo' }),
    });
    await req(base, `/api/tasks/${target.body.task.id}/tags/${launch.body.tag.id}`, { method: 'POST', cookie });
    await req(base, `/api/tasks/${lowPriority.body.task.id}/tags/${launch.body.tag.id}`, { method: 'POST', cookie });
    await req(base, `/api/tasks/${wrongDate.body.task.id}/tags/${launch.body.tag.id}`, { method: 'POST', cookie });
    await req(base, `/api/tasks/${undated.body.task.id}/tags/${launch.body.tag.id}`, { method: 'POST', cookie });

    const comboQuery = {
      listId: work.body.list.id,
      tagId: launch.body.tag.id,
      priority: 3,
      status: 'doing',
      q: 'brief',
      from: dayStart,
      to: dayEnd,
    };
    const combo = await req(base, `/api/tasks?${queryString(comboQuery)}`, { cookie });
    assert(combo.res.status === 200, `combo query failed: ${combo.res.status}`);
    assert(combo.body.tasks.length === 1 && combo.body.tasks[0].id === target.body.task.id, 'combo query should return only the matching task');

    const savedFilter = await req(base, '/api/filters', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Launch high priority brief', query: comboQuery }),
    });
    assert(savedFilter.res.status === 201, `save filter failed: ${savedFilter.res.status}`);
    const savedCombo = await req(base, `/api/tasks?${queryString(savedFilter.body.filter.query)}`, { cookie });
    assert(savedCombo.body.tasks.length === 1 && savedCombo.body.tasks[0].id === target.body.task.id, 'saved filter query should replay combo query');

    const undatedCombo = await req(base, `/api/tasks?${queryString({ listId: work.body.list.id, tagId: launch.body.tag.id, priority: 3, dateFilter: 'undated' })}`, { cookie });
    assert(undatedCombo.body.tasks.length === 1 && undatedCombo.body.tasks[0].id === undated.body.task.id, 'undated combo query should stay scoped to list/tag/priority');

    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare('SELECT query_json FROM saved_filters WHERE name = ?').get('Launch high priority brief') as { query_json: string } | undefined;
      assert(row, 'SQLite saved filter row missing');
      const saved = JSON.parse(row.query_json);
      assert(saved.listId === work.body.list.id && saved.priority === 3 && saved.tagId === launch.body.tag.id, 'SQLite saved filter query mismatch');
      const tagCount = db.prepare('SELECT COUNT(*) c FROM task_tags').get() as { c: number };
      assert(tagCount.c === 4, `expected four task_tags rows, got ${tagCount.c}`);
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
