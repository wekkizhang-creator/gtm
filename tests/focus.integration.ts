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
  return loginCookie(base, email, smtpMessages);
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `focus-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'focus-token-secret',
    AUTH_IDENTIFIER_SECRET: 'focus-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const cookie = await login(base, 'focus-alice@example.com', smtp.messages);
    const bobCookie = await login(base, 'focus-bob@example.com', smtp.messages);

    const sounds = await req(base, '/api/focus/sounds', { cookie });
    assert(sounds.body.sounds.some((s: any) => s.id === 'rain'), 'seed background sound missing');
    const focusSettings = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        focus: {
          defaultMinutes: 35,
          restMinutes: 8,
          soundId: 'rain',
          defaultVolume: 65,
          pauseSoundOnPause: false,
          playSoundDuringRest: true,
          backgroundAudioAllowed: true,
          autoCacheSounds: true,
        },
      }),
    });
    assert(focusSettings.body.settings.focus.soundId === 'rain', 'focus default sound setting did not persist');
    assert(focusSettings.body.settings.focus.defaultVolume === 65, 'focus default volume setting did not persist');
    const cached = await req(base, '/api/focus/sounds/rain/cache', { method: 'POST', cookie });
    assert(cached.body.sound.cacheStatus === 'cached', 'sound cache status was not stored');
    const bobSounds = await req(base, '/api/focus/sounds', { cookie: bobCookie });
    assert(!bobSounds.body.sounds.find((s: any) => s.id === 'rain')?.cacheStatus, 'Bob should not see Alice sound cache');
    const list = await req(base, '/api/lists', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Deep Work', color: '#2f6fed' }),
    });
    assert(list.res.status === 201, `create focus list failed: ${list.res.status}`);
    const tag = await req(base, '/api/tags', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Writing', color: '#10b981' }),
    });
    assert(tag.res.status === 201, `create focus tag failed: ${tag.res.status}`);
    const linkedTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Draft PM-12 report',
        listId: list.body.list.id,
        tagIds: [tag.body.tag.id],
        priority: 2,
      }),
    });
    assert(linkedTask.res.status === 201, `create linked focus task failed: ${linkedTask.res.status}`);

    const endedAt = new Date().toISOString();
    const startedAt = new Date(Date.now() - 25 * 60_000).toISOString();
    const session = await req(base, '/api/focus/sessions', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        mode: 'pomodoro',
        startedAt,
        endedAt,
        durationSec: 1500,
        isPomodoro: true,
        isMuted: false,
      }),
    });
    assert(session.res.status === 201, `create focus session failed: ${session.res.status}`);
    assert(session.body.session.backgroundSoundName === 'Rain', 'focus session did not apply default sound');
    assert(session.body.session.backgroundVolume === 65, 'focus session did not apply default volume');
    assert(session.body.session.soundPlayedDuration === 1500, 'focus session did not default sound played duration');
    const linkedEndedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const linkedStartedAt = new Date(new Date(linkedEndedAt).getTime() - 15 * 60_000).toISOString();
    const linkedSession = await req(base, '/api/focus/sessions', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        taskId: linkedTask.body.task.id,
        mode: 'pomodoro',
        startedAt: linkedStartedAt,
        endedAt: linkedEndedAt,
        durationSec: 900,
        isPomodoro: true,
        isMuted: false,
      }),
    });
    assert(linkedSession.res.status === 201, `create linked focus session failed: ${linkedSession.res.status}`);

    const restStartedAt = endedAt;
    const restEndedAt = new Date(new Date(endedAt).getTime() + 8 * 60_000).toISOString();
    const nextFocusStartedAt = restEndedAt;
    const restCycle = await req(base, '/api/focus/rest-cycles', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        focusSessionId: session.body.session.id,
        restStartedAt,
        restEndedAt,
        restDurationSec: 8 * 60,
        nextFocusStartedAt,
      }),
    });
    assert(restCycle.res.status === 201, `create rest cycle failed: ${restCycle.res.status} ${JSON.stringify(restCycle.body)}`);
    assert(restCycle.body.restCycle.focusSessionId === session.body.session.id, 'rest cycle did not link to the focus session');
    assert(restCycle.body.restCycle.reminderStatus === 'created', 'rest cycle should create an in-app reminder');
    assert(restCycle.body.restCycle.notificationId, 'rest cycle notification id missing');
    const duplicateRestCycle = await req(base, '/api/focus/rest-cycles', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        focusSessionId: session.body.session.id,
        restStartedAt,
        restEndedAt,
        restDurationSec: 8 * 60,
        nextFocusStartedAt,
      }),
    });
    assert(duplicateRestCycle.body.restCycle.id === restCycle.body.restCycle.id, 'rest cycle create should be idempotent per focus session');
    const restCycles = await req(base, '/api/focus/rest-cycles', { cookie });
    assert(restCycles.body.restCycles.length === 1, 'rest cycle list should include the recorded cycle');
    const bobRest = await req(base, '/api/focus/rest-cycles', {
      method: 'POST',
      cookie: bobCookie,
      body: JSON.stringify({
        focusSessionId: session.body.session.id,
        restStartedAt,
        restEndedAt,
        restDurationSec: 60,
      }),
    });
    assert(bobRest.res.status === 404, `Bob should not create rest cycle for Alice session, got ${bobRest.res.status}`);
    const invalidRest = await req(base, '/api/focus/rest-cycles', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        focusSessionId: session.body.session.id,
        restStartedAt: restEndedAt,
        restEndedAt: restStartedAt,
        restDurationSec: 0,
      }),
    });
    assert(invalidRest.res.status === 400, `invalid rest cycle should be 400, got ${invalidRest.res.status}`);
    const notifications = await req(base, '/api/notifications', { cookie });
    assert(
      notifications.body.notifications.some((item: any) => item.type === 'focus_rest_complete' && item.targetId === restCycle.body.restCycle.id),
      'rest completion reminder notification was not created',
    );

    const report = await req(base, '/api/focus/reports?range=week', { cookie });
    assert(report.body.report.totalCount === 2, `expected two report sessions, got ${report.body.report.totalCount}`);
    assert(report.body.report.totalDurationSec === 2400, 'report duration mismatch');
    assert(
      report.body.report.byTask.some((item: any) => item.id === linkedTask.body.task.id && item.name === 'Draft PM-12 report' && item.count === 1 && item.durationSec === 900),
      'focus report did not aggregate by linked task',
    );
    assert(
      report.body.report.byTask.some((item: any) => item.id == null && item.name === '未关联任务' && item.count === 1 && item.durationSec === 1500),
      'focus report did not include unlinked task bucket',
    );
    assert(
      report.body.report.byList.some((item: any) => item.id === list.body.list.id && item.name === 'Deep Work' && item.durationSec === 900),
      'focus report did not aggregate by list',
    );
    assert(
      report.body.report.byTag.some((item: any) => item.id === tag.body.tag.id && item.name === 'Writing' && item.durationSec === 900),
      'focus report did not aggregate by tag',
    );
    assert(
      report.body.report.byTag.some((item: any) => item.id == null && item.name === '未标记' && item.durationSec === 1500),
      'focus report did not include untagged bucket',
    );
    const achievements = await req(base, '/api/focus/achievements', { cookie });
    const byAchievement = new Map(achievements.body.achievements.map((item: any) => [item.id, item]));
    assert(byAchievement.get('first_pomodoro')?.achieved === true, 'first pomodoro achievement should be achieved');
    assert(byAchievement.get('first_pomodoro')?.achievedAt, 'first pomodoro achievement should include achievedAt');
    assert(byAchievement.get('five_pomodoros')?.progress === 2, 'five-pomodoro achievement should report current progress');
    assert(byAchievement.get('five_pomodoros')?.achieved === false, 'five-pomodoro achievement should still be locked');
    assert(byAchievement.get('focus_one_hour')?.progress === 2400, 'one-hour focus achievement should use total focus duration');
    assert(byAchievement.get('daily_three_pomodoros')?.progress === 2, 'daily achievement should use same-day pomodoro count');

    const exportA = await req(base, '/api/settings/export', { cookie });
    assert(exportA.body.userSoundCache.length === 1, 'export should include sound cache');
    assert(exportA.body.focusRestCycles.length === 1, 'export should include focus rest cycles');

    const delCache = await req(base, '/api/focus/sounds/rain/cache', { method: 'DELETE', cookie });
    assert(delCache.res.status === 204, `delete cached sound failed: ${delCache.res.status}`);

    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare('SELECT background_sound_id, background_volume, sound_played_duration FROM focus_sessions WHERE id = ?').get(session.body.session.id) as {
        background_sound_id: string;
        background_volume: number;
        sound_played_duration: number;
      };
      assert(row.background_sound_id === 'rain', 'DB background_sound_id mismatch');
      assert(row.background_volume === 65, 'DB background_volume mismatch');
      assert(row.sound_played_duration === 1500, 'DB sound_played_duration mismatch');
      const focusRows = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(duration_sec), 0) AS duration FROM focus_sessions').get() as { count: number; duration: number };
      assert(focusRows.count === 2 && focusRows.duration === 2400, 'DB focus rows should back achievement progress');
      const linkedRow = db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM focus_sessions f
           JOIN tasks t ON t.user_id = f.user_id AND t.id = f.task_id
           JOIN task_tags tt ON tt.user_id = t.user_id AND tt.task_id = t.id
           WHERE f.task_id = ? AND t.list_id = ? AND tt.tag_id = ?`,
        )
        .get(linkedTask.body.task.id, list.body.list.id, tag.body.tag.id) as { count: number };
      assert(linkedRow.count === 1, 'DB linked focus report source rows missing');
      const cycleRow = db.prepare('SELECT rest_duration_sec, next_focus_started_at, notification_id FROM focus_rest_cycles').get() as {
        rest_duration_sec: number;
        next_focus_started_at: string | null;
        notification_id: string | null;
      };
      assert(cycleRow.rest_duration_sec === 480, 'DB rest duration mismatch');
      assert(cycleRow.next_focus_started_at === nextFocusStartedAt, 'DB next focus timestamp mismatch');
      assert(cycleRow.notification_id, 'DB rest cycle notification id missing');
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
