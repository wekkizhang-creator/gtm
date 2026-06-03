// Habits + daily check-ins, with streak computation over scheduled weekdays.
import { randomUUID } from 'node:crypto';
import { db, nowISO } from './db';
import { AppError, type HabitDTO, type HabitStatsDTO } from './types';

// ---------- local-date string helpers (YYYY-MM-DD) ----------
function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function dateToStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function todayStr(): string {
  return dateToStr(new Date());
}
function strToDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDaysStr(s: string, n: number): string {
  const d = strToDate(s);
  d.setDate(d.getDate() + n);
  return dateToStr(d);
}
function dowOf(s: string): number {
  return strToDate(s).getDay();
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDays(s: string): number[] {
  return s
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
}

// ---------- streaks ----------
function computeStreaks(checked: Set<string>, days: number[]): { current: number; best: number } {
  const scheduled = (s: string) => days.includes(dowOf(s));
  const today = todayStr();

  // current: walk back over scheduled days; today not-yet-done does not break it
  let current = 0;
  let d = today;
  if (scheduled(d) && !checked.has(d)) d = addDaysStr(d, -1);
  for (let guard = 0; guard < 3000; guard++) {
    if (!scheduled(d)) {
      d = addDaysStr(d, -1);
      continue;
    }
    if (checked.has(d)) {
      current++;
      d = addDaysStr(d, -1);
    } else break;
  }

  // best: scan scheduled days from earliest check-in to today
  let best = 0;
  if (checked.size > 0) {
    const sorted = [...checked].sort();
    let cur = sorted[0];
    let run = 0;
    for (let guard = 0; cur <= today && guard < 6000; guard++) {
      if (scheduled(cur)) {
        if (checked.has(cur)) {
          run++;
          if (run > best) best = run;
        } else run = 0;
      }
      cur = addDaysStr(cur, 1);
    }
  }
  return { current, best };
}

function allCheckins(userId: string, habitId: string): string[] {
  return (db.prepare('SELECT date FROM habit_checkins WHERE user_id = ? AND habit_id = ? ORDER BY date').all(userId, habitId) as { date: string }[]).map(
    (r) => r.date,
  );
}

function allCheckinDetails(userId: string, habitId: string): { date: string; value: number | null; note: string | null }[] {
  return db
    .prepare('SELECT date, value, note FROM habit_checkins WHERE user_id = ? AND habit_id = ? ORDER BY date')
    .all(userId, habitId) as { date: string; value: number | null; note: string | null }[];
}

function mapHabit(userId: string, r: any, from?: string, to?: string): HabitDTO {
  const checks = allCheckins(userId, r.id);
  const details = allCheckinDetails(userId, r.id).filter((d) => (!from || d.date >= from) && (!to || d.date <= to));
  const checkedSet = new Set(checks);
  const { current, best } = computeStreaks(checkedSet, parseDays(r.days_of_week));
  const inRange = checks.filter((d) => (!from || d >= from) && (!to || d <= to));
  return {
    id: r.id,
    name: r.name,
    icon: r.icon ?? null,
    color: r.color ?? null,
    daysOfWeek: parseDays(r.days_of_week),
    targetType: r.target_type ?? 'check',
    targetValue: r.target_value ?? null,
    targetUnit: r.target_unit ?? null,
    startDate: r.start_date ?? null,
    groupName: r.group_name ?? null,
    reminderTime: r.reminder_time ?? null,
    note: r.note ?? null,
    sortOrder: r.sort_order,
    archived: !!r.archived,
    checkins: inRange,
    checkinDetails: details,
    currentStreak: current,
    bestStreak: best,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------- CRUD ----------
export function listHabits(userId: string, from?: string, to?: string): HabitDTO[] {
  const rows = db
    .prepare('SELECT * FROM habits WHERE user_id = ? AND archived = 0 ORDER BY sort_order ASC, created_at ASC')
    .all(userId) as any[];
  return rows.map((r) => mapHabit(userId, r, from, to));
}

export function getHabit(userId: string, id: string, from?: string, to?: string): HabitDTO | null {
  const row = db.prepare('SELECT * FROM habits WHERE user_id = ? AND id = ?').get(userId, id);
  return row ? mapHabit(userId, row, from, to) : null;
}

export function createHabit(userId: string, input: {
  name: string;
  icon: string | null;
  color: string | null;
  daysOfWeek: number[] | null;
  targetType?: 'check' | 'count' | 'timer';
  targetValue?: number | null;
  targetUnit?: string | null;
  startDate?: string | null;
  groupName?: string | null;
  reminderTime?: string | null;
  note: string | null;
}): HabitDTO {
  const id = randomUUID();
  const ts = nowISO();
  const days = input.daysOfWeek && input.daysOfWeek.length ? input.daysOfWeek : [0, 1, 2, 3, 4, 5, 6];
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM habits WHERE user_id = ?').get(userId) as { m: number };
  db.prepare(
    `INSERT INTO habits
       (id, user_id, name, icon, color, days_of_week, target_type, target_value, target_unit, start_date, group_name, reminder_time, note, sort_order, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    id,
    userId,
    input.name,
    input.icon,
    input.color,
    days.join(','),
    input.targetType ?? 'check',
    input.targetValue ?? null,
    input.targetUnit ?? null,
    input.startDate ?? null,
    input.groupName ?? null,
    input.reminderTime ?? null,
    input.note,
    (max.m ?? 0) + 1,
    ts,
    ts,
  );
  return mapHabit(userId, db.prepare('SELECT * FROM habits WHERE user_id = ? AND id = ?').get(userId, id));
}

export function updateHabit(userId: string, id: string, patch: Record<string, unknown>): HabitDTO | null {
  const map: Record<string, string> = {
    name: 'name',
    icon: 'icon',
    color: 'color',
    note: 'note',
    targetType: 'target_type',
    targetValue: 'target_value',
    targetUnit: 'target_unit',
    startDate: 'start_date',
    groupName: 'group_name',
    reminderTime: 'reminder_time',
    sortOrder: 'sort_order',
    archived: 'archived',
  };
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) {
      let v = patch[k];
      if (k === 'archived') v = v ? 1 : 0;
      cols.push(`${col} = ?`);
      vals.push(v ?? null);
    }
  }
  if ('daysOfWeek' in patch && Array.isArray(patch.daysOfWeek)) {
    cols.push('days_of_week = ?');
    vals.push((patch.daysOfWeek as number[]).join(','));
  }
  cols.push('updated_at = ?');
  vals.push(nowISO());
  vals.push(userId);
  vals.push(id);
  const info = db.prepare(`UPDATE habits SET ${cols.join(', ')} WHERE user_id = ? AND id = ?`).run(...(vals as any[]));
  if (info.changes === 0) return null;
  return mapHabit(userId, db.prepare('SELECT * FROM habits WHERE user_id = ? AND id = ?').get(userId, id));
}

export function deleteHabit(userId: string, id: string): boolean {
  // remove check-ins explicitly (CASCADE also covers this when FK is on)
  db.prepare('DELETE FROM habit_checkins WHERE user_id = ? AND habit_id = ?').run(userId, id);
  return db.prepare('DELETE FROM habits WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
}

export function archiveHabit(userId: string, id: string): HabitDTO | null {
  const info = db.prepare('UPDATE habits SET archived = 1, updated_at = ? WHERE user_id = ? AND id = ?').run(nowISO(), userId, id);
  if (info.changes === 0) return null;
  return getHabit(userId, id);
}

export function habitStats(userId: string, id: string, from: string, to: string): HabitStatsDTO {
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new AppError(400, 'invalid', 'from/to must be YYYY-MM-DD range');
  const habit = db.prepare('SELECT * FROM habits WHERE user_id = ? AND id = ?').get(userId, id) as any;
  if (!habit) throw new AppError(404, 'not_found', 'habit not found');
  const days = parseDays(habit.days_of_week);
  let scheduledDays = 0;
  let d = from;
  for (let guard = 0; d <= to && guard < 5000; guard++) {
    if (days.includes(dowOf(d))) scheduledDays++;
    d = addDaysStr(d, 1);
  }
  const rows = db
    .prepare('SELECT date, value FROM habit_checkins WHERE user_id = ? AND habit_id = ? AND date >= ? AND date <= ?')
    .all(userId, id, from, to) as { date: string; value: number | null }[];
  const checked = new Set(rows.map((r) => r.date));
  const { current, best } = computeStreaks(new Set(allCheckins(userId, id)), days);
  return {
    habitId: id,
    from,
    to,
    scheduledDays,
    completedDays: checked.size,
    completionRate: scheduledDays ? checked.size / scheduledDays : 0,
    totalValue: rows.reduce((sum, r) => sum + (r.value ?? 1), 0),
    currentStreak: current,
    bestStreak: best,
  };
}

export function toggleCheckin(
  userId: string,
  id: string,
  date: string,
  value: number | null = null,
  note: string | null = null,
): { checked: boolean; currentStreak: number; bestStreak: number } {
  if (!DATE_RE.test(date)) throw new AppError(400, 'invalid', 'date must be YYYY-MM-DD');
  if (date > todayStr()) throw new AppError(400, 'invalid', 'cannot check in for a future date');
  const habit = db.prepare('SELECT * FROM habits WHERE user_id = ? AND id = ?').get(userId, id) as any;
  if (!habit) throw new AppError(404, 'not_found', 'habit not found');

  const existing = db.prepare('SELECT id FROM habit_checkins WHERE user_id = ? AND habit_id = ? AND date = ?').get(userId, id, date) as
    | { id: string }
    | undefined;
  let checked: boolean;
  if (existing) {
    db.prepare('DELETE FROM habit_checkins WHERE user_id = ? AND id = ?').run(userId, existing.id);
    checked = false;
  } else {
    db.prepare('INSERT INTO habit_checkins (id, user_id, habit_id, date, value, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      randomUUID(),
      userId,
      id,
      date,
      value,
      note,
      nowISO(),
    );
    checked = true;
  }
  const { current, best } = computeStreaks(new Set(allCheckins(userId, id)), parseDays(habit.days_of_week));
  return { checked, currentStreak: current, bestStreak: best };
}
