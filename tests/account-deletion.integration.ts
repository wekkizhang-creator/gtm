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

async function requestCode(base: string, email: string, purpose: string, smtpMessages: string[]): Promise<{ challengeId: string; code: string }> {
  const start = smtpMessages.length;
  const challenge = await req(base, '/api/auth/verification-codes', {
    method: 'POST',
    body: JSON.stringify({ type: 'email', identifier: email, purpose }),
  });
  assert(challenge.res.status === 201, `verification code failed: ${challenge.res.status} ${JSON.stringify(challenge.body)}`);
  for (let i = 0; i < 20 && smtpMessages.length === start; i++) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const code = (smtpMessages.at(-1) ?? '').match(/\b\d{6}\b/)?.[0];
  assert(code, 'SMTP message did not include a code');
  return { challengeId: challenge.body.challengeId, code };
}

async function login(base: string, email: string, smtpMessages: string[]): Promise<string> {
  return loginCookie(base, email, smtpMessages);
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `account-delete-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'account-delete-token-secret',
    AUTH_IDENTIFIER_SECRET: 'account-delete-identifier-secret',
    ACCOUNT_DELETION_RUNNER_TOKEN: 'runner-secret',
    ACCOUNT_REREGISTRATION_POLICY: 'block',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const email = 'delete-alice@example.com';
    const cookie = await login(base, email, smtp.messages);
    await req(base, '/api/tasks', { method: 'POST', cookie, body: JSON.stringify({ title: 'Delete me task' }) });
    await req(base, '/api/notes', { method: 'POST', cookie, body: JSON.stringify({ title: 'Delete me note' }) });
    const preview = await req(base, '/api/account/deletion/preview', { cookie });
    assert(preview.body.coolingDays === 7, 'deletion preview should expose 7 cooling days');
    assert(preview.body.deletionImpact.tasks >= 1, 'preview should count tasks');
    assert(preview.body.deletionImpact.notes >= 1, 'preview should count notes');

    const missingVerify = await req(base, '/api/account/deletion/request', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ confirmText: 'DELETE', exportAcknowledged: true }),
    });
    assert(missingVerify.res.status === 400, `missing verification should fail, got ${missingVerify.res.status}`);

    const wrongIdentity = await requestCode(base, 'other-delete@example.com', 'account_delete', smtp.messages);
    const mismatch = await req(base, '/api/account/deletion/request', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ ...wrongIdentity, confirmText: 'DELETE', exportAcknowledged: true }),
    });
    assert(mismatch.res.status === 403, `identity mismatch should be 403, got ${mismatch.res.status}`);

    const deletionCode = await requestCode(base, email, 'account_delete', smtp.messages);
    const requested = await req(base, '/api/account/deletion/request', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ ...deletionCode, confirmText: 'DELETE', exportAcknowledged: true }),
    });
    assert(requested.res.status === 200, `deletion request failed: ${requested.res.status}`);
    assert(requested.body.user.status === 'deleting', 'user should enter deleting status');
    assert(requested.body.deleteScheduledAt, 'scheduled delete time missing');
    const oldSession = await req(base, '/api/account', { cookie });
    assert(oldSession.res.status === 401, `old session should be revoked, got ${oldSession.res.status}`);

    const reloginCookie = await login(base, email, smtp.messages);
    const pending = await req(base, '/api/account', { cookie: reloginCookie });
    assert(pending.body.user.status === 'deleting', 'login during cooling period should keep the account in deleting status');
    assert(pending.body.user.deleteScheduledAt, 'deleting account should keep scheduled delete time');
    const blockedTaskCreate = await req(base, '/api/tasks', {
      method: 'POST',
      cookie: reloginCookie,
      body: JSON.stringify({ title: 'Should stay blocked while deleting' }),
    });
    assert(blockedTaskCreate.res.status === 423, `deleting account should not create business data, got ${blockedTaskCreate.res.status}`);

    const cancelled = await req(base, '/api/account/deletion/cancel', { method: 'POST', cookie: reloginCookie });
    assert(cancelled.res.status === 200, `cancel deletion failed: ${cancelled.res.status}`);
    assert(cancelled.body.user.status === 'normal', 'explicit cancel should restore account status');
    assert(cancelled.body.user.deleteScheduledAt === null, 'cancelled account should clear scheduled delete time');

    const restored = await req(base, '/api/account', { cookie: reloginCookie });
    assert(restored.body.user.status === 'normal', 'cancelled deleting account should stay normal');

    const secondCode = await requestCode(base, email, 'account_delete', smtp.messages);
    const requestedAgain = await req(base, '/api/account/deletion/request', {
      method: 'POST',
      cookie: reloginCookie,
      body: JSON.stringify({ ...secondCode, confirmText: 'DELETE', exportAcknowledged: true }),
    });
    assert(requestedAgain.body.user.status === 'deleting', 'second deletion request should enter deleting status');

    const runnerDenied = await req(base, '/api/account/deletion/finalize-due', {
      method: 'POST',
      headers: { 'x-runner-token': 'bad' },
      body: JSON.stringify({ now: '2999-01-01T00:00:00.000Z' }),
    });
    assert(runnerDenied.res.status === 403, `bad runner token should be 403, got ${runnerDenied.res.status}`);

    const finalized = await req(base, '/api/account/deletion/finalize-due', {
      method: 'POST',
      headers: { 'x-runner-token': 'runner-secret' },
      body: JSON.stringify({ now: '2999-01-01T00:00:00.000Z' }),
    });
    assert(finalized.body.finalized === 1, `expected one finalized account, got ${finalized.body.finalized}`);

    const blockedReRegistration = await req(base, '/api/auth/register/start', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    assert(
      blockedReRegistration.res.status === 423 && blockedReRegistration.body.error.code === 'identity_re_registration_blocked',
      `blocked re-registration should be 423 identity_re_registration_blocked, got ${blockedReRegistration.res.status}`,
    );

    const db = new DatabaseSync(dbPath);
    try {
      const oldUser = db.prepare("SELECT status, email_masked FROM users WHERE status = 'deleted'").get() as
        | { status: string; email_masked: string | null }
        | undefined;
      const tasks = db.prepare('SELECT COUNT(*) c FROM tasks').get() as { c: number };
      const notes = db.prepare('SELECT COUNT(*) c FROM sticky_notes').get() as { c: number };
      const identities = db.prepare('SELECT COUNT(*) c FROM auth_identities').get() as { c: number };
      const reservations = db.prepare('SELECT COUNT(*) c FROM deleted_identity_reservations WHERE type = ?').get('email') as { c: number };
      assert(oldUser?.status === 'deleted' && oldUser.email_masked === null, 'deleted user should be anonymized');
      assert(tasks.c === 0, `expected tasks deleted, got ${tasks.c}`);
      assert(notes.c === 0, `expected notes deleted, got ${notes.c}`);
      assert(identities.c === 0, `expected identities deleted, got ${identities.c}`);
      assert(reservations.c === 1, `expected one deleted identity reservation, got ${reservations.c}`);
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
