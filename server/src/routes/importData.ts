import { Router } from 'express';
import { requireUserId } from '../authMiddleware';
import { db } from '../db';
import * as tasks from '../repo';
import * as habits from '../habitsRepo';
import * as countdowns from '../countdownsRepo';
import { AppError } from '../types';

const router = Router();

type Row = { type: string; title: string; payload: Record<string, any> };

function parseInput(body: any): any {
  if (body?.format === 'json') return typeof body.data === 'string' ? JSON.parse(body.data) : body.data;
  if (body?.format === 'csv') {
    const text = String(body.data ?? '');
    const [head, ...lines] = text.trim().split(/\r?\n/);
    const headers = head.split(',').map((h) => h.trim());
    return {
      tasks: lines.map((line) => {
        const cells = line.split(',');
        return Object.fromEntries(headers.map((h, i) => [h, cells[i]?.trim() ?? '']));
      }),
    };
  }
  throw new AppError(400, 'invalid', 'format must be json or csv');
}

function normalize(body: any): { rows: Row[]; invalidRows: { type: string; reason: string; payload: unknown }[] } {
  const data = parseInput(body) ?? {};
  const rows: Row[] = [];
  const invalidRows: { type: string; reason: string; payload: unknown }[] = [];
  const collect = (type: string, list: any[] | undefined, field: 'title' | 'name') => {
    for (const item of Array.isArray(list) ? list : []) {
      const title = String(item?.[field] ?? item?.title ?? item?.name ?? '').trim();
      if (!title) invalidRows.push({ type, reason: 'missing title/name', payload: item });
      else rows.push({ type, title, payload: item });
    }
  };
  collect('lists', data.lists, 'name');
  collect('tasks', data.tasks, 'title');
  collect('tags', data.tags, 'name');
  collect('habits', data.habits, 'name');
  collect('countdowns', data.countdowns, 'title');
  collect('goals', data.goals, 'title');
  return { rows, invalidRows };
}

function duplicate(userId: string, row: Row): boolean {
  const table: Record<string, { table: string; col: string; extra?: string }> = {
    lists: { table: 'lists', col: 'name', extra: 'AND is_inbox = 0' },
    tasks: { table: 'tasks', col: 'title', extra: 'AND deleted_at IS NULL' },
    tags: { table: 'tags', col: 'name' },
    habits: { table: 'habits', col: 'name' },
    countdowns: { table: 'countdowns', col: 'title' },
    goals: { table: 'goals', col: 'title' },
  };
  const cfg = table[row.type];
  if (!cfg) return false;
  const found = db.prepare(`SELECT id FROM ${cfg.table} WHERE user_id = ? AND ${cfg.col} = ? ${cfg.extra ?? ''} LIMIT 1`).get(userId, row.title);
  return !!found;
}

function preview(userId: string, body: any) {
  const { rows, invalidRows } = normalize(body);
  const duplicates = rows.filter((row) => duplicate(userId, row));
  return {
    summary: { total: rows.length + invalidRows.length, valid: rows.length, duplicates: duplicates.length, invalid: invalidRows.length },
    rows,
    duplicates,
    invalidRows,
  };
}

router.post('/preview', (req, res) => {
  res.json(preview(requireUserId(req), req.body ?? {}));
});

router.post('/commit', (req, res) => {
  const userId = requireUserId(req);
  if (req.body?.confirm !== true) throw new AppError(400, 'confirmation_required', 'confirm:true is required');
  const before = preview(userId, req.body ?? {});
  const created: Row[] = [];
  for (const row of before.rows) {
    if (duplicate(userId, row)) continue;
    if (row.type === 'lists') tasks.createList(userId, row.title, row.payload.color ?? null, row.payload.icon ?? null);
    else if (row.type === 'tasks')
      tasks.createTask(userId, {
        title: row.title,
        note: row.payload.note ?? null,
        listId: null,
        tagIds: [],
        priority: row.payload.priority ?? 0,
        dueDate: row.payload.dueDate ?? null,
        startDate: row.payload.startDate ?? null,
        isAllDay: row.payload.isAllDay ?? true,
      });
    else if (row.type === 'tags') tasks.createTag(userId, { name: row.title, color: row.payload.color ?? null });
    else if (row.type === 'habits')
      habits.createHabit(userId, { name: row.title, icon: row.payload.icon ?? null, color: row.payload.color ?? null, daysOfWeek: null, note: row.payload.note ?? null });
    else if (row.type === 'countdowns')
      countdowns.createCountdown(userId, { title: row.title, targetDate: row.payload.targetDate, icon: null, color: null, repeatYearly: false, pinned: false, note: null });
    else if (row.type === 'goals') tasks.createGoal(userId, { title: row.title, description: row.payload.description ?? null });
    created.push(row);
  }
  res.json({ created, skippedDuplicates: before.duplicates, invalidRows: before.invalidRows });
});

export default router;
