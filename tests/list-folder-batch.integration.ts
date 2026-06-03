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

async function requestCode(base: string, email: string, smtpMessages: string[]): Promise<{ challengeId: string; code: string }> {
  const start = smtpMessages.length;
  const challenge = await req(base, '/api/auth/verification-codes', {
    method: 'POST',
    body: JSON.stringify({ type: 'email', identifier: email, purpose: 'login' }),
  });
  assert(challenge.res.status === 201, `verification code failed: ${challenge.res.status}`);
  for (let i = 0; i < 20 && smtpMessages.length === start; i++) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const code = (smtpMessages.at(-1) ?? '').match(/\b\d{6}\b/)?.[0];
  assert(code, 'SMTP message did not include a code');
  return { challengeId: challenge.body.challengeId, code };
}

async function login(base: string, email: string, smtpMessages: string[]): Promise<string> {
  const challenge = await requestCode(base, email, smtpMessages);
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      code: challenge.code,
      agreedToTerms: true,
      device: { deviceId: `list-batch-${email}`, deviceName: 'List batch test', platform: 'Web', appVersion: 'test' },
    }),
  });
  await json(loginRes);
  assert(loginRes.status === 201 || loginRes.status === 200, `login failed: ${loginRes.status}`);
  return cookiesFrom(loginRes);
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `list-batch-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'list-batch-token-secret',
    AUTH_IDENTIFIER_SECRET: 'list-batch-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const alice = await login(base, 'list-batch-alice@example.com', smtp.messages);
    const bob = await login(base, 'list-batch-bob@example.com', smtp.messages);

    const folder = await req(base, '/api/lists/folders', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({ name: 'Work' }),
    });
    assert(folder.res.status === 201, `folder create failed: ${folder.res.status}`);
    const folderId = folder.body.folder.id;

    const projectList = await req(base, '/api/lists', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({ name: 'Project', folderId }),
    });
    const laterList = await req(base, '/api/lists', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({ name: 'Later' }),
    });
    assert(projectList.body.list.folderId === folderId, 'created list should be in folder');

    const collapsed = await req(base, `/api/lists/folders/${folderId}`, {
      method: 'PATCH',
      cookie: alice,
      body: JSON.stringify({ collapsed: true }),
    });
    assert(collapsed.body.folder.collapsed === true, 'folder collapsed flag should persist');

    const t1 = await req(base, '/api/tasks', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({ title: 'Batch one', listId: projectList.body.list.id }),
    });
    const t2 = await req(base, '/api/tasks', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({ title: 'Batch two', listId: projectList.body.list.id }),
    });
    const dueDate = new Date('2030-01-02T00:00:00.000Z').toISOString();
    const batched = await req(base, '/api/tasks/batch', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({
        taskIds: [t1.body.task.id, t2.body.task.id],
        action: 'update',
        patch: { listId: laterList.body.list.id, priority: 3, dueDate, completed: true },
      }),
    });
    assert(batched.body.affected === 2, `expected two batch updates, got ${batched.body.affected}`);
    assert(batched.body.tasks.every((task: any) => task.listId === laterList.body.list.id && task.priority === 3 && task.completed), 'batch patch mismatch');

    const denied = await req(base, '/api/tasks/batch', {
      method: 'POST',
      cookie: bob,
      body: JSON.stringify({ taskIds: [t1.body.task.id], action: 'delete' }),
    });
    assert(denied.res.status === 404, `Bob should not batch Alice task, got ${denied.res.status}`);

    const deleted = await req(base, '/api/tasks/batch', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({ taskIds: [t1.body.task.id, t2.body.task.id], action: 'delete' }),
    });
    assert(deleted.body.affected === 2, 'batch delete should affect two tasks');

    const restored = await req(base, '/api/tasks/batch', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({ taskIds: [t1.body.task.id, t2.body.task.id], action: 'restore' }),
    });
    assert(restored.body.affected === 2, 'batch restore should affect two tasks');

    await req(base, `/api/lists/folders/${folderId}`, { method: 'DELETE', cookie: alice });
    const listsAfterDelete = await req(base, '/api/lists', { cookie: alice });
    assert(listsAfterDelete.body.lists.some((list: any) => list.id === projectList.body.list.id && list.folderId === null), 'deleting folder should ungroup lists');

    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare('SELECT COUNT(*) c FROM tasks WHERE list_id = ? AND priority = 3 AND completed = 1').get(laterList.body.list.id) as { c: number };
      const folders = db.prepare('SELECT COUNT(*) c FROM list_folders').get() as { c: number };
      assert(rows.c === 2, `expected two moved completed tasks, got ${rows.c}`);
      assert(folders.c === 0, `expected deleted folder row, got ${folders.c}`);
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
