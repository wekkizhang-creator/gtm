import { loginCookie } from './auth-test-helper';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event-1@example.com
SUMMARY:External Planning
DTSTART:20300102T090000Z
DTEND:20300102T100000Z
END:VEVENT
END:VCALENDAR`;
const systemIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:system-event-1@example.com
SUMMARY:System Standup
DTSTART:20300104T090000Z
DTEND:20300104T093000Z
END:VEVENT
END:VCALENDAR`;

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
  const dbPath = resolve(root, 'server', 'data', `calendar-test-${Date.now()}.db`);
  const systemIcsPath = resolve(root, 'server', 'data', `system-calendar-${Date.now()}.ics`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'calendar-token-secret',
    AUTH_IDENTIFIER_SECRET: 'calendar-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const cookie = await login(base, 'calendar-alice@example.com', smtp.messages);
    const bobCookie = await login(base, 'calendar-bob@example.com', smtp.messages);
    const blankSelectStart = '2030-01-02T09:15:00.000Z';
    const blankSelectDue = '2030-01-02T10:45:00.000Z';
    const blankSelectTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Blank selected calendar task',
        startDate: blankSelectStart,
        dueDate: blankSelectDue,
        isAllDay: false,
      }),
    });
    assert(blankSelectTask.res.status === 201, `blank-selection task create failed: ${blankSelectTask.res.status}`);
    assert(blankSelectTask.body.task.startDate === blankSelectStart, 'blank-selection task start did not persist');
    assert(blankSelectTask.body.task.dueDate === blankSelectDue, 'blank-selection task due did not persist');
    const blankSelectRange = await req(base, '/api/tasks?from=2030-01-02T00:00:00.000Z&to=2030-01-02T23:59:59.999Z', { cookie });
    assert(
      blankSelectRange.body.tasks.some((task: any) => task.id === blankSelectTask.body.task.id && task.isAllDay === false),
      'blank-selection task was not returned by calendar range query',
    );
    const crossDayStart = '2030-01-02T23:30:00.000Z';
    const crossDayDue = '2030-01-03T01:30:00.000Z';
    const crossDayTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Cross-day calendar task',
        startDate: crossDayStart,
        dueDate: crossDayDue,
        isAllDay: false,
      }),
    });
    assert(crossDayTask.res.status === 201, `cross-day task create failed: ${crossDayTask.res.status}`);
    const overlapA = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Overlap A',
        startDate: '2030-01-02T09:00:00.000Z',
        dueDate: '2030-01-02T10:00:00.000Z',
        isAllDay: false,
      }),
    });
    const overlapB = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Overlap B',
        startDate: '2030-01-02T09:30:00.000Z',
        dueDate: '2030-01-02T10:30:00.000Z',
        isAllDay: false,
      }),
    });
    assert(overlapA.res.status === 201 && overlapB.res.status === 201, 'overlap task creation failed');
    const crossDayRange = await req(base, '/api/tasks?from=2030-01-03T00:00:00.000Z&to=2030-01-03T23:59:59.999Z', { cookie });
    assert(
      crossDayRange.body.tasks.some((task: any) => task.id === crossDayTask.body.task.id),
      'cross-day task was not returned by the second-day calendar range query',
    );
    const overlapRange = await req(base, '/api/tasks?from=2030-01-02T00:00:00.000Z&to=2030-01-02T23:59:59.999Z', { cookie });
    assert(
      overlapRange.body.tasks.some((task: any) => task.id === overlapA.body.task.id) &&
        overlapRange.body.tasks.some((task: any) => task.id === overlapB.body.task.id),
      'overlapping tasks were not returned by the calendar range query',
    );
    const rootTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: '年度学习' }),
    });
    const parentTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: '学习 AI Agent', parentId: rootTask.body.task.id }),
    });
    const subtaskBlock = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: '阅读第 1 章',
        parentId: parentTask.body.task.id,
        startDate: '2030-01-02T13:00:00.000Z',
        dueDate: '2030-01-02T14:00:00.000Z',
        isAllDay: false,
      }),
    });
    assert(subtaskBlock.res.status === 201, `subtask calendar block create failed: ${subtaskBlock.res.status}`);
    const subtaskRange = await req(base, '/api/tasks?from=2030-01-02T00:00:00.000Z&to=2030-01-02T23:59:59.999Z', { cookie });
    const rangedSubtask = subtaskRange.body.tasks.find((task: any) => task.id === subtaskBlock.body.task.id);
    assert(rangedSubtask, 'scheduled subtask was not returned by the calendar range query');
    assert(rangedSubtask.parentTitle === '学习 AI Agent', 'scheduled subtask did not include direct parent title');
    assert(
      Array.isArray(rangedSubtask.hierarchyPath) && rangedSubtask.hierarchyPath.join(' / ') === '年度学习 / 学习 AI Agent / 阅读第 1 章',
      'scheduled subtask did not include full hierarchy path',
    );
    const initialSystemPermission = await req(base, '/api/calendar/system-permission', { cookie });
    assert(initialSystemPermission.res.status === 200, `system calendar permission should be 200, got ${initialSystemPermission.res.status}`);
    assert(initialSystemPermission.body.permission.status === 'unknown', 'initial system calendar permission should be unknown');

    const invalidSystemPermission = await req(base, '/api/calendar/system-permission', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ status: 'maybe', promptReason: 'system_calendar_subscription' }),
    });
    assert(invalidSystemPermission.res.status === 400, `invalid system calendar permission should be 400, got ${invalidSystemPermission.res.status}`);

    const unsupportedSystemPermission = await req(base, '/api/calendar/system-permission', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ status: 'unsupported', promptReason: 'system_calendar_subscription' }),
    });
    assert(unsupportedSystemPermission.body.permission.status === 'unsupported', 'unsupported system calendar permission did not persist');
    assert(unsupportedSystemPermission.body.permission.guidance === 'unsupported', 'unsupported system calendar permission should report unsupported guidance');

    const systemWithoutPermission = await req(base, '/api/calendar/system-subscription', {
      method: 'POST',
      cookie: bobCookie,
      body: JSON.stringify({ name: 'Bob system calendar' }),
    });
    assert(systemWithoutPermission.res.status === 403, `system calendar without permission should be 403, got ${systemWithoutPermission.res.status}`);

    const grantedSystemPermission = await req(base, '/api/calendar/system-permission', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ status: 'granted', promptReason: 'system_calendar_subscription' }),
    });
    assert(grantedSystemPermission.body.permission.status === 'granted', 'granted system calendar permission did not persist');

    const systemCreate = await req(base, '/api/calendar/system-subscription', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Alice system calendar' }),
    });
    assert(systemCreate.res.status === 501, `system calendar without provider should be 501, got ${systemCreate.res.status}`);

    writeFileSync(systemIcsPath, systemIcs, 'utf8');
    process.env.SYSTEM_CALENDAR_ICS_FILE = systemIcsPath;
    const systemCreateWithProvider = await req(base, '/api/calendar/system-subscription', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Alice system calendar', color: '#2f9e6f' }),
    });
    assert(systemCreateWithProvider.res.status === 201, `system calendar with provider should be 201, got ${systemCreateWithProvider.res.status}`);
    assert(systemCreateWithProvider.body.subscription.type === 'system', 'system provider should create a system subscription');
    assert(systemCreateWithProvider.body.events.length === 1, 'system provider should sync one event on create');
    assert(systemCreateWithProvider.body.events[0].title === 'System Standup', 'system provider should sync the configured ICS event');
    const systemSubId = systemCreateWithProvider.body.subscription.id;
    const systemEvents = await req(base, '/api/calendar/events?from=2030-01-04T00:00:00.000Z&to=2030-01-05T00:00:00.000Z', { cookie });
    assert(systemEvents.body.events.length === 1 && systemEvents.body.events[0].title === 'System Standup', 'system calendar event should be queryable');
    const systemSourcePatch = await req(base, `/api/calendar/subscriptions/${systemSubId}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ type: 'ics', url: 'https://example.com/fake.ics' }),
    });
    assert(systemSourcePatch.res.status === 400, `system calendar source patch should be 400, got ${systemSourcePatch.res.status}`);

    const genericSystemCreate = await req(base, '/api/calendar/subscriptions', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Generic system calendar', type: 'system' }),
    });
    assert(genericSystemCreate.res.status === 501, `generic system subscription should be 501 without provider, got ${genericSystemCreate.res.status}`);

    const sub = await req(base, '/api/calendar/subscriptions', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Work ICS', type: 'ics', color: '#4a8cf0' }),
    });
    assert(sub.res.status === 201, `create subscription failed: ${sub.res.status}`);
    const subId = sub.body.subscription.id;
    const sync = await req(base, `/api/calendar/subscriptions/${subId}/sync`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ icsText: ics }),
    });
    assert(sync.body.events.length === 1, 'sync should create one event');
    const eventId = sync.body.events[0].id;
    const events = await req(base, '/api/calendar/events?from=2030-01-01T00:00:00.000Z&to=2030-01-03T00:00:00.000Z', { cookie });
    assert(events.body.events.length === 1 && events.body.events[0].title === 'External Planning', 'range query did not return ICS event');
    const dayInfo = await req(base, '/api/calendar/day-info?from=2026-02-14T00:00:00.000Z&to=2026-02-23T23:59:59.999Z', { cookie });
    const byDate = new Map(dayInfo.body.days.map((d: any) => [d.date, d]));
    assert(byDate.get('2026-02-14')?.isAdjustedWorkday === true, 'Spring Festival adjusted workday missing');
    assert(byDate.get('2026-02-14')?.isOffDay === false, 'adjusted workday should not be an off day');
    assert(byDate.get('2026-02-15')?.holidayName === '春节', 'Spring Festival holiday missing');
    assert(byDate.get('2026-02-15')?.isOffDay === true, 'Spring Festival date should be an off day');
    assert(byDate.get('2026-02-17')?.lunarLabel === '正月', 'lunar new year label should be 正月');
    const taskPatch = await req(base, `/api/tasks/${eventId}`, { method: 'PATCH', cookie, body: JSON.stringify({ title: 'mutate external' }) });
    assert(taskPatch.res.status === 404, `external event should not be editable as task, got ${taskPatch.res.status}`);
    const bobEvents = await req(base, '/api/calendar/events?from=2030-01-01T00:00:00.000Z&to=2030-01-03T00:00:00.000Z', { cookie: bobCookie });
    assert(bobEvents.body.events.length === 0, 'Bob should not see Alice external events');
    const exportA = await req(base, '/api/settings/export', { cookie });
    assert(exportA.body.calendarPermissions.length === 1, 'export should include Alice calendar permission state');
    const db = new DatabaseSync(dbPath);
    try {
      const subCount = db.prepare('SELECT COUNT(*) c FROM calendar_subscriptions').get() as { c: number };
      const evCount = db.prepare('SELECT COUNT(*) c FROM external_calendar_events').get() as { c: number };
      const systemSubCount = db.prepare("SELECT COUNT(*) c FROM calendar_subscriptions WHERE type = 'system'").get() as { c: number };
      const blankTaskRow = db.prepare('SELECT start_date, due_date, is_all_day FROM tasks WHERE id = ?').get(blankSelectTask.body.task.id) as
        | { start_date: string; due_date: string; is_all_day: number }
        | undefined;
      const crossDayRow = db.prepare('SELECT start_date, due_date, is_all_day FROM tasks WHERE id = ?').get(crossDayTask.body.task.id) as
        | { start_date: string; due_date: string; is_all_day: number }
        | undefined;
      const overlapCount = db.prepare('SELECT COUNT(*) c FROM tasks WHERE id IN (?, ?) AND is_all_day = 0').get(overlapA.body.task.id, overlapB.body.task.id) as {
        c: number;
      };
      const subtaskRow = db.prepare('SELECT parent_id, start_date, due_date, is_all_day FROM tasks WHERE id = ?').get(subtaskBlock.body.task.id) as
        | { parent_id: string; start_date: string; due_date: string; is_all_day: number }
        | undefined;
      const permissionRow = db
        .prepare("SELECT status, prompt_reason FROM calendar_permissions WHERE permission = 'system-calendar-readonly'")
        .get() as { status: string; prompt_reason: string | null };
      assert(subCount.c === 2, `expected two subscriptions, got ${subCount.c}`);
      assert(systemSubCount.c === 1, `expected one system subscription, got ${systemSubCount.c}`);
      assert(evCount.c === 2, `expected two external events, got ${evCount.c}`);
      assert(blankTaskRow?.start_date === blankSelectStart && blankTaskRow.due_date === blankSelectDue, 'DB blank-selection task time range mismatch');
      assert(blankTaskRow.is_all_day === 0, 'DB blank-selection task should be timed');
      assert(crossDayRow?.start_date === crossDayStart && crossDayRow.due_date === crossDayDue, 'DB cross-day task time range mismatch');
      assert(crossDayRow.is_all_day === 0, 'DB cross-day task should be timed');
      assert(overlapCount.c === 2, 'DB overlapping timed task rows missing');
      assert(subtaskRow?.parent_id === parentTask.body.task.id, 'DB scheduled subtask parent mismatch');
      assert(subtaskRow.start_date === '2030-01-02T13:00:00.000Z' && subtaskRow.due_date === '2030-01-02T14:00:00.000Z', 'DB scheduled subtask time mismatch');
      assert(subtaskRow.is_all_day === 0, 'DB scheduled subtask should be timed');
      assert(permissionRow.status === 'granted', `expected system calendar permission granted, got ${permissionRow.status}`);
      assert(permissionRow.prompt_reason === 'system_calendar_subscription', 'system calendar prompt reason should persist');
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
    if (existsSync(systemIcsPath)) unlinkSync(systemIcsPath);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
