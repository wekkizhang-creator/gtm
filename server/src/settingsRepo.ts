// Account-scoped settings store (KV table). Returns defaults deep-merged with stored values.
// The AI API key is stored obfuscated and never returned in full (only last-4 mask).
import { db, nowISO } from './db';
import { AppError, type Settings } from './types';

const DEFAULTS: Settings = {
  account: {},
  notifications: {
    enabled: true,
    email: true,
    desktop: false,
    doNotDisturb: false,
    doNotDisturbStart: '22:00',
    doNotDisturbEnd: '08:00',
    reminderSound: 'default',
    reminderSoundId: null,
    detailVisibility: 'when_unlocked',
    completionSound: 'ding',
    completionSoundId: null,
    reminderVolume: 70,
    taskReminders: true,
    habitReminders: true,
    focusReminders: true,
    goalReminders: true,
  },
  focus: {
    defaultMinutes: 25,
    restMinutes: 5,
    longRestMinutes: 15,
    longRestInterval: 4,
    soundId: null,
    defaultVolume: 50,
    pauseSoundOnPause: true,
    playSoundDuringRest: false,
    backgroundAudioAllowed: true,
    autoCacheSounds: false,
    fadeOutStop: true,
  },
  quickAdd: {
    defaultListId: null,
    parseEnabled: true,
    dateRecognition: true,
    removeDateText: false,
    tagRecognition: true,
    removeTagText: true,
    urlParsing: true,
  },
  miniCalendar: { enabled: true, showLunar: 'follow', showWeekNumbers: false },
  imports: { lastSource: null },
  calendar: { view: '3day' },
  notes: {
    enabled: true,
    defaultColor: '#fff2a8',
    defaultOpacity: 95,
    defaultFontSize: 'normal',
    defaultPinned: false,
    defaultPosition: { x: 40, y: 40, width: 300, height: 220 },
  },
  widgets: { enabled: false },
  shortcuts: { enabled: false },
  desktop: { startup: false, tray: false, appLock: false },
  localization: { language: 'system' },
  appearance: {
    themeMode: 'system',
    accent: '#c96442',
    fontSize: 'normal',
    density: 'standard',
    animations: true,
    sidebarBackground: { type: 'default', color: '#f0eee6', imageUrl: null },
    appOpacity: 100,
  },
  datetime: { weekStart: 1, timeFormat: 'system', showLunar: true, showHolidayAdjustments: true, timeZoneMode: 'system', timeZone: null },
  modules: { hidden: [], defaultLaunch: 'tasks', order: ['goals', 'tasks', 'calendar', 'matrix', 'focus', 'habits', 'countdown', 'notes'] },
  smartLists: { hidden: [] },
  taskDefaults: {
    priority: 0,
    listId: null,
    defaultDate: 'none',
    customDate: null,
    dateMode: 'date',
    defaultTimeBlockMinutes: 30,
    defaultTimeBlockStart: '09:00',
    timedReminder: '30m_before',
    timedReminderCustomMinutes: 30,
    allDayReminder: '1d_before',
    allDayReminderTime: '09:00',
    defaultTagIds: [],
    addPosition: 'top',
    overduePosition: 'top',
  },
  ai: { enabled: false, provider: '', baseUrl: '', model: '', hasApiKey: false, apiKeyMasked: '' },
};

const GROUPS = [
  'account',
  'notifications',
  'focus',
  'quickAdd',
  'miniCalendar',
  'imports',
  'calendar',
  'notes',
  'widgets',
  'shortcuts',
  'desktop',
  'localization',
  'appearance',
  'datetime',
  'modules',
  'smartLists',
  'taskDefaults',
] as const;
const AI_KEY_ROW = 'ai.apiKey';
const MODULE_KEYS = ['goals', 'tasks', 'calendar', 'matrix', 'focus', 'habits', 'countdown', 'notes'] as const;

function readRow(userId: string, key: string): string | null {
  const r = db.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?').get(userId, key) as { value: string } | undefined;
  return r ? r.value : null;
}

function writeRow(userId: string, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(userId, key, value, nowISO());
}

export function initializeDefaultSettings(userId: string): void {
  const defaults: Settings = JSON.parse(JSON.stringify(DEFAULTS));
  for (const group of GROUPS) {
    writeRow(userId, group, JSON.stringify(defaults[group]));
  }
}

