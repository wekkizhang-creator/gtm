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
    socket.write('220 activity.smtp.local ESMTP\r\n');
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
  const dbPath = resolve(root, 'server', 'data', `activity-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'activity-token-secret',
    AUTH_IDENTIFIER_SECRET: 'activity-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const alice = await login(base, 'activity-alice@example.com', smtp.messages);
    const bob = await login(base, 'activity-bob@example.com', smtp.messages);

    const created = await req(base, '/api/tasks', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({ title: 'Activity source task', priority: 2 }),
    });
    assert(created.res.status === 201, `task create failed: ${created.res.status} ${JSON.stringify(created.body)}`);
    const taskId = created.body.task.id;

    const update = await req(base, `/api/tasks/${taskId}`, {
      method: 'PATCH',
      cookie: alice,
      body: JSON.stringify({ title: 'Activity tracked task' }),
    });
    assert(update.res.status === 200, `task title update failed: ${update.res.status}`);

    const complete = await req(base, `/api/tasks/${taskId}`, {
      method: 'PATCH',
      cookie: alice,
      body: JSON.stringify({ completed: true }),
    });
    assert(complete.res.status === 200 && complete.body.task.completed, 'task completion failed');

    const item = await req(base, `/api/tasks/${taskId}/checklist`, {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({ title: 'Activity checklist item' }),
    });
    assert(item.res.status === 201, `checklist create failed: ${item.res.status}`);
    const itemDone = await req(base, `/api/tasks/${taskId}/checklist/${item.body.item.id}`, {
      method: 'PATCH',
      cookie: alice,
      body: JSON.stringify({ completed: true }),
    });
    assert(itemDone.res.status === 200 && itemDone.body.item.completed, 'checklist completion failed');
    const converted = await req(base, `/api/tasks/${taskId}/checklist/${item.body.item.id}/convert-to-subtask`, {
      method: 'POST',
      cookie: alice,
    });
    assert(converted.res.status === 201 && converted.body.task.parentId === taskId, 'checklist conversion failed');

    const reminderAt = new Date(Date.now() + 3600_000).toISOString();
    const reminder = await req(base, `/api/tasks/${taskId}/reminders`, {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({ remindAt: reminderAt }),
    });
    assert(reminder.res.status === 201, `reminder create failed: ${reminder.res.status}`);

    const attachment = await req(base, `/api/tasks/${taskId}/attachments`, {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({ fileName: 'activity.txt', mimeType: 'text/plain', contentBase64: Buffer.from('activity').toString('base64') }),
    });
    assert(attachment.res.status === 201, `attachment create failed: ${attachment.res.status}`);

    const deleted = await req(base, `/api/tasks/${taskId}`, { method: 'DELETE', cookie: alice });
    assert(deleted.res.status === 204, `task delete failed: ${deleted.res.status}`);
    const restored = await req(base, `/api/tasks/${taskId}/restore`, { method: 'POST', cookie: alice });
    assert(restored.res.status === 200, `task restore failed: ${restored.res.status}`);

    const activity = await req(base, `/api/tasks/${taskId}/activity`, { cookie: alice });
    assert(activity.res.status === 200, `activity read failed: ${activity.res.status}`);
    const actions = activity.body.activities.map((row: any) => row.action);
    for (const action of [
      'task_created',
      'task_updated',
      'task_completed',
      'checklist_item_created',
      'checklist_item_completed',
      'checklist_converted_to_subtask',
      'reminder_created',
      'attachment_added',
      'task_deleted',
      'task_restored',
    ]) {
      assert(actions.includes(action), `missing task activity action ${action}; saw ${actions.join(',')}`);
    }
    assert(activity.body.activities.every((row: any) => row.taskId === taskId && row.summary), 'activity rows should be scoped to the task');

    const isolated = await req(base, `/api/tasks/${taskId}/activity`, { cookie: bob });
    assert(isolated.res.status === 404, `another user should not read activity, got ${isolated.res.status}`);

    const exported = await req(base, '/api/settings/export', { cookie: alice });
    assert(
      exported.body.taskActivityLogs.some((row: any) => row.task_id === taskId && row.action === 'checklist_converted_to_subtask'),
      'export should include task activity logs',
    );

    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare('SELECT action, details_json FROM task_activity_logs WHERE user_id IS NOT NULL AND task_id = ?').all(taskId) as Array<{
        action: string;
        details_json: string;
      }>;
      assert(rows.length >= 10, `expected at least ten activity rows, got ${rows.length}`);
      assert(rows.some((row) => row.action === 'task_updated' && JSON.parse(row.details_json).changedFields.includes('title')), 'task update details missing changed title field');
      assert(rows.some((row) => row.action === 'attachment_added' && JSON.parse(row.details_json).fileName === 'activity.txt'), 'attachment activity details mismatch');
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
