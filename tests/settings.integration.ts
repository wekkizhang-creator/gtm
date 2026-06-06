import { loginCookie } from './auth-test-helper';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';

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

async function startTitleServer(): Promise<{ pageUrl: string; missingUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/page')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>Project Alpha &amp; Launch</title></head><body>ok</body></html>');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<title>Not found</title>');
  });
  const port = await new Promise<number>((resolvePromise, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolvePromise(typeof addr === 'object' && addr ? addr.port : 0);
    });
    server.on('error', reject);
  });
  return {
    pageUrl: `http://127.0.0.1:${port}/page?from=quick-add`,
    missingUrl: `http://127.0.0.1:${port}/missing`,
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
  const titleServer = await startTitleServer();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `settings-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'settings-token-secret',
    AUTH_IDENTIFIER_SECRET: 'settings-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const cookie = await login(base, 'settings-alice@example.com', smtp.messages);
    const patch = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        notifications: {
          enabled: false,
          detailVisibility: 'hidden',
          reminderVolume: 65,
          taskReminders: false,
          habitReminders: false,
          focusReminders: false,
          goalReminders: false,
        },
        focus: { defaultMinutes: 30, restMinutes: 8, longRestMinutes: 18, longRestInterval: 3, fadeOutStop: false },
        quickAdd: { parseEnabled: true, dateRecognition: true, removeDateText: false, tagRecognition: true, removeTagText: true, urlParsing: true },
        miniCalendar: { enabled: false, showLunar: 'on', showWeekNumbers: true },
        calendar: { view: 'month' },
        modules: { order: ['tasks', 'goals', 'focus', 'calendar', 'matrix', 'habits', 'countdown', 'notes'] },
        localization: { language: 'en-US' },
        appearance: {
          sidebarBackground: { type: 'color', color: '#123456', imageUrl: null },
          appOpacity: 82,
        },
        datetime: { weekStart: 0, timeFormat: '24', showLunar: false, showHolidayAdjustments: false, timeZoneMode: 'manual', timeZone: 'Asia/Tokyo' },
      }),
    });
    assert(patch.body.settings.notifications.enabled === false, 'notifications setting did not persist');
    assert(patch.body.settings.notifications.detailVisibility === 'hidden', 'notification detail visibility did not persist');
    assert(patch.body.settings.notifications.reminderVolume === 65, 'notification reminder volume did not persist');
    assert(patch.body.settings.notifications.taskReminders === false, 'task reminder switch did not persist');
    assert(patch.body.settings.notifications.habitReminders === false, 'habit reminder switch did not persist');
    assert(patch.body.settings.notifications.focusReminders === false, 'focus reminder switch did not persist');
    assert(patch.body.settings.notifications.goalReminders === false, 'goal reminder switch did not persist');
    assert(patch.body.settings.focus.defaultMinutes === 30, 'focus setting did not persist');
    assert(patch.body.settings.focus.restMinutes === 8, 'focus rest setting did not persist');
    assert(patch.body.settings.focus.longRestMinutes === 18, 'focus long-rest setting did not persist');
    assert(patch.body.settings.focus.longRestInterval === 3, 'focus long-rest interval setting did not persist');
    assert(patch.body.settings.focus.fadeOutStop === false, 'focus fade-out setting did not persist');
    assert(patch.body.settings.quickAdd.parseEnabled === true, 'quickAdd setting did not persist');
    assert(patch.body.settings.quickAdd.removeDateText === false, 'quickAdd removeDateText setting did not persist');
    assert(patch.body.settings.quickAdd.removeTagText === true, 'quickAdd removeTagText setting did not persist');
    assert(patch.body.settings.quickAdd.urlParsing === true, 'quickAdd urlParsing setting did not persist');
    assert(patch.body.settings.miniCalendar.enabled === false, 'mini calendar enabled setting did not persist');
    assert(patch.body.settings.miniCalendar.showLunar === 'on', 'mini calendar lunar setting did not persist');
    assert(patch.body.settings.miniCalendar.showWeekNumbers === true, 'mini calendar week number setting did not persist');
    assert(patch.body.settings.calendar.view === 'month', 'calendar view setting did not persist');
    assert(patch.body.settings.modules.order.join('|') === 'tasks|goals|focus|calendar|matrix|habits|countdown|notes', 'module order setting did not persist');
    assert(patch.body.settings.localization.language === 'en-US', 'localization language setting did not persist');
    assert(patch.body.settings.appearance.sidebarBackground.type === 'color', 'sidebar background type did not persist');
    assert(patch.body.settings.appearance.sidebarBackground.color === '#123456', 'sidebar background color did not persist');
    assert(patch.body.settings.appearance.appOpacity === 82, 'app opacity setting did not persist');
    assert(patch.body.settings.datetime.showLunar === false, 'showLunar setting did not persist');
    assert(patch.body.settings.datetime.showHolidayAdjustments === false, 'showHolidayAdjustments setting did not persist');
    assert(patch.body.settings.datetime.timeZoneMode === 'manual', 'time zone mode setting did not persist');
    assert(patch.body.settings.datetime.timeZone === 'Asia/Tokyo', 'time zone setting did not persist');
    const unknown = await req(base, '/api/settings', { method: 'PATCH', cookie, body: JSON.stringify({ unknownGroup: {} }) });
    assert(unknown.res.status === 400, `unknown group should be 400, got ${unknown.res.status}`);
    const invalidNotificationDetail = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ notifications: { detailVisibility: 'sometimes' } }),
    });
    assert(invalidNotificationDetail.res.status === 400, `invalid notification detail visibility should be 400, got ${invalidNotificationDetail.res.status}`);
    const invalidReminderVolume = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ notifications: { reminderVolume: 101 } }),
    });
    assert(invalidReminderVolume.res.status === 400, `invalid reminder volume should be 400, got ${invalidReminderVolume.res.status}`);
    const invalidTaskReminderSwitch = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ notifications: { taskReminders: 'off' } }),
    });
    assert(invalidTaskReminderSwitch.res.status === 400, `invalid task reminder switch should be 400, got ${invalidTaskReminderSwitch.res.status}`);
    const invalid = await req(base, '/api/settings', { method: 'PATCH', cookie, body: JSON.stringify({ appearance: { themeMode: 'blue' } }) });
    assert(invalid.res.status === 400, `invalid setting should be 400, got ${invalid.res.status}`);
    const invalidSidebarColor = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ appearance: { sidebarBackground: { type: 'color', color: 'blue', imageUrl: null } } }),
    });
    assert(invalidSidebarColor.res.status === 400, `invalid sidebar color should be 400, got ${invalidSidebarColor.res.status}`);
    const invalidSidebarImage = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ appearance: { sidebarBackground: { type: 'image', color: '#123456', imageUrl: 'file:///tmp/sidebar.jpg' } } }),
    });
    assert(invalidSidebarImage.res.status === 400, `invalid sidebar image URL should be 400, got ${invalidSidebarImage.res.status}`);
    const invalidAppOpacity = await req(base, '/api/settings', { method: 'PATCH', cookie, body: JSON.stringify({ appearance: { appOpacity: 101 } }) });
    assert(invalidAppOpacity.res.status === 400, `invalid app opacity should be 400, got ${invalidAppOpacity.res.status}`);
    const invalidDateSetting = await req(base, '/api/settings', { method: 'PATCH', cookie, body: JSON.stringify({ datetime: { showLunar: 'yes' } }) });
    assert(invalidDateSetting.res.status === 400, `invalid date setting should be 400, got ${invalidDateSetting.res.status}`);
    const invalidTimeZone = await req(base, '/api/settings', { method: 'PATCH', cookie, body: JSON.stringify({ datetime: { timeZoneMode: 'manual', timeZone: 'Mars/Olympus' } }) });
    assert(invalidTimeZone.res.status === 400, `invalid time zone should be 400, got ${invalidTimeZone.res.status}`);
    const missingManualTimeZone = await req(base, '/api/settings', { method: 'PATCH', cookie, body: JSON.stringify({ datetime: { timeZoneMode: 'manual', timeZone: null } }) });
    assert(missingManualTimeZone.res.status === 400, `manual time zone without zone should be 400, got ${missingManualTimeZone.res.status}`);
    const invalidCalendar = await req(base, '/api/settings', { method: 'PATCH', cookie, body: JSON.stringify({ calendar: { view: 'year' } }) });
    assert(invalidCalendar.res.status === 400, `invalid calendar view should be 400, got ${invalidCalendar.res.status}`);
    const invalidMiniCalendar = await req(base, '/api/settings', { method: 'PATCH', cookie, body: JSON.stringify({ miniCalendar: { showLunar: 'maybe' } }) });
    assert(invalidMiniCalendar.res.status === 400, `invalid mini calendar setting should be 400, got ${invalidMiniCalendar.res.status}`);
    const invalidModuleOrder = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ modules: { order: ['tasks', 'tasks', 'goals', 'focus', 'calendar', 'matrix', 'habits', 'countdown'] } }),
    });
    assert(invalidModuleOrder.res.status === 400, `invalid module order should be 400, got ${invalidModuleOrder.res.status}`);
    const invalidLanguage = await req(base, '/api/settings', { method: 'PATCH', cookie, body: JSON.stringify({ localization: { language: 'fr-FR' } }) });
    assert(invalidLanguage.res.status === 400, `invalid language should be 400, got ${invalidLanguage.res.status}`);
    const invalidFocusVolume = await req(base, '/api/settings', { method: 'PATCH', cookie, body: JSON.stringify({ focus: { defaultVolume: 101 } }) });
    assert(invalidFocusVolume.res.status === 400, `invalid focus volume should be 400, got ${invalidFocusVolume.res.status}`);
    const invalidLongRestInterval = await req(base, '/api/settings', { method: 'PATCH', cookie, body: JSON.stringify({ focus: { longRestInterval: 0 } }) });
    assert(invalidLongRestInterval.res.status === 400, `invalid long-rest interval should be 400, got ${invalidLongRestInterval.res.status}`);
    const invalidFocusFadeOut = await req(base, '/api/settings', { method: 'PATCH', cookie, body: JSON.stringify({ focus: { fadeOutStop: 'yes' } }) });
    assert(invalidFocusFadeOut.res.status === 400, `invalid focus fade-out setting should be 400, got ${invalidFocusFadeOut.res.status}`);
    const invalidFocusSound = await req(base, '/api/settings', { method: 'PATCH', cookie, body: JSON.stringify({ focus: { soundId: 'missing-sound' } }) });
    assert(invalidFocusSound.res.status === 400, `invalid focus sound should be 400, got ${invalidFocusSound.res.status}`);
    const invalidNoteColor = await req(base, '/api/settings', { method: 'PATCH', cookie, body: JSON.stringify({ notes: { defaultColor: 'blue' } }) });
    assert(invalidNoteColor.res.status === 400, `invalid note color should be 400, got ${invalidNoteColor.res.status}`);

    const defaultList = await req(base, '/api/lists', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Default target list' }),
    });
    const defaultListId = defaultList.body.list.id;
    const defaultTag = await req(base, '/api/tags', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Default tag' }),
    });
    const defaultTagId = defaultTag.body.tag.id;
    const taskDefaults = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        taskDefaults: {
          defaultDate: 'tomorrow',
          dateMode: 'timeBlock',
          defaultTimeBlockStart: '10:15',
          defaultTimeBlockMinutes: 45,
          timedReminder: 'custom',
          timedReminderCustomMinutes: 10,
          priority: 3,
          listId: defaultListId,
          defaultTagIds: [defaultTagId],
        },
      }),
    });
    assert(taskDefaults.body.settings.taskDefaults.defaultDate === 'tomorrow', 'default date setting did not persist');
    assert(taskDefaults.body.settings.taskDefaults.defaultTimeBlockMinutes === 45, 'default time block duration did not persist');
    assert(taskDefaults.body.settings.taskDefaults.defaultTagIds.includes(defaultTagId), 'default tag setting did not persist');
    const quickParseDefault = await req(base, '/api/tasks/quick-parse', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ text: '明天下午3点开会 #工作 !高' }),
    });
    assert(quickParseDefault.body.draft.title === '明天下午3点开会', `quick add default title mismatch: ${quickParseDefault.body.draft.title}`);
    assert(quickParseDefault.body.draft.priority === 3, 'quick add priority parse failed');
    assert(quickParseDefault.body.draft.tags.includes('工作'), 'quick add tag parse failed');
    assert(quickParseDefault.body.draft.startDate && new Date(quickParseDefault.body.draft.startDate).getHours() === 15, 'quick add Chinese time parse failed');
    await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ quickAdd: { removeDateText: true, removeTagText: false } }),
    });
    const quickParseCleanDate = await req(base, '/api/tasks/quick-parse', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ text: '明天下午3点开会 #工作 !高' }),
    });
    assert(quickParseCleanDate.body.draft.title === '开会 #工作', `quick add cleaned title mismatch: ${quickParseCleanDate.body.draft.title}`);
    const quickParseUrl = await req(base, '/api/tasks/quick-parse', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ text: titleServer.pageUrl }),
    });
    assert(quickParseUrl.res.status === 200, `URL quick-parse should be 200, got ${quickParseUrl.res.status}`);
    assert(quickParseUrl.body.draft.title === 'Project Alpha & Launch', `URL title mismatch: ${quickParseUrl.body.draft.title}`);
    assert(quickParseUrl.body.draft.note === titleServer.pageUrl, 'URL quick-parse should preserve original URL in note');
    assert(quickParseUrl.body.tokens.some((token: any) => token.type === 'url' && token.value === titleServer.pageUrl), 'URL token missing');
    const missingUrl = await req(base, '/api/tasks/quick-parse', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ text: titleServer.missingUrl }),
    });
    assert(missingUrl.res.status === 502, `missing URL title should be 502, got ${missingUrl.res.status}`);
    await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ quickAdd: { urlParsing: false } }),
    });
    const quickParseUrlDisabled = await req(base, '/api/tasks/quick-parse', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ text: titleServer.pageUrl }),
    });
    assert(quickParseUrlDisabled.body.draft.title === titleServer.pageUrl, 'URL parsing off should keep URL as title');
    assert(quickParseUrlDisabled.body.draft.note === null, 'URL parsing off should not synthesize note');
    const defaultTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Uses task defaults' }),
    });
    assert(defaultTask.body.task.priority === 3, 'task priority did not inherit defaults');
    assert(defaultTask.body.task.listId === defaultListId, 'task list did not inherit defaults');
    assert(defaultTask.body.task.tags.some((tag: any) => tag.id === defaultTagId), 'task did not inherit default tag');
    assert(defaultTask.body.task.isAllDay === false, 'time block default should create a timed task');
    assert(defaultTask.body.task.startDate && defaultTask.body.task.dueDate, 'time block default should set start and due dates');
    const start = new Date(defaultTask.body.task.startDate);
    const due = new Date(defaultTask.body.task.dueDate);
    assert(start.getHours() === 10 && start.getMinutes() === 15, 'default time block start time was not applied');
    assert((due.getTime() - start.getTime()) / 60_000 === 45, 'default time block duration was not applied');
    assert(defaultTask.body.task.reminders.length === 1, 'timed default reminder was not created');
    assert(
      (start.getTime() - new Date(defaultTask.body.task.reminders[0].remindAt).getTime()) / 60_000 === 10,
      'timed default reminder offset was not applied',
    );

    const customDate = new Date(2031, 5, 2, 0, 0, 0, 0).toISOString();
    await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        taskDefaults: {
          defaultDate: 'custom',
          customDate,
          dateMode: 'allDay',
          allDayReminder: 'same_day',
          allDayReminderTime: '08:30',
        },
      }),
    });
    const allDayTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Uses all day defaults' }),
    });
    assert(allDayTask.body.task.isAllDay === true, 'all-day default should create an all-day task');
    assert(allDayTask.body.task.startDate === null, 'all-day default should not set startDate');
    assert(new Date(allDayTask.body.task.dueDate).toDateString() === new Date(customDate).toDateString(), 'custom default date was not applied');
    assert(allDayTask.body.task.reminders.length === 1, 'all-day default reminder was not created');
    const allDayReminder = new Date(allDayTask.body.task.reminders[0].remindAt);
    assert(allDayReminder.getHours() === 8 && allDayReminder.getMinutes() === 30, 'all-day default reminder time was not applied');

    const orderList = await req(base, '/api/lists', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Order list' }),
    });
    const orderListId = orderList.body.list.id;
    await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        taskDefaults: { defaultDate: 'none', addPosition: 'bottom', overduePosition: 'original', defaultTagIds: [] },
      }),
    });
    const createOrderedTask = (title: string, dueDate: string | null = null) =>
      req(base, '/api/tasks', {
        method: 'POST',
        cookie,
        body: JSON.stringify({ title, listId: orderListId, priority: 0, dueDate, startDate: null, isAllDay: true, tagIds: [] }),
      });
    const bottomFirst = await createOrderedTask('Bottom first');
    const bottomSecond = await createOrderedTask('Bottom second');
    await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ taskDefaults: { addPosition: 'top' } }),
    });
    const topFirst = await createOrderedTask('Top first');
    const topSecond = await createOrderedTask('Top second');
    const orderedOriginal = await req(base, `/api/tasks?listId=${orderListId}`, { cookie });
    assert(
      orderedOriginal.body.tasks.map((task: any) => task.title).join('|') === 'Top second|Top first|Bottom first|Bottom second',
      `addPosition order mismatch: ${orderedOriginal.body.tasks.map((task: any) => task.title).join('|')}`,
    );
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    await req(base, `/api/tasks/${bottomSecond.body.task.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ dueDate: yesterday, isAllDay: true }),
    });
    const orderedOverdueOriginal = await req(base, `/api/tasks?listId=${orderListId}`, { cookie });
    assert(
      orderedOverdueOriginal.body.tasks.map((task: any) => task.title).join('|') === 'Top second|Top first|Bottom first|Bottom second',
      'overdue original position should preserve list order',
    );
    await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ taskDefaults: { overduePosition: 'top' } }),
    });
    const orderedOverdueTop = await req(base, `/api/tasks?listId=${orderListId}`, { cookie });
    assert(orderedOverdueTop.body.tasks[0].id === bottomSecond.body.task.id, 'overdue top should place overdue task first');
    await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ taskDefaults: { overduePosition: 'grouped' } }),
    });
    const orderedOverdueGrouped = await req(base, `/api/tasks?listId=${orderListId}`, { cookie });
    assert(orderedOverdueGrouped.body.tasks[0].id === bottomSecond.body.task.id, 'overdue grouped should return overdue tasks first for grouping');
    const invalidAddPosition = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ taskDefaults: { addPosition: 'middle' } }),
    });
    assert(invalidAddPosition.res.status === 400, `invalid add position should be 400, got ${invalidAddPosition.res.status}`);
    const invalidOverduePosition = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ taskDefaults: { overduePosition: 'later' } }),
    });
    assert(invalidOverduePosition.res.status === 400, `invalid overdue position should be 400, got ${invalidOverduePosition.res.status}`);

    const invalidTimeBlockDuration = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ taskDefaults: { defaultTimeBlockMinutes: 17 } }),
    });
    assert(invalidTimeBlockDuration.res.status === 400, `invalid time block duration should be 400, got ${invalidTimeBlockDuration.res.status}`);
    const invalidDefaultList = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ taskDefaults: { listId: 'missing-list' } }),
    });
    assert(invalidDefaultList.res.status === 400, `invalid default list should be 400, got ${invalidDefaultList.res.status}`);
    const invalidDefaultTag = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ taskDefaults: { defaultTagIds: ['missing-tag'] } }),
    });
    assert(invalidDefaultTag.res.status === 400, `invalid default tag should be 400, got ${invalidDefaultTag.res.status}`);

    const desktop = await req(base, '/api/desktop/status', { cookie });
    assert(desktop.res.status === 200, `desktop status should be 200, got ${desktop.res.status}`);
    assert(desktop.body.status.hostAvailable === false, 'desktop web bridge should not claim a native host');

    const db = new DatabaseSync(dbPath);
    try {
      const rows = db.prepare('SELECT task_id, remind_at FROM task_reminders ORDER BY created_at ASC').all() as Array<{
        task_id: string;
        remind_at: string;
      }>;
      assert(rows.length === 2, `expected two default reminder rows, got ${rows.length}`);
      assert(rows.some((row) => row.task_id === defaultTask.body.task.id), 'timed default reminder was not written to SQLite');
      assert(rows.some((row) => row.task_id === allDayTask.body.task.id), 'all-day default reminder was not written to SQLite');
      const tagRow = db
        .prepare('SELECT COUNT(*) AS c FROM task_tags WHERE task_id = ? AND tag_id = ?')
        .get(defaultTask.body.task.id, defaultTagId) as { c: number };
      assert(tagRow.c === 1, 'default tag was not written to SQLite');
      const miniRow = db.prepare("SELECT value FROM settings WHERE key = 'miniCalendar'").get() as { value: string } | undefined;
      assert(miniRow && JSON.parse(miniRow.value).showLunar === 'on', 'mini calendar settings were not written to SQLite');
      const notificationRow = db.prepare("SELECT value FROM settings WHERE key = 'notifications'").get() as { value: string } | undefined;
      const persistedNotifications = notificationRow ? JSON.parse(notificationRow.value) : null;
      assert(persistedNotifications?.detailVisibility === 'hidden', 'notification detail visibility was not written to SQLite');
      assert(persistedNotifications?.reminderVolume === 65, 'notification reminder volume was not written to SQLite');
      assert(persistedNotifications?.taskReminders === false, 'task reminder switch was not written to SQLite');
      assert(persistedNotifications?.habitReminders === false, 'habit reminder switch was not written to SQLite');
      assert(persistedNotifications?.focusReminders === false, 'focus reminder switch was not written to SQLite');
      assert(persistedNotifications?.goalReminders === false, 'goal reminder switch was not written to SQLite');
      const focusRow = db.prepare("SELECT value FROM settings WHERE key = 'focus'").get() as { value: string } | undefined;
      assert(focusRow && JSON.parse(focusRow.value).fadeOutStop === false, 'focus fade-out setting was not written to SQLite');
      const modulesRow = db.prepare("SELECT value FROM settings WHERE key = 'modules'").get() as { value: string } | undefined;
      assert(modulesRow && JSON.parse(modulesRow.value).order?.[0] === 'tasks', 'module order settings were not written to SQLite');
      const localeRow = db.prepare("SELECT value FROM settings WHERE key = 'localization'").get() as { value: string } | undefined;
      assert(localeRow && JSON.parse(localeRow.value).language === 'en-US', 'localization settings were not written to SQLite');
      const datetimeRow = db.prepare("SELECT value FROM settings WHERE key = 'datetime'").get() as { value: string } | undefined;
      assert(datetimeRow && JSON.parse(datetimeRow.value).timeZone === 'Asia/Tokyo', 'time zone settings were not written to SQLite');
      const appearanceRow = db.prepare("SELECT value FROM settings WHERE key = 'appearance'").get() as { value: string } | undefined;
      const persistedAppearance = appearanceRow ? JSON.parse(appearanceRow.value) : null;
      assert(persistedAppearance?.sidebarBackground?.color === '#123456', 'sidebar background settings were not written to SQLite');
      assert(persistedAppearance?.appOpacity === 82, 'app opacity setting was not written to SQLite');
      const sortRows = db
        .prepare('SELECT title, sort_order FROM tasks WHERE list_id = ? ORDER BY sort_order ASC')
        .all(orderListId) as Array<{ title: string; sort_order: number }>;
      assert(sortRows[0].title === 'Top second' && sortRows[0].sort_order < sortRows[1].sort_order, 'top inserted task sort_order mismatch');
      assert(sortRows.at(-1)?.title === 'Bottom second', 'bottom inserted task sort_order mismatch');
    } finally {
      db.close();
    }
  } finally {
    await new Promise((resolvePromise) => server.close(() => resolvePromise(null)));
    const dbModule = await import(pathToFileURL(resolve(root, 'server', 'src', 'db.ts')).href);
    dbModule.db.close();
    await smtp.close();
    await titleServer.close();
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