function readGroup(userId: string, key: string): Record<string, unknown> {
  const raw = readRow(userId, key);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function ob(s: string): string {
  return 'b64:' + Buffer.from(s, 'utf8').toString('base64');
}
function deob(s: string): string {
  return s.startsWith('b64:') ? Buffer.from(s.slice(4), 'base64').toString('utf8') : s;
}
function mask(key: string): string {
  if (!key) return '';
  return key.length <= 4 ? '****' : '****' + key.slice(-4);
}

export function getSettings(userId: string): Settings {
  const out: Settings = JSON.parse(JSON.stringify(DEFAULTS));
  for (const g of GROUPS) Object.assign(out[g], readGroup(userId, g));
  const notePosition = out.notes.defaultPosition as unknown;
  out.notes.defaultPosition = {
    ...DEFAULTS.notes.defaultPosition,
    ...(notePosition && typeof notePosition === 'object' && !Array.isArray(notePosition) ? notePosition : {}),
  };
  const sidebarBackground = out.appearance.sidebarBackground as unknown;
  out.appearance.sidebarBackground = {
    ...DEFAULTS.appearance.sidebarBackground,
    ...(sidebarBackground && typeof sidebarBackground === 'object' && !Array.isArray(sidebarBackground) ? sidebarBackground : {}),
  };
  if (!Number.isInteger(out.appearance.appOpacity)) out.appearance.appOpacity = DEFAULTS.appearance.appOpacity;
  if (!Number.isInteger(out.notifications.reminderVolume)) out.notifications.reminderVolume = DEFAULTS.notifications.reminderVolume;
  out.modules.order = normalizeModuleOrder(out.modules.order);
  const defaultTagIds = Array.isArray(out.taskDefaults.defaultTagIds) ? out.taskDefaults.defaultTagIds : [];
  out.taskDefaults.defaultTagIds = defaultTagIds.filter((tagId): tagId is string => {
    if (typeof tagId !== 'string') return false;
    return !!db.prepare('SELECT id FROM tags WHERE user_id = ? AND id = ?').get(userId, tagId);
  });
  Object.assign(out.ai, readGroup(userId, 'ai'));
  const keyRaw = readRow(userId, AI_KEY_ROW);
  if (keyRaw) {
    const real = deob(keyRaw);
    out.ai.hasApiKey = !!real;
    out.ai.apiKeyMasked = mask(real);
  }
  delete (out.ai as Record<string, unknown>).apiKey;
  return out;
}

export function patchSettings(userId: string, patch: Record<string, any>): Settings {
  const allowed = new Set<string>([...GROUPS, 'ai']);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new AppError(400, 'invalid_settings_group', `unknown settings group: ${key}`);
  }
  validatePatch(userId, patch);
  for (const g of GROUPS) {
    if (patch[g] && typeof patch[g] === 'object') {
      writeRow(userId, g, JSON.stringify({ ...readGroup(userId, g), ...patch[g] }));
    }
  }
  if (patch.ai && typeof patch.ai === 'object') {
    const { apiKey, ...rest } = patch.ai;
    if (Object.keys(rest).length) writeRow(userId, 'ai', JSON.stringify({ ...readGroup(userId, 'ai'), ...rest }));
    if (typeof apiKey === 'string') {
      if (apiKey === '') db.prepare('DELETE FROM settings WHERE user_id = ? AND key = ?').run(userId, AI_KEY_ROW);
      else writeRow(userId, AI_KEY_ROW, ob(apiKey));
    }
  }
  return getSettings(userId);
}

function oneOf(value: unknown, allowed: readonly unknown[], field: string): void {
  if (value != null && !allowed.includes(value)) throw new AppError(400, 'invalid_settings_value', `${field} is invalid`);
}

function validTime(value: unknown, field: string): void {
  if (value != null && (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))) {
    throw new AppError(400, 'invalid_settings_value', `${field} must be HH:mm`);
  }
}

function validTimeZone(value: unknown, field: string): void {
  if (value == null) return;
  if (typeof value !== 'string' || !value.trim()) throw new AppError(400, 'invalid_settings_value', `${field} must be an IANA time zone`);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
  } catch {
    throw new AppError(400, 'invalid_settings_value', `${field} must be an IANA time zone`);
  }
}

function bool(value: unknown, field: string): void {
  if (value != null && typeof value !== 'boolean') throw new AppError(400, 'invalid_settings_value', `${field} must be boolean`);
}

