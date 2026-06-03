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

function localDateString(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
      device: { deviceId: `desktop-${email}`, deviceName: 'Desktop integration test', platform: 'Web', appVersion: 'test' },
    }),
  });
  await json(loginRes);
  assert(loginRes.status === 201 || loginRes.status === 200, `login failed: ${loginRes.status}`);
  return cookiesFrom(loginRes);
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `desktop-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'desktop-token-secret',
    AUTH_IDENTIFIER_SECRET: 'desktop-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const cookie = await login(base, 'desktop-alice@example.com', smtp.messages);

    const initial = await req(base, '/api/desktop/status', { cookie });
    assert(initial.res.status === 200, `desktop status should be 200, got ${initial.res.status}`);
    assert(initial.body.status.hostAvailable === false, 'web bridge must not claim a desktop host');
    assert(initial.body.status.capabilities.globalShortcuts === 'host_required', 'global shortcuts must be marked host-required');
    assert(initial.body.status.state.startup === false, 'startup default should be false');
    assert(initial.body.status.appLockPasswordSet === false, 'app lock password should be unset by default');

    const invalidState = await req(base, '/api/desktop/state', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ startup: 'yes' }),
    });
    assert(invalidState.res.status === 400, `invalid desktop state should be 400, got ${invalidState.res.status}`);

    const state = await req(base, '/api/desktop/state', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        startup: true,
        tray: true,
        closeBehavior: 'minimize_to_tray',
        appLock: true,
        autoLockMinutes: 1,
        backgroundAudioAllowed: true,
      }),
    });
    assert(state.body.status.state.startup === true, 'desktop startup state did not persist');
    assert(state.body.status.state.tray === true, 'desktop tray state did not persist');
    assert(state.body.status.state.closeBehavior === 'minimize_to_tray', 'desktop close behavior did not persist');
    assert(state.body.status.state.autoLockMinutes === 1, 'desktop auto-lock setting did not persist');

    const invalidCloseBehavior = await req(base, '/api/desktop/state', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ closeBehavior: 'hide' }),
    });
    assert(invalidCloseBehavior.res.status === 400, `invalid close behavior should be 400, got ${invalidCloseBehavior.res.status}`);

    const invalidAutoLock = await req(base, '/api/desktop/state', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ autoLockMinutes: 2 }),
    });
    assert(invalidAutoLock.res.status === 400, `invalid auto-lock setting should be 400, got ${invalidAutoLock.res.status}`);

    const closeIntent = await req(base, '/api/desktop/window/close-intent', { method: 'POST', cookie });
    assert(closeIntent.body.action === 'minimize_to_tray', 'close intent should use persisted minimize-to-tray behavior');

    const oldActivity = new Date(Date.now() - 90_000).toISOString();
    const activity = await req(base, '/api/desktop/app-lock/activity', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ occurredAt: oldActivity }),
    });
    assert(activity.body.status.state.lastActiveAt === oldActivity, 'desktop activity timestamp did not persist');
    const autoLock = await req(base, '/api/desktop/app-lock/auto-lock-check', { method: 'POST', cookie });
    assert(autoLock.body.status.state.locked === true, 'desktop auto-lock did not lock after idle threshold');
    assert(autoLock.body.status.state.autoLockedAt, 'desktop auto-lock timestamp missing');

    const widgetTemplates = await req(base, '/api/desktop/widget-templates', { cookie });
    const widgetTypes = widgetTemplates.body.widgetTemplates.map((item: any) => item.type).sort();
    assert(widgetTypes.length === 6, `expected six widget templates, got ${widgetTypes.length}`);
    assert(
      ['countdowns', 'focus-timer', 'goal-progress', 'habit-checkin', 'inbox-quick-add', 'today-tasks'].every((type) =>
        widgetTypes.includes(type),
      ),
      `widget templates missing PRD types: ${widgetTypes.join(', ')}`,
    );

    const invalidWidgetType = await req(base, '/api/desktop/widgets', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ type: 'unknown-widget', title: 'Unknown' }),
    });
    assert(invalidWidgetType.res.status === 400, `unknown widget type should be 400, got ${invalidWidgetType.res.status}`);

    const invalidWidgetConfig = await req(base, '/api/desktop/widgets', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ type: 'focus-timer', title: 'Bad timer', config: { defaultMinutes: 0 } }),
    });
    assert(invalidWidgetConfig.res.status === 400, `invalid widget config should be 400, got ${invalidWidgetConfig.res.status}`);

    const widget = await req(base, '/api/desktop/widgets', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        type: 'today-tasks',
        title: 'Today tasks',
        config: { range: 'today', limit: 5, allowComplete: true },
        position: { x: 10, y: 20, width: 360, height: 280, screen: 'primary' },
      }),
    });
    assert(widget.res.status === 201, `widget create failed: ${widget.res.status}`);
    assert(widget.body.widget.config.range === 'today', 'widget config did not round-trip');
    assert(widget.body.widget.position.width === 360, 'widget position did not round-trip');

    const atLocalHour = (offsetDays: number, hour: number) => {
      const d = new Date();
      d.setDate(d.getDate() + offsetDays);
      d.setHours(hour, 0, 0, 0);
      return d.toISOString();
    };
    const overdueTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Widget overdue task', dueDate: atLocalHour(-1, 9), isAllDay: true }),
    });
    const todayTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Widget today task', dueDate: atLocalHour(0, 12), isAllDay: false }),
    });
    const futureTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Widget future task', dueDate: atLocalHour(1, 12), isAllDay: false }),
    });
    const completedTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Widget completed task', dueDate: atLocalHour(0, 13), isAllDay: false, status: 'done' }),
    });
    assert(futureTask.res.status === 201 && completedTask.res.status === 201, 'widget fixture tasks should be created');

    const widgetData = await req(base, `/api/desktop/widgets/${widget.body.widget.id}/data`, { cookie });
    assert(widgetData.res.status === 200, `today widget data failed: ${widgetData.res.status}`);
    const widgetTaskIds = widgetData.body.data.tasks.map((task: any) => task.id);
    assert(widgetData.body.data.type === 'today-tasks', 'today widget data type mismatch');
    assert(widgetData.body.data.allowComplete === true, 'today widget should allow completion from config');
    assert(widgetData.body.data.counts.total === 2, `today widget total count mismatch: ${widgetData.body.data.counts.total}`);
    assert(widgetData.body.data.counts.shown === 2, `today widget shown count mismatch: ${widgetData.body.data.counts.shown}`);
    assert(widgetData.body.data.counts.overdue === 1, `today widget overdue count mismatch: ${widgetData.body.data.counts.overdue}`);
    assert(widgetTaskIds.includes(overdueTask.body.task.id), 'today widget should include overdue task');
    assert(widgetTaskIds.includes(todayTask.body.task.id), 'today widget should include today task');
    assert(!widgetTaskIds.includes(futureTask.body.task.id), 'today widget must not include future tasks');
    assert(!widgetTaskIds.includes(completedTask.body.task.id), 'today widget must not include completed tasks');

    const widgetComplete = await req(base, `/api/desktop/widgets/${widget.body.widget.id}/actions`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ action: 'complete_task', taskId: overdueTask.body.task.id }),
    });
    assert(widgetComplete.res.status === 200, `today widget completion failed: ${widgetComplete.res.status}`);
    assert(widgetComplete.body.task.completed === true, 'widget completion should complete the task');
    assert(!widgetComplete.body.data.tasks.some((task: any) => task.id === overdueTask.body.task.id), 'completed task should leave widget data');
    assert(widgetComplete.body.data.counts.total === 1, 'today widget total should refresh after completion');

    const invalidWidgetAction = await req(base, `/api/desktop/widgets/${widget.body.widget.id}/actions`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ action: 'delete_task', taskId: todayTask.body.task.id }),
    });
    assert(invalidWidgetAction.res.status === 400, `invalid widget action should be 400, got ${invalidWidgetAction.res.status}`);

    const countdownWidget = await req(base, '/api/desktop/widgets', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        type: 'countdowns',
        title: 'Important dates',
        config: { limit: 3, pinnedFirst: true },
      }),
    });
    assert(countdownWidget.res.status === 201, `countdown widget create failed: ${countdownWidget.res.status}`);
    assert(countdownWidget.body.widget.config.limit === 3, 'countdown widget config did not round-trip');
    const unsupportedWidgetData = await req(base, `/api/desktop/widgets/${countdownWidget.body.widget.id}/data`, { cookie });
    assert(unsupportedWidgetData.res.status === 501, `unsupported widget data should be 501, got ${unsupportedWidgetData.res.status}`);

    const focusWidget = await req(base, '/api/desktop/widgets', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        type: 'focus-timer',
        title: 'Focus timer',
        config: { defaultMinutes: 25, allowStartPause: true },
      }),
    });
    assert(focusWidget.res.status === 201, `focus widget create failed: ${focusWidget.res.status}`);

    const focusDataBefore = await req(base, `/api/desktop/widgets/${focusWidget.body.widget.id}/data`, { cookie });
    assert(focusDataBefore.res.status === 200, `focus widget data failed: ${focusDataBefore.res.status}`);
    assert(focusDataBefore.body.data.type === 'focus-timer', 'focus widget data type mismatch');
    assert(focusDataBefore.body.data.timer.status === 'idle', 'focus widget should start idle');
    assert(focusDataBefore.body.data.timer.targetDurationSec === 1500, 'focus widget target duration should come from config');
    assert(focusDataBefore.body.data.stats.todayCount === 0, 'focus widget should include real focus stats');

    const pauseBeforeStart = await req(base, `/api/desktop/widgets/${focusWidget.body.widget.id}/actions`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ action: 'pause_focus' }),
    });
    assert(pauseBeforeStart.res.status === 409, `pause before focus start should be 409, got ${pauseBeforeStart.res.status}`);

    const focusStart = await req(base, `/api/desktop/widgets/${focusWidget.body.widget.id}/actions`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ action: 'start_focus' }),
    });
    assert(focusStart.res.status === 200, `focus widget start failed: ${focusStart.res.status}`);
    assert(focusStart.body.data.timer.status === 'running', 'focus widget start should persist running status');
    assert(focusStart.body.data.timer.startedAt, 'focus widget start should persist startedAt');

    const invalidFocusAction = await req(base, `/api/desktop/widgets/${focusWidget.body.widget.id}/actions`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ action: 'complete_focus' }),
    });
    assert(invalidFocusAction.res.status === 400, `invalid focus widget action should be 400, got ${invalidFocusAction.res.status}`);

    const focusPause = await req(base, `/api/desktop/widgets/${focusWidget.body.widget.id}/actions`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ action: 'pause_focus' }),
    });
    assert(focusPause.res.status === 200, `focus widget pause failed: ${focusPause.res.status}`);
    assert(focusPause.body.data.timer.status === 'paused', 'focus widget pause should persist paused status');
    assert(focusPause.body.data.timer.pausedAt, 'focus widget pause should persist pausedAt');

    const focusWidgetDisabledStartPause = await req(base, `/api/desktop/widgets/${focusWidget.body.widget.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ config: { allowStartPause: false } }),
    });
    assert(focusWidgetDisabledStartPause.body.widget.config.allowStartPause === false, 'focus allowStartPause config patch did not persist');
    const disabledFocusStart = await req(base, `/api/desktop/widgets/${focusWidget.body.widget.id}/actions`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ action: 'start_focus' }),
    });
    assert(disabledFocusStart.res.status === 409, `disabled focus start should be 409, got ${disabledFocusStart.res.status}`);

    const inboxWidget = await req(base, '/api/desktop/widgets', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        type: 'inbox-quick-add',
        title: 'Inbox capture',
        config: { quickAdd: true, limit: 6 },
      }),
    });
    assert(inboxWidget.res.status === 201, `inbox widget create failed: ${inboxWidget.res.status}`);
    const inboxDataBefore = await req(base, `/api/desktop/widgets/${inboxWidget.body.widget.id}/data`, { cookie });
    assert(inboxDataBefore.res.status === 200, `inbox widget data failed: ${inboxDataBefore.res.status}`);
    assert(inboxDataBefore.body.data.type === 'inbox-quick-add', 'inbox widget data type mismatch');
    assert(inboxDataBefore.body.data.quickAdd === true, 'inbox widget quickAdd flag should come from config');
    assert(inboxDataBefore.body.data.counts.total >= 2, 'inbox widget should read real inbox tasks');

    const inboxQuickAdd = await req(base, `/api/desktop/widgets/${inboxWidget.body.widget.id}/actions`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ action: 'quick_add_task', text: 'Widget inbox capture' }),
    });
    assert(inboxQuickAdd.res.status === 200, `inbox widget quick-add failed: ${inboxQuickAdd.res.status}`);
    assert(inboxQuickAdd.body.task.title === 'Widget inbox capture', 'inbox widget quick-add task title mismatch');
    assert(inboxQuickAdd.body.task.source === 'desktop_widget', 'inbox widget quick-add should mark source=desktop_widget');
    assert(inboxQuickAdd.body.data.tasks.some((task: any) => task.id === inboxQuickAdd.body.task.id), 'new inbox task should appear in refreshed widget data');

    const invalidInboxAction = await req(base, `/api/desktop/widgets/${inboxWidget.body.widget.id}/actions`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ action: 'complete_task', taskId: todayTask.body.task.id }),
    });
    assert(invalidInboxAction.res.status === 400, `invalid inbox widget action should be 400, got ${invalidInboxAction.res.status}`);

    const inboxWidgetDisabledQuickAdd = await req(base, `/api/desktop/widgets/${inboxWidget.body.widget.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ config: { quickAdd: false } }),
    });
    assert(inboxWidgetDisabledQuickAdd.body.widget.config.quickAdd === false, 'inbox quickAdd config patch did not persist');
    const disabledInboxQuickAdd = await req(base, `/api/desktop/widgets/${inboxWidget.body.widget.id}/actions`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ action: 'quick_add_task', text: 'Should not create' }),
    });
    assert(disabledInboxQuickAdd.res.status === 409, `disabled inbox quick-add should be 409, got ${disabledInboxQuickAdd.res.status}`);

    const today = localDateString();
    const todayDow = new Date().getDay();
    const habit = await req(base, '/api/habits', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Widget habit check-in',
        icon: 'check',
        color: '#14b8a6',
        daysOfWeek: [todayDow],
        note: 'Created by desktop widget integration test',
      }),
    });
    assert(habit.res.status === 201, `habit fixture create failed: ${habit.res.status}`);

    const habitWidget = await req(base, '/api/desktop/widgets', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        type: 'habit-checkin',
        title: 'Daily habits',
        config: { date: 'today', allowCheckin: true },
      }),
    });
    assert(habitWidget.res.status === 201, `habit widget create failed: ${habitWidget.res.status}`);

    const habitDataBefore = await req(base, `/api/desktop/widgets/${habitWidget.body.widget.id}/data`, { cookie });
    assert(habitDataBefore.res.status === 200, `habit widget data failed: ${habitDataBefore.res.status}`);
    assert(habitDataBefore.body.data.type === 'habit-checkin', 'habit widget data type mismatch');
    assert(habitDataBefore.body.data.date === today, 'habit widget should use the local current date');
    assert(habitDataBefore.body.data.allowCheckin === true, 'habit widget allowCheckin flag should come from config');
    assert(habitDataBefore.body.data.counts.total === 1, `habit widget total count mismatch: ${habitDataBefore.body.data.counts.total}`);
    assert(habitDataBefore.body.data.counts.checked === 0, 'habit widget should start unchecked');
    assert(habitDataBefore.body.data.habits.some((item: any) => item.id === habit.body.habit.id), 'habit widget should include scheduled habit');

    const invalidHabitAction = await req(base, `/api/desktop/widgets/${habitWidget.body.widget.id}/actions`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ action: 'complete_task', habitId: habit.body.habit.id }),
    });
    assert(invalidHabitAction.res.status === 400, `invalid habit widget action should be 400, got ${invalidHabitAction.res.status}`);

    const habitCheckin = await req(base, `/api/desktop/widgets/${habitWidget.body.widget.id}/actions`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ action: 'toggle_habit', habitId: habit.body.habit.id, note: 'Checked from widget' }),
    });
    assert(habitCheckin.res.status === 200, `habit widget check-in failed: ${habitCheckin.res.status}`);
    assert(habitCheckin.body.checkin.checked === true, 'habit widget action should check in the habit');
    assert(habitCheckin.body.habit.checkins.includes(today), 'habit widget action should return the checked date');
    assert(habitCheckin.body.data.counts.checked === 1, 'habit widget data should refresh checked count after action');

    const habitDataAfter = await req(base, `/api/desktop/widgets/${habitWidget.body.widget.id}/data`, { cookie });
    assert(habitDataAfter.body.data.counts.checked === 1, 'habit widget data should persist checked count after refresh');
    assert(habitDataAfter.body.data.habits[0].checkinDetails.some((item: any) => item.date === today), 'habit widget data should expose real check-in detail');

    const habitWidgetDisabledCheckin = await req(base, `/api/desktop/widgets/${habitWidget.body.widget.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ config: { allowCheckin: false } }),
    });
    assert(habitWidgetDisabledCheckin.body.widget.config.allowCheckin === false, 'habit allowCheckin config patch did not persist');
    const disabledHabitCheckin = await req(base, `/api/desktop/widgets/${habitWidget.body.widget.id}/actions`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ action: 'toggle_habit', habitId: habit.body.habit.id }),
    });
    assert(disabledHabitCheckin.res.status === 409, `disabled habit check-in should be 409, got ${disabledHabitCheckin.res.status}`);

    const widgetList = await req(base, '/api/desktop/widgets', { cookie });
    assert(widgetList.body.widgets.length === 5, `expected five widgets, got ${widgetList.body.widgets.length}`);

    const disableComplete = await req(base, `/api/desktop/widgets/${widget.body.widget.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ config: { allowComplete: false } }),
    });
    assert(disableComplete.body.widget.config.allowComplete === false, 'widget allowComplete patch did not persist');
    const disabledCompleteAction = await req(base, `/api/desktop/widgets/${widget.body.widget.id}/actions`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ action: 'complete_task', taskId: todayTask.body.task.id }),
    });
    assert(disabledCompleteAction.res.status === 409, `disabled widget completion should be 409, got ${disabledCompleteAction.res.status}`);

    const widgetPatch = await req(base, `/api/desktop/widgets/${widget.body.widget.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ enabled: false, title: 'Pinned agenda' }),
    });
    assert(widgetPatch.body.widget.enabled === false, 'widget enabled patch did not persist');
    assert(widgetPatch.body.widget.title === 'Pinned agenda', 'widget title patch did not persist');
    const disabledWidgetData = await req(base, `/api/desktop/widgets/${widget.body.widget.id}/data`, { cookie });
    assert(disabledWidgetData.res.status === 409, `disabled widget data should be 409, got ${disabledWidgetData.res.status}`);

    const shortcut = await req(base, '/api/desktop/shortcuts', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ action: 'task.quickAdd', accelerator: 'CommandOrControl+Shift+N' }),
    });
    assert(shortcut.res.status === 201, `shortcut create failed: ${shortcut.res.status}`);

    const duplicate = await req(base, '/api/desktop/shortcuts', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ action: 'task.quickAdd', accelerator: 'CommandOrControl+Alt+N' }),
    });
    assert(duplicate.res.status === 409, `duplicate shortcut action should be 409, got ${duplicate.res.status}`);

    const duplicateAccelerator = await req(base, '/api/desktop/shortcuts', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ action: 'search.open', accelerator: 'CommandOrControl+Shift+N' }),
    });
    assert(duplicateAccelerator.res.status === 409, `duplicate shortcut accelerator should be 409, got ${duplicateAccelerator.res.status}`);

    const reservedAccelerator = await req(base, '/api/desktop/shortcuts', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ action: 'system.reserved', accelerator: 'Ctrl+Alt+Delete' }),
    });
    assert(reservedAccelerator.res.status === 409, `reserved shortcut accelerator should be 409, got ${reservedAccelerator.res.status}`);

    const registered = await req(base, `/api/desktop/shortcuts/${shortcut.body.shortcut.id}/register`, { method: 'POST', cookie });
    assert(registered.body.shortcut.registeredAt, 'shortcut register request was not persisted');
    assert(registered.body.shortcut.hostRegistered === false, 'web bridge must not claim OS shortcut registration');

    const templates = await req(base, '/api/desktop/shortcut-templates', { cookie });
    assert(templates.body.shortcutTemplates.length >= 7, 'shortcut templates should include PRD defaults');
    assert(
      templates.body.shortcutTemplates.some((item: any) => item.action === 'task.quickAdd' && item.accelerator === 'CommandOrControl+N'),
      'quick-add default shortcut template is missing',
    );

    const resetShortcuts = await req(base, '/api/desktop/shortcuts/reset', { method: 'POST', cookie });
    assert(resetShortcuts.body.shortcuts.length === 7, `expected seven default shortcuts, got ${resetShortcuts.body.shortcuts.length}`);
    assert(
      resetShortcuts.body.shortcuts.some((item: any) => item.action === 'settings.open' && item.accelerator === 'CommandOrControl+,'),
      'settings default shortcut did not persist after reset',
    );
    const defaultQuickAdd = resetShortcuts.body.shortcuts.find((item: any) => item.action === 'task.quickAdd');
    assert(defaultQuickAdd, 'reset should create the quick-add shortcut');
    const registeredDefault = await req(base, `/api/desktop/shortcuts/${defaultQuickAdd.id}/register`, { method: 'POST', cookie });
    assert(registeredDefault.body.shortcut.registeredAt, 'default shortcut registration request was not persisted');

    const invalidAppLockPassword = await req(base, '/api/desktop/app-lock/password', {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ password: '123' }),
    });
    assert(invalidAppLockPassword.res.status === 400, `short app-lock password should be 400, got ${invalidAppLockPassword.res.status}`);

    const setAppLockPassword = await req(base, '/api/desktop/app-lock/password', {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ password: '123456' }),
    });
    assert(setAppLockPassword.body.status.appLockPasswordSet === true, 'app-lock password flag should be set');
    assert(setAppLockPassword.body.status.state.appLock === true, 'setting app-lock password should enable app lock');
    assert(setAppLockPassword.body.status.state.locked === false, 'setting app-lock password should clear stale locks');

    const passwordDb = new DatabaseSync(dbPath);
    try {
      const row = passwordDb.prepare('SELECT password_hash FROM desktop_app_lock_credentials').get() as { password_hash: string } | undefined;
      assert(row, 'app-lock password credential row was not written to SQLite');
      assert(row.password_hash.startsWith('scrypt:v1:'), 'app-lock password should use scrypt hash encoding');
      assert(!row.password_hash.includes('123456'), 'app-lock password hash must not contain the raw password');
    } finally {
      passwordDb.close();
    }

    const passwordLock = await req(base, '/api/desktop/app-lock/lock', { method: 'POST', cookie });
    assert(passwordLock.body.status.state.locked === true, 'password-protected app lock did not lock');
    const unlockMissingPassword = await req(base, '/api/desktop/app-lock/unlock', { method: 'POST', cookie });
    assert(unlockMissingPassword.res.status === 401, `missing app-lock password should be 401, got ${unlockMissingPassword.res.status}`);
    const unlockWrongPassword = await req(base, '/api/desktop/app-lock/unlock', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    assert(unlockWrongPassword.res.status === 401, `wrong app-lock password should be 401, got ${unlockWrongPassword.res.status}`);
    const unlockCorrectPassword = await req(base, '/api/desktop/app-lock/unlock', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ password: '123456' }),
    });
    assert(unlockCorrectPassword.body.status.state.locked === false, 'correct app-lock password should unlock');

    const changePasswordMissingCurrent = await req(base, '/api/desktop/app-lock/password', {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ password: '654321' }),
    });
    assert(
      changePasswordMissingCurrent.res.status === 401,
      `changing app-lock password without current password should be 401, got ${changePasswordMissingCurrent.res.status}`,
    );
    const changePassword = await req(base, '/api/desktop/app-lock/password', {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ currentPassword: '123456', password: '654321' }),
    });
    assert(changePassword.body.status.appLockPasswordSet === true, 'changed app-lock password flag should remain set');
    await req(base, '/api/desktop/app-lock/lock', { method: 'POST', cookie });
    const unlockWithOldPassword = await req(base, '/api/desktop/app-lock/unlock', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ password: '123456' }),
    });
    assert(unlockWithOldPassword.res.status === 401, `old app-lock password should be rejected, got ${unlockWithOldPassword.res.status}`);
    const unlockWithNewPassword = await req(base, '/api/desktop/app-lock/unlock', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ password: '654321' }),
    });
    assert(unlockWithNewPassword.body.status.state.locked === false, 'new app-lock password should unlock');

    const clearPasswordWrong = await req(base, '/api/desktop/app-lock/password', {
      method: 'DELETE',
      cookie,
      body: JSON.stringify({ currentPassword: 'wrong-password' }),
    });
    assert(clearPasswordWrong.res.status === 401, `wrong current password should not disable app-lock password, got ${clearPasswordWrong.res.status}`);
    const clearPassword = await req(base, '/api/desktop/app-lock/password', {
      method: 'DELETE',
      cookie,
      body: JSON.stringify({ currentPassword: '654321' }),
    });
    assert(clearPassword.body.status.appLockPasswordSet === false, 'cleared app-lock password flag should be false');
    assert(clearPassword.body.status.state.appLock === false, 'clearing app-lock password should disable app lock');
    assert(clearPassword.body.status.state.locked === false, 'clearing app-lock password should unlock the app');

    const lock = await req(base, '/api/desktop/app-lock/lock', { method: 'POST', cookie });
    assert(lock.body.status.state.locked === true, 'desktop lock state did not persist');
    const unlock = await req(base, '/api/desktop/app-lock/unlock', { method: 'POST', cookie });
    assert(unlock.body.status.state.locked === false, 'desktop unlock state did not persist');

    const exported = await req(base, '/api/settings/export', { cookie });
    assert(exported.body.desktopWidgets.length === 5, 'export should include desktop widgets');
    assert(exported.body.desktopShortcuts.length === 7, 'export should include reset default desktop shortcuts');
    assert(exported.body.desktopShellState.length >= 4, 'export should include desktop shell state rows');
    assert(!('desktopAppLockCredentials' in exported.body), 'export must not include app-lock password credentials');
    assert(!JSON.stringify(exported.body).includes('scrypt:v1:'), 'export must not leak app-lock password hashes');

    const db = new DatabaseSync(dbPath);
    try {
      const widgetRow = db
        .prepare("SELECT config_json, enabled FROM desktop_widgets WHERE type = 'today-tasks'")
        .get() as { config_json: string; enabled: number };
      const inboxWidgetRow = db
        .prepare("SELECT config_json FROM desktop_widgets WHERE type = 'inbox-quick-add'")
        .get() as { config_json: string };
      const habitWidgetRow = db
        .prepare("SELECT config_json FROM desktop_widgets WHERE type = 'habit-checkin'")
        .get() as { config_json: string };
      const focusWidgetRow = db
        .prepare("SELECT config_json FROM desktop_widgets WHERE type = 'focus-timer'")
        .get() as { config_json: string };
      const countdownRow = db
        .prepare("SELECT config_json FROM desktop_widgets WHERE type = 'countdowns'")
        .get() as { config_json: string };
      const focusTimerRow = db
        .prepare('SELECT status, target_duration_sec, paused_at FROM desktop_focus_timers WHERE widget_id = ?')
        .get(focusWidget.body.widget.id) as { status: string; target_duration_sec: number; paused_at: string | null };
      const widgetCount = db.prepare('SELECT COUNT(*) count FROM desktop_widgets').get() as { count: number };
      const shortcutRow = db
        .prepare("SELECT registered_at, accelerator FROM desktop_shortcuts WHERE action = 'task.quickAdd'")
        .get() as { registered_at: string | null; accelerator: string };
      const shortcutCount = db.prepare('SELECT COUNT(*) count FROM desktop_shortcuts').get() as { count: number };
      const startupRow = db
        .prepare("SELECT value_json FROM desktop_shell_state WHERE key = 'startup'")
        .get() as { value_json: string };
      const closeRow = db
        .prepare("SELECT value_json FROM desktop_shell_state WHERE key = 'closeBehavior'")
        .get() as { value_json: string };
      const autoLockRow = db
        .prepare("SELECT value_json FROM desktop_shell_state WHERE key = 'autoLockMinutes'")
        .get() as { value_json: string };
      const lastActiveRow = db
        .prepare("SELECT value_json FROM desktop_shell_state WHERE key = 'lastActiveAt'")
        .get() as { value_json: string };
      const credentialCount = db.prepare('SELECT COUNT(*) count FROM desktop_app_lock_credentials').get() as { count: number };
      const completedFromWidget = db.prepare('SELECT completed FROM tasks WHERE id = ?').get(overdueTask.body.task.id) as { completed: number };
      const inboxTaskRow = db.prepare('SELECT source, list_id FROM tasks WHERE id = ?').get(inboxQuickAdd.body.task.id) as { source: string; list_id: string };
      const inboxListRow = db.prepare("SELECT id FROM lists WHERE user_id IS NOT NULL AND is_inbox = 1").get() as { id: string };
      const habitCheckinRow = db
        .prepare('SELECT date, note FROM habit_checkins WHERE habit_id = ?')
        .get(habit.body.habit.id) as { date: string; note: string | null };
      assert(widgetCount.count === 5, 'widget templates were not written to SQLite');
      assert(JSON.parse(widgetRow.config_json).range === 'today', 'widget config was not written to SQLite');
      assert(JSON.parse(widgetRow.config_json).allowComplete === false, 'widget allowComplete patch was not written to SQLite');
      assert(JSON.parse(inboxWidgetRow.config_json).quickAdd === false, 'inbox widget quickAdd patch was not written to SQLite');
      assert(JSON.parse(habitWidgetRow.config_json).allowCheckin === false, 'habit widget allowCheckin patch was not written to SQLite');
      assert(JSON.parse(focusWidgetRow.config_json).allowStartPause === false, 'focus widget allowStartPause patch was not written to SQLite');
      assert(JSON.parse(countdownRow.config_json).limit === 3, 'countdown widget config was not written to SQLite');
      assert(
        focusTimerRow.status === 'paused' && focusTimerRow.target_duration_sec === 1500 && !!focusTimerRow.paused_at,
        'focus widget timer state was not written to SQLite',
      );
      assert(widgetRow.enabled === 0, 'widget enabled patch was not written to SQLite');
      assert(completedFromWidget.completed === 1, 'desktop widget completion was not written to SQLite');
      assert(inboxTaskRow.source === 'desktop_widget' && inboxTaskRow.list_id === inboxListRow.id, 'inbox widget quick-add task was not written to inbox in SQLite');
      assert(habitCheckinRow.date === today && habitCheckinRow.note === 'Checked from widget', 'habit widget check-in was not written to SQLite');
      assert(shortcutCount.count === 7, 'default shortcuts were not written to SQLite');
      assert(shortcutRow.accelerator === 'CommandOrControl+N', 'default quick-add accelerator was not written to SQLite');
      assert(!!shortcutRow.registered_at, 'shortcut registration request was not written to SQLite');
      assert(JSON.parse(startupRow.value_json) === true, 'desktop startup state was not written to SQLite');
      assert(JSON.parse(closeRow.value_json) === 'minimize_to_tray', 'desktop close behavior was not written to SQLite');
      assert(JSON.parse(autoLockRow.value_json) === 1, 'desktop auto-lock setting was not written to SQLite');
      assert(typeof JSON.parse(lastActiveRow.value_json) === 'string', 'desktop activity timestamp was not written to SQLite');
      assert(credentialCount.count === 0, 'cleared app-lock credentials should be deleted from SQLite');
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
