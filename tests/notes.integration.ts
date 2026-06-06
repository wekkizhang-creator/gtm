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

async function login(base: string, email: string, smtpMessages: string[]): Promise<string> {
  return loginCookie(base, email, smtpMessages);
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `notes-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'notes-token-secret',
    AUTH_IDENTIFIER_SECRET: 'notes-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const cookie = await login(base, 'notes-alice@example.com', smtp.messages);
    const bobCookie = await login(base, 'notes-bob@example.com', smtp.messages);

    const noteSettings = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        notes: {
          defaultColor: '#d7ecff',
          defaultOpacity: 72,
          defaultFontSize: 'xlarge',
          defaultPinned: true,
          defaultPosition: { x: 65, y: 75, width: 420, height: 280 },
        },
      }),
    });
    assert(noteSettings.body.settings.notes.defaultColor === '#d7ecff', 'note default color setting did not persist');
    assert(noteSettings.body.settings.notes.defaultOpacity === 72, 'note default opacity setting did not persist');

    const task = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Review PRD notes', note: 'Extract assumptions into a sticky note' }),
    });
    assert(task.res.status === 201, `task create failed: ${task.res.status}`);

    const fromTask = await req(base, '/api/notes/from-task', { method: 'POST', cookie, body: JSON.stringify({ taskId: task.body.task.id }) });
    assert(fromTask.res.status === 201, `create note from task failed: ${fromTask.res.status}`);
    assert(fromTask.body.note.taskId === task.body.task.id, 'note should link to the task');
    assert(fromTask.body.note.color === '#d7ecff', 'note from task should use default color setting');
    assert(fromTask.body.note.opacity === 72, 'note from task should use default opacity setting');
    assert(fromTask.body.note.fontSize === 'xlarge', 'note from task should use default font size setting');
    assert(fromTask.body.note.pinned === true, 'note from task should use default pinned setting');
    assert(fromTask.body.note.position.width === 420, 'note from task should use default width setting');

    const patched = await req(base, `/api/notes/${fromTask.body.note.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ color: '#d8f5d0', opacity: 80, fontSize: 'large', position: { x: 80, y: 90, width: 360, height: 260 } }),
    });
    assert(patched.body.note.opacity === 80, 'note opacity patch did not persist');
    assert(patched.body.note.position.width === 360, 'note position patch did not persist');

    const standalone = await req(base, '/api/notes', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Call supplier', body: 'Call supplier\nConfirm delivery window' }),
    });
    assert(standalone.res.status === 201, `create standalone note failed: ${standalone.res.status}`);
    assert(standalone.body.note.color === '#d7ecff', 'standalone note should use default color setting');
    assert(standalone.body.note.pinned === true, 'standalone note should use default pinned setting');

    const converted = await req(base, `/api/notes/${standalone.body.note.id}/convert-to-task`, { method: 'POST', cookie });
    assert(converted.res.status === 201, `convert note failed: ${converted.res.status}`);
    assert(converted.body.task.source === 'note', 'converted task should carry source=note');
    assert(converted.body.note.taskId === converted.body.task.id, 'converted note should link to created task');

    const list = await req(base, '/api/notes', { cookie });
    assert(list.body.notes.length === 2, `expected two notes, got ${list.body.notes.length}`);

    const bobPatch = await req(base, `/api/notes/${standalone.body.note.id}`, {
      method: 'PATCH',
      cookie: bobCookie,
      body: JSON.stringify({ title: 'Bob edit' }),
    });
    assert(bobPatch.res.status === 404, `Bob should not edit Alice note, got ${bobPatch.res.status}`);

    const deleted = await req(base, `/api/notes/${fromTask.body.note.id}`, { method: 'DELETE', cookie });
    assert(deleted.res.status === 204, `delete note failed: ${deleted.res.status}`);
    const activeList = await req(base, '/api/notes', { cookie });
    assert(activeList.body.notes.length === 1, 'deleted note should be hidden from active list');
    const restored = await req(base, `/api/notes/${fromTask.body.note.id}/restore`, { method: 'POST', cookie });
    assert(restored.body.note.deletedAt === null, 'restored note should be active');

    const exported = await req(base, '/api/settings/export', { cookie });
    assert(exported.body.stickyNotes.length === 2, 'export should include sticky notes');

    const db = new DatabaseSync(dbPath);
    try {
      const noteCount = db.prepare('SELECT COUNT(*) c FROM sticky_notes').get() as { c: number };
      const noteTask = db.prepare('SELECT task_id, opacity, font_size FROM sticky_notes WHERE id = ?').get(fromTask.body.note.id) as {
        task_id: string | null;
        opacity: number;
        font_size: string;
      };
      const convertedTask = db.prepare("SELECT COUNT(*) c FROM tasks WHERE source = 'note'").get() as { c: number };
      const defaultStyled = db
        .prepare("SELECT COUNT(*) c FROM sticky_notes WHERE color = '#d7ecff' AND pinned = 1")
        .get() as { c: number };
      const pinnedNotes = db.prepare('SELECT COUNT(*) c FROM sticky_notes WHERE pinned = 1').get() as { c: number };
      assert(noteCount.c === 2, `expected 2 sticky_notes rows, got ${noteCount.c}`);
      assert(noteTask.task_id === task.body.task.id && noteTask.opacity === 80 && noteTask.font_size === 'large', 'note row mismatch');
      assert(convertedTask.c === 1, `expected one task converted from note, got ${convertedTask.c}`);
      assert(defaultStyled.c === 1, `expected the unpatched note to keep default styling, got ${defaultStyled.c}`);
      assert(pinnedNotes.c === 2, `expected two default-pinned sticky notes, got ${pinnedNotes.c}`);
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
