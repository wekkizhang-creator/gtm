import { Router, type NextFunction, type Request, type Response } from 'express';
import * as repo from '../repo';
import { AppError, type QuickCaptureSource } from '../types';
import { requireUserId } from '../authMiddleware';
import { quickParseTaskWithUrlTitle } from '../quickParse';
import { getSettings } from '../settingsRepo';

const router = Router();
const QUICK_CAPTURE_SOURCES: QuickCaptureSource[] = ['voice', 'system_share', 'desktop_widget', 'shortcut', 'web'];

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

function quickAddParseOptions(userId: string, requestedValue: unknown) {
  const quickAdd = getSettings(userId).quickAdd;
  const requested = requestedValue && typeof requestedValue === 'object' ? requestedValue as Record<string, unknown> : {};
  return {
    dateRecognition: typeof requested.dateRecognition === 'boolean' ? requested.dateRecognition : quickAdd.dateRecognition,
    removeDateText: typeof requested.removeDateText === 'boolean' ? requested.removeDateText : quickAdd.removeDateText,
    tagRecognition: typeof requested.tagRecognition === 'boolean' ? requested.tagRecognition : quickAdd.tagRecognition,
    removeTagText: typeof requested.removeTagText === 'boolean' ? requested.removeTagText : quickAdd.removeTagText,
    urlParsing: typeof requested.urlParsing === 'boolean' ? requested.urlParsing : quickAdd.urlParsing,
  };
}

function optionalTrimmedString(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new AppError(400, 'invalid', `${field} must be a string`);
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeCaptureSource(value: unknown): QuickCaptureSource {
  if (value == null) return 'web';
  if (typeof value !== 'string') throw new AppError(400, 'invalid', 'source must be a string');
  if (!QUICK_CAPTURE_SOURCES.includes(value as QuickCaptureSource)) {
    throw new AppError(400, 'invalid_capture_source', `source must be one of ${QUICK_CAPTURE_SOURCES.join(', ')}`);
  }
  return value as QuickCaptureSource;
}

function normalizeSharedUrl(value: unknown): string | null {
  const raw = optionalTrimmedString(value, 'url');
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError(400, 'invalid_url', 'url must be a valid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AppError(400, 'invalid_url', 'url must be http or https');
  }
  return parsed.toString();
}

function noteWithUrl(note: string | null | undefined, url: string | null): string | null | undefined {
  if (!url) return note;
  if (note && note.includes(url)) return note;
  return note ? `${note}\n${url}` : url;
}

function ensureTagIdsByName(userId: string, names: string[]): string[] {
  const existing = new Map(repo.listTags(userId).map((tag) => [tag.name.trim().toLowerCase(), tag]));
  const ids: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const tag = existing.get(key) ?? repo.createTag(userId, { name });
    existing.set(key, tag);
    ids.push(tag.id);
  }
  return Array.from(new Set(ids));
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
    const parsed = await quickParseTaskWithUrlTitle(text, quickAddParseOptions(requireUserId(req), req.body?.options));
    res.json(parsed);
  } catch (err) {
    next(err);
  }
});

router.post('/quick-capture', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = requireUserId(req);
    const body = req.body ?? {};
    const source = normalizeCaptureSource(body.source);
    const title = optionalTrimmedString(body.title, 'title');
    const text = optionalTrimmedString(body.text, 'text');
    const url = normalizeSharedUrl(body.url);
    const captureText = [title, text].filter(Boolean).join(' ').trim() || url;
    if (!captureText) throw new AppError(400, 'invalid', 'text, title or url is required');
    const listId = body.listId == null ? null : optionalTrimmedString(body.listId, 'listId');
    const input: Parameters<typeof repo.createTask>[1] = {
      title: captureText,
      source,
    };
    if (listId) input.listId = listId;
    assertPriority(body.priority);
    if (body.startDate != null) assertISODate(body.startDate, 'startDate');
    if (body.dueDate != null) assertISODate(body.dueDate, 'dueDate');
    if (body.isAllDay != null && typeof body.isAllDay !== 'boolean') throw new AppError(400, 'invalid', 'isAllDay must be boolean');
    if (body.startDate && body.dueDate && body.startDate > body.dueDate) {
      throw new AppError(400, 'invalid', 'startDate must be on or before dueDate');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'priority')) input.priority = body.priority ?? 0;
    if (Object.prototype.hasOwnProperty.call(body, 'dueDate')) input.dueDate = body.dueDate ?? null;
    if (Object.prototype.hasOwnProperty.call(body, 'startDate')) input.startDate = body.startDate ?? null;
    if (Object.prototype.hasOwnProperty.call(body, 'isAllDay')) input.isAllDay = body.isAllDay ?? true;
    let parsed: Awaited<ReturnType<typeof quickParseTaskWithUrlTitle>> | null = null;
    if (body.parse !== false) {
      parsed = await quickParseTaskWithUrlTitle(captureText, quickAddParseOptions(userId, body.options));
      input.title = parsed.draft.title || captureText;
      if (parsed.draft.dueDate || parsed.draft.startDate) {
        input.dueDate = parsed.draft.dueDate;
        input.startDate = parsed.draft.startDate;
        input.isAllDay = parsed.draft.isAllDay;
      }
      if (parsed.draft.priority > 0) input.priority = parsed.draft.priority;
      if (parsed.draft.estimatedMinutes != null) input.estimatedMinutes = parsed.draft.estimatedMinutes;
      if (parsed.draft.recurrenceRule) input.recurrenceRule = parsed.draft.recurrenceRule;
      if (parsed.draft.note) input.note = parsed.draft.note;
      const parsedTagIds = ensureTagIdsByName(userId, parsed.draft.tags);
      if (parsedTagIds.length) {
        input.tagIds = Array.from(new Set([...getSettings(userId).taskDefaults.defaultTagIds, ...parsedTagIds]));
      }
    }
    input.note = noteWithUrl(input.note, url);
    const task = repo.createTask(userId, input);
    res.status(201).json({ task, parsed });
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
    scheduleEnergyType: b.scheduleEnergyType ?? null,
    scheduleTaskType: b.scheduleTaskType ?? null,
    isSplittable: b.isSplittable ?? false,
    minScheduleMinutes: b.minScheduleMinutes ?? null,
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

// POST /api/tasks/:id/reparent
router.post('/:id/reparent', (req, res) => {
  const rawParentId = req.body?.parentId;
  if (rawParentId != null && (typeof rawParentId !== 'string' || !rawParentId.trim())) {
    throw new AppError(400, 'invalid', 'parentId must be a task id or null');
  }
  const task = repo.reparentTask(requireUserId(req), req.params.id, rawParentId == null ? null : rawParentId.trim());
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
