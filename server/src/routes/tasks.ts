import { Router, type NextFunction, type Request, type Response } from 'express';
import * as repo from '../repo';
import { AppError } from '../types';
import { requireUserId } from '../authMiddleware';
import { quickParseTaskWithUrlTitle } from '../quickParse';
import { getSettings } from '../settingsRepo';

const router = Router();

function assertPriority(p: unknown) {
  if (p != null && ![0, 1, 2, 3].includes(p as number)) {
    throw new AppError(400, 'invalid', 'priority must be 0, 1, 2 or 3');
  }
}

function parsePriorityParam(p: unknown): number | undefined {
  if (p == null) return undefined;
  const n = Number(p);
  assertPriority(n);
  return n;
}

function assertISODate(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new AppError(400, 'invalid', `${field} must be an ISO date string`);
  }
}

// GET /api/tasks?view=...  OR  ?listId=...
router.get('/', (req, res) => {
  const view = typeof req.query.view === 'string' ? req.query.view : undefined;
  const listId = typeof req.query.listId === 'string' ? req.query.listId : undefined;
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  if (from != null) assertISODate(from, 'from');
  if (to != null) assertISODate(to, 'to');
  const parentId = typeof req.query.parentId === 'string' ? req.query.parentId : undefined;
  const tagId = typeof req.query.tagId === 'string' ? req.query.tagId : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const dateFilter = typeof req.query.dateFilter === 'string' ? req.query.dateFilter : undefined;
  if (dateFilter != null && !['today', 'next7days', 'undated'].includes(dateFilter)) {
    throw new AppError(400, 'invalid', 'dateFilter must be today, next7days or undated');
  }
  const priority = parsePriorityParam(req.query.priority);
  res.json({ tasks: repo.getTasks(requireUserId(req), { view, listId, from, to, parentId, tagId, priority, status: status as any, q, dateFilter: dateFilter as any }) });
});

router.post('/quick-parse', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim()) throw new AppError(400, 'invalid', 'text is required');
    const quickAdd = getSettings(requireUserId(req)).quickAdd;
    const requested = req.body?.options && typeof req.body.options === 'object' ? req.body.options : {};
    const parsed = await quickParseTaskWithUrlTitle(text, {
      dateRecognition: typeof requested.dateRecognition === 'boolean' ? requested.dateRecognition : quickAdd.dateRecognition,
      removeDateText: typeof requested.removeDateText === 'boolean' ? requested.removeDateText : quickAdd.removeDateText,
      tagRecognition: typeof requested.tagRecognition === 'boolean' ? requested.tagRecognition : quickAdd.tagRecognition,
      removeTagText: typeof requested.removeTagText === 'boolean' ? requested.removeTagText : quickAdd.removeTagText,
      urlParsing: typeof requested.urlParsing === 'boolean' ? requested.urlParsing : quickAdd.urlParsing,
    });
    res.json(parsed);
  } catch (err) {
    next(err);
  }
});

router.post('/batch', (req, res) => {
  const b = req.body ?? {};
  if (!Array.isArray(b.taskIds)) throw new AppError(400, 'invalid', 'taskIds must be an array');
  if (!['update', 'delete', 'restore', 'purge'].includes(b.action)) {
    throw new AppError(400, 'invalid', 'action must be update, delete, restore or purge');
  }
  if (b.action === 'update') {
    const patch = b.patch ?? {};
    assertPriority(patch.priority);
    if (patch.dueDate != null && Number.isNaN(Date.parse(patch.dueDate))) throw new AppError(400, 'invalid', 'dueDate must be an ISO date string');
    if (patch.startDate != null && Number.isNaN(Date.parse(patch.startDate))) throw new AppError(400, 'invalid', 'startDate must be an ISO date string');
  }
  res.json(repo.batchTasks(requireUserId(req), { taskIds: b.taskIds, action: b.action, patch: b.patch ?? {} }));
});

router.get('/trash/summary', (req, res) => {
  res.json({ trash: repo.getTrashSummary(requireUserId(req), req.query.retentionDays) });
});

router.post('/trash/purge-expired', (req, res) => {
  res.json({ trash: repo.purgeExpiredTrash(requireUserId(req), req.body?.retentionDays) });
});