function normalizeModuleOrder(value: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const input = Array.isArray(value) ? value : [];
  for (const key of input) {
    if (typeof key === 'string' && (MODULE_KEYS as readonly string[]).includes(key) && !seen.has(key)) {
      out.push(key);
      seen.add(key);
    }
  }
  for (const key of MODULE_KEYS) {
    if (!seen.has(key)) out.push(key);
  }
  return out;
}

function moduleKeyList(value: unknown, field: string, options: { allowTasks: boolean; requireAll?: boolean }): void {
  if (value == null) return;
  if (!Array.isArray(value)) throw new AppError(400, 'invalid_settings_value', `${field} must be an array`);
  const seen = new Set<string>();
  for (const key of value) {
    if (typeof key !== 'string' || !(MODULE_KEYS as readonly string[]).includes(key)) {
      throw new AppError(400, 'invalid_settings_value', `${field} contains an invalid module key`);
    }
    if (!options.allowTasks && key === 'tasks') throw new AppError(400, 'invalid_settings_value', `${field} cannot include core tasks module`);
    if (seen.has(key)) throw new AppError(400, 'invalid_settings_value', `${field} must not contain duplicate module keys`);
    seen.add(key);
  }
  if (options.requireAll && seen.size !== MODULE_KEYS.length) {
    throw new AppError(400, 'invalid_settings_value', `${field} must contain every module key exactly once`);
  }
}

function tagIdList(userId: string, value: unknown, field: string): void {
  if (value == null) return;
  if (!Array.isArray(value)) throw new AppError(400, 'invalid_settings_value', `${field} must be an array`);
  const seen = new Set<string>();
  for (const tagId of value) {
    if (typeof tagId !== 'string' || !tagId.trim()) throw new AppError(400, 'invalid_settings_value', `${field} must contain tag ids`);
    if (seen.has(tagId)) throw new AppError(400, 'invalid_settings_value', `${field} must not contain duplicate tag ids`);
    seen.add(tagId);
    const tag = db.prepare('SELECT id FROM tags WHERE user_id = ? AND id = ?').get(userId, tagId);
    if (!tag) throw new AppError(400, 'invalid_settings_value', `${field} contains an invalid tag id`);
  }
}

function integerRange(value: unknown, min: number, max: number, field: string): void {
  if (value != null && (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)) {
    throw new AppError(400, 'invalid_settings_value', `${field} must be an integer from ${min} to ${max}`);
  }
}

function color(value: unknown, field: string): void {
  if (value != null && (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value))) {
    throw new AppError(400, 'invalid_settings_value', `${field} must be a hex color`);
  }
}

function webImageUrl(value: unknown, field: string): void {
  if (value == null) return;
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) {
    throw new AppError(400, 'invalid_settings_value', `${field} must be an http or https image URL`);
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
  } catch {
    throw new AppError(400, 'invalid_settings_value', `${field} must be an http or https image URL`);
  }
}

function sidebarBackground(value: unknown, field: string): void {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, 'invalid_settings_value', `${field} must be an object`);
  }
  const bg = value as Record<string, unknown>;
  oneOf(bg.type, ['default', 'color', 'image'], `${field}.type`);
  color(bg.color, `${field}.color`);
  webImageUrl(bg.imageUrl, `${field}.imageUrl`);
  if (bg.type === 'color' && bg.color == null) {
    throw new AppError(400, 'invalid_settings_value', `${field}.color is required for color background`);
  }
  if (bg.type === 'image' && bg.imageUrl == null) {
    throw new AppError(400, 'invalid_settings_value', `${field}.imageUrl is required for image background`);
  }
}

function notificationSoundId(userId: string, value: unknown, field: string): void {
  if (value == null) return;
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(400, 'invalid_settings_value', `${field} must be a notification sound id or null`);
  }
  const sound = db.prepare('SELECT id FROM notification_sounds WHERE user_id = ? AND id = ?').get(userId, value);
  if (!sound) throw new AppError(400, 'invalid_settings_value', `${field} is invalid`);
}

function notePosition(value: unknown, field: string): void {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, 'invalid_settings_value', `${field} must be an object`);
  }
  const p = value as Record<string, unknown>;
  for (const key of ['x', 'y', 'width', 'height']) integerRange(p[key], key === 'width' ? 160 : key === 'height' ? 120 : -10000, 10000, `${field}.${key}`);
}

