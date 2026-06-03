import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { db, getInboxId, nowISO } from './db';
import {
  AppError,
  type DesktopWidgetActionResultDTO,
  type DesktopWidgetDataDTO,
  type DesktopShellStateDTO,
  type DesktopShortcutDTO,
  type DesktopShortcutTemplateDTO,
  type DesktopStatusDTO,
  type DesktopWidgetDTO,
  type DesktopWidgetTemplateDTO,
} from './types';
import * as taskRepo from './repo';
import * as habitsRepo from './habitsRepo';

type WidgetRow = {
  id: string;
  type: string;
  title: string;
  config_json: string;
  position_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type ShortcutRow = {
  id: string;
  action: string;
  accelerator: string;
  enabled: number;
  registered_at: string | null;
  created_at: string;
  updated_at: string;
};

const DEFAULT_STATE: DesktopShellStateDTO = {
  startup: false,
  tray: false,
  closeBehavior: 'minimize_to_tray',
  appLock: false,
  locked: false,
  autoLockMinutes: 0,
  lastActiveAt: null,
  autoLockedAt: null,
  backgroundAudioAllowed: false,
};

const STATE_KEYS = new Set<keyof DesktopShellStateDTO>([
  'startup',
  'tray',
  'closeBehavior',
  'appLock',
  'locked',
  'autoLockMinutes',
  'lastActiveAt',
  'autoLockedAt',
  'backgroundAudioAllowed',
]);

const DEFAULT_POSITION = { x: 0, y: 0, width: 320, height: 240, screen: null as string | null };

const DEFAULT_WIDGETS: DesktopWidgetTemplateDTO[] = [
  {
    type: 'today-tasks',
    label: '今日任务',
    priority: 'P1',
    defaultTitle: '今日任务',
    defaultConfig: { range: 'today', limit: 8, allowComplete: true },
    defaultPosition: { x: 0, y: 0, width: 360, height: 280, screen: null },
  },
  {
    type: 'inbox-quick-add',
    label: '收集箱',
    priority: 'P2',
    defaultTitle: '收集箱',
    defaultConfig: { quickAdd: true, limit: 6 },
    defaultPosition: { x: 0, y: 0, width: 340, height: 220, screen: null },
  },
  {
    type: 'habit-checkin',
    label: '习惯打卡',
    priority: 'P2',
    defaultTitle: '习惯打卡',
    defaultConfig: { date: 'today', allowCheckin: true },
    defaultPosition: { x: 0, y: 0, width: 320, height: 260, screen: null },
  },
  {
    type: 'focus-timer',
    label: '番茄计时',
    priority: 'P2',
    defaultTitle: '番茄计时',
    defaultConfig: { defaultMinutes: 25, allowStartPause: true },
    defaultPosition: { x: 0, y: 0, width: 300, height: 220, screen: null },
  },
  {
    type: 'goal-progress',
    label: '目标进度',
    priority: 'P2',
    defaultTitle: '目标进度',
    defaultConfig: { limit: 5, showTodaySuggestion: true },
    defaultPosition: { x: 0, y: 0, width: 360, height: 260, screen: null },
  },
  {
    type: 'countdowns',
    label: '倒数日',
    priority: 'P2',
    defaultTitle: '倒数日',
    defaultConfig: { limit: 5, pinnedFirst: true },
    defaultPosition: { x: 0, y: 0, width: 320, height: 240, screen: null },
  },
];

const DEFAULT_SHORTCUTS: DesktopShortcutTemplateDTO[] = [
  { action: 'task.quickAdd', label: '快速添加任务', accelerator: 'CommandOrControl+N', priority: 'P1' },
  { action: 'search.open', label: '打开全局搜索', accelerator: 'CommandOrControl+F', priority: 'P1' },
  { action: 'calendar.today', label: '回到今天', accelerator: 'T', priority: 'P1' },
  { action: 'calendar.open', label: '打开日历', accelerator: 'CommandOrControl+2', priority: 'P2' },
  { action: 'focus.start', label: '开始番茄', accelerator: 'CommandOrControl+Shift+P', priority: 'P2' },
  { action: 'desktop.lock', label: '锁定 / 解锁应用', accelerator: 'Control+Shift+L', priority: 'P1' },
  { action: 'settings.open', label: '打开设置', accelerator: 'CommandOrControl+,', priority: 'P1' },
];

const RESERVED_ACCELERATORS = new Set(['ctrl+alt+delete', 'control+alt+delete', 'alt+f4']);
const PASSWORD_PREFIX = 'scrypt:v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonRecord(raw: string, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readPosition(raw: string): DesktopWidgetDTO['position'] {
  const parsed = readJsonRecord(raw, DEFAULT_POSITION);
  return {
    x: typeof parsed.x === 'number' ? parsed.x : DEFAULT_POSITION.x,
    y: typeof parsed.y === 'number' ? parsed.y : DEFAULT_POSITION.y,
    width: typeof parsed.width === 'number' ? parsed.width : DEFAULT_POSITION.width,
    height: typeof parsed.height === 'number' ? parsed.height : DEFAULT_POSITION.height,
    screen: typeof parsed.screen === 'string' ? parsed.screen : null,
  };
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function clonePosition(value: DesktopWidgetDTO['position']): DesktopWidgetDTO['position'] {
  return { ...value };
}

function getPasswordHash(userId: string): string | null {
  const row = db.prepare('SELECT password_hash FROM desktop_app_lock_credentials WHERE user_id = ?').get(userId) as
    | { password_hash: string }
    | undefined;
  return row?.password_hash ?? null;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password, salt, 64).toString('hex');
  return `${PASSWORD_PREFIX}:${salt}:${key}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const [prefix, version, salt, key] = encoded.split(':');
  if (`${prefix}:${version}` !== PASSWORD_PREFIX || !salt || !key) return false;
  const expected = Buffer.from(key, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function assertPasswordInput(value: unknown, field = 'password'): asserts value is string {
  if (typeof value !== 'string' || value.length < 4 || value.length > 128) {
    throw new AppError(400, 'invalid_app_lock_password', `${field} must be 4 to 128 characters`);
  }
}

function requirePasswordMatch(userId: string, password: unknown): void {
  const stored = getPasswordHash(userId);
  if (!stored) return;
  if (typeof password !== 'string' || !verifyPassword(password, stored)) {
    throw new AppError(401, 'invalid_app_lock_password', 'app lock password is incorrect');
  }
}

function widgetTemplateFor(type: string): DesktopWidgetTemplateDTO | undefined {
  return DEFAULT_WIDGETS.find((widget) => widget.type === type);
}

function normalizeWidgetType(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(400, 'invalid_desktop_widget', 'type is required');
  }
  const type = value.trim();
  if (!widgetTemplateFor(type)) throw new AppError(400, 'invalid_desktop_widget', `unknown widget type: ${type}`);
  return type;
}

function integerConfig(config: Record<string, unknown>, key: string, min: number, max: number): void {
  const value = config[key];
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new AppError(400, 'invalid_desktop_widget', `config.${key} must be an integer between ${min} and ${max}`);
  }
}

function booleanConfig(config: Record<string, unknown>, key: string): void {
  if (typeof config[key] !== 'boolean') throw new AppError(400, 'invalid_desktop_widget', `config.${key} must be boolean`);
}

function enumConfig(config: Record<string, unknown>, key: string, allowed: string[]): void {
  if (typeof config[key] !== 'string' || !allowed.includes(config[key] as string)) {
    throw new AppError(400, 'invalid_desktop_widget', `config.${key} is invalid`);
  }
}

function assertConfigKeys(type: string, config: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(config)) {
    if (!allowed.includes(key)) throw new AppError(400, 'invalid_desktop_widget', `${type} does not support config.${key}`);
  }
}

function normalizeWidgetConfig(type: string, value: unknown, existing?: Record<string, unknown>): Record<string, unknown> {
  const template = widgetTemplateFor(type);
  if (!template) throw new AppError(400, 'invalid_desktop_widget', `unknown widget type: ${type}`);
  if (value != null && !isRecord(value)) throw new AppError(400, 'invalid_desktop_widget', 'config must be an object');
  const config = {
    ...cloneRecord(template.defaultConfig),
    ...(existing ? cloneRecord(existing) : {}),
    ...(value ? value : {}),
  };
  switch (type) {
    case 'today-tasks':
      assertConfigKeys(type, config, ['range', 'limit', 'allowComplete']);
      enumConfig(config, 'range', ['today']);
      integerConfig(config, 'limit', 1, 50);
      booleanConfig(config, 'allowComplete');
      break;
    case 'inbox-quick-add':
      assertConfigKeys(type, config, ['quickAdd', 'limit']);
      booleanConfig(config, 'quickAdd');
      integerConfig(config, 'limit', 1, 50);
      break;
    case 'habit-checkin':
      assertConfigKeys(type, config, ['date', 'allowCheckin']);
      enumConfig(config, 'date', ['today']);
      booleanConfig(config, 'allowCheckin');
      break;
    case 'focus-timer':
      assertConfigKeys(type, config, ['defaultMinutes', 'allowStartPause']);
      integerConfig(config, 'defaultMinutes', 1, 180);
      booleanConfig(config, 'allowStartPause');
      break;
    case 'goal-progress':
      assertConfigKeys(type, config, ['limit', 'showTodaySuggestion']);
      integerConfig(config, 'limit', 1, 50);
      booleanConfig(config, 'showTodaySuggestion');
      break;
    case 'countdowns':
      assertConfigKeys(type, config, ['limit', 'pinnedFirst']);
      integerConfig(config, 'limit', 1, 50);
      booleanConfig(config, 'pinnedFirst');
      break;
    default:
      throw new AppError(400, 'invalid_desktop_widget', `unknown widget type: ${type}`);
  }
  return config;
}

function normalizePosition(value: unknown, existing = DEFAULT_POSITION): DesktopWidgetDTO['position'] {
  if (value == null) return existing;
  if (!isRecord(value)) throw new AppError(400, 'invalid_desktop_widget', 'position must be an object');
  const next = { ...existing };
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (value[key] == null) continue;
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
      throw new AppError(400, 'invalid_desktop_widget', `position.${key} must be a number`);
    }
    next[key] = value[key];
  }
  if (next.width <= 0 || next.height <= 0) {
    throw new AppError(400, 'invalid_desktop_widget', 'position width and height must be positive');
  }
  if (value.screen != null) {
    if (typeof value.screen !== 'string') throw new AppError(400, 'invalid_desktop_widget', 'position.screen must be a string');
    next.screen = value.screen;
  }
  return next;
}

function normalizeShortcutAction(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(400, 'invalid_desktop_shortcut', 'action is required');
  }
  return value.trim();
}

function normalizeAccelerator(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(400, 'invalid_desktop_shortcut', 'accelerator is required');
  }
  const accelerator = value.trim().replace(/\s+/g, '');
  if (RESERVED_ACCELERATORS.has(accelerator.toLowerCase())) {
    throw new AppError(409, 'desktop_shortcut_reserved', 'shortcut accelerator is reserved by the system');
  }
  return accelerator;
}

function acceleratorKey(accelerator: string): string {
  return accelerator.toLowerCase().replace(/\s+/g, '').replace(/cmdorctrl/g, 'commandorcontrol');
}

function assertShortcutAvailable(userId: string, action: string, accelerator: string, exceptId?: string): void {
  const rows = db
    .prepare('SELECT id, action, accelerator FROM desktop_shortcuts WHERE user_id = ?')
    .all(userId) as Array<Pick<ShortcutRow, 'id' | 'action' | 'accelerator'>>;
  const wanted = acceleratorKey(accelerator);
  for (const row of rows) {
    if (row.id === exceptId) continue;
    if (row.action === action) throw new AppError(409, 'desktop_shortcut_exists', 'shortcut action already exists');
    if (acceleratorKey(row.accelerator) === wanted) {
      throw new AppError(409, 'desktop_shortcut_conflict', 'shortcut accelerator already exists');
    }
  }
}

function insertShortcut(userId: string, action: string, accelerator: string, enabled: boolean, ts: string): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO desktop_shortcuts (id, user_id, action, accelerator, enabled, registered_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(id, userId, action, accelerator, enabled ? 1 : 0, ts, ts);
  return id;
}

function mapWidget(row: WidgetRow): DesktopWidgetDTO {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    config: readJsonRecord(row.config_json, {}),
    position: readPosition(row.position_json),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireWidget(userId: string, id: string): DesktopWidgetDTO {
  const widget = getWidget(userId, id);
  if (!widget) throw new AppError(404, 'not_found', 'widget not found');
  return widget;
}

function localTodayStartMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function localDateString(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dayOfWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function todayTasksWidgetData(userId: string, widget: DesktopWidgetDTO): DesktopWidgetDataDTO {
  const allTasks = taskRepo.getTasks(userId, { view: 'today' });
  const limit = Number(widget.config.limit);
  const tasks = allTasks.slice(0, Number.isInteger(limit) && limit > 0 ? limit : 8);
  const todayStart = localTodayStartMs();
  return {
    type: 'today-tasks',
    widget,
    generatedAt: nowISO(),
    tasks,
    counts: {
      shown: tasks.length,
      total: allTasks.length,
      overdue: allTasks.filter((task) => task.dueDate && Date.parse(task.dueDate) < todayStart).length,
    },
    allowComplete: widget.config.allowComplete === true,
  };
}

function inboxQuickAddWidgetData(userId: string, widget: DesktopWidgetDTO): DesktopWidgetDataDTO {
  const allTasks = taskRepo.getTasks(userId, { view: 'inbox' });
  const limit = Number(widget.config.limit);
  const tasks = allTasks.slice(0, Number.isInteger(limit) && limit > 0 ? limit : 6);
  return {
    type: 'inbox-quick-add',
    widget,
    generatedAt: nowISO(),
    tasks,
    counts: {
      shown: tasks.length,
      total: allTasks.length,
    },
    quickAdd: widget.config.quickAdd === true,
  };
}

function habitsForWidgetDate(userId: string, date: string) {
  const dow = dayOfWeek(date);
  return habitsRepo.listHabits(userId, date, date).filter((habit) => habit.daysOfWeek.includes(dow));
}

function habitCheckinWidgetData(userId: string, widget: DesktopWidgetDTO): DesktopWidgetDataDTO {
  const date = localDateString();
  const habits = habitsForWidgetDate(userId, date);
  return {
    type: 'habit-checkin',
    widget,
    generatedAt: nowISO(),
    date,
    habits,
    counts: {
      shown: habits.length,
      total: habits.length,
      checked: habits.filter((habit) => habit.checkins.includes(date)).length,
    },
    allowCheckin: widget.config.allowCheckin === true,
  };
}

export function getWidgetData(userId: string, id: string): DesktopWidgetDataDTO {
  const widget = requireWidget(userId, id);
  if (!widget.enabled) throw new AppError(409, 'desktop_widget_disabled', 'widget is disabled');
  if (widget.type === 'today-tasks') return todayTasksWidgetData(userId, widget);
  if (widget.type === 'inbox-quick-add') return inboxQuickAddWidgetData(userId, widget);
  if (widget.type === 'habit-checkin') return habitCheckinWidgetData(userId, widget);
  throw new AppError(501, 'desktop_widget_data_not_implemented', `${widget.type} widget data is not implemented`);
}

export function runWidgetAction(userId: string, id: string, input: unknown): DesktopWidgetActionResultDTO {
  if (!isRecord(input)) throw new AppError(400, 'invalid_desktop_widget_action', 'body must be an object');
  const widget = requireWidget(userId, id);
  if (!widget.enabled) throw new AppError(409, 'desktop_widget_disabled', 'widget is disabled');
  if (widget.type === 'inbox-quick-add') {
    if (input.action !== 'quick_add_task') {
      throw new AppError(400, 'invalid_desktop_widget_action', 'action must be quick_add_task');
    }
    if (widget.config.quickAdd !== true) {
      throw new AppError(409, 'desktop_widget_action_disabled', 'quick add is disabled for this widget');
    }
    if (typeof input.text !== 'string' || !input.text.trim()) {
      throw new AppError(400, 'invalid_desktop_widget_action', 'text is required');
    }
    const task = taskRepo.createTask(userId, {
      title: input.text.trim(),
      listId: getInboxId(userId),
      source: 'desktop_widget',
    });
    return { widget, task, data: inboxQuickAddWidgetData(userId, widget) };
  }
  if (widget.type === 'habit-checkin') {
    if (input.action !== 'toggle_habit') {
      throw new AppError(400, 'invalid_desktop_widget_action', 'action must be toggle_habit');
    }
    if (widget.config.allowCheckin !== true) {
      throw new AppError(409, 'desktop_widget_action_disabled', 'habit check-in is disabled for this widget');
    }
    if (typeof input.habitId !== 'string' || !input.habitId.trim()) {
      throw new AppError(400, 'invalid_desktop_widget_action', 'habitId is required');
    }
    const value =
      input.value == null
        ? null
        : typeof input.value === 'number' && Number.isFinite(input.value)
          ? input.value
          : undefined;
    if (value === undefined) throw new AppError(400, 'invalid_desktop_widget_action', 'value must be a number or null');
    if (input.note != null && typeof input.note !== 'string') {
      throw new AppError(400, 'invalid_desktop_widget_action', 'note must be a string or null');
    }
    const date = localDateString();
    const visibleHabitIds = new Set(habitsForWidgetDate(userId, date).map((habit) => habit.id));
    if (!visibleHabitIds.has(input.habitId)) throw new AppError(404, 'not_found', 'habit not found in widget data');
    const checkin = habitsRepo.toggleCheckin(userId, input.habitId, date, value, input.note ?? null);
    const habit = habitsRepo.getHabit(userId, input.habitId, date, date);
    if (!habit) throw new AppError(404, 'not_found', 'habit not found');
    return { widget, habit, checkin, data: habitCheckinWidgetData(userId, widget) };
  }
  if (widget.type !== 'today-tasks') {
    throw new AppError(501, 'desktop_widget_action_not_implemented', `${widget.type} widget actions are not implemented`);
  }
  if (input.action !== 'complete_task') {
    throw new AppError(400, 'invalid_desktop_widget_action', 'action must be complete_task');
  }
  if (widget.config.allowComplete !== true) {
    throw new AppError(409, 'desktop_widget_action_disabled', 'task completion is disabled for this widget');
  }
  if (typeof input.taskId !== 'string' || !input.taskId.trim()) {
    throw new AppError(400, 'invalid_desktop_widget_action', 'taskId is required');
  }
  const todayIds = new Set(taskRepo.getTasks(userId, { view: 'today' }).map((task) => task.id));
  if (!todayIds.has(input.taskId)) throw new AppError(404, 'not_found', 'task not found in widget data');
  const task = taskRepo.updateTask(userId, input.taskId, { completed: true });
  if (!task) throw new AppError(404, 'not_found', 'task not found');
  return { widget, task, data: todayTasksWidgetData(userId, widget) };
}

function mapShortcut(row: ShortcutRow): DesktopShortcutDTO {
  return {
    id: row.id,
    action: row.action,
    accelerator: row.accelerator,
    enabled: row.enabled === 1,
    registeredAt: row.registered_at,
    hostRegistered: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isStateKey(key: string): key is keyof DesktopShellStateDTO {
  return STATE_KEYS.has(key as keyof DesktopShellStateDTO);
}

function normalizeStateValue(key: keyof DesktopShellStateDTO, value: unknown): DesktopShellStateDTO[keyof DesktopShellStateDTO] {
  switch (key) {
    case 'startup':
    case 'tray':
    case 'appLock':
    case 'locked':
    case 'backgroundAudioAllowed':
      if (typeof value !== 'boolean') throw new AppError(400, 'invalid_desktop_state', `${key} must be boolean`);
      return value;
    case 'closeBehavior':
      if (value !== 'minimize_to_tray' && value !== 'quit') {
        throw new AppError(400, 'invalid_desktop_state', 'closeBehavior must be minimize_to_tray or quit');
      }
      return value;
    case 'autoLockMinutes':
      if (![0, 1, 5, 10].includes(value as number)) {
        throw new AppError(400, 'invalid_desktop_state', 'autoLockMinutes must be 0, 1, 5 or 10');
      }
      return value as 0 | 1 | 5 | 10;
    case 'lastActiveAt':
    case 'autoLockedAt':
      if (value != null && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) {
        throw new AppError(400, 'invalid_desktop_state', `${key} must be an ISO date string or null`);
      }
      return value as string | null;
    default:
      return value as never;
  }
}

function writeStateValue(userId: string, key: keyof DesktopShellStateDTO, value: DesktopShellStateDTO[keyof DesktopShellStateDTO], ts = nowISO()): void {
  db.prepare(
    `INSERT INTO desktop_shell_state (user_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(userId, key, JSON.stringify(value), ts);
}

export function getDesktopState(userId: string): DesktopShellStateDTO {
  const state = { ...DEFAULT_STATE };
  const rows = db.prepare('SELECT key, value_json FROM desktop_shell_state WHERE user_id = ?').all(userId) as Array<{
    key: string;
    value_json: string;
  }>;
  for (const row of rows) {
    if (!isStateKey(row.key)) continue;
    try {
      const value = JSON.parse(row.value_json);
      state[row.key] = normalizeStateValue(row.key, value) as never;
    } catch {
      // Ignore malformed legacy values and keep the default.
    }
  }
  return state;
}

export function getDesktopStatus(userId: string): DesktopStatusDTO {
  const row = db
    .prepare(
      `SELECT MAX(updated_at) updatedAt FROM (
        SELECT updated_at FROM desktop_shell_state WHERE user_id = ?
        UNION ALL SELECT updated_at FROM desktop_widgets WHERE user_id = ?
        UNION ALL SELECT updated_at FROM desktop_shortcuts WHERE user_id = ?
      )`,
    )
    .get(userId, userId, userId) as { updatedAt: string | null } | undefined;
  return {
    hostAvailable: false,
    hostAdapter: 'web-bridge',
    appLockPasswordSet: !!getPasswordHash(userId),
    capabilities: {
      widgets: 'persisted',
      globalShortcuts: 'host_required',
      startup: 'persisted',
      tray: 'persisted',
      closeBehavior: 'persisted',
      appLock: 'persisted',
      autoLock: 'web_bridge',
      systemCalendar: 'calendar_subscriptions',
      backgroundAudio: 'web_only',
    },
    state: getDesktopState(userId),
    updatedAt: row?.updatedAt ?? null,
  };
}

export function patchDesktopState(userId: string, patch: unknown): DesktopStatusDTO {
  if (!isRecord(patch)) throw new AppError(400, 'invalid_desktop_state', 'state patch must be an object');
  const ts = nowISO();
  for (const [key, value] of Object.entries(patch)) {
    if (!isStateKey(key)) throw new AppError(400, 'invalid_desktop_state', `unknown desktop state key: ${key}`);
    writeStateValue(userId, key, normalizeStateValue(key, value), ts);
  }
  return getDesktopStatus(userId);
}

export function recordBridgeActivity(userId: string, occurredAt = nowISO()): DesktopStatusDTO {
  const activeAt = normalizeStateValue('lastActiveAt', occurredAt) as string;
  writeStateValue(userId, 'lastActiveAt', activeAt);
  const state = getDesktopState(userId);
  if (!state.locked) writeStateValue(userId, 'autoLockedAt', null);
  return getDesktopStatus(userId);
}

export function evaluateAutoLock(userId: string): DesktopStatusDTO {
  const state = getDesktopState(userId);
  if (!state.appLock || state.locked || state.autoLockMinutes === 0 || !state.lastActiveAt) return getDesktopStatus(userId);
  const idleMs = Date.now() - new Date(state.lastActiveAt).getTime();
  if (idleMs >= state.autoLockMinutes * 60_000) {
    const ts = nowISO();
    writeStateValue(userId, 'locked', true, ts);
    writeStateValue(userId, 'autoLockedAt', ts, ts);
  }
  return getDesktopStatus(userId);
}

export function resolveWindowCloseIntent(userId: string): { action: 'minimize_to_tray' | 'quit'; status: DesktopStatusDTO } {
  const status = getDesktopStatus(userId);
  return { action: status.state.closeBehavior, status };
}

export function setAppLockPassword(userId: string, input: unknown): DesktopStatusDTO {
  if (!isRecord(input)) throw new AppError(400, 'invalid_app_lock_password', 'body must be an object');
  const current = getPasswordHash(userId);
  if (current) requirePasswordMatch(userId, input.currentPassword);
  assertPasswordInput(input.password);
  const ts = nowISO();
  db.prepare(
    `INSERT INTO desktop_app_lock_credentials (user_id, password_hash, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
  ).run(userId, hashPassword(input.password), ts);
  writeStateValue(userId, 'appLock', true, ts);
  writeStateValue(userId, 'locked', false, ts);
  writeStateValue(userId, 'autoLockedAt', null, ts);
  writeStateValue(userId, 'lastActiveAt', ts, ts);
  return getDesktopStatus(userId);
}

export function clearAppLockPassword(userId: string, input: unknown): DesktopStatusDTO {
  if (!isRecord(input)) throw new AppError(400, 'invalid_app_lock_password', 'body must be an object');
  requirePasswordMatch(userId, input.currentPassword);
  db.prepare('DELETE FROM desktop_app_lock_credentials WHERE user_id = ?').run(userId);
  const ts = nowISO();
  writeStateValue(userId, 'appLock', false, ts);
  writeStateValue(userId, 'locked', false, ts);
  writeStateValue(userId, 'autoLockedAt', null, ts);
  return getDesktopStatus(userId);
}

export function listWidgets(userId: string): DesktopWidgetDTO[] {
  return (
    db
      .prepare('SELECT * FROM desktop_widgets WHERE user_id = ? ORDER BY enabled DESC, updated_at DESC')
      .all(userId) as WidgetRow[]
  ).map(mapWidget);
}

export function listWidgetTemplates(): DesktopWidgetTemplateDTO[] {
  return DEFAULT_WIDGETS.map((widget) => ({
    ...widget,
    defaultConfig: cloneRecord(widget.defaultConfig),
    defaultPosition: clonePosition(widget.defaultPosition),
  }));
}

export function createWidget(userId: string, input: Record<string, unknown>): DesktopWidgetDTO {
  const type = normalizeWidgetType(input.type);
  const template = widgetTemplateFor(type)!;
  const title = input.title == null ? template.defaultTitle : String(input.title).trim();
  if (!title) {
    throw new AppError(400, 'invalid_desktop_widget', 'title is required');
  }
  const id = randomUUID();
  const ts = nowISO();
  const widget = {
    id,
    type,
    title,
    config: normalizeWidgetConfig(type, input.config),
    position: normalizePosition(input.position, template.defaultPosition),
    enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
    createdAt: ts,
    updatedAt: ts,
  };
  db.prepare(
    `INSERT INTO desktop_widgets (id, user_id, type, title, config_json, position_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    widget.id,
    userId,
    widget.type,
    widget.title,
    JSON.stringify(widget.config),
    JSON.stringify(widget.position),
    widget.enabled ? 1 : 0,
    widget.createdAt,
    widget.updatedAt,
  );
  return widget;
}

export function getWidget(userId: string, id: string): DesktopWidgetDTO | null {
  const row = db.prepare('SELECT * FROM desktop_widgets WHERE user_id = ? AND id = ?').get(userId, id) as WidgetRow | undefined;
  return row ? mapWidget(row) : null;
}

export function updateWidget(userId: string, id: string, patch: Record<string, unknown>): DesktopWidgetDTO | null {
  const existing = getWidget(userId, id);
  if (!existing) return null;
  const title = patch.title == null ? existing.title : String(patch.title).trim();
  if (!title) throw new AppError(400, 'invalid_desktop_widget', 'title is required');
  const type = patch.type == null ? normalizeWidgetType(existing.type) : normalizeWidgetType(patch.type);
  const template = widgetTemplateFor(type)!;
  const enabled = patch.enabled == null ? existing.enabled : patch.enabled;
  if (typeof enabled !== 'boolean') throw new AppError(400, 'invalid_desktop_widget', 'enabled must be boolean');
  const configBase = type === existing.type ? existing.config : undefined;
  const config = normalizeWidgetConfig(type, patch.config, configBase);
  const positionBase = type === existing.type ? existing.position : template.defaultPosition;
  const position = normalizePosition(patch.position, positionBase);
  const ts = nowISO();
  db.prepare(
    `UPDATE desktop_widgets
     SET type = ?, title = ?, config_json = ?, position_json = ?, enabled = ?, updated_at = ?
     WHERE user_id = ? AND id = ?`,
  ).run(type, title, JSON.stringify(config), JSON.stringify(position), enabled ? 1 : 0, ts, userId, id);
  return getWidget(userId, id);
}

export function deleteWidget(userId: string, id: string): boolean {
  return db.prepare('DELETE FROM desktop_widgets WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
}

export function listShortcuts(userId: string): DesktopShortcutDTO[] {
  return (
    db
      .prepare('SELECT * FROM desktop_shortcuts WHERE user_id = ? ORDER BY enabled DESC, updated_at DESC')
      .all(userId) as ShortcutRow[]
  ).map(mapShortcut);
}

export function listShortcutTemplates(): DesktopShortcutTemplateDTO[] {
  return DEFAULT_SHORTCUTS.map((shortcut) => ({ ...shortcut }));
}

export function createShortcut(userId: string, input: Record<string, unknown>): DesktopShortcutDTO {
  const action = normalizeShortcutAction(input.action);
  const accelerator = normalizeAccelerator(input.accelerator);
  assertShortcutAvailable(userId, action, accelerator);
  const ts = nowISO();
  const id = insertShortcut(userId, action, accelerator, input.enabled !== false, ts);
  return getShortcut(userId, id)!;
}

export function getShortcut(userId: string, id: string): DesktopShortcutDTO | null {
  const row = db.prepare('SELECT * FROM desktop_shortcuts WHERE user_id = ? AND id = ?').get(userId, id) as ShortcutRow | undefined;
  return row ? mapShortcut(row) : null;
}

export function updateShortcut(userId: string, id: string, patch: Record<string, unknown>): DesktopShortcutDTO | null {
  const existing = getShortcut(userId, id);
  if (!existing) return null;
  const action = patch.action == null ? existing.action : normalizeShortcutAction(patch.action);
  const accelerator = patch.accelerator == null ? existing.accelerator : normalizeAccelerator(patch.accelerator);
  const enabled = patch.enabled == null ? existing.enabled : patch.enabled;
  if (typeof enabled !== 'boolean') throw new AppError(400, 'invalid_desktop_shortcut', 'enabled must be boolean');
  assertShortcutAvailable(userId, action, accelerator, id);
  const ts = nowISO();
  db.prepare(
    `UPDATE desktop_shortcuts SET action = ?, accelerator = ?, enabled = ?, updated_at = ? WHERE user_id = ? AND id = ?`,
  ).run(action, accelerator, enabled ? 1 : 0, ts, userId, id);
  return getShortcut(userId, id);
}

export function resetShortcuts(userId: string): DesktopShortcutDTO[] {
  const ts = nowISO();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM desktop_shortcuts WHERE user_id = ?').run(userId);
    for (const shortcut of DEFAULT_SHORTCUTS) {
      insertShortcut(userId, shortcut.action, shortcut.accelerator, true, ts);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return listShortcuts(userId);
}

export function deleteShortcut(userId: string, id: string): boolean {
  return db.prepare('DELETE FROM desktop_shortcuts WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
}

export function registerShortcut(userId: string, id: string): DesktopShortcutDTO | null {
  const existing = getShortcut(userId, id);
  if (!existing) return null;
  if (!existing.enabled) throw new AppError(409, 'desktop_shortcut_disabled', 'shortcut is disabled');
  const ts = nowISO();
  db.prepare('UPDATE desktop_shortcuts SET registered_at = ?, updated_at = ? WHERE user_id = ? AND id = ?').run(ts, ts, userId, id);
  return getShortcut(userId, id);
}

export function setBridgeLock(userId: string, locked: boolean, input: unknown = {}): DesktopStatusDTO {
  if (!locked) requirePasswordMatch(userId, isRecord(input) ? input.password : undefined);
  const status = patchDesktopState(userId, { locked, autoLockedAt: null, ...(locked ? {} : { lastActiveAt: nowISO() }) });
  return status;
}