router.post('/trash/empty', (req, res) => {
  res.json({ trash: repo.emptyTrash(requireUserId(req)) });
});

// POST /api/tasks
router.post('/', (req, res) => {
  const b = req.body ?? {};
  if (typeof b.title !== 'string' || !b.title.trim()) {
    throw new AppError(400, 'invalid', 'title is required');
  }
  assertPriority(b.priority);
  if (b.startDate != null) assertISODate(b.startDate, 'startDate');
  if (b.dueDate != null) assertISODate(b.dueDate, 'dueDate');
  if (b.startDate && b.dueDate && b.startDate > b.dueDate) {
    throw new AppError(400, 'invalid', 'startDate must be on or before dueDate');
  }
  if (b.tagIds != null && (!Array.isArray(b.tagIds) || b.tagIds.some((tagId: unknown) => typeof tagId !== 'string' || !tagId.trim()))) {
    throw new AppError(400, 'invalid', 'tagIds must be an array of tag ids');
  }
  const input: Parameters<typeof repo.createTask>[1] = {
    title: b.title.trim(),
    isImportant: b.isImportant ?? null,
    isUrgent: b.isUrgent ?? null,
    parentId: b.parentId ?? null,
    estimatedMinutes: b.estimatedMinutes ?? null,
    recurrenceRule: b.recurrenceRule ?? null,
    source: b.source ?? 'manual',
    manualProgress: b.manualProgress ?? null,
    pinned: b.pinned ?? false,
    status: b.status ?? 'todo',
  };
  for (const key of ['note', 'listId', 'priority', 'dueDate', 'startDate', 'isAllDay'] as const) {
    if (Object.prototype.hasOwnProperty.call(b, key)) (input as Record<string, unknown>)[key] = b[key] ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'tagIds')) input.tagIds = b.tagIds ?? [];
  const task = repo.createTask(requireUserId(req), input);
  res.status(201).json({ task });
});

// GET /api/tasks/:id
router.get('/:id', (req, res) => {
  const task = repo.getTask(requireUserId(req), req.params.id);
  if (!task) throw new AppError(404, 'not_found', 'task not found');
  res.json({ task });
});

// GET /api/tasks/:id/activity
router.get('/:id/activity', (req, res) => {
  const limit = req.query.limit == null ? 50 : Number(req.query.limit);
  res.json({ activities: repo.listTaskActivity(requireUserId(req), req.params.id, limit) });
});

// PATCH /api/tasks/:id
router.patch('/:id', (req, res) => {
  assertPriority(req.body?.priority);
  const task = repo.updateTask(requireUserId(req), req.params.id, req.body ?? {});
  if (!task) throw new AppError(404, 'not_found', 'task not found');
  res.json({ task });
});

// POST /api/tasks/:id/tags/:tagId
router.post('/:id/tags/:tagId', (req, res) => {
  const task = repo.addTaskTag(requireUserId(req), req.params.id, req.params.tagId);
  res.json({ task });
});

// DELETE /api/tasks/:id/tags/:tagId
router.delete('/:id/tags/:tagId', (req, res) => {
  const task = repo.removeTaskTag(requireUserId(req), req.params.id, req.params.tagId);
  res.json({ task });
});

// GET /api/tasks/:id/reminders
router.get('/:id/reminders', (req, res) => {
  res.json({ reminders: repo.listTaskReminders(requireUserId(req), req.params.id) });
});

// GET /api/tasks/:id/checklist
router.get('/:id/checklist', (req, res) => {
  res.json({ items: repo.listChecklistItems(requireUserId(req), req.params.id) });
});

// POST /api/tasks/:id/checklist
router.post('/:id/checklist', (req, res) => {
  const b = req.body ?? {};
  if (typeof b.title !== 'string' || !b.title.trim()) throw new AppError(400, 'invalid', 'title is required');
  const item = repo.createChecklistItem(requireUserId(req), req.params.id, {
    title: b.title,
    sortOrder: typeof b.sortOrder === 'number' ? b.sortOrder : null,
  });
  res.status(201).json({ item });
});

