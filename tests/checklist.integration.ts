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
    socket.write('220 checklist.smtp.local ESMTP\r\n');
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
      device: { deviceId: `checklist-${email}`, deviceName: 'Checklist integration test', platform: 'Web', appVersion: 'test' },
    }),
  });
  await json(loginRes);
  assert(loginRes.status === 201 || loginRes.status === 200, `login failed: ${loginRes.status}`);
  return cookiesFrom(loginRes);
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `checklist-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'checklist-token-secret',
    AUTH_IDENTIFIER_SECRET: 'checklist-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const alice = await login(base, 'checklist-alice@example.com', smtp.messages);
    const bob = await login(base, 'checklist-bob@example.com', smtp.messages);

    const parent = await req(base, '/api/tasks', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({ title: 'Prepare launch checklist', priority: 2 }),
    });
    assert(parent.res.status === 201, `task create failed: ${parent.res.status} ${JSON.stringify(parent.body)}`);
    const taskId = parent.body.task.id;

    const empty = await req(base, `/api/tasks/${taskId}/checklist`, { cookie: alice });
    assert(empty.res.status === 200 && empty.body.items.length === 0, 'new task should have empty checklist');

    const first = await req(base, `/api/tasks/${taskId}/checklist`, {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({ title: 'Write launch copy' }),
    });
    const second = await req(base, `/api/tasks/${taskId}/checklist`, {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({ title: 'Review pricing page' }),
    });
    assert(first.res.status === 201 && second.res.status === 201, 'checklist item creation failed');

    const done = await req(base, `/api/tasks/${taskId}/checklist/${first.body.item.id}`, {
      method: 'PATCH',
      cookie: alice,
      body: JSON.stringify({ completed: true, title: 'Write final launch copy' }),
    });
    assert(done.res.status === 200 && done.body.item.completed, 'checklist item update failed');

    const withCounts = await req(base, `/api/tasks/${taskId}`, { cookie: alice });
    assert(withCounts.body.task.checklistTotal === 2, `expected two checklist items, got ${withCounts.body.task.checklistTotal}`);
    assert(withCounts.body.task.checklistDone === 1, `expected one completed checklist item, got ${withCounts.body.task.checklistDone}`);
    assert(withCounts.body.task.rollupProgress === 0.5, `expected checklist progress 0.5, got ${withCounts.body.task.rollupProgress}`);

    const isolated = await req(base, `/api/tasks/${taskId}/checklist`, { cookie: bob });
    assert(isolated.res.status === 404, `another user should not read checklist items, got ${isolated.res.status}`);

    const converted = await req(base, `/api/tasks/${taskId}/checklist/${first.body.item.id}/convert-to-subtask`, {
      method: 'POST',
      cookie: alice,
    });
    assert(converted.res.status === 201, `convert checklist item failed: ${converted.res.status} ${JSON.stringify(converted.body)}`);
    assert(converted.body.item.convertedTaskId === converted.body.task.id, 'converted task id was not stored on checklist item');
    assert(converted.body.task.parentId === taskId, 'converted checklist item should become a subtask');
    assert(converted.body.task.completed === true, 'completed checklist item should convert to completed subtask');
    assert(converted.body.task.source === 'checklist', 'converted subtask should record checklist source');

    const convertedAgain = await req(base, `/api/tasks/${taskId}/checklist/${first.body.item.id}/convert-to-subtask`, {
      method: 'POST',
      cookie: alice,
    });
    assert(convertedAgain.body.task.id === converted.body.task.id, 'checklist conversion should be idempotent');

    const removeSecond = await req(base, `/api/tasks/${taskId}/checklist/${second.body.item.id}`, {
      method: 'DELETE',
      cookie: alice,
    });
    assert(removeSecond.res.status === 204, `checklist delete failed: ${removeSecond.res.status}`);

    const exported = await req(base, '/api/settings/export', { cookie: alice });
    assert(
      exported.body.taskChecklistItems.some((item: any) => item.id === first.body.item.id && item.converted_task_id === converted.body.task.id),
      'export should include checklist item with converted task reference',
    );

    const db = new DatabaseSync(dbPath);
    try {
      const checklistRows = db.prepare('SELECT COUNT(*) c FROM task_checklist_items WHERE user_id IS NOT NULL').get() as { c: number };
      assert(checklistRows.c === 1, `expected one remaining checklist item, got ${checklistRows.c}`);
      const convertedRow = db.prepare('SELECT completed, converted_task_id FROM task_checklist_items WHERE id = ?').get(first.body.item.id) as
        | { completed: number; converted_task_id: string }
        | undefined;
      assert(convertedRow?.completed === 1 && convertedRow.converted_task_id === converted.body.task.id, 'converted checklist row mismatch');
      const subtaskRow = db.prepare('SELECT parent_id, source, completed FROM tasks WHERE id = ?').get(converted.body.task.id) as
        | { parent_id: string; source: string; completed: number }
        | undefined;
      assert(subtaskRow?.parent_id === taskId && subtaskRow.source === 'checklist' && subtaskRow.completed === 1, 'converted subtask row mismatch');
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
