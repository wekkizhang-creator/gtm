import { randomUUID } from 'node:crypto';
import { db, nowISO } from './db';
import * as repo from './repo';
import { getSettings } from './settingsRepo';
import { AppError, type StickyNoteDTO, type TaskDTO } from './types';

type NoteRow = {
  id: string;
  task_id: string | null;
  title: string;
  body: string;
  color: string | null;
  opacity: number;
  font_size: StickyNoteDTO['fontSize'];
  pinned: number;
  position_json: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

const DEFAULT_POSITION = { x: 40, y: 40, width: 300, height: 220 };
const FONT_SIZES = new Set(['small', 'normal', 'large', 'xlarge']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePosition(value: unknown, fallback = DEFAULT_POSITION): StickyNoteDTO['position'] {
  if (value == null) return fallback;
  if (!isRecord(value)) throw new AppError(400, 'invalid_note', 'position must be an object');
  const next = { ...fallback };
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (value[key] == null) continue;
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
      throw new AppError(400, 'invalid_note', `position.${key} must be a number`);
    }
    next[key] = Math.round(value[key]);
  }
  if (next.width < 160 || next.height < 120) throw new AppError(400, 'invalid_note', 'note size is too small');
  return next;
}

function readPosition(raw: string): StickyNoteDTO['position'] {
  try {
    return normalizePosition(JSON.parse(raw));
  } catch {
    return DEFAULT_POSITION;
  }
}

function normalizeFontSize(value: unknown, fallback: StickyNoteDTO['fontSize'] = 'normal'): StickyNoteDTO['fontSize'] {
  if (value == null) return fallback;
  if (typeof value !== 'string' || !FONT_SIZES.has(value)) throw new AppError(400, 'invalid_note', 'fontSize is invalid');
  return value as StickyNoteDTO['fontSize'];
}

function normalizeOpacity(value: unknown, fallback = 95): number {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 20 || n > 100) throw new AppError(400, 'invalid_note', 'opacity must be an integer from 20 to 100');
  return n;
}

