import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { taskManualOrderUpdates } from '../client/src/taskManualOrder';

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
    socket.write('220 task.manual.order.smtp.local ESMTP\r\n');
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
      device: { deviceId: `task-manual-order-${email}`, deviceName: 'Task manual order test', platform: 'Web', appVersion: 'test' },
    }),
  });
  await json(loginRes);
  assert(loginRes.status === 201 || loginRes.status === 200, `login failed: ${loginRes.status}`);
  return cookiesFrom(loginRes);
}

async function applyUpdates(base: string, cookie: string, updates: Array<{ id: string; sortOrder: number }>): Promise<void> {
  for (const update of updates) {
    const patched = await req(base, `/api/tasks/${update.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ sortOrder: update.sortOrder }),
    });
    assert(patched.res.status === 200, `patch sortOrder failed: ${patched.res.status}`);
  }
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `task-manual-order-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'task-manual-order-token-secret',
    AUTH_IDENTIFIER_SECRET: 'task-manual-order-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const alice = await login(base, 'task-manual-order@example.com', smtp.messages);
    const bob = await login(base, 'task-manual-order-bob@example.com', smtp.messages);
    const list = await req(base, '/api/lists', { method: 'POST', cookie: alice, body: JSON.stringify({ name: 'Manual Order' }) });
    for (const title of ['Alpha', 'Bravo', 'Charlie']) {
      const created = await req(base, '/api/tasks', {
        method: 'POST',
        cookie: alice,
        body: JSON.stringify({ title, listId: list.body.list.id }),
      });
      assert(created.res.status === 201, `task create failed: ${created.res.status}`);
    }

    const firstFetch = await req(base, `/api/tasks?listId=${list.body.list.id}`, { cookie: alice });
    const firstOrder = firstFetch.body.tasks;
    assert(firstOrder.length === 3, 'expected three tasks before reordering');

    await applyUpdates(base, alice, taskManualOrderUpdates(firstOrder, firstOrder[0].id, 'down'));
    const afterDown = await req(base, `/api/tasks?listId=${list.body.list.id}`, { cookie: alice });
    assert(afterDown.body.tasks[0].id === firstOrder[1].id && afterDown.body.tasks[1].id === firstOrder[0].id, 'move down should swap first two tasks');

    const last = afterDown.body.tasks[2];
    await applyUpdates(base, alice, taskManualOrderUpdates(afterDown.body.tasks, last.id, 'top'));
    const afterTop = await req(base, `/api/tasks?listId=${list.body.list.id}`, { cookie: alice });
    assert(afterTop.body.tasks[0].id === last.id, 'pin top should move the last task to the first position');

    const crossAccount = await req(base, `/api/tasks/${afterTop.body.tasks[0].id}`, {
      method: 'PATCH',
      cookie: bob,
      body: JSON.stringify({ sortOrder: 999 }),
    });
    assert(crossAccount.res.status === 404, `cross-account task reorder should be 404, got ${crossAccount.res.status}`);

    const db = new DatabaseSync(dbPath);
    try {
      const rows = db
        .prepare('SELECT title FROM tasks WHERE list_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC')
        .all(list.body.list.id) as Array<{ title: string }>;
      assert(rows.map((row) => row.title).join(',') === afterTop.body.tasks.map((task: any) => task.title).join(','), 'SQLite order should match API order');
      const activity = db.prepare("SELECT COUNT(*) c FROM task_activity_logs WHERE action = 'task_updated'").get() as { c: number };
      assert(activity.c >= 3, `expected sort updates to create activity rows, got ${activity.c}`);
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
