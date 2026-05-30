import { Router } from 'express';
import * as repo from '../repo';
import { AppError } from '../types';

const router = Router();

function assertPriority(p: unknown) {
  if (p != null && ![0, 1, 2, 3].includes(p as number)) {
    throw new AppError(400, 'invalid', 'priority must be 0, 1, 2 or 3');
  }
}

// GET /api/tasks?view=...  OR  ?listId=...
router.get('/', (req, res) => {
  const view = typeof req.query.view === 'string' ? req.query.view : undefined;
  const listId = typeof req.query.listId === 'string' ? req.query.listId : undefined;
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  res.json({ tasks: repo.getTasks({ view, listId, from, to }) });
});

// POST /api/tasks
router.post('/', (req, res) => {
  const b = req.body ?? {};
  if (typeof b.title !== 'string' || !b.title.trim()) {
    throw new AppError(400, 'invalid', 'title is required');
  }
  assertPriority(b.priority);
  if (b.startDate && b.dueDate && b.startDate > b.dueDate) {
    throw new AppError(400, 'invalid', 'startDate must be on or before dueDate');
  }
  const task = repo.createTask({
    title: b.title.trim(),
    note: b.note ?? null,
    listId: b.listId ?? null,
    priority: b.priority ?? 0,
    dueDate: b.dueDate ?? null,
    startDate: b.startDate ?? null,
    isAllDay: b.isAllDay ?? true,
    isImportant: b.isImportant ?? null,
    isUrgent: b.isUrgent ?? null,
  });
  res.status(201).json({ task });
});

// GET /api/tasks/:id
router.get('/:id', (req, res) => {
  const task = repo.getTask(req.params.id);
  if (!task) throw new AppError(404, 'not_found', 'task not found');
  res.json({ task });
});

// PATCH /api/tasks/:id
router.patch('/:id', (req, res) => {
  assertPriority(req.body?.priority);
  const task = repo.updateTask(req.params.id, req.body ?? {});
  if (!task) throw new AppError(404, 'not_found', 'task not found');
  res.json({ task });
});

// POST /api/tasks/:id/restore
router.post('/:id/restore', (req, res) => {
  const task = repo.restoreTask(req.params.id);
  if (!task) throw new AppError(404, 'not_found', 'task not found');
  res.json({ task });
});

// DELETE /api/tasks/:id            -> soft delete (trash)
// DELETE /api/tasks/:id?permanent=1 -> hard delete
router.delete('/:id', (req, res) => {
  const permanent = req.query.permanent === '1' || req.query.permanent === 'true';
  const ok = permanent ? repo.hardDeleteTask(req.params.id) : repo.softDeleteTask(req.params.id);
  if (!ok) throw new AppError(404, 'not_found', 'task not found');
  res.status(204).end();
});

export default router;
