// Data access for focus (Pomodoro) sessions + aggregated stats.
import { randomUUID } from 'node:crypto';
import { db, nowISO } from './db';
import { AppError, type FocusSessionDTO, type FocusStats } from './types';

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
    note: r.note ?? null,
    createdAt: r.created_at,
  };
}

const SELECT_JOIN = `
  SELECT f.*, t.title AS task_title
  FROM focus_sessions f
  LEFT JOIN tasks t ON t.id = f.task_id
`;

export function listSessions(limit = 100): FocusSessionDTO[] {
  const rows = db.prepare(`${SELECT_JOIN} ORDER BY f.ended_at DESC LIMIT ?`).all(limit) as any[];
  return rows.map(mapSession);
}

export function createSession(input: {
  taskId: string | null;
  mode: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  isPomodoro: boolean;
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
  const id = randomUUID();
  const ts = nowISO();
  db.prepare(
    `INSERT INTO focus_sessions (id, task_id, mode, started_at, ended_at, duration_sec, is_pomodoro, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.taskId,
    input.mode,
    input.startedAt,
    input.endedAt,
    Math.round(input.durationSec),
    input.isPomodoro ? 1 : 0,
    input.note,
    ts,
  );
  return mapSession(db.prepare(`${SELECT_JOIN} WHERE f.id = ?`).get(id));
}

export function deleteSession(id: string): boolean {
  return db.prepare('DELETE FROM focus_sessions WHERE id = ?').run(id).changes > 0;
}

export function stats(): FocusStats {
  const t0 = startOfTodayISO();
  const t1 = endOfTodayISO();
  const one = (sql: string, p: unknown[] = []) => (db.prepare(sql).get(...(p as any[])) as { v: number }).v;
  return {
    todayCount: one('SELECT COUNT(*) v FROM focus_sessions WHERE is_pomodoro = 1 AND ended_at >= ? AND ended_at <= ?', [t0, t1]),
    todayDurationSec: one('SELECT COALESCE(SUM(duration_sec), 0) v FROM focus_sessions WHERE ended_at >= ? AND ended_at <= ?', [t0, t1]),
    totalCount: one('SELECT COUNT(*) v FROM focus_sessions WHERE is_pomodoro = 1'),
    totalDurationSec: one('SELECT COALESCE(SUM(duration_sec), 0) v FROM focus_sessions'),
  };
}
