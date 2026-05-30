// Data access + business logic. All queries are real, parameterized SQL against SQLite.
import { randomUUID } from 'node:crypto';
import { db, nowISO, INBOX_ID } from './db';
import { AppError, type ListDTO, type TaskDTO, type SmartCounts } from './types';

// ---------- row -> DTO mappers ----------
function mapList(r: any): ListDTO {
  return {
    id: r.id,
    name: r.name,
    color: r.color ?? null,
    icon: r.icon ?? null,
    sortOrder: r.sort_order,
    isInbox: !!r.is_inbox,
    taskCount: r.task_count ?? 0,
  };
}

function mapTask(r: any): TaskDTO {
  return {
    id: r.id,
    title: r.title,
    note: r.note ?? null,
    listId: r.list_id ?? null,
    priority: r.priority,
    dueDate: r.due_date ?? null,
    startDate: r.start_date ?? null,
    isAllDay: !!r.is_all_day,
    isImportant: r.is_important == null ? null : !!r.is_important,
    isUrgent: r.is_urgent == null ? null : !!r.is_urgent,
    completed: !!r.completed,
    completedAt: r.completed_at ?? null,
    deletedAt: r.deleted_at ?? null,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------- date helpers (smart-list boundaries, server local time) ----------
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
function endOfDayOffsetISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

// ---------- lists ----------
const LIST_WITH_COUNT = `
  SELECT l.*, (
    SELECT COUNT(*) FROM tasks t
    WHERE t.list_id = l.id AND t.completed = 0 AND t.deleted_at IS NULL
  ) AS task_count
  FROM lists l
`;

export function listLists(): ListDTO[] {
  const rows = db
    .prepare(`${LIST_WITH_COUNT} WHERE l.is_inbox = 0 ORDER BY l.sort_order ASC, l.created_at ASC`)
    .all() as any[];
  return rows.map(mapList);
}

export function createList(name: string, color: string | null, icon: string | null): ListDTO {
  const id = randomUUID();
  const ts = nowISO();
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM lists WHERE is_inbox = 0').get() as {
    m: number;
  };
  db.prepare(
    `INSERT INTO lists (id, name, color, icon, sort_order, is_inbox, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(id, name, color, icon, (max.m ?? 0) + 1, ts, ts);
  const row = db.prepare(`${LIST_WITH_COUNT} WHERE l.id = ?`).get(id);
  return mapList(row);
}

export function updateList(id: string, patch: Record<string, unknown>): ListDTO | null {
  const map: Record<string, string> = {
    name: 'name',
    color: 'color',
    icon: 'icon',
    sortOrder: 'sort_order',
  };
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) {
      cols.push(`${col} = ?`);
      vals.push(patch[k] ?? null);
    }
  }
  cols.push('updated_at = ?');
  vals.push(nowISO());
  vals.push(id);
  const info = db.prepare(`UPDATE lists SET ${cols.join(', ')} WHERE id = ? AND is_inbox = 0`).run(...(vals as any[]));
  if (info.changes === 0) return null;
  return mapList(db.prepare(`${LIST_WITH_COUNT} WHERE l.id = ?`).get(id));
}

export function deleteList(id: string): void {
  const row = db.prepare('SELECT is_inbox FROM lists WHERE id = ?').get(id) as { is_inbox: number } | undefined;
  if (!row) throw new AppError(404, 'not_found', 'list not found');
  if (row.is_inbox) throw new AppError(400, 'forbidden', 'cannot delete the inbox list');
  // move tasks of this list back to the inbox, then remove the list
  db.prepare('UPDATE tasks SET list_id = ?, updated_at = ? WHERE list_id = ?').run(INBOX_ID, nowISO(), id);
  db.prepare('DELETE FROM lists WHERE id = ?').run(id);
}

// ---------- tasks ----------
export function getTasks(opts: { view?: string; listId?: string; from?: string; to?: string }): TaskDTO[] {
  let where: string;
  let order: string;
  let params: unknown[] = [];

  if (opts.from && opts.to) {
    // calendar range: timed blocks overlapping the window, plus all-day/point tasks landing in it
    where =
      'deleted_at IS NULL AND ( (start_date IS NOT NULL AND start_date <= ? AND due_date >= ?) OR (start_date IS NULL AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ?) )';
    params = [opts.to, opts.from, opts.from, opts.to];
    order = 'start_date ASC, due_date ASC';
  } else if (opts.view) {
    switch (opts.view) {
      case 'inbox':
        where = 'list_id = ? AND completed = 0 AND deleted_at IS NULL';
        params = [INBOX_ID];
        order = 'priority DESC, created_at DESC';
        break;
      case 'active':
        where = 'completed = 0 AND deleted_at IS NULL';
        order = 'priority DESC, created_at DESC';
        break;
      case 'today':
        where = 'completed = 0 AND deleted_at IS NULL AND due_date IS NOT NULL AND due_date <= ?';
        params = [endOfTodayISO()];
        order = 'due_date ASC, priority DESC';
        break;
      case 'next7days':
        where = 'completed = 0 AND deleted_at IS NULL AND due_date >= ? AND due_date <= ?';
        params = [startOfTodayISO(), endOfDayOffsetISO(6)];
        order = 'due_date ASC, priority DESC';
        break;
      case 'completed':
        where = 'completed = 1 AND deleted_at IS NULL';
        order = 'completed_at DESC';
        break;
      case 'trash':
        where = 'deleted_at IS NOT NULL';
        order = 'deleted_at DESC';
        break;
      case 'undated':
        where = 'due_date IS NULL AND completed = 0 AND deleted_at IS NULL';
        order = 'priority DESC, created_at DESC';
        break;
      case 'matrix':
        where = 'deleted_at IS NULL AND is_important IS NOT NULL AND is_urgent IS NOT NULL';
        order = 'completed ASC, priority DESC, created_at DESC';
        break;
      case 'unclassified':
        where = 'completed = 0 AND deleted_at IS NULL AND (is_important IS NULL OR is_urgent IS NULL)';
        order = 'priority DESC, created_at DESC';
        break;
      default:
        throw new AppError(400, 'bad_view', `unknown view: ${opts.view}`);
    }
  } else if (opts.listId) {
    where = 'list_id = ? AND completed = 0 AND deleted_at IS NULL';
    params = [opts.listId];
    order = 'priority DESC, created_at DESC';
  } else {
    throw new AppError(400, 'missing_query', 'either view or listId is required');
  }

  const rows = db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY ${order}`).all(...(params as any[])) as any[];
  return rows.map(mapTask);
}

export function getTask(id: string): TaskDTO | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return row ? mapTask(row) : null;
}

