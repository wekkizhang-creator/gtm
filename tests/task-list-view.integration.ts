import { loginCookie } from './auth-test-helper';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { buildTaskListGroups, sortTaskList } from '../client/src/taskListView';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INBOX_LABEL = '\u6536\u96c6\u7bb1';

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
    socket.write('220 task.list.view.smtp.local ESMTP\r\n');
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
  const dbPath = resolve(root, 'server', 'data', `task-list-view-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'task-list-view-token-secret',
    AUTH_IDENTIFIER_SECRET: 'task-list-view-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const cookie = await login(base, 'task-list-view@example.com', smtp.messages);
    const work = await req(base, '/api/lists', { method: 'POST', cookie, body: JSON.stringify({ name: 'Work' }) });
    const home = await req(base, '/api/lists', { method: 'POST', cookie, body: JSON.stringify({ name: 'Home' }) });
    const launch = await req(base, '/api/tags', { method: 'POST', cookie, body: JSON.stringify({ name: 'Launch' }) });
    const errand = await req(base, '/api/tags', { method: 'POST', cookie, body: JSON.stringify({ name: 'Errand' }) });

    const later = new Date('2030-01-03T09:00:00.000Z').toISOString();
    const earlier = new Date('2030-01-02T09:00:00.000Z').toISOString();
    const taskA = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Beta launch', listId: work.body.list.id, priority: 3, dueDate: later, startDate: later, isAllDay: false }),
    });
    const taskB = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Alpha home', listId: home.body.list.id, priority: 1, dueDate: earlier, startDate: earlier, isAllDay: false }),
    });
    const taskC = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Inbox followup', priority: 2 }),
    });
    await req(base, `/api/tasks/${taskA.body.task.id}/tags/${launch.body.tag.id}`, { method: 'POST', cookie });
    await req(base, `/api/tasks/${taskB.body.task.id}/tags/${errand.body.tag.id}`, { method: 'POST', cookie });

    const tasksRes = await req(base, '/api/tasks?view=active', { cookie });
    const listsRes = await req(base, '/api/lists', { cookie });
    const tagsRes = await req(base, '/api/tags', { cookie });
    assert(tasksRes.res.status === 200 && tasksRes.body.tasks.length === 3, 'active task list should return real tasks');

    assert(sortTaskList(tasksRes.body.tasks, 'priority', listsRes.body.lists)[0].id === taskA.body.task.id, 'priority sort should use HTTP task priorities');
    assert(sortTaskList(tasksRes.body.tasks, 'time', listsRes.body.lists)[0].id === taskB.body.task.id, 'time sort should use HTTP task dates');
    assert(sortTaskList(tasksRes.body.tasks, 'list', listsRes.body.lists)[0].id === taskC.body.task.id, 'list sort should put the HTTP inbox first');

    const byList = buildTaskListGroups(tasksRes.body.tasks, 'list', 'priority', listsRes.body.lists, tagsRes.body.tags);
    const inboxGroup = byList.find((group) => group.id === 'inbox');
    assert(inboxGroup?.label === INBOX_LABEL, 'list grouping should use inbox fallback for task list ids excluded from /api/lists');
    assert(inboxGroup.tasks.some((task) => task.id === taskC.body.task.id), 'list grouping should include inbox task');

    const byTag = buildTaskListGroups(tasksRes.body.tasks, 'tag', 'priority', listsRes.body.lists, tagsRes.body.tags);
    assert(byTag.some((group) => group.label === 'Launch' && group.tasks[0].id === taskA.body.task.id), 'tag grouping should use HTTP tag relation');
    assert(byTag.some((group) => group.label === 'Errand' && group.tasks[0].id === taskB.body.task.id), 'tag grouping should include the second HTTP tag relation');
    assert(byTag.some((group) => group.id === 'tag:none' && group.tasks[0].id === taskC.body.task.id), 'tag grouping should include untagged HTTP tasks');

    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare('SELECT title, priority, start_date FROM tasks WHERE deleted_at IS NULL').all() as Array<{
        title: string;
        priority: number;
        start_date: string | null;
      }>;
      assert(rows.some((row) => row.title === 'Beta launch' && row.priority === 3 && row.start_date === later), 'SQLite high priority dated task missing');
      assert(rows.some((row) => row.title === 'Inbox followup' && row.priority === 2), 'SQLite inbox task missing');
      const tagRows = db.prepare('SELECT COUNT(*) c FROM task_tags').get() as { c: number };
      assert(tagRows.c === 2, `expected two SQLite task_tags rows, got ${tagRows.c}`);
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