function mapNote(row: NoteRow): StickyNoteDTO {
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    body: row.body,
    color: row.color,
    opacity: row.opacity,
    fontSize: row.font_size,
    pinned: row.pinned === 1,
    position: readPosition(row.position_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function getRow(userId: string, id: string, includeDeleted = false): NoteRow | undefined {
  return db
    .prepare(`SELECT * FROM sticky_notes WHERE user_id = ? AND id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`)
    .get(userId, id) as NoteRow | undefined;
}

function defaultTitle(body: string): string {
  const first = body.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return (first || 'Untitled note').slice(0, 80);
}

export function listNotes(userId: string, includeDeleted = false): StickyNoteDTO[] {
  const rows = db
    .prepare(`SELECT * FROM sticky_notes WHERE user_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY pinned DESC, updated_at DESC`)
    .all(userId) as NoteRow[];
  return rows.map(mapNote);
}

export function createNote(
  userId: string,
  input: {
    taskId?: string | null;
    title?: string | null;
    body?: string | null;
    color?: string | null;
    opacity?: number | null;
    fontSize?: string | null;
    pinned?: boolean | null;
    position?: unknown;
  },
): StickyNoteDTO {
  const taskId = input.taskId ?? null;
  if (taskId && !repo.getTask(userId, taskId)) throw new AppError(404, 'not_found', 'task not found');
  const body = String(input.body ?? '').trim();
  const title = String(input.title ?? (body ? defaultTitle(body) : '')).trim();
  if (!title && !body) throw new AppError(400, 'invalid_note', 'title or body is required');
  const defaults = getSettings(userId).notes;
  const id = randomUUID();
  const ts = nowISO();
  const noteTitle = (title || defaultTitle(body)).slice(0, 120);
  db.prepare(
    `INSERT INTO sticky_notes
       (id, user_id, task_id, title, body, color, opacity, font_size, pinned, position_json, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    userId,
    taskId,
    noteTitle,
    body,
    input.color ?? defaults.defaultColor,
    normalizeOpacity(input.opacity, defaults.defaultOpacity),
    normalizeFontSize(input.fontSize, defaults.defaultFontSize),
    (input.pinned ?? defaults.defaultPinned) ? 1 : 0,
    JSON.stringify(normalizePosition(input.position, defaults.defaultPosition)),
    ts,
    ts,
  );
  return mapNote(getRow(userId, id)!);
}

export function createNoteFromTask(userId: string, taskId: string): StickyNoteDTO {
  const task = repo.getTask(userId, taskId);
  if (!task) throw new AppError(404, 'not_found', 'task not found');
  const existing = db
    .prepare('SELECT * FROM sticky_notes WHERE user_id = ? AND task_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1')
    .get(userId, taskId) as NoteRow | undefined;
  if (existing) return mapNote(existing);
  return createNote(userId, {
    taskId,
    title: task.title,
    body: task.note ?? task.title,
  });
}

export function updateNote(userId: string, id: string, patch: Record<string, unknown>): StickyNoteDTO | null {
  const existing = getRow(userId, id);
  if (!existing) return null;
  const current = mapNote(existing);
  const title = patch.title == null ? current.title : String(patch.title).trim();
  const body = patch.body == null ? current.body : String(patch.body);
  if (!title.trim() && !body.trim()) throw new AppError(400, 'invalid_note', 'title or body is required');
  const taskId = patch.taskId === undefined ? current.taskId : patch.taskId == null ? null : String(patch.taskId);
  if (taskId && !repo.getTask(userId, taskId)) throw new AppError(404, 'not_found', 'task not found');
  const color = patch.color === undefined ? current.color : patch.color == null ? null : String(patch.color);
  const opacity = normalizeOpacity(patch.opacity, current.opacity);
  const fontSize = normalizeFontSize(patch.fontSize, current.fontSize);
  const pinned = patch.pinned == null ? current.pinned : !!patch.pinned;
  const position = normalizePosition(patch.position, current.position);
  const ts = nowISO();
  db.prepare(
    `UPDATE sticky_notes
     SET task_id = ?, title = ?, body = ?, color = ?, opacity = ?, font_size = ?, pinned = ?, position_json = ?, updated_at = ?
     WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
  ).run(taskId, title || defaultTitle(body), body, color, opacity, fontSize, pinned ? 1 : 0, JSON.stringify(position), ts, userId, id);
  return mapNote(getRow(userId, id)!);
}

export function deleteNote(userId: string, id: string): boolean {
  return db.prepare('UPDATE sticky_notes SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND id = ? AND deleted_at IS NULL').run(
    nowISO(),
    nowISO(),
    userId,
    id,
  ).changes > 0;
}

export function restoreNote(userId: string, id: string): StickyNoteDTO | null {
  const info = db
    .prepare('UPDATE sticky_notes SET deleted_at = NULL, updated_at = ? WHERE user_id = ? AND id = ? AND deleted_at IS NOT NULL')
    .run(nowISO(), userId, id);
  if (info.changes === 0) return null;
  return mapNote(getRow(userId, id)!);
}

export function convertNoteToTask(userId: string, id: string): { note: StickyNoteDTO; task: TaskDTO } | null {
  const note = getRow(userId, id);
  if (!note) return null;
  const mapped = mapNote(note);
  if (mapped.taskId) {
    const existingTask = repo.getTask(userId, mapped.taskId);
    if (existingTask) return { note: mapped, task: existingTask };
  }
  const title = mapped.title.trim() || defaultTitle(mapped.body);
  const task = repo.createTask(userId, {
    title,
    note: mapped.body || null,
    listId: null,
    tagIds: [],
    priority: 0,
    dueDate: null,
    startDate: null,
    isAllDay: true,
    source: 'note',
  });
  const updated = updateNote(userId, id, { taskId: task.id })!;
  return { note: updated, task };
}