function validatePatch(userId: string, patch: Record<string, any>): void {
  if (patch.notifications) {
    oneOf(patch.notifications.reminderSound, ['default', 'custom'], 'notifications.reminderSound');
    notificationSoundId(userId, patch.notifications.reminderSoundId, 'notifications.reminderSoundId');
    oneOf(patch.notifications.completionSound, ['ding', 'none', 'custom'], 'notifications.completionSound');
    notificationSoundId(userId, patch.notifications.completionSoundId, 'notifications.completionSoundId');
    oneOf(patch.notifications.detailVisibility, ['when_unlocked', 'always', 'hidden'], 'notifications.detailVisibility');
    integerRange(patch.notifications.reminderVolume, 0, 100, 'notifications.reminderVolume');
    for (const key of ['taskReminders', 'habitReminders', 'focusReminders', 'goalReminders']) {
      bool(patch.notifications[key], `notifications.${key}`);
    }
    const next = { ...getSettings(userId).notifications, ...patch.notifications };
    if (next.reminderSound === 'custom' && !next.reminderSoundId) {
      throw new AppError(400, 'invalid_settings_value', 'notifications.reminderSoundId is required for a custom reminder sound');
    }
    if (next.completionSound === 'custom' && !next.completionSoundId) {
      throw new AppError(400, 'invalid_settings_value', 'notifications.completionSoundId is required for a custom completion sound');
    }
    validTime(patch.notifications.doNotDisturbStart, 'notifications.doNotDisturbStart');
    validTime(patch.notifications.doNotDisturbEnd, 'notifications.doNotDisturbEnd');
  }
  if (patch.appearance) {
    oneOf(patch.appearance.themeMode, ['light', 'dark', 'system'], 'appearance.themeMode');
    color(patch.appearance.accent, 'appearance.accent');
    oneOf(patch.appearance.fontSize, ['small', 'normal', 'large', 'xlarge'], 'appearance.fontSize');
    oneOf(patch.appearance.density, ['compact', 'standard', 'loose'], 'appearance.density');
    bool(patch.appearance.animations, 'appearance.animations');
    sidebarBackground(patch.appearance.sidebarBackground, 'appearance.sidebarBackground');
    integerRange(patch.appearance.appOpacity, 0, 100, 'appearance.appOpacity');
  }
  if (patch.localization) {
    oneOf(patch.localization.language, ['system', 'zh-CN', 'en-US'], 'localization.language');
  }
  if (patch.datetime) {
    oneOf(patch.datetime.weekStart, [0, 1], 'datetime.weekStart');
    oneOf(patch.datetime.timeFormat, ['system', '12', '24'], 'datetime.timeFormat');
    bool(patch.datetime.showLunar, 'datetime.showLunar');
    bool(patch.datetime.showHolidayAdjustments, 'datetime.showHolidayAdjustments');
    oneOf(patch.datetime.timeZoneMode, ['system', 'manual'], 'datetime.timeZoneMode');
    validTimeZone(patch.datetime.timeZone, 'datetime.timeZone');
    if (patch.datetime.timeZoneMode === 'manual' && patch.datetime.timeZone == null) {
      throw new AppError(400, 'invalid_settings_value', 'datetime.timeZone is required when manual time zone is enabled');
    }
  }
  if (patch.modules) {
    moduleKeyList(patch.modules.hidden, 'modules.hidden', { allowTasks: false });
    moduleKeyList(patch.modules.order, 'modules.order', { allowTasks: true, requireAll: true });
    oneOf(patch.modules.defaultLaunch, MODULE_KEYS, 'modules.defaultLaunch');
  }
  if (patch.calendar) oneOf(patch.calendar.view, ['day', '3day', 'week', 'month'], 'calendar.view');
  if (patch.miniCalendar) {
    bool(patch.miniCalendar.enabled, 'miniCalendar.enabled');
    oneOf(patch.miniCalendar.showLunar, ['follow', 'on', 'off'], 'miniCalendar.showLunar');
    bool(patch.miniCalendar.showWeekNumbers, 'miniCalendar.showWeekNumbers');
  }
  if (patch.quickAdd) {
    for (const key of ['parseEnabled', 'dateRecognition', 'removeDateText', 'tagRecognition', 'removeTagText', 'urlParsing']) {
      bool(patch.quickAdd[key], `quickAdd.${key}`);
    }
    if (patch.quickAdd.defaultListId != null) {
      if (typeof patch.quickAdd.defaultListId !== 'string' || !patch.quickAdd.defaultListId.trim()) {
        throw new AppError(400, 'invalid_settings_value', 'quickAdd.defaultListId must be a list id or null');
      }
      const list = db.prepare('SELECT id FROM lists WHERE user_id = ? AND id = ?').get(userId, patch.quickAdd.defaultListId);
      if (!list) throw new AppError(400, 'invalid_settings_value', 'quickAdd.defaultListId is invalid');
    }
  }
  if (patch.taskDefaults) {
    oneOf(patch.taskDefaults.priority, [0, 1, 2, 3], 'taskDefaults.priority');
    oneOf(patch.taskDefaults.defaultDate, ['none', 'today', 'tomorrow', 'custom'], 'taskDefaults.defaultDate');
    oneOf(patch.taskDefaults.dateMode, ['date', 'timeBlock', 'allDay'], 'taskDefaults.dateMode');
    oneOf(patch.taskDefaults.defaultTimeBlockMinutes, [15, 30, 45, 60], 'taskDefaults.defaultTimeBlockMinutes');
    validTime(patch.taskDefaults.defaultTimeBlockStart, 'taskDefaults.defaultTimeBlockStart');
    oneOf(patch.taskDefaults.timedReminder, ['none', 'at_start', '5m_before', '30m_before', 'custom'], 'taskDefaults.timedReminder');
    integerRange(patch.taskDefaults.timedReminderCustomMinutes, 0, 10080, 'taskDefaults.timedReminderCustomMinutes');
    oneOf(patch.taskDefaults.allDayReminder, ['none', '1d_before', 'same_day'], 'taskDefaults.allDayReminder');
    validTime(patch.taskDefaults.allDayReminderTime, 'taskDefaults.allDayReminderTime');
    tagIdList(userId, patch.taskDefaults.defaultTagIds, 'taskDefaults.defaultTagIds');
    oneOf(patch.taskDefaults.addPosition, ['top', 'bottom'], 'taskDefaults.addPosition');
    oneOf(patch.taskDefaults.overduePosition, ['top', 'original', 'grouped'], 'taskDefaults.overduePosition');
    if (patch.taskDefaults.customDate != null && (typeof patch.taskDefaults.customDate !== 'string' || Number.isNaN(Date.parse(patch.taskDefaults.customDate)))) {
      throw new AppError(400, 'invalid_settings_value', 'taskDefaults.customDate must be an ISO date string or null');
    }
    if (patch.taskDefaults.listId != null) {
      if (typeof patch.taskDefaults.listId !== 'string' || !patch.taskDefaults.listId.trim()) {
        throw new AppError(400, 'invalid_settings_value', 'taskDefaults.listId must be a list id or null');
      }
      const list = db.prepare('SELECT id FROM lists WHERE user_id = ? AND id = ?').get(userId, patch.taskDefaults.listId);
      if (!list) throw new AppError(400, 'invalid_settings_value', 'taskDefaults.listId is invalid');
    }
  }
  if (patch.notes) {
    bool(patch.notes.enabled, 'notes.enabled');
    color(patch.notes.defaultColor, 'notes.defaultColor');
    integerRange(patch.notes.defaultOpacity, 20, 100, 'notes.defaultOpacity');
    oneOf(patch.notes.defaultFontSize, ['small', 'normal', 'large', 'xlarge'], 'notes.defaultFontSize');
    bool(patch.notes.defaultPinned, 'notes.defaultPinned');
    notePosition(patch.notes.defaultPosition, 'notes.defaultPosition');
  }
  if (patch.focus) {
    for (const key of ['defaultMinutes', 'restMinutes', 'longRestMinutes', 'longRestInterval']) {
      if (patch.focus[key] != null && (!Number.isInteger(patch.focus[key]) || patch.focus[key] <= 0)) {
        throw new AppError(400, 'invalid_settings_value', `focus.${key} must be a positive integer`);
      }
    }
    integerRange(patch.focus.defaultVolume, 0, 100, 'focus.defaultVolume');
    bool(patch.focus.pauseSoundOnPause, 'focus.pauseSoundOnPause');
    bool(patch.focus.playSoundDuringRest, 'focus.playSoundDuringRest');
    bool(patch.focus.backgroundAudioAllowed, 'focus.backgroundAudioAllowed');
    bool(patch.focus.autoCacheSounds, 'focus.autoCacheSounds');
    bool(patch.focus.fadeOutStop, 'focus.fadeOutStop');
    if (patch.focus.soundId != null) {
      if (typeof patch.focus.soundId !== 'string' || !patch.focus.soundId.trim()) {
        throw new AppError(400, 'invalid_settings_value', 'focus.soundId must be a sound id or null');
      }
      const sound = db.prepare('SELECT id FROM background_sounds WHERE id = ?').get(patch.focus.soundId);
      if (!sound) throw new AppError(400, 'invalid_settings_value', 'focus.soundId is invalid');
    }
  }
}

