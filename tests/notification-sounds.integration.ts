import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, rmSync, unlinkSync } from 'node:fs';
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
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      server.close(() => resolvePromise(typeof addr === 'object' && addr ? addr.port : 0));
    });
    server.on('error', reject);
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
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
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
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function req(base: string, path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const res = await fetch(`${base}${path}`, { ...init, headers });
  return { res, body: await json(res) };
}

function latestCode(messages: string[]): string {
  const message = messages.at(-1) ?? '';
  const match = message.match(/\b(\d{6})\b/);
  assert(match, `verification code not found in SMTP message: ${message}`);
  return match[1];
}

async function login(base: string, email: string, messages: string[]): Promise<string> {
  const codeStart = messages.length;
  const challenge = await req(base, '/api/auth/verification-codes', {
    method: 'POST',
    body: JSON.stringify({ type: 'email', identifier: email, purpose: 'login' }),
  });
  assert(challenge.res.status === 201, `verification code failed: ${challenge.res.status} ${JSON.stringify(challenge.body)}`);
  for (let i = 0; i < 20 && messages.length === codeStart; i++) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const complete = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.body.challengeId,
      code: latestCode(messages),
      agreedToTerms: true,
      device: { deviceId: `sound-${email}`, deviceName: 'Sound test', platform: 'Web' },
    }),
  });
  const body = await json(complete);
  assert(complete.status === 201 || complete.status === 200, `login failed: ${complete.status} ${JSON.stringify(body)}`);
  return cookiesFrom(complete);
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dbPath = resolve(root, 'server', 'data', `notification-sounds-test-${Date.now()}.db`);
  const soundDir = resolve(root, 'server', 'data', `notification-sounds-test-${Date.now()}`);
  const smtp = await startSmtp();
  Object.assign(process.env, {
    DB_PATH: dbPath,
    NOTIFICATION_SOUNDS_DIR: soundDir,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'notification-sounds-token-secret',
    AUTH_IDENTIFIER_SECRET: 'notification-sounds-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const instance = mod.app.listen(port, '127.0.0.1', () => resolvePromise(instance));
  });
  try {
    await waitForHealth(base);
    const cookie = await login(base, 'sound-alice@example.com', smtp.messages);
    const bobCookie = await login(base, 'sound-bob@example.com', smtp.messages);
    const bytes = Buffer.from('UklGRgQAAABXQVZF', 'base64');

    const invalidMime = await req(base, '/api/notification-sounds', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'not-a-sound.txt', purpose: 'reminder', mimeType: 'text/plain', contentBase64: bytes.toString('base64') }),
    });
    assert(invalidMime.res.status === 400, `invalid mime should be 400, got ${invalidMime.res.status}`);

    const reminder = await req(base, '/api/notification-sounds', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'custom-reminder.wav', purpose: 'reminder', mimeType: 'audio/wav', contentBase64: bytes.toString('base64') }),
    });
    assert(reminder.res.status === 201, `reminder sound upload should be 201, got ${reminder.res.status}`);
    const completion = await req(base, '/api/notification-sounds', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'custom-complete.ogg', purpose: 'completion', mimeType: 'audio/ogg', contentBase64: bytes.toString('base64') }),
    });
    assert(completion.res.status === 201, `completion sound upload should be 201, got ${completion.res.status}`);

    const list = await req(base, '/api/notification-sounds', { cookie });
    assert(list.body.sounds.length === 2, `expected two notification sounds, got ${list.body.sounds.length}`);
    const reminderList = await req(base, '/api/notification-sounds?purpose=reminder', { cookie });
    assert(reminderList.body.sounds.length === 1 && reminderList.body.sounds[0].id === reminder.body.sound.id, 'purpose-filtered reminder sounds mismatch');

    const missingCustomId = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie: bobCookie,
      body: JSON.stringify({ notifications: { completionSound: 'custom' } }),
    });
    assert(missingCustomId.res.status === 400, `custom completion sound without id should be 400, got ${missingCustomId.res.status}`);
    const bobCannotReferenceAlice = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie: bobCookie,
      body: JSON.stringify({ notifications: { reminderSound: 'custom', reminderSoundId: reminder.body.sound.id } }),
    });
    assert(bobCannotReferenceAlice.res.status === 400, `cross-account sound reference should be 400, got ${bobCannotReferenceAlice.res.status}`);

    const settings = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        notifications: {
          reminderSound: 'custom',
          reminderSoundId: reminder.body.sound.id,
          completionSound: 'custom',
          completionSoundId: completion.body.sound.id,
        },
      }),
    });
    assert(settings.body.settings.notifications.reminderSoundId === reminder.body.sound.id, 'custom reminder sound id did not persist');
    assert(settings.body.settings.notifications.completionSoundId === completion.body.sound.id, 'custom completion sound id did not persist');

    const download = await fetch(`${base}${reminder.body.sound.downloadUrl}`, { headers: { Cookie: cookie } });
    assert(download.status === 200, `download should be 200, got ${download.status}`);
    assert(Buffer.from(await download.arrayBuffer()).length === bytes.length, 'downloaded sound byte size mismatch');
    const bobDownload = await fetch(`${base}${reminder.body.sound.downloadUrl}`, { headers: { Cookie: bobCookie } });
    assert(bobDownload.status === 404, `Bob download should be 404, got ${bobDownload.status}`);

    const exportA = await req(base, '/api/settings/export', { cookie });
    assert(exportA.body.notificationSounds.length === 2, 'export should include notification sound metadata');

    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare('SELECT id, storage_path FROM notification_sounds ORDER BY created_at ASC').all() as Array<{ id: string; storage_path: string }>;
      assert(rows.length === 2, `expected two notification_sounds rows, got ${rows.length}`);
      assert(rows.every((row) => existsSync(row.storage_path)), 'notification sound file was not written to disk');
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
    if (existsSync(soundDir)) rmSync(soundDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