// PATCH /api/tasks/:id/checklist/:itemId
router.patch('/:id/checklist/:itemId', (req, res) => {
  const item = repo.updateChecklistItem(requireUserId(req), req.params.id, req.params.itemId, req.body ?? {});
  if (!item) throw new AppError(404, 'not_found', 'checklist item not found');
  res.json({ item });
});

// DELETE /api/tasks/:id/checklist/:itemId
router.delete('/:id/checklist/:itemId', (req, res) => {
  const ok = repo.deleteChecklistItem(requireUserId(req), req.params.id, req.params.itemId);
  if (!ok) throw new AppError(404, 'not_found', 'checklist item not found');
  res.status(204).end();
});

// POST /api/tasks/:id/checklist/:itemId/convert-to-subtask
router.post('/:id/checklist/:itemId/convert-to-subtask', (req, res) => {
  const result = repo.convertChecklistItemToSubtask(requireUserId(req), req.params.id, req.params.itemId);
  if (!result) throw new AppError(404, 'not_found', 'checklist item not found');
  res.status(201).json(result);
});

// POST /api/tasks/:id/reminders
router.post('/:id/reminders', (req, res) => {
  const b = req.body ?? {};
  assertISODate(b.remindAt, 'remindAt');
  if (b.channel != null && b.channel !== 'email') {
    throw new AppError(400, 'invalid', 'channel must be email');
  }
  const reminder = repo.createTaskReminder(requireUserId(req), req.params.id, { remindAt: b.remindAt, channel: 'email' });
  res.status(201).json({ reminder });
});

// POST /api/tasks/:id/recurrence/defer
router.post('/:id/recurrence/defer', (req, res) => {
  const task = repo.deferRecurringTask(requireUserId(req), req.params.id);
  res.json({ task });
});

// POST /api/tasks/:id/recurrence/skip
router.post('/:id/recurrence/skip', (req, res) => {
  res.json(repo.skipRecurringTask(requireUserId(req), req.params.id));
});

// DELETE /api/tasks/:id/reminders/:reminderId
router.delete('/:id/reminders/:reminderId', (req, res) => {
  const ok = repo.deleteTaskReminder(requireUserId(req), req.params.id, req.params.reminderId);
  if (!ok) throw new AppError(404, 'not_found', 'reminder not found');
  res.status(204).end();
});

// POST /api/tasks/:id/attachments
router.post('/:id/attachments', (req, res) => {
  const b = req.body ?? {};
  if (typeof b.fileName !== 'string' || !b.fileName.trim()) {
    throw new AppError(400, 'invalid', 'fileName is required');
  }
  const attachment = repo.createTaskAttachment(requireUserId(req), req.params.id, {
    fileName: b.fileName,
    mimeType: b.mimeType ?? null,
    contentBase64: b.contentBase64,
  });
  res.status(201).json({ attachment });
});

// POST /api/tasks/:id/dependencies
router.post('/:id/dependencies', (req, res) => {
  const dependencyId = req.body?.dependencyId;
  if (typeof dependencyId !== 'string' || !dependencyId) {
    throw new AppError(400, 'invalid', 'dependencyId is required');
  }
  const task = repo.addTaskDependency(requireUserId(req), req.params.id, dependencyId);
  res.json({ task });
});

// DELETE /api/tasks/:id/dependencies/:dependencyId
router.delete('/:id/dependencies/:dependencyId', (req, res) => {
  const task = repo.removeTaskDependency(requireUserId(req), req.params.id, req.params.dependencyId);
  res.json({ task });
});

// POST /api/tasks/:id/restore
router.post('/:id/restore', (req, res) => {
  const task = repo.restoreTask(requireUserId(req), req.params.id);
  if (!task) throw new AppError(404, 'not_found', 'task not found');
  res.json({ task });
});

// DELETE /api/tasks/:id            -> soft delete (trash)
// DELETE /api/tasks/:id?permanent=1 -> hard delete
router.delete('/:id', (req, res) => {
  const permanent = req.query.permanent === '1' || req.query.permanent === 'true';
  const ok = permanent ? repo.hardDeleteTask(requireUserId(req), req.params.id) : repo.softDeleteTask(requireUserId(req), req.params.id);
  if (!ok) throw new AppError(404, 'not_found', 'task not found');
  res.status(204).end();
});

export default router;
