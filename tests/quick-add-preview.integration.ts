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
    socket.write('220 quick.preview.smtp.local ESMTP\r\n');
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
      device: { deviceId: `quick-preview-${email}`, deviceName: 'Quick preview test', platform: 'Web', appVersion: 'test' },
    }),
  });
  await json(loginRes);
  assert(loginRes.status === 201 || loginRes.status === 200, `login failed: ${loginRes.status}`);
  return cookiesFrom(loginRes);
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `quick-add-preview-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'quick-preview-token-secret',
    AUTH_IDENTIFIER_SECRET: 'quick-preview-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const cookie = await login(base, 'quick-preview@example.com', smtp.messages);
    const rawText = '明天下午3点开会 #工作 !高';

    const preview = await req(base, '/api/tasks/quick-parse', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ text: rawText }),
    });
    assert(preview.res.status === 200, `quick parse failed: ${preview.res.status}`);
    assert(preview.body.tokens.some((token: any) => token.type === 'date'), 'date token missing');
    assert(preview.body.tokens.some((token: any) => token.type === 'time'), 'time token missing');
    assert(preview.body.tokens.some((token: any) => token.type === 'priority' && token.value === 3), 'priority token missing');
    assert(preview.body.tokens.some((token: any) => token.type === 'tag' && token.value === '工作'), 'tag token missing');

    const parsedTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: preview.body.draft.title,
        dueDate: preview.body.draft.dueDate,
        startDate: preview.body.draft.startDate,
        isAllDay: preview.body.draft.isAllDay,
        priority: preview.body.draft.priority,
      }),
    });
    assert(parsedTask.res.status === 201, `parsed task create failed: ${parsedTask.res.status}`);
    const tag = await req(base, '/api/tags', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: preview.body.draft.tags[0] }),
    });
    assert(tag.res.status === 201, `tag create failed: ${tag.res.status}`);
    const tagged = await req(base, `/api/tasks/${parsedTask.body.task.id}/tags/${tag.body.tag.id}`, { method: 'POST', cookie });
    assert(tagged.body.task.tags.some((item: any) => item.name === '工作'), 'parsed task should get parsed tag');

    const rawTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: rawText }),
    });
    assert(rawTask.res.status === 201, `raw task create failed: ${rawTask.res.status}`);

    const db = new DatabaseSync(dbPath);
    try {
      const parsedRow = db.prepare('SELECT title, priority, start_date FROM tasks WHERE id = ?').get(parsedTask.body.task.id) as
        | { title: string; priority: number; start_date: string | null }
        | undefined;
      const rawRow = db.prepare('SELECT title, priority, start_date FROM tasks WHERE id = ?').get(rawTask.body.task.id) as
        | { title: string; priority: number; start_date: string | null }
        | undefined;
      assert(parsedRow?.title === '明天下午3点开会' && parsedRow.priority === 3 && parsedRow.start_date, 'parsed task DB row mismatch');
      assert(rawRow?.title === rawText && rawRow.priority === 0 && rawRow.start_date === null, 'dismissed parse should create original task text');
      const parsedTags = db.prepare('SELECT COUNT(*) c FROM task_tags WHERE task_id = ?').get(parsedTask.body.task.id) as { c: number };
      const rawTags = db.prepare('SELECT COUNT(*) c FROM task_tags WHERE task_id = ?').get(rawTask.body.task.id) as { c: number };
      assert(parsedTags.c === 1, 'parsed task should have one tag relation');
      assert(rawTags.c === 0, 'raw task should not get parsed tags');
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
