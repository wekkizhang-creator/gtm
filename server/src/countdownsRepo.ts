// Countdown / anniversary days. Computes next occurrence + signed days remaining.
import { randomUUID } from 'node:crypto';
import { db, nowISO } from './db';
import { AppError, type CountdownDTO } from './types';

const COUNTDOWN_MODES = ['countdown', 'countup'] as const;
type CountdownMode = (typeof COUNTDOWN_MODES)[number];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function fmt(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function todayDate(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function assertCountdownMode(value: unknown): CountdownMode {
  if (value === undefined || value === null) return 'countdown';
  if (COUNTDOWN_MODES.includes(value as CountdownMode)) return value as CountdownMode;
  throw new AppError(400, 'invalid_countdown_mode', 'mode must be countdown or countup');
}

function normalizeCountdownColor(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new AppError(400, 'invalid_countdown_color', 'color must be a hex color');
  const color = value.trim();
  if (!color) return null;
  if (!HEX_COLOR_RE.test(color)) throw new AppError(400, 'invalid_countdown_color', 'color must be a hex color');
  return color.toLowerCase();
}

function normalizeCountdownNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new AppError(400, 'invalid_countdown_note', 'note must be a string');
  const note = value.trim();
  if (!note) return null;
  if (note.length > 2000) throw new AppError(400, 'invalid_countdown_note', 'note must be at most 2000 characters');
  return note;
}

/** next occurrence + signed day delta from today */
function compute(targetStr: string, repeat: boolean): { effectiveDate: string; daysRemaining: number } {
  const today = todayDate();
  let eff = parseDate(targetStr);
  if (repeat) {
    const t = parseDate(targetStr);
    eff = new Date(today.getFullYear(), t.getMonth(), t.getDate());
    if (eff.getTime() < today.getTime()) {
      eff = new Date(today.getFullYear() + 1, t.getMonth(), t.getDate());
    }
  }
  const daysRemaining = Math.round((eff.getTime() - today.getTime()) / 86_400_000);
  return { effectiveDate: fmt(eff), daysRemaining };
}

function mapCountdown(r: any): CountdownDTO {
  const { effectiveDate, daysRemaining } = compute(r.target_date, !!r.repeat_yearly);
  return {
    id: r.id,
    title: r.title,
    targetDate: r.target_date,
    mode: assertCountdownMode(r.mode),
    icon: r.icon ?? null,
    color: r.color ?? null,
    repeatYearly: !!r.repeat_yearly,
    pinned: !!r.pinned,
    note: r.note ?? null,
    sortOrder: r.sort_order,
    effectiveDate,
    daysRemaining,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listCountdowns(userId: string): CountdownDTO[] {
  const rows = db.prepare('SELECT * FROM countdowns WHERE user_id = ?').all(userId) as any[];
  const list = rows.map(mapCountdown);
  list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1; // pinned first
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    const au = a.daysRemaining >= 0;
    const bu = b.daysRemaining >= 0;
    if (au !== bu) return au ? -1 : 1; // upcoming before past
    if (au) return a.daysRemaining - b.daysRemaining; // soonest first
    return b.daysRemaining - a.daysRemaining; // most-recent past first
  });
  return list;
}

export function createCountdown(userId: string, input: {
  title: string;
  targetDate: string;
  mode?: unknown;
  icon: string | null;
  color: string | null;
  repeatYearly: boolean;
  pinned: boolean;
  note: string | null;
}): CountdownDTO {
  const id = randomUUID();
  const ts = nowISO();
  const mode = assertCountdownMode(input.mode);
  const color = normalizeCountdownColor(input.color);
  const note = normalizeCountdownNote(input.note);
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM countdowns WHERE user_id = ?').get(userId) as { m: number };
  db.prepare(
    `INSERT INTO countdowns (id, user_id, title, target_date, mode, icon, color, repeat_yearly, pinned, note, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    input.title,
    input.targetDate,
    mode,
    input.icon,
    color,
    input.repeatYearly ? 1 : 0,
    input.pinned ? 1 : 0,
    note,
    (max.m ?? 0) + 1,
    ts,
    ts,
  );
  return mapCountdown(db.prepare('SELECT * FROM countdowns WHERE user_id = ? AND id = ?').get(userId, id));
}

export function reorderCountdowns(userId: string, orderedIds: string[]): CountdownDTO[] {
  const ids = orderedIds.map((id) => id.trim());
  const uniqueIds = Array.from(new Set(ids));
  if (!uniqueIds.length || ids.some((id) => !id) || uniqueIds.length !== ids.length) {
    throw new AppError(400, 'invalid_countdown_order', 'orderedIds must contain unique countdown ids');
  }
  const current = db.prepare('SELECT id, sort_order FROM countdowns WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC').all(userId) as {
    id: string;
    sort_order: number;
  }[];
  const currentIds = new Set(current.map((row) => row.id));
  if (uniqueIds.some((id) => !currentIds.has(id))) {
    throw new AppError(404, 'countdown_not_found', 'countdown not found');
  }
  const ordered = [...uniqueIds, ...current.map((row) => row.id).filter((id) => !uniqueIds.includes(id))];
  const ts = nowISO();
  const update = db.prepare('UPDATE countdowns SET sort_order = ?, updated_at = ? WHERE user_id = ? AND id = ?');
  db.exec('BEGIN');
  try {
    ordered.forEach((id, index) => update.run(index + 1, ts, userId, id));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return listCountdowns(userId);
}

export function updateCountdown(userId: string, id: string, patch: Record<string, unknown>): CountdownDTO | null {
  const map: Record<string, string> = {
    title: 'title',
    targetDate: 'target_date',
    mode: 'mode',
    icon: 'icon',
    color: 'color',
    repeatYearly: 'repeat_yearly',
    pinned: 'pinned',
    note: 'note',
    sortOrder: 'sort_order',
  };
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) {
      let v = patch[k];
      if (k === 'repeatYearly' || k === 'pinned') v = v ? 1 : 0;
      if (k === 'mode') v = assertCountdownMode(v);
      if (k === 'color') v = normalizeCountdownColor(v);
      if (k === 'note') v = normalizeCountdownNote(v);
      cols.push(`${col} = ?`);
      vals.push(v ?? null);
    }
  }
  cols.push('updated_at = ?');
  vals.push(nowISO());
  vals.push(userId);
  vals.push(id);
  const info = db.prepare(`UPDATE countdowns SET ${cols.join(', ')} WHERE user_id = ? AND id = ?`).run(...(vals as any[]));
  if (info.changes === 0) return null;
  return mapCountdown(db.prepare('SELECT * FROM countdowns WHERE user_id = ? AND id = ?').get(userId, id));
}

export function deleteCountdown(userId: string, id: string): boolean {
  return db.prepare('DELETE FROM countdowns WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
}
