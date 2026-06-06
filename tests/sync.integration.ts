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
    socket.write('220 sync.smtp.local ESMTP\r\n');
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
  const dbPath = resolve(root, 'server', 'data', `sync-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'sync-token-secret',
    AUTH_IDENTIFIER_SECRET: 'sync-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const alice = await login(base, 'sync-alice@example.com', smtp.messages);
    const bob = await login(base, 'sync-bob@example.com', smtp.messages);

    const initialStatus = await req(base, '/api/account/sync-status', { cookie: alice });
    assert(initialStatus.res.status === 200, `initial sync status failed: ${initialStatus.res.status}`);
    assert(initialStatus.body.syncStatus.health === 'never_synced', 'new account should start as never_synced');
    assert(initialStatus.body.syncStatus.pendingServerOperationCount === 0, 'new account should not have pending server sync operations');

    const create = await req(base, '/api/sync/operations', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({
        operations: [
          {
            clientOperationId: 'op-create-1',
            entityType: 'task',
            action: 'create',
            clientCreatedAt: '2030-01-01T00:00:00.000Z',
            payload: { title: 'Offline created task', priority: 2, source: 'offline_sync' },
          },
        ],
      }),
    });
    assert(create.res.status === 200, `sync create failed: ${create.res.status} ${JSON.stringify(create.body)}`);
    const created = create.body.results[0];
    assert(created.status === 'applied' && created.task.title === 'Offline created task', 'offline create was not applied');
    const createdStatus = await req(base, '/api/account/sync-status', { cookie: alice });
    assert(createdStatus.body.syncStatus.health === 'synced', 'applied sync operation should report synced');
    assert(createdStatus.body.syncStatus.lastOperation.clientOperationId === 'op-create-1', 'sync status should expose the latest operation id');
    assert(createdStatus.body.syncStatus.lastSuccessfulSyncAt, 'sync status should expose the last successful sync time');

    const repeat = await req(base, '/api/sync/operations', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({
        operations: [
          {
            clientOperationId: 'op-create-1',
            entityType: 'task',
            action: 'create',
            payload: { title: 'Should not duplicate' },
          },
        ],
      }),
    });
    assert(repeat.body.results[0].status === 'duplicate', 'repeated client operation should be duplicate');

    const update = await req(base, '/api/sync/operations', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({
        operations: [
          {
            clientOperationId: 'op-update-1',
            entityType: 'task',
            action: 'update',
            entityId: created.entityId,
            baseUpdatedAt: created.task.updatedAt,
            payload: { title: 'Offline updated task', completed: true },
          },
        ],
      }),
    });
    assert(update.body.results[0].status === 'applied', 'sync update should apply');
    assert(update.body.results[0].task.completed === true, 'sync update did not complete task');
    const updatedTask = update.body.results[0].task;

    const conflict = await req(base, '/api/sync/operations', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({
        operations: [
          {
            clientOperationId: 'op-update-conflict',
            entityType: 'task',
            action: 'update',
            entityId: created.entityId,
            baseUpdatedAt: created.task.updatedAt,
            payload: { title: 'Stale offline title' },
          },
        ],
      }),
    });
    assert(conflict.body.results[0].status === 'conflict', 'stale update should report conflict');
    assert(conflict.body.results[0].conflict.serverTask.title === 'Offline updated task', 'conflict should return server task');
    const conflictStatus = await req(base, '/api/account/sync-status', { cookie: alice });
    assert(conflictStatus.body.syncStatus.health === 'conflict', 'latest conflict should report conflict health');
    assert(conflictStatus.body.syncStatus.pendingServerOperationCount === 1, 'conflict should count as pending server sync work');

    const serverRename = await req(base, `/api/tasks/${created.entityId}`, {
      method: 'PATCH',
      cookie: alice,
      body: JSON.stringify({ title: 'Server renamed task', priority: 3 }),
    });
    assert(serverRename.body.task.title === 'Server renamed task', 'direct server task rename did not apply');
    assert(serverRename.body.task.priority === 3, 'direct server priority update did not apply');

    const fieldMerge = await req(base, '/api/sync/operations', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({
        operations: [
          {
            clientOperationId: 'op-merge-completed',
            entityType: 'task',
            action: 'update',
            entityId: created.entityId,
            baseUpdatedAt: updatedTask.updatedAt,
            clientCreatedAt: '2030-01-01T00:01:00.000Z',
            payload: { completed: false, baseSnapshot: updatedTask },
          },
        ],
      }),
    });
    assert(fieldMerge.body.results[0].status === 'applied', 'stale different-field update should field-merge');
    assert(fieldMerge.body.results[0].task.title === 'Server renamed task', 'field merge should keep independently changed server title');
    assert(fieldMerge.body.results[0].task.priority === 3, 'field merge should keep independently changed server priority');
    assert(fieldMerge.body.results[0].task.completed === false, 'field merge should apply untouched completed field');

    const serverWins = await req(base, '/api/sync/operations', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({
        operations: [
          {
            clientOperationId: 'op-merge-server-wins',
            entityType: 'task',
            action: 'update',
            entityId: created.entityId,
            baseUpdatedAt: updatedTask.updatedAt,
            clientCreatedAt: '2000-01-01T00:00:00.000Z',
            payload: { title: 'Older offline title', baseSnapshot: updatedTask },
          },
        ],
      }),
    });
    assert(serverWins.body.results[0].status === 'applied', 'same-field server-win merge should be recorded as applied');
    assert(serverWins.body.results[0].task.title === 'Server renamed task', 'older stale same-field write should keep server value');

    const clientWins = await req(base, '/api/sync/operations', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({
        operations: [
          {
            clientOperationId: 'op-merge-client-wins',
            entityType: 'task',
            action: 'update',
            entityId: created.entityId,
            baseUpdatedAt: updatedTask.updatedAt,
            clientCreatedAt: '2999-01-01T00:00:00.000Z',
            payload: { title: 'Client newer title', baseSnapshot: updatedTask },
          },
        ],
      }),
    });
    assert(clientWins.body.results[0].status === 'applied', 'same-field client-win merge should apply');
    assert(clientWins.body.results[0].task.title === 'Client newer title', 'newer stale same-field write should win');

    const bobUpdate = await req(base, '/api/sync/operations', {
      method: 'POST',
      cookie: bob,
      body: JSON.stringify({
        operations: [
          {
            clientOperationId: 'op-bob-update',
            entityType: 'task',
            action: 'update',
            entityId: created.entityId,
            payload: { title: 'Bob tries Alice task' },
          },
        ],
      }),
    });
    assert(bobUpdate.body.results[0].status === 'failed' && bobUpdate.body.results[0].error.code === 'not_found', 'cross-account sync should fail as not_found');
    const bobStatus = await req(base, '/api/account/sync-status', { cookie: bob });
    assert(bobStatus.body.syncStatus.health === 'failed', 'Bob failed sync should report failed health');
    assert(bobStatus.body.syncStatus.lastOperation.error.code === 'not_found', 'Bob sync status should include last sync error code');

    const currentTask = (await req(base, `/api/tasks/${created.entityId}`, { cookie: alice })).body.task;
    const del = await req(base, '/api/sync/operations', {
      method: 'POST',
      cookie: alice,
      body: JSON.stringify({
        operations: [
          {
            clientOperationId: 'op-delete-1',
            entityType: 'task',
            action: 'delete',
            entityId: created.entityId,
            baseUpdatedAt: currentTask.updatedAt,
            payload: {},
          },
        ],
      }),
    });
    assert(del.body.results[0].status === 'applied' && del.body.results[0].task.deletedAt, 'sync delete should soft-delete task');
    const finalStatus = await req(base, '/api/account/sync-status', { cookie: alice });
    assert(finalStatus.body.syncStatus.health === 'synced', 'latest successful delete should report synced health');
    assert(finalStatus.body.syncStatus.pendingServerOperationCount === 1, 'unresolved conflict should remain in pending server count');
    assert(finalStatus.body.syncStatus.statusCounts.applied === 6, 'sync status should count applied operations');
    assert(finalStatus.body.syncStatus.statusCounts.conflict === 1, 'sync status should count conflict operations');

    const exported = (await req(base, '/api/settings/export', { cookie: alice })).body;
    assert(exported.syncOperations.some((op: any) => op.client_operation_id === 'op-create-1'), 'export should include sync operations');

    const db = new DatabaseSync(dbPath);
    try {
      const taskCount = db.prepare("SELECT COUNT(*) c FROM tasks WHERE title = 'Offline created task' OR title = 'Should not duplicate'").get() as { c: number };
      assert(taskCount.c === 0, 'duplicate create should not create extra stale-title rows');
      const updatedCount = db.prepare("SELECT COUNT(*) c FROM tasks WHERE title = 'Client newer title' AND deleted_at IS NOT NULL").get() as { c: number };
      assert(updatedCount.c === 1, 'merged task should exist and be soft-deleted');
      const applied = db.prepare("SELECT COUNT(*) c FROM sync_operations WHERE status = 'applied'").get() as { c: number };
      const conflicts = db.prepare("SELECT COUNT(*) c FROM sync_operations WHERE status = 'conflict'").get() as { c: number };
      const failed = db.prepare("SELECT COUNT(*) c FROM sync_operations WHERE status = 'failed'").get() as { c: number };
      const mergeRows = db.prepare("SELECT COUNT(*) c FROM sync_operations WHERE result_json LIKE '%field_merge_lww%'").get() as { c: number };
      assert(applied.c === 6, `expected six applied operations, got ${applied.c}`);
      assert(conflicts.c === 1, `expected one conflict operation, got ${conflicts.c}`);
      assert(failed.c === 1, `expected one failed operation, got ${failed.c}`);
      assert(mergeRows.c === 3, `expected three field-merge sync rows, got ${mergeRows.c}`);
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