export function getRawApiKey(userId: string): string | null {
  const raw = readRow(userId, AI_KEY_ROW);
  return raw ? deob(raw) : null;
}

export function resetGroup(userId: string, group: string): Settings {
  if (group !== 'ai' && !(GROUPS as readonly string[]).includes(group)) {
    throw new AppError(400, 'invalid_settings_group', `unknown settings group: ${group}`);
  }
  if (group === 'ai') {
    db.prepare('DELETE FROM settings WHERE user_id = ? AND key = ?').run(userId, 'ai');
    db.prepare('DELETE FROM settings WHERE user_id = ? AND key = ?').run(userId, AI_KEY_ROW);
  } else {
    db.prepare('DELETE FROM settings WHERE user_id = ? AND key = ?').run(userId, group);
  }
  return getSettings(userId);
}

export function exportAll(userId: string): Record<string, unknown> {
  const all = (sql: string) => db.prepare(sql).all(userId);
  return {
    exportedAt: nowISO(),
    version: 1,
    listFolders: all('SELECT * FROM list_folders WHERE user_id = ?'),
    lists: all('SELECT * FROM lists WHERE user_id = ?'),
    tasks: all('SELECT * FROM tasks WHERE user_id = ?'),
    goals: all('SELECT * FROM goals WHERE user_id = ?'),
    tags: all('SELECT * FROM tags WHERE user_id = ?'),
    taskTags: all('SELECT * FROM task_tags WHERE user_id = ?'),
    taskReminders: all('SELECT * FROM task_reminders WHERE user_id = ?'),
    taskChecklistItems: all('SELECT * FROM task_checklist_items WHERE user_id = ?'),
    taskActivityLogs: all('SELECT * FROM task_activity_logs WHERE user_id = ?'),
    attachments: all('SELECT * FROM attachments WHERE user_id = ?'),
    notifications: all('SELECT * FROM notifications WHERE user_id = ?'),
    notificationPermissions: all('SELECT * FROM notification_permissions WHERE user_id = ?'),
    notificationSounds: all('SELECT id, name, purpose, mime_type, size_bytes, created_at FROM notification_sounds WHERE user_id = ?'),
    savedFilters: all('SELECT * FROM saved_filters WHERE user_id = ?'),
    searchHistory: all('SELECT * FROM search_history WHERE user_id = ?'),
    desktopWidgets: all('SELECT * FROM desktop_widgets WHERE user_id = ?'),
    desktopShortcuts: all('SELECT * FROM desktop_shortcuts WHERE user_id = ?'),
    desktopShellState: all('SELECT * FROM desktop_shell_state WHERE user_id = ?'),
    aiGenerationLogs: all('SELECT * FROM ai_generation_logs WHERE user_id = ?'),
    stickyNotes: all('SELECT * FROM sticky_notes WHERE user_id = ?'),
    focusSessions: all('SELECT * FROM focus_sessions WHERE user_id = ?'),
    focusRestCycles: all('SELECT * FROM focus_rest_cycles WHERE user_id = ?'),
    userSoundCache: all('SELECT * FROM user_sound_cache WHERE user_id = ?'),
    calendarPermissions: all('SELECT * FROM calendar_permissions WHERE user_id = ?'),
    calendarSubscriptions: all('SELECT * FROM calendar_subscriptions WHERE user_id = ?'),
    externalCalendarEvents: all('SELECT * FROM external_calendar_events WHERE user_id = ?'),
    habits: all('SELECT * FROM habits WHERE user_id = ?'),
    habitCheckins: all('SELECT * FROM habit_checkins WHERE user_id = ?'),
    countdowns: all('SELECT * FROM countdowns WHERE user_id = ?'),
    analyticsEvents: all('SELECT id, event_name, properties_json, source, occurred_at, received_at FROM analytics_events WHERE user_id = ?'),
    diagnosticLogUploads: all('SELECT id, filename, summary_json, size_bytes, uploaded_at FROM diagnostic_log_uploads WHERE user_id = ?'),
    syncOperations: all('SELECT client_operation_id, entity_type, entity_id, action, status, base_updated_at, client_created_at, result_json, received_at, applied_at FROM sync_operations WHERE user_id = ?'),
    settings: getSettings(userId),
  };
}