export function createTask(input: {
  title: string;
  note: string | null;
  listId: string | null;
  priority: number;
  dueDate: string | null;
  startDate: string | null;
  isAllDay: boolean;
  isImportant?: boolean | null;
  isUrgent?: boolean | null;
}): TaskDTO {
  const id = randomUUID();
  const ts = nowISO();
  const listId = input.listId ?? INBOX_ID;
  db.prepare(
    `INSERT INTO tasks
       (id, title, note, list_id, priority, due_date, start_date, is_all_day, is_important, is_urgent, completed, completed_at, deleted_at, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, 0, ?, ?)`,
  ).run(
    id,
    input.title,
    input.note,
    listId,
    input.priority,
    input.dueDate,
    input.startDate,
    input.isAllDay ? 1 : 0,
    input.isImportant == null ? null : input.isImportant ? 1 : 0,
    input.isUrgent == null ? null : input.isUrgent ? 1 : 0,
    ts,
    ts,
  );
  return getTask(id)!;
}

export function updateTask(id: string, patch: Record<string, unknown>): TaskDTO | null {
  // validate start/due ordering against the merged (post-patch) state
  if ('startDate' in patch || 'dueDate' in patch) {
    const cur = getTask(id);
    if (cur) {
      const finalStart = 'startDate' in patch ? (patch.startDate as string | null) : cur.startDate;
      const finalDue = 'dueDate' in patch ? (patch.dueDate as string | null) : cur.dueDate;
      if (finalStart && finalDue && finalStart > finalDue) {
        throw new AppError(400, 'invalid', 'startDate must be on or before dueDate');
      }
    }
  }
  const map: Record<string, string> = {
    title: 'title',
    note: 'note',
    listId: 'list_id',
    priority: 'priority',
    dueDate: 'due_date',
    startDate: 'start_date',
    isAllDay: 'is_all_day',
    isImportant: 'is_important',
    isUrgent: 'is_urgent',
    completed: 'completed',
    sortOrder: 'sort_order',
  };
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) {
      let v = patch[k];
      if (k === 'isAllDay' || k === 'completed') v = v ? 1 : 0;
      else if (k === 'isImportant' || k === 'isUrgent') v = v == null ? null : v ? 1 : 0;
      cols.push(`${col} = ?`);
      vals.push(v ?? null);
    }
  }
  // keep completed_at in sync whenever completion is toggled
  if ('completed' in patch) {
    cols.push('completed_at = ?');
    vals.push(patch.completed ? nowISO() : null);
  }
  cols.push('updated_at = ?');
  vals.push(nowISO());
  vals.push(id);
  const info = db.prepare(`UPDATE tasks SET ${cols.join(', ')} WHERE id = ?`).run(...(vals as any[]));
  if (info.changes === 0) return null;
  return getTask(id);
}

export function softDeleteTask(id: string): boolean {
  const ts = nowISO();
  const info = db
    .prepare('UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(ts, ts, id);
  return info.changes > 0;
}

export function restoreTask(id: string): TaskDTO | null {
  const info = db.prepare('UPDATE tasks SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(nowISO(), id);
  if (info.changes === 0) return null;
  return getTask(id);
}

export function hardDeleteTask(id: string): boolean {
  const info = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return info.changes > 0;
}

// ---------- smart-list counts ----------
function count(where: string, params: unknown[]): number {
  const r = db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE ${where}`).get(...(params as any[])) as { c: number };
  return r.c;
}

export function smartCounts(): SmartCounts {
  return {
    inbox: count('list_id = ? AND completed = 0 AND deleted_at IS NULL', [INBOX_ID]),
    today: count('completed = 0 AND deleted_at IS NULL AND due_date IS NOT NULL AND due_date <= ?', [endOfTodayISO()]),
    next7days: count('completed = 0 AND deleted_at IS NULL AND due_date >= ? AND due_date <= ?', [
      startOfTodayISO(),
      endOfDayOffsetISO(6),
    ]),
    completed: count('completed = 1 AND deleted_at IS NULL', []),
    trash: count('deleted_at IS NOT NULL', []),
  };
}
