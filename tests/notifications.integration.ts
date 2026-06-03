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
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    throw new Error(`invalid JSON ${res.status}: ${body}`);
  }
}

async function req(base: string, path: string, init: RequestInit & { cookie?: string } = {}): Promise<{ res: Response; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) };
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await fetch(`${base}${path}`, { ...init, headers });
  return { res, body: await json(res) };
}

function forceReminderDue(dbPath: string, reminderId: string, remindAt: string) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE task_reminders SET remind_at = ?, status = 'scheduled' WHERE id = ?").run(remindAt, reminderId);
  } finally {
    db.close();
  }
}

async function login(base: string, email: string, smtpMessages: string[]): Promise<string> {
  const codeStart = smtpMessages.length;
  const challenge = await req(base, '/api/auth/verification-codes', {
    method: 'POST',
    body: JSON.stringify({ type: 'email', identifier: email, purpose: 'login' }),
  });
  assert(challenge.res.status === 201, `verification code failed: ${challenge.res.status} ${JSON.stringify(challenge.body)}`);
  for (let i = 0; i < 20 && smtpMessages.length === codeStart; i++) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const message = smtpMessages.at(-1) ?? '';
  const code = message.match(/\b\d{6}\b/)?.[0];
  assert(code, `SMTP message did not include a code: ${message}`);
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.body.challengeId,
      code,
      agreedToTerms: true,
      device: { deviceId: `notif-${email}`, deviceName: 'Notifications integration test', platform: 'Web', appVersion: 'test' },
    }),
  });
  const body = await json(loginRes);
  assert(loginRes.status === 201 || loginRes.status === 200, `login failed: ${loginRes.status} ${JSON.stringify(body)}`);
  return cookiesFrom(loginRes);
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `notifications-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'notifications-token-secret',
    AUTH_IDENTIFIER_SECRET: 'notifications-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const cookie = await login(base, 'notif-alice@example.com', smtp.messages);

    const initialPermission = await req(base, '/api/notifications/permission', { cookie });
    assert(initialPermission.res.status === 200, `notification permission should be 200, got ${initialPermission.res.status}`);
    assert(initialPermission.body.permission.status === 'unknown', 'initial notification permission should be unknown');
    assert(initialPermission.body.permission.shouldPrompt === true, 'unknown notification permission should ask for guidance prompt');

    const invalidPermission = await req(base, '/api/notifications/permission', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ status: 'maybe' }),
    });
    assert(invalidPermission.res.status === 400, `invalid notification permission should be 400, got ${invalidPermission.res.status}`);

    const taskReminderPrompt = await req(base, '/api/notifications/permission', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ status: 'default', promptReason: 'task_reminder' }),
    });
    assert(taskReminderPrompt.body.permission.promptReason === 'task_reminder', 'task reminder prompt reason did not persist');
    assert(taskReminderPrompt.body.permission.shouldPrompt === true, 'task reminder default status should still prompt');

    const habitReminderPrompt = await req(base, '/api/notifications/permission', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ status: 'default', promptReason: 'habit_reminder' }),
    });
    assert(habitReminderPrompt.body.permission.promptReason === 'habit_reminder', 'habit reminder prompt reason did not persist');

    const focusReminderPrompt = await req(base, '/api/notifications/permission', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ status: 'default', promptReason: 'focus_reminder' }),
    });
    assert(focusReminderPrompt.body.permission.promptReason === 'focus_reminder', 'focus reminder prompt reason did not persist');

    const defaultPermission = await req(base, '/api/notifications/permission', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ status: 'default', promptReason: 'settings' }),
    });
    assert(defaultPermission.body.permission.status === 'default', 'default notification permission did not persist');
    assert(defaultPermission.body.permission.promptReason === 'settings', 'notification prompt reason did not persist');
    assert(defaultPermission.body.permission.lastPromptedAt, 'notification prompt timestamp did not persist');

    const deniedPermission = await req(base, '/api/notifications/permission', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ status: 'denied' }),
    });
    assert(deniedPermission.body.permission.status === 'denied', 'denied notification permission did not persist');
    assert(deniedPermission.body.permission.guidance === 'blocked', 'denied notification permission should return blocked guidance');

    const task = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Due reminder task' }),
    });
    const taskId = task.body.task.id;
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    const reminder = await req(base, `/api/tasks/${taskId}/reminders`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ remindAt: dueAt, channel: 'email' }),
    });
    const reminderId = reminder.body.reminder.id;

    const tick1 = await req(base, '/api/reminder-runner/tick', { method: 'POST', cookie });
    assert(tick1.body.created === 1, `expected first tick to create one notification, got ${tick1.body.created}`);
    const tick2 = await req(base, '/api/reminder-runner/tick', { method: 'POST', cookie });
    assert(tick2.body.created === 0, `expected second tick to create zero notifications, got ${tick2.body.created}`);

    const list = await req(base, '/api/notifications', { cookie });
    assert(list.body.notifications.length === 1, `expected one notification, got ${list.body.notifications.length}`);
    const notificationId = list.body.notifications[0].id;
    assert(list.body.notifications[0].targetId === reminderId, 'notification targetId should be the reminder id');

    const read = await req(base, `/api/notifications/${notificationId}/read`, { method: 'POST', cookie });
    assert(read.body.notification.readAt, 'readAt was not set');
    const unread = await req(base, '/api/notifications?unread=1', { cookie });
    assert(unread.body.notifications.length === 0, 'unread list should be empty after read');

    const snoozedUntil = new Date(Date.now() + 10 * 60_000).toISOString();
    const snooze = await req(base, `/api/notifications/${notificationId}/snooze`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ snoozedUntil }),
    });
    assert(snooze.body.notification.scheduledAt === snoozedUntil, 'snooze did not update scheduledAt');
    assert(snooze.body.notification.readAt === null, 'snooze should make notification unread again');

    const importantTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Important repeat reminder task', priority: 3 }),
    });
    const importantReminder = await req(base, `/api/tasks/${importantTask.body.task.id}/reminders`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ remindAt: dueAt, channel: 'email' }),
    });
    const importantReminderId = importantReminder.body.reminder.id;
    const importantTick1 = await req(base, '/api/reminder-runner/tick', { method: 'POST', cookie });
    assert(importantTick1.body.created === 1, `important reminder first tick should create one notification, got ${importantTick1.body.created}`);
    assert(
      importantTick1.body.notifications[0].targetId === importantReminderId,
      'important reminder first notification should target the reminder id',
    );

    forceReminderDue(dbPath, importantReminderId, dueAt);
    const importantTick2 = await req(base, '/api/reminder-runner/tick', { method: 'POST', cookie });
    assert(importantTick2.body.created === 1, `important reminder repeat tick should create one notification, got ${importantTick2.body.created}`);
    const repeatNotification = importantTick2.body.notifications[0];
    assert(
      repeatNotification.targetId.startsWith(`${importantReminderId}:repeat:`),
      `repeat notification targetId should include repeat marker, got ${repeatNotification.targetId}`,
    );

    const confirmImportant = await req(base, `/api/notifications/${repeatNotification.id}/read`, { method: 'POST', cookie });
    assert(confirmImportant.body.notification.readAt, 'important repeat notification readAt was not set');
    forceReminderDue(dbPath, importantReminderId, dueAt);
    const importantTickAfterConfirm = await req(base, '/api/reminder-runner/tick', { method: 'POST', cookie });
    assert(
      importantTickAfterConfirm.body.created === 0,
      `confirmed important reminder should stop repeating, got ${importantTickAfterConfirm.body.created}`,
    );

    const dndSettings = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        notifications: {
          doNotDisturb: true,
          doNotDisturbStart: '00:00',
          doNotDisturbEnd: '00:00',
          completionSound: 'none',
        },
      }),
    });
    assert(dndSettings.body.settings.notifications.doNotDisturb === true, 'DND setting should persist');
    assert(dndSettings.body.settings.notifications.completionSound === 'none', 'completion sound setting should persist');

    const quietTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Quiet hours task' }),
    });
    const quietReminder = await req(base, `/api/tasks/${quietTask.body.task.id}/reminders`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ remindAt: dueAt, channel: 'email' }),
    });
    const quietTick = await req(base, '/api/reminder-runner/tick', { method: 'POST', cookie });
    assert(quietTick.body.created === 0, `DND tick should create zero notifications, got ${quietTick.body.created}`);

    await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ notifications: { doNotDisturb: false } }),
    });
    const afterDnd = await req(base, '/api/reminder-runner/tick', { method: 'POST', cookie });
    assert(afterDnd.body.created === 1, `after DND tick should create one notification, got ${afterDnd.body.created}`);

    await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ notifications: { taskReminders: false, habitReminders: false, goalReminders: false, focusReminders: false } }),
    });
    const disabledTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Disabled task reminder' }),
    });
    const disabledTaskReminder = await req(base, `/api/tasks/${disabledTask.body.task.id}/reminders`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ remindAt: dueAt, channel: 'email' }),
    });
    const disabledHabit = await req(base, '/api/habits', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Disabled habit reminder', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], reminderTime: '00:00' }),
    });
    const disabledGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Disabled goal reminder', deadlineAt: dueAt }),
    });
    const disabledClassTick = await req(base, '/api/reminder-runner/tick', { method: 'POST', cookie });
    assert(disabledClassTick.body.created === 0, `disabled classified reminders should create zero notifications, got ${disabledClassTick.body.created}`);

    const focusSession = await req(base, '/api/focus/sessions', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        mode: 'pomodoro',
        startedAt: new Date(Date.now() - 25 * 60_000).toISOString(),
        endedAt: dueAt,
        durationSec: 25 * 60,
        isPomodoro: true,
        taskId: null,
      }),
    });
    const disabledRestCycle = await req(base, '/api/focus/rest-cycles', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        focusSessionId: focusSession.body.session.id,
        restStartedAt: dueAt,
        restEndedAt: new Date().toISOString(),
        restDurationSec: 5 * 60,
      }),
    });
    assert(disabledRestCycle.body.restCycle.reminderStatus === 'suppressed', 'focus reminder switch should suppress rest notifications');
    assert(disabledRestCycle.body.restCycle.notificationId === null, 'suppressed focus reminder should not have a notification id');

    await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ notifications: { taskReminders: true, habitReminders: true, goalReminders: true } }),
    });
    const classifiedTick = await req(base, '/api/reminder-runner/tick', { method: 'POST', cookie });
    assert(classifiedTick.body.created === 3, `classified reminders should create three notifications, got ${classifiedTick.body.created}`);
    assert(classifiedTick.body.notifications.some((item: any) => item.type === 'task_reminder' && item.targetId === disabledTaskReminder.body.reminder.id), 'task reminder switch did not create the task notification after re-enable');
    assert(classifiedTick.body.notifications.some((item: any) => item.type === 'habit_reminder' && item.targetId === `${disabledHabit.body.habit.id}:${new Date().toLocaleDateString('sv-SE')}`), 'habit reminder switch did not create the habit notification after re-enable');
    assert(classifiedTick.body.notifications.some((item: any) => item.type === 'goal_reminder' && item.targetId === disabledGoal.body.goal.id), 'goal reminder switch did not create the goal notification after re-enable');

    const bobCookie = await login(base, 'notif-bob@example.com', smtp.messages);
    const bobList = await req(base, '/api/notifications', { cookie: bobCookie });
    assert(bobList.body.notifications.length === 0, 'Bob should not see Alice notifications');
    const bobRead = await req(base, `/api/notifications/${notificationId}/read`, { method: 'POST', cookie: bobCookie });
    assert(bobRead.res.status === 404, `expected Bob read to be 404, got ${bobRead.res.status}`);

    const exportA = await req(base, '/api/settings/export', { cookie });
    assert(exportA.body.notifications.length === 7, 'export should include Alice notifications');
    assert(exportA.body.notificationPermissions.length === 1, 'export should include Alice notification permission state');

    const db = new DatabaseSync(dbPath);
    try {
      const n = db.prepare('SELECT COUNT(*) c FROM notifications').get() as { c: number };
      const permissionRow = db
        .prepare("SELECT status, prompt_reason, last_prompted_at FROM notification_permissions WHERE permission = 'system-notifications'")
        .get() as { status: string; prompt_reason: string | null; last_prompted_at: string | null };
      const r = db.prepare('SELECT status FROM task_reminders WHERE id = ?').get(reminderId) as { status: string };
      const important = db.prepare('SELECT status FROM task_reminders WHERE id = ?').get(importantReminderId) as { status: string };
      const quiet = db.prepare('SELECT status FROM task_reminders WHERE id = ?').get(quietReminder.body.reminder.id) as { status: string };
      const disabledStatus = db.prepare('SELECT status FROM task_reminders WHERE id = ?').get(disabledTaskReminder.body.reminder.id) as { status: string };
      assert(n.c === 7, `expected seven notification rows, got ${n.c}`);
      assert(permissionRow.status === 'denied', `expected notification permission denied, got ${permissionRow.status}`);
      assert(permissionRow.prompt_reason === 'settings', 'notification permission prompt reason should be preserved');
      assert(!!permissionRow.last_prompted_at, 'notification permission prompt timestamp should be preserved');
      assert(r.status === 'sent', `expected reminder status sent, got ${r.status}`);
      assert(important.status === 'sent', `expected confirmed important reminder status sent, got ${important.status}`);
      assert(quiet.status === 'sent', `expected quiet reminder status sent after DND ends, got ${quiet.status}`);
      assert(disabledStatus.status === 'sent', `expected disabled task reminder to send after re-enable, got ${disabledStatus.status}`);
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
