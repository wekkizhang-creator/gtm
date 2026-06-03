// Data access for focus (Pomodoro) sessions + aggregated stats.
import { randomUUID } from 'node:crypto';
import { db, nowISO } from './db';
import { getSettings } from './settingsRepo';
import {
  AppError,
  type BackgroundSoundDTO,
  type FocusAchievementDTO,
  type FocusAchievementMetric,
  type FocusReportDimensionDTO,
  type FocusReportDTO,
  type FocusRestCycleDTO,
  type FocusSessionDTO,
  type FocusStats,
} from './types';

function startOfTodayISO(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
function endOfTodayISO(): string {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

function mapSession(r: any): FocusSessionDTO {
  return {
    id: r.id,
    taskId: r.task_id ?? null,
    taskTitle: r.task_title ?? null,
    mode: r.mode,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationSec: r.duration_sec,
    isPomodoro: !!r.is_pomodoro,
    backgroundSoundId: r.background_sound_id ?? null,
    backgroundSoundName: r.background_sound_name ?? null,
    backgroundVolume: r.background_volume ?? null,
    soundPlayedDuration: r.sound_played_duration ?? null,
    isMuted: !!r.is_muted,
    note: r.note ?? null,
    createdAt: r.created_at,
  };
}

function mapSound(r: any): BackgroundSoundDTO {
  return {
    id: r.id,
    name: r.name,
    category: r.category ?? null,
    assetUrl: r.asset_url,
    license: r.license ?? null,
    cacheStatus: r.cache_status ?? null,
    localPath: r.local_path ?? null,
    volume: r.volume ?? null,
  };
}

function mapRestCycle(r: any): FocusRestCycleDTO {
  return {
    id: r.id,
    focusSessionId: r.focus_session_id,
    restStartedAt: r.rest_started_at,
    restEndedAt: r.rest_ended_at,
    restDurationSec: r.rest_duration_sec,
    nextFocusStartedAt: r.next_focus_started_at ?? null,
    reminderStatus: r.reminder_status,
    notificationId: r.notification_id ?? null,
    createdAt: r.created_at,
  };
}

const SELECT_JOIN = `
  SELECT f.*, t.title AS task_title
  FROM focus_sessions f
  LEFT JOIN tasks t ON t.user_id = f.user_id AND t.id = f.task_id
`;

export function listSessions(userId: string, limit = 100): FocusSessionDTO[] {
  const rows = db.prepare(`${SELECT_JOIN} WHERE f.user_id = ? ORDER BY f.ended_at DESC LIMIT ?`).all(userId, limit) as any[];
  return rows.map(mapSession);
}

export function createSession(userId: string, input: {
  taskId: string | null;
  mode: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  isPomodoro: boolean;
  backgroundSoundId?: string | null;
  backgroundVolume?: number | null;
  soundPlayedDuration?: number | null;
  isMuted?: boolean;
  note: string | null;
}): FocusSessionDTO {
  if (input.mode !== 'pomodoro' && input.mode !== 'countup') {
    throw new AppError(400, 'invalid', 'mode must be "pomodoro" or "countup"');
  }
  if (!input.startedAt || !input.endedAt) {
    throw new AppError(400, 'invalid', 'startedAt and endedAt are required');
  }
  if (input.endedAt < input.startedAt) {
    throw new AppError(400, 'invalid', 'endedAt must be on or after startedAt');
  }
  if (!Number.isFinite(input.durationSec) || input.durationSec < 0) {
    throw new AppError(400, 'invalid', 'durationSec must be >= 0');
  }
  if (input.taskId) {
    const task = db.prepare('SELECT id FROM tasks WHERE user_id = ? AND id = ?').get(userId, input.taskId);
    if (!task) throw new AppError(404, 'not_found', 'task not found');
  }
  const focusDefaults = getSettings(userId).focus;
  const backgroundSoundId = input.backgroundSoundId === undefined ? focusDefaults.soundId : input.backgroundSoundId;
  let backgroundVolume = input.backgroundVolume === undefined ? focusDefaults.defaultVolume : input.backgroundVolume;
  if (!backgroundSoundId) backgroundVolume = null;
  if (backgroundVolume != null && (!Number.isInteger(backgroundVolume) || backgroundVolume < 0 || backgroundVolume > 100)) {
    throw new AppError(400, 'invalid', 'backgroundVolume must be an integer from 0 to 100');
  }
  let soundName: string | null = null;
  if (backgroundSoundId) {
    const sound = db.prepare('SELECT name FROM background_sounds WHERE id = ?').get(backgroundSoundId) as { name: string } | undefined;
    if (!sound) throw new AppError(404, 'not_found', 'background sound not found');
    soundName = sound.name;
  }
  const id = randomUUID();
  const ts = nowISO();
  db.prepare(
    `INSERT INTO focus_sessions
       (id, user_id, task_id, mode, started_at, ended_at, duration_sec, is_pomodoro, background_sound_id, background_sound_name, background_volume, sound_played_duration, is_muted, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    input.taskId,
    input.mode,
    input.startedAt,
    input.endedAt,
    Math.round(input.durationSec),
    input.isPomodoro ? 1 : 0,
    backgroundSoundId ?? null,
    soundName,
    backgroundVolume,
    (input.soundPlayedDuration ?? (backgroundSoundId ? input.durationSec : null)) == null
      ? null
      : Math.round(input.soundPlayedDuration ?? input.durationSec),
    input.isMuted ? 1 : 0,
    input.note,
    ts,
  );
  return mapSession(db.prepare(`${SELECT_JOIN} WHERE f.user_id = ? AND f.id = ?`).get(userId, id));
}

export function deleteSession(userId: string, id: string): boolean {
  return db.prepare('DELETE FROM focus_sessions WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
}

export function listRestCycles(userId: string, limit = 100): FocusRestCycleDTO[] {
  const rows = db
    .prepare('SELECT * FROM focus_rest_cycles WHERE user_id = ? ORDER BY rest_ended_at DESC, created_at DESC LIMIT ?')
    .all(userId, limit) as any[];
  return rows.map(mapRestCycle);
}

function isInDoNotDisturbWindow(now: Date, start: string | null, end: string | null): boolean {
  if (!start || !end) return false;
  const [startH, startM] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);
  const current = now.getHours() * 60 + now.getMinutes();
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  if (startMin === endMin) return true;
  if (startMin < endMin) return current >= startMin && current < endMin;
  return current >= startMin || current < endMin;
}

function maybeCreateRestNotification(userId: string, restEndedAt: string, cycleId: string): { status: 'created' | 'suppressed'; id: string | null } {
  const notifications = getSettings(userId).notifications;
  if (!notifications.enabled) return { status: 'suppressed', id: null };
  if (!notifications.focusReminders) return { status: 'suppressed', id: null };
  if (
    notifications.doNotDisturb &&
    isInDoNotDisturbWindow(new Date(restEndedAt), notifications.doNotDisturbStart, notifications.doNotDisturbEnd)
  ) {
    return { status: 'suppressed', id: null };
  }
  const id = randomUUID();
  const ts = nowISO();
  db.prepare(
    `INSERT INTO notifications
       (id, user_id, type, title, body, target_type, target_id, scheduled_at, delivered_at, read_at, action_state, created_at)
     VALUES (?, ?, 'focus_rest_complete', ?, ?, 'focus_rest_cycle', ?, ?, ?, NULL, 'created', ?)`,
  ).run(id, userId, '休息结束', '休息时间结束，已进入下一轮番茄。', cycleId, restEndedAt, ts, ts);
  return { status: 'created', id };
}

export function createRestCycle(userId: string, input: {
  focusSessionId?: unknown;
  restStartedAt?: unknown;
  restEndedAt?: unknown;
  restDurationSec?: unknown;
  nextFocusStartedAt?: unknown;
}): FocusRestCycleDTO {
  const focusSessionId = typeof input.focusSessionId === 'string' ? input.focusSessionId.trim() : '';
  const restStartedAt = typeof input.restStartedAt === 'string' ? input.restStartedAt.trim() : '';
  const restEndedAt = typeof input.restEndedAt === 'string' ? input.restEndedAt.trim() : '';
  const restDurationSec = typeof input.restDurationSec === 'number' ? Math.round(input.restDurationSec) : NaN;
  const nextFocusStartedAt = typeof input.nextFocusStartedAt === 'string' && input.nextFocusStartedAt.trim() ? input.nextFocusStartedAt.trim() : null;
  if (!focusSessionId) throw new AppError(400, 'invalid_rest_cycle', 'focusSessionId is required');
  if (!restStartedAt || !restEndedAt) throw new AppError(400, 'invalid_rest_cycle', 'restStartedAt and restEndedAt are required');
  if (restEndedAt < restStartedAt) throw new AppError(400, 'invalid_rest_cycle', 'restEndedAt must be on or after restStartedAt');
  if (!Number.isFinite(restDurationSec) || restDurationSec <= 0) throw new AppError(400, 'invalid_rest_cycle', 'restDurationSec must be positive');
  if (nextFocusStartedAt && nextFocusStartedAt < restEndedAt) {
    throw new AppError(400, 'invalid_rest_cycle', 'nextFocusStartedAt must be on or after restEndedAt');
  }
  const session = db
    .prepare('SELECT id, is_pomodoro FROM focus_sessions WHERE user_id = ? AND id = ?')
    .get(userId, focusSessionId) as { id: string; is_pomodoro: number } | undefined;
  if (!session) throw new AppError(404, 'not_found', 'focus session not found');
  if (!session.is_pomodoro) throw new AppError(400, 'invalid_rest_cycle', 'rest cycles must follow a pomodoro focus session');
  const existing = db.prepare('SELECT * FROM focus_rest_cycles WHERE user_id = ? AND focus_session_id = ?').get(userId, focusSessionId);
  if (existing) return mapRestCycle(existing);

  const id = randomUUID();
  const notification = maybeCreateRestNotification(userId, restEndedAt, id);
  db.prepare(
    `INSERT INTO focus_rest_cycles
       (id, user_id, focus_session_id, rest_started_at, rest_ended_at, rest_duration_sec, next_focus_started_at, reminder_status, notification_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, focusSessionId, restStartedAt, restEndedAt, restDurationSec, nextFocusStartedAt, notification.status, notification.id, nowISO());
  return mapRestCycle(db.prepare('SELECT * FROM focus_rest_cycles WHERE user_id = ? AND id = ?').get(userId, id));
}

export function stats(userId: string): FocusStats {
  const t0 = startOfTodayISO();
  const t1 = endOfTodayISO();
  const one = (sql: string, p: unknown[] = []) => (db.prepare(sql).get(...(p as any[])) as { v: number }).v;
  return {
    todayCount: one('SELECT COUNT(*) v FROM focus_sessions WHERE user_id = ? AND is_pomodoro = 1 AND ended_at >= ? AND ended_at <= ?', [userId, t0, t1]),
    todayDurationSec: one('SELECT COALESCE(SUM(duration_sec), 0) v FROM focus_sessions WHERE user_id = ? AND ended_at >= ? AND ended_at <= ?', [userId, t0, t1]),
    totalCount: one('SELECT COUNT(*) v FROM focus_sessions WHERE user_id = ? AND is_pomodoro = 1', [userId]),
    totalDurationSec: one('SELECT COALESCE(SUM(duration_sec), 0) v FROM focus_sessions WHERE user_id = ?', [userId]),
  };
}

export function listSounds(userId: string): BackgroundSoundDTO[] {
  const rows = db
    .prepare(
      `SELECT s.*, c.status AS cache_status, c.local_path, c.volume
       FROM background_sounds s
       LEFT JOIN user_sound_cache c ON c.sound_id = s.id AND c.user_id = ?
       ORDER BY s.category ASC, s.name ASC`,
    )
    .all(userId) as any[];
  return rows.map(mapSound);
}

export function cacheSound(userId: string, soundId: string): BackgroundSoundDTO {
  const sound = db.prepare('SELECT id FROM background_sounds WHERE id = ?').get(soundId);
  if (!sound) throw new AppError(404, 'not_found', 'background sound not found');
  db.prepare(
    `INSERT INTO user_sound_cache (user_id, sound_id, status, local_path, volume, updated_at)
     VALUES (?, ?, 'cached', ?, 50, ?)
     ON CONFLICT(user_id, sound_id) DO UPDATE SET status = 'cached', local_path = excluded.local_path, updated_at = excluded.updated_at`,
  ).run(userId, soundId, `cache://${soundId}`, nowISO());
  return listSounds(userId).find((s) => s.id === soundId)!;
}

export function deleteCachedSound(userId: string, soundId: string): boolean {
  return db.prepare('DELETE FROM user_sound_cache WHERE user_id = ? AND sound_id = ?').run(userId, soundId).changes > 0;
}

function rangeStart(range: 'day' | 'week' | 'month'): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (range === 'week') d.setDate(d.getDate() - 6);
  if (range === 'month') d.setDate(d.getDate() - 29);
  return d;
}

const ACHIEVEMENT_DEFS: Array<Omit<FocusAchievementDTO, 'progress' | 'achieved' | 'achievedAt'>> = [
  {
    id: 'first_pomodoro',
    title: '第一次番茄',
    description: '完成 1 个番茄专注',
    metric: 'pomodoro_count',
    target: 1,
  },
  {
    id: 'five_pomodoros',
    title: '进入节奏',
    description: '累计完成 5 个番茄专注',
    metric: 'pomodoro_count',
    target: 5,
  },
  {
    id: 'focus_one_hour',
    title: '专注 1 小时',
    description: '累计专注时长达到 1 小时',
    metric: 'focus_duration_sec',
    target: 3600,
  },
  {
    id: 'daily_three_pomodoros',
    title: '单日三连',
    description: '同一天完成 3 个番茄专注',
    metric: 'daily_pomodoro_count',
    target: 3,
  },
];

function achievementProgress(metric: FocusAchievementMetric, sessions: Array<{ ended_at: string; duration_sec: number; is_pomodoro: number }>): {
  progress: number;
  achievedAt: string | null;
} {
  if (metric === 'pomodoro_count') {
    let count = 0;
    for (const session of sessions) {
      if (!session.is_pomodoro) continue;
      count++;
      if (count >= 1_000_000) break;
    }
    return { progress: count, achievedAt: null };
  }
  if (metric === 'focus_duration_sec') {
    return { progress: sessions.reduce((sum, session) => sum + Math.max(0, session.duration_sec), 0), achievedAt: null };
  }
  const byDay = new Map<string, number>();
  let maxDaily = 0;
  for (const session of sessions) {
    if (!session.is_pomodoro) continue;
    const day = session.ended_at.slice(0, 10);
    const count = (byDay.get(day) ?? 0) + 1;
    byDay.set(day, count);
    maxDaily = Math.max(maxDaily, count);
  }
  return { progress: maxDaily, achievedAt: null };
}

function achievementReachedAt(metric: FocusAchievementMetric, target: number, sessions: Array<{ ended_at: string; duration_sec: number; is_pomodoro: number }>): string | null {
  if (metric === 'pomodoro_count') {
    let count = 0;
    for (const session of sessions) {
      if (!session.is_pomodoro) continue;
      count++;
      if (count >= target) return session.ended_at;
    }
    return null;
  }
  if (metric === 'focus_duration_sec') {
    let total = 0;
    for (const session of sessions) {
      total += Math.max(0, session.duration_sec);
      if (total >= target) return session.ended_at;
    }
    return null;
  }
  const byDay = new Map<string, number>();
  for (const session of sessions) {
    if (!session.is_pomodoro) continue;
    const day = session.ended_at.slice(0, 10);
    const count = (byDay.get(day) ?? 0) + 1;
    byDay.set(day, count);
    if (count >= target) return session.ended_at;
  }
  return null;
}

export function achievements(userId: string): FocusAchievementDTO[] {
  const sessions = db
    .prepare('SELECT ended_at, duration_sec, is_pomodoro FROM focus_sessions WHERE user_id = ? ORDER BY ended_at ASC, created_at ASC')
    .all(userId) as Array<{ ended_at: string; duration_sec: number; is_pomodoro: number }>;
  return ACHIEVEMENT_DEFS.map((def) => {
    const { progress } = achievementProgress(def.metric, sessions);
    const achieved = progress >= def.target;
    return {
      ...def,
      progress: Math.min(progress, def.target),
      achieved,
      achievedAt: achieved ? achievementReachedAt(def.metric, def.target, sessions) : null,
    };
  });
}

export function report(userId: string, range: 'day' | 'week' | 'month'): FocusReportDTO {
  const start = rangeStart(range);
  const startISO = start.toISOString();
  const rows = db
    .prepare(
      `SELECT substr(ended_at, 1, 10) AS label, COUNT(*) AS count, COALESCE(SUM(duration_sec), 0) AS durationSec
       FROM focus_sessions
       WHERE user_id = ? AND ended_at >= ?
       GROUP BY substr(ended_at, 1, 10)
       ORDER BY label ASC`,
    )
    .all(userId, startISO) as any[];
  const buckets = rows.map((r) => ({ label: r.label, count: r.count, durationSec: r.durationSec }));
  return {
    range,
    buckets,
    byTask: reportByTask(userId, startISO),
    byList: reportByList(userId, startISO),
    byTag: reportByTag(userId, startISO),
    totalCount: buckets.reduce((sum, b) => sum + b.count, 0),
    totalDurationSec: buckets.reduce((sum, b) => sum + b.durationSec, 0),
  };
}

function mapReportDimension(rows: any[]): FocusReportDimensionDTO[] {
  return rows.map((r) => ({
    id: r.id ?? null,
    name: r.name,
    count: r.count,
    durationSec: r.durationSec,
  }));
}

function reportByTask(userId: string, startISO: string): FocusReportDimensionDTO[] {
  const rows = db
    .prepare(
      `SELECT f.task_id AS id,
              COALESCE(t.title, '未关联任务') AS name,
              COUNT(*) AS count,
              COALESCE(SUM(f.duration_sec), 0) AS durationSec
       FROM focus_sessions f
       LEFT JOIN tasks t ON t.user_id = f.user_id AND t.id = f.task_id
       WHERE f.user_id = ? AND f.ended_at >= ?
       GROUP BY f.task_id, COALESCE(t.title, '未关联任务')
       ORDER BY durationSec DESC, count DESC, name ASC`,
    )
    .all(userId, startISO) as any[];
  return mapReportDimension(rows);
}

function reportByList(userId: string, startISO: string): FocusReportDimensionDTO[] {
  const rows = db
    .prepare(
      `SELECT t.list_id AS id,
              CASE WHEN f.task_id IS NULL THEN '未关联清单' ELSE COALESCE(l.name, '收集箱') END AS name,
              COUNT(*) AS count,
              COALESCE(SUM(f.duration_sec), 0) AS durationSec
       FROM focus_sessions f
       LEFT JOIN tasks t ON t.user_id = f.user_id AND t.id = f.task_id
       LEFT JOIN lists l ON l.user_id = f.user_id AND l.id = t.list_id
       WHERE f.user_id = ? AND f.ended_at >= ?
       GROUP BY t.list_id, CASE WHEN f.task_id IS NULL THEN '未关联清单' ELSE COALESCE(l.name, '收集箱') END
       ORDER BY durationSec DESC, count DESC, name ASC`,
    )
    .all(userId, startISO) as any[];
  return mapReportDimension(rows);
}

function reportByTag(userId: string, startISO: string): FocusReportDimensionDTO[] {
  const rows = db
    .prepare(
      `SELECT tags.id AS id,
              COALESCE(tags.name, '未标记') AS name,
              COUNT(*) AS count,
              COALESCE(SUM(f.duration_sec), 0) AS durationSec
       FROM focus_sessions f
       LEFT JOIN tasks t ON t.user_id = f.user_id AND t.id = f.task_id
       LEFT JOIN task_tags tt ON tt.user_id = f.user_id AND tt.task_id = t.id
       LEFT JOIN tags ON tags.user_id = tt.user_id AND tags.id = tt.tag_id
       WHERE f.user_id = ? AND f.ended_at >= ?
       GROUP BY tags.id, COALESCE(tags.name, '未标记')
       ORDER BY durationSec DESC, count DESC, name ASC`,
    )
    .all(userId, startISO) as any[];
  return mapReportDimension(rows);
}
