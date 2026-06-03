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
      device: { deviceId: `trash-${email}`, deviceName: 'Trash integration test', platform: 'Web', appVersion: 'test' },
    }),
  });
  await json(loginRes);
  assert(loginRes.status === 201 || loginRes.status === 200, `login failed: ${loginRes.status}`);
  return cookiesFrom(loginRes);
}

async function createTask(base: string, cookie: string, title: string): Promise<string> {
  const created = await req(base, '/api/tasks', { method: 'POST', cookie, body: JSON.stringify({ title }) });
  assert(created.res.status === 201, `create task failed: ${created.res.status}`);
  return created.body.task.id;
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `trash-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'trash-token-secret',
    AUTH_IDENTIFIER_SECRET: 'trash-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const alice = await login(base, 'trash-alice@example.com', smtp.messages);
    const bob = await login(base, 'trash-bob@example.com', smtp.messages);

    const activeId = await createTask(base, alice, 'Active keeper');
    const oldTrashId = await createTask(base, alice, 'Old trash');
    const newTrashId = await createTask(base, alice, 'New trash');
    const bobTrashId = await createTask(base, bob, 'Bob trash');

    for (const [cookie, id] of [[alice, oldTrashId], [alice, newTrashId], [bob, bobTrashId]] as const) {
      const deleted = await req(base, `/api/tasks/${id}`, { method: 'DELETE', cookie });
      assert(deleted.res.status === 204, `soft delete failed: ${deleted.res.status}`);
    }

    const db = new DatabaseSync(dbPath);
    const oldDeletedAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
    db.prepare('UPDATE tasks SET deleted_at = ? WHERE id = ?').run(oldDeletedAt, oldTrashId);

    const invalid = await req(base, '/api/tasks/trash/summary?retentionDays=0', { cookie: alice });
    assert(invalid.res.status === 400, `invalid retention should be 400, got ${invalid.res.status}`);

    const summary = await req(base, '/api/tasks/trash/summary?retentionDays=30', { cookie: alice });
    assert(summary.body.trash.trashCount === 2, `Alice trash count should be 2, got ${summary.body.trash.trashCount}`);
    assert(summary.body.trash.expiredCount === 1, `Alice expired count should be 1, got ${summary.body.trash.expiredCount}`);
    assert(summary.body.trash.oldestDeletedAt === oldDeletedAt, 'oldestDeletedAt should use the oldest deleted row');

    const expired = await req(base, '/api/tasks/trash/purge-expired', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({ retentionDays: 30 }),
    });
    assert(expired.body.trash.purgedCount === 1, `expected one expired purge, got ${expired.body.trash.purgedCount}`);
    assert(expired.body.trash.trashCount === 1, `Alice trash count after expired purge should be 1, got ${expired.body.trash.trashCount}`);

    const bobSummary = await req(base, '/api/tasks/trash/summary', { cookie: bob });
    assert(bobSummary.body.trash.trashCount === 1, `Bob trash should remain isolated, got ${bobSummary.body.trash.trashCount}`);

    const empty = await req(base, '/api/tasks/trash/empty', { method: 'POST', cookie: alice });
    assert(empty.body.trash.purgedCount === 1, `expected one remaining Alice trash purge, got ${empty.body.trash.purgedCount}`);
    assert(empty.body.trash.trashCount === 0, 'Alice trash should be empty after empty-trash');

    try {
      const active = db.prepare('SELECT COUNT(*) c FROM tasks WHERE id = ? AND deleted_at IS NULL').get(activeId) as { c: number };
      const aliceTrash = db.prepare('SELECT COUNT(*) c FROM tasks WHERE id IN (?, ?)').get(oldTrashId, newTrashId) as { c: number };
      const bobTrash = db.prepare('SELECT COUNT(*) c FROM tasks WHERE id = ? AND deleted_at IS NOT NULL').get(bobTrashId) as { c: number };
      const logs = db
        .prepare("SELECT COUNT(*) c FROM task_activity_logs WHERE action IN ('trash_expired_purged', 'trash_emptied')")
        .get() as { c: number };
      assert(active.c === 1, 'active task should not be purged');
      assert(aliceTrash.c === 0, 'Alice trash rows should be deleted from SQLite');
      assert(bobTrash.c === 1, 'Bob trash row should remain in SQLite');
      assert(logs.c === 2, `expected two trash cleanup activity logs, got ${logs.c}`);
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
