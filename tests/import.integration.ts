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

async function login(base: string, email: string, smtpMessages: string[]): Promise<string> {
  const codeStart = smtpMessages.length;
  const challenge = await req(base, '/api/auth/verification-codes', {
    method: 'POST',
    body: JSON.stringify({ type: 'email', identifier: email, purpose: 'login' }),
  });
  assert(challenge.res.status === 201, `verification code failed: ${challenge.res.status}`);
  for (let i = 0; i < 20 && smtpMessages.length === codeStart; i++) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const code = (smtpMessages.at(-1) ?? '').match(/\b\d{6}\b/)?.[0];
  assert(code, 'SMTP message did not include a code');
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.body.challengeId,
      code,
      agreedToTerms: true,
      device: { deviceId: `import-${email}`, deviceName: 'Import integration test', platform: 'Web', appVersion: 'test' },
    }),
  });
  await json(loginRes);
  assert(loginRes.status === 201 || loginRes.status === 200, `login failed: ${loginRes.status}`);
  return cookiesFrom(loginRes);
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `import-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'import-token-secret',
    AUTH_IDENTIFIER_SECRET: 'import-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const cookie = await login(base, 'import-alice@example.com', smtp.messages);
    await req(base, '/api/tasks', { method: 'POST', cookie, body: JSON.stringify({ title: 'Existing task' }) });
    const data = {
      tasks: [{ title: 'Existing task' }, { title: 'Imported task', priority: 2 }, { title: '' }],
      lists: [{ name: 'Imported list' }],
      tags: [{ name: 'Imported tag' }],
      goals: [{ title: 'Imported goal' }],
    };
    const preview = await req(base, '/api/import/preview', { method: 'POST', cookie, body: JSON.stringify({ format: 'json', data }) });
    assert(preview.body.summary.valid === 5, `expected 5 valid rows, got ${preview.body.summary.valid}`);
    assert(preview.body.summary.duplicates === 1, 'preview should find one duplicate');
    assert(preview.body.summary.invalid === 1, 'preview should find one invalid row');

    const denied = await req(base, '/api/import/commit', { method: 'POST', cookie, body: JSON.stringify({ format: 'json', data }) });
    assert(denied.res.status === 400, `commit without confirm should fail, got ${denied.res.status}`);

    const commit = await req(base, '/api/import/commit', { method: 'POST', cookie, body: JSON.stringify({ format: 'json', data, confirm: true }) });
    assert(commit.body.created.length === 4, `expected 4 created rows, got ${commit.body.created.length}`);

    const csv = 'title,priority\nCSV imported task,1\n,2';
    const csvPreview = await req(base, '/api/import/preview', { method: 'POST', cookie, body: JSON.stringify({ format: 'csv', data: csv }) });
    assert(csvPreview.body.summary.valid === 1, `expected one valid CSV row, got ${csvPreview.body.summary.valid}`);
    assert(csvPreview.body.summary.invalid === 1, `expected one invalid CSV row, got ${csvPreview.body.summary.invalid}`);
    const csvCommit = await req(base, '/api/import/commit', { method: 'POST', cookie, body: JSON.stringify({ format: 'csv', data: csv, confirm: true }) });
    assert(csvCommit.body.created.length === 1, `expected one CSV created row, got ${csvCommit.body.created.length}`);

    const db = new DatabaseSync(dbPath);
    try {
      const taskCount = db.prepare('SELECT COUNT(*) c FROM tasks').get() as { c: number };
      const csvTask = db.prepare("SELECT COUNT(*) c FROM tasks WHERE title = 'CSV imported task'").get() as { c: number };
      const list = db.prepare("SELECT COUNT(*) c FROM lists WHERE name = 'Imported list'").get() as { c: number };
      const tag = db.prepare("SELECT COUNT(*) c FROM tags WHERE name = 'Imported tag'").get() as { c: number };
      const goal = db.prepare("SELECT COUNT(*) c FROM goals WHERE title = 'Imported goal'").get() as { c: number };
      assert(taskCount.c === 3, `expected three tasks after import, got ${taskCount.c}`);
      assert(csvTask.c === 1, 'CSV import did not write a task row');
      assert(list.c === 1 && tag.c === 1 && goal.c === 1, 'import did not write list/tag/goal rows');
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
