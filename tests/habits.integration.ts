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

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
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
  return {
    port,
    messages,
    close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())),
  };
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
      device: { deviceId: `habits-${email}`, deviceName: 'Habits integration test', platform: 'Web', appVersion: 'test' },
    }),
  });
  await json(loginRes);
  assert(loginRes.status === 201 || loginRes.status === 200, `login failed: ${loginRes.status}`);
  return cookiesFrom(loginRes);
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `habits-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'habits-token-secret',
    AUTH_IDENTIFIER_SECRET: 'habits-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const cookie = await login(base, 'habits-alice@example.com', smtp.messages);
    const bobCookie = await login(base, 'habits-bob@example.com', smtp.messages);
    const today = ymd(new Date());

    const created = await req(base, '/api/habits', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Read pages',
        targetType: 'count',
        targetValue: 10,
        targetUnit: 'pages',
        groupName: 'Study',
        reminderTime: '20:30',
        startDate: today,
        daysOfWeek: [new Date().getDay()],
      }),
    });
    assert(created.res.status === 201, `create habit failed: ${created.res.status}`);
    const habitId = created.body.habit.id;
    assert(created.body.habit.targetType === 'count', 'targetType did not round-trip');

    const check = await req(base, `/api/habits/${habitId}/toggle`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ date: today, value: 8, note: 'chapter 1' }),
    });
    assert(check.body.checked === true, 'habit checkin failed');

    const detail = await req(base, `/api/habits/${habitId}?from=${today}&to=${today}`, { cookie });
    assert(detail.body.habit.checkinDetails[0].value === 8, 'checkin value missing');
    assert(detail.body.habit.checkinDetails[0].note === 'chapter 1', 'checkin note missing');

    const stats = await req(base, `/api/habits/${habitId}/stats?from=${today}&to=${today}`, { cookie });
    assert(stats.body.stats.completedDays === 1, 'habit stats completedDays mismatch');
    assert(stats.body.stats.totalValue === 8, 'habit stats totalValue mismatch');

    const archive = await req(base, `/api/habits/${habitId}/archive`, { method: 'POST', cookie });
    assert(archive.body.habit.archived === true, 'archive did not mark habit archived');
    const list = await req(base, `/api/habits?from=${today}&to=${today}`, { cookie });
    assert(list.body.habits.length === 0, 'archived habit should not appear in active list');

    const bobDetail = await req(base, `/api/habits/${habitId}`, { cookie: bobCookie });
    assert(bobDetail.res.status === 404, `expected Bob habit read to be 404, got ${bobDetail.res.status}`);

    const db = new DatabaseSync(dbPath);
    try {
      const habit = db.prepare('SELECT target_type, target_value, target_unit, group_name, reminder_time, archived FROM habits WHERE id = ?').get(habitId) as any;
      const checkin = db.prepare('SELECT value, note FROM habit_checkins WHERE habit_id = ?').get(habitId) as any;
      assert(habit.target_type === 'count' && habit.target_value === 10 && habit.target_unit === 'pages', 'DB habit target mismatch');
      assert(habit.group_name === 'Study' && habit.reminder_time === '20:30' && habit.archived === 1, 'DB habit metadata mismatch');
      assert(checkin.value === 8 && checkin.note === 'chapter 1', 'DB checkin metadata mismatch');
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
