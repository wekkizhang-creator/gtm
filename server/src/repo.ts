// Data access + business logic. All queries are real, parameterized SQL against SQLite.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getInboxId, nowISO } from './db';
import { getSettings } from './settingsRepo';
import {
  AppError,
  type AttachmentDTO,
  type DayPilotDashboardDTO,
  type DayPilotDashboardRuleImpactDTO,
  type DayPilotDashboardRiskDTO,
  type DayPilotDashboardTaskDTO,
  type ListFolderDTO,
  type GoalDTO,
  type GoalTaskScheduleInsightDTO,
  type ListDTO,
  type NotificationDTO,
  type NotificationPermissionDTO,
  type NotificationPermissionPromptReason,
  type NotificationPermissionStatus,
  type NotificationSoundDTO,
  type Priority,
  type SavedFilterDTO,
  type SearchResultDTO,
  type SmartCounts,
  type TaskActivityDTO,
  type TaskChecklistItemDTO,
  type TagDTO,
  type TaskDTO,
  type TaskReminderDTO,
  type TaskStatus,
  type TrashCleanupResultDTO,
  type TrashSummaryDTO,
  type Settings,
} from './types';

const here = dirname(fileURLToPath(import.meta.url));
const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR ?? resolve(here, '../data/attachments');
const NOTIFICATION_SOUNDS_DIR = process.env.NOTIFICATION_SOUNDS_DIR ?? resolve(here, '../data/notification-sounds');
const AUDIO_MIME_TYPES = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4']);
const MAX_NOTIFICATION_SOUND_BYTES = 2 * 1024 * 1024;

function mapList(r: any): ListDTO {
  return {
    id: r.id,
    folderId: r.folder_id ?? null,
    name: r.name,
    color: r.color ?? null,
    icon: r.icon ?? null,
    type: r.type === 'note' ? 'note' : 'task',
    sortOrder: r.sort_order,
    isInbox: !!r.is_inbox,
    taskCount: r.task_count ?? 0,
  };
}

function normalizeListType(value: unknown): ListDTO['type'] {
  if (value == null || value === '') return 'task';
  if (value === 'task' || value === 'note') return value;
  throw new AppError(400, 'invalid_list_type', 'list type must be task or note');
}

function mapListFolder(r: any): ListFolderDTO {
  return {
    id: r.id,
    name: r.name,
    sortOrder: r.sort_order,
    collapsed: !!r.collapsed,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapTag(r: any): TagDTO {
  return {
    id: r.id,
    name: r.name,
    color: r.color ?? null,
    parentId: r.parent_id ?? null,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapReminder(r: any): TaskReminderDTO {
  return {
    id: r.id,
    taskId: r.task_id,
    remindAt: r.remind_at,
    channel: r.channel,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapChecklistItem(r: any): TaskChecklistItemDTO {
  return {
    id: r.id,
    taskId: r.task_id,
    title: r.title,
    completed: !!r.completed,
    sortOrder: r.sort_order,
    convertedTaskId: r.converted_task_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapTaskActivity(r: any): TaskActivityDTO {
  let details: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(r.details_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) details = parsed;
  } catch {
    details = {};
  }
  return {
    id: r.id,
    taskId: r.task_id,
    action: r.action,
    summary: r.summary,
    details,
    createdAt: r.created_at,
  };
}

function mapAttachment(r: any): AttachmentDTO {
  return {
    id: r.id,
    taskId: r.task_id ?? null,
    fileName: r.file_name,
    mimeType: r.mime_type ?? null,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
  };
}

function mapGoal(r: any): GoalDTO {
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? null,
    startAt: r.start_at ?? null,
    deadlineAt: r.deadline_at ?? null,
    priority: (r.priority ?? 0) as Priority,
    totalEstimatedMinutes: r.total_estimated_minutes ?? null,
    availableTimeRule: r.available_time_rule ?? null,
    progressMode: r.progress_mode ?? 'auto',
    status: r.status ?? 'not_started',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapNotification(r: any): NotificationDTO {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body ?? null,
    targetType: r.target_type ?? null,
    targetId: r.target_id ?? null,
    scheduledAt: r.scheduled_at ?? null,
    deliveredAt: r.delivered_at ?? null,
    readAt: r.read_at ?? null,
    actionState: r.action_state ?? null,
    createdAt: r.created_at,
  };
}

function mapNotificationSound(r: any): NotificationSoundDTO {
  return {
    id: r.id,
    name: r.name,
    purpose: r.purpose ?? 'both',
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    downloadUrl: `/api/notification-sounds/${r.id}/download`,
    createdAt: r.created_at,
  };
}

function mapSavedFilter(r: any): SavedFilterDTO {
  let query: Record<string, unknown> = {};
  try {
    query = JSON.parse(r.query_json);
  } catch {
    query = {};
  }
  return {
    id: r.id,
    name: r.name,
    query,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function parseIdList(s: any): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function assertTaskStatus(status: unknown): asserts status is TaskStatus {
  if (status != null && !['todo', 'doing', 'waiting', 'done', 'skipped'].includes(String(status))) {
    throw new AppError(400, 'invalid', 'status must be todo, doing, waiting, done or skipped');
  }
}

function assertGoalStatus(status: unknown): void {
  if (status != null && !['not_started', 'active', 'paused', 'completed', 'archived'].includes(String(status))) {
    throw new AppError(400, 'invalid', 'goal status must be not_started, active, paused, completed or archived');
  }
}

function assertGoalPriority(priority: unknown): asserts priority is Priority | null | undefined {
  if (priority == null) return;
  if (![0, 1, 2, 3].includes(Number(priority))) {
    throw new AppError(400, 'invalid', 'goal priority must be 0, 1, 2 or 3');
  }
}

function assertProgressMode(mode: unknown): void {
  if (mode != null && !['auto', 'manual'].includes(String(mode))) {
    throw new AppError(400, 'invalid', 'progressMode must be auto or manual');
  }
}

function assertManualProgress(value: unknown): asserts value is number | null | undefined {
  if (value == null) return;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 100) {
    throw new AppError(400, 'invalid', 'manualProgress must be an integer from 0 to 100');
  }
}

function assertScheduleEnergyType(value: unknown): void {
  if (value != null && !['high', 'medium', 'low'].includes(String(value))) {
    throw new AppError(400, 'invalid', 'scheduleEnergyType must be high, medium or low');
  }
}

function assertScheduleMinutes(value: unknown, field: string): void {
  if (value == null) return;
  if (!Number.isInteger(value) || Number(value) < 15 || Number(value) > 1440) {
    throw new AppError(400, 'invalid', `${field} must be an integer from 15 to 1440`);
  }
}

function recordTaskActivity(
  userId: string,
  taskId: string,
  action: string,
  summary: string,
  details: Record<string, unknown> = {},
): void {
  db.prepare(
    `INSERT INTO task_activity_logs (id, user_id, task_id, action, summary, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), userId, taskId, action, summary, JSON.stringify(details), nowISO());
}

function compactDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined));
}

const ACTIVITY_FIELD_LABELS: Record<string, string> = {
  title: 'title',
  note: 'note',
  listId: 'list',
  priority: 'priority',
  dueDate: 'due date',
  startDate: 'start date',
  isAllDay: 'all-day state',
  isImportant: 'important flag',
  isUrgent: 'urgent flag',
  parentId: 'parent task',
  goalId: 'goal',
  plannedStartAt: 'planned start',
  plannedEndAt: 'planned end',
  actualStartAt: 'actual start',
  actualEndAt: 'actual end',
  autoScheduleEnabled: 'auto schedule setting',
  isLockedSchedule: 'schedule lock',
  estimatedMinutes: 'estimate',
  scheduleEnergyType: 'schedule energy type',
  scheduleTaskType: 'schedule task type',
  isSplittable: 'schedule split setting',
  minScheduleMinutes: 'minimum schedule block',
  recurrenceRule: 'recurrence',
  manualProgress: 'manual progress',
  pinned: 'pin state',
  status: 'status',
  completed: 'completion',
  sortOrder: 'sort order',
  subtaskConfig: 'subtask settings',
  dependencyTaskIds: 'dependencies',
};

const DEFAULT_SUBTASK_CONFIG = { progressMode: 'auto' as const, autoCompleteParent: false, collapsed: false };
function parseConfig(s: any): TaskDTO['subtaskConfig'] {
  if (!s) return { ...DEFAULT_SUBTASK_CONFIG };
  try {
    return { ...DEFAULT_SUBTASK_CONFIG, ...JSON.parse(s) };
  } catch {
    return { ...DEFAULT_SUBTASK_CONFIG };
  }
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
    parentId: r.parent_id ?? null,
    parentTitle: null,
    hierarchyPath: [],
    goalId: r.goal_id ?? null,
    rootTaskId: r.root_task_id ?? null,
    level: r.level ?? 1,
    plannedStartAt: r.planned_start_at ?? null,
    plannedEndAt: r.planned_end_at ?? null,
    actualStartAt: r.actual_start_at ?? null,
    actualEndAt: r.actual_end_at ?? null,
    dependencyTaskIds: parseIdList(r.dependency_task_ids),
    autoScheduleEnabled: r.auto_schedule_enabled == null ? true : !!r.auto_schedule_enabled,
    isLockedSchedule: !!r.is_locked_schedule,
    estimatedMinutes: r.estimated_minutes ?? null,
    scheduleEnergyType: r.schedule_energy_type ?? null,
    scheduleTaskType: r.schedule_task_type ?? null,
    isSplittable: !!r.is_splittable,
    minScheduleMinutes: r.min_schedule_minutes ?? null,
    subtaskConfig: parseConfig(r.subtask_config),
    recurrenceRule: r.recurrence_rule ?? null,
    source: r.source ?? 'manual',
    manualProgress: r.manual_progress ?? null,
    pinned: !!r.pinned,
    status: r.status ?? (r.completed ? 'done' : 'todo'),
    tags: [],
    reminders: [],
    attachments: [],
    checklistTotal: 0,
    checklistDone: 0,
    subtaskTotal: 0,
    subtaskDone: 0,
    rollupProgress: r.completed ? 1 : 0,
    completed: !!r.completed,
    completedAt: r.completed_at ?? null,
    deletedAt: r.deleted_at ?? null,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

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

function dashboardDayRange(input?: string | null): { from: string; to: string; date: string } {
  const base = input ? new Date(input) : new Date();
  if (Number.isNaN(base.getTime())) throw new AppError(400, 'invalid', 'date must be a valid ISO date');
  const from = new Date(base);
  from.setHours(0, 0, 0, 0);
  const to = new Date(base);
  to.setHours(23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString(), date: from.toISOString().slice(0, 10) };
}

function mapDashboardTask(row: any): DayPilotDashboardTaskDTO {
  return {
    id: row.id,
    title: row.title,
    goalId: row.goal_id,
    goalTitle: row.goal_title,
    priority: row.priority,
    startDate: row.start_date ?? null,
    dueDate: row.due_date ?? null,
    estimatedMinutes: row.estimated_minutes ?? null,
    scheduleEnergyType: row.schedule_energy_type ?? null,
    scheduleTaskType: row.schedule_task_type ?? null,
    status: row.status ?? (row.completed ? 'done' : 'todo'),
    dependencyTaskIds: parseIdList(row.dependency_task_ids),
    blockingDependencies: [],
  };
}

function attachDashboardDependencyState(userId: string, tasks: DayPilotDashboardTaskDTO[]): DayPilotDashboardTaskDTO[] {
  const dependencyIds = Array.from(new Set(tasks.flatMap((task) => task.dependencyTaskIds)));
  if (!dependencyIds.length) return tasks;
  const ph = dependencyIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, title, status, completed FROM tasks WHERE user_id = ? AND id IN (${ph}) AND deleted_at IS NULL`)
    .all(userId, ...dependencyIds) as Array<{ id: string; title: string; status: TaskStatus | null; completed: number }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  return tasks.map((task) => ({
    ...task,
    blockingDependencies: task.dependencyTaskIds
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => !!row && !row.completed && row.status !== 'skipped')
      .map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status ?? 'todo',
        completed: !!row.completed,
      })),
  }));
}

function parseJsonArraySafe(raw: unknown): any[] {
  if (!raw) return [];
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

const LIST_WITH_COUNT = `
  SELECT l.*, (
    SELECT COUNT(*) FROM tasks t
    WHERE t.user_id = l.user_id AND t.list_id = l.id AND t.completed = 0 AND t.deleted_at IS NULL AND t.status <> 'skipped'
  ) AS task_count
  FROM lists l
`;

export function listLists(userId: string): ListDTO[] {
  getInboxId(userId);
  const rows = db
    .prepare(`${LIST_WITH_COUNT} WHERE l.user_id = ? AND l.is_inbox = 0 ORDER BY l.folder_id IS NOT NULL, l.sort_order ASC, l.created_at ASC`)
    .all(userId) as any[];
  return rows.map(mapList);
}

export function listFolders(userId: string): ListFolderDTO[] {
  const rows = db
    .prepare('SELECT * FROM list_folders WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC')
    .all(userId) as any[];
  return rows.map(mapListFolder);
}

function ensureFolder(userId: string, folderId: string | null | undefined): string | null {
  if (!folderId) return null;
  const row = db.prepare('SELECT id FROM list_folders WHERE user_id = ? AND id = ?').get(userId, folderId);
  if (!row) throw new AppError(404, 'not_found', 'folder not found');
  return folderId;
}

export function createFolder(userId: string, input: { name: string; collapsed?: boolean; sortOrder?: number }): ListFolderDTO {
  const name = input.name.trim();
  if (!name) throw new AppError(400, 'invalid', 'folder name is required');
  const id = randomUUID();
  const ts = nowISO();
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM list_folders WHERE user_id = ?').get(userId) as { m: number };
  db.prepare(
    `INSERT INTO list_folders (id, user_id, name, sort_order, collapsed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, name, input.sortOrder ?? (max.m ?? 0) + 1, input.collapsed ? 1 : 0, ts, ts);
  return mapListFolder(db.prepare('SELECT * FROM list_folders WHERE user_id = ? AND id = ?').get(userId, id));
}

export function updateFolder(userId: string, id: string, patch: Record<string, unknown>): ListFolderDTO | null {
  const cols: string[] = [];
  const vals: unknown[] = [];
  if ('name' in patch) {
    const name = String(patch.name ?? '').trim();
    if (!name) throw new AppError(400, 'invalid', 'folder name is required');
    cols.push('name = ?');
    vals.push(name);
  }
  if ('sortOrder' in patch) {
    cols.push('sort_order = ?');
    vals.push(patch.sortOrder ?? 0);
  }
  if ('collapsed' in patch) {
    cols.push('collapsed = ?');
    vals.push(patch.collapsed ? 1 : 0);
  }
  if (!cols.length) {
    const row = db.prepare('SELECT * FROM list_folders WHERE user_id = ? AND id = ?').get(userId, id);
    return row ? mapListFolder(row) : null;
  }
  cols.push('updated_at = ?');
  vals.push(nowISO(), userId, id);
  const info = db.prepare(`UPDATE list_folders SET ${cols.join(', ')} WHERE user_id = ? AND id = ?`).run(...(vals as any[]));
  if (info.changes === 0) return null;
  return mapListFolder(db.prepare('SELECT * FROM list_folders WHERE user_id = ? AND id = ?').get(userId, id));
}

export function deleteFolder(userId: string, id: string): boolean {
  const exists = db.prepare('SELECT id FROM list_folders WHERE user_id = ? AND id = ?').get(userId, id);
  if (!exists) return false;
  db.prepare('UPDATE lists SET folder_id = NULL, updated_at = ? WHERE user_id = ? AND folder_id = ?').run(nowISO(), userId, id);
  const info = db.prepare('DELETE FROM list_folders WHERE user_id = ? AND id = ?').run(userId, id);
  return info.changes > 0;
}

export function createList(userId: string, name: string, color: string | null, icon: string | null, folderId?: string | null, type?: unknown): ListDTO {
  const validFolderId = ensureFolder(userId, folderId);
  const listType = normalizeListType(type);
  const id = randomUUID();
  const ts = nowISO();
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM lists WHERE user_id = ? AND is_inbox = 0').get(userId) as {
    m: number;
  };
  db.prepare(
    `INSERT INTO lists (id, user_id, folder_id, name, color, icon, type, sort_order, is_inbox, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(id, userId, validFolderId, name, color, icon, listType, (max.m ?? 0) + 1, ts, ts);
  return mapList(db.prepare(`${LIST_WITH_COUNT} WHERE l.user_id = ? AND l.id = ?`).get(userId, id));
}

export function updateList(userId: string, id: string, patch: Record<string, unknown>): ListDTO | null {
  const map: Record<string, string> = {
    name: 'name',
    color: 'color',
    icon: 'icon',
    type: 'type',
    folderId: 'folder_id',
    sortOrder: 'sort_order',
  };
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) {
      cols.push(`${col} = ?`);
      vals.push(
        k === 'folderId'
          ? ensureFolder(userId, patch[k] as string | null | undefined)
          : k === 'type'
            ? normalizeListType(patch[k])
            : patch[k] ?? null,
      );
    }
  }
  cols.push('updated_at = ?');
  vals.push(nowISO(), userId, id);
  const info = db
    .prepare(`UPDATE lists SET ${cols.join(', ')} WHERE user_id = ? AND id = ? AND is_inbox = 0`)
    .run(...(vals as any[]));
  if (info.changes === 0) return null;
  return mapList(db.prepare(`${LIST_WITH_COUNT} WHERE l.user_id = ? AND l.id = ?`).get(userId, id));
}

export function deleteList(userId: string, id: string): void {
  const row = db.prepare('SELECT is_inbox FROM lists WHERE user_id = ? AND id = ?').get(userId, id) as
    | { is_inbox: number }
    | undefined;
  if (!row) throw new AppError(404, 'not_found', 'list not found');
  if (row.is_inbox) throw new AppError(400, 'forbidden', 'cannot delete the inbox list');
  db.prepare('UPDATE tasks SET list_id = ?, updated_at = ? WHERE user_id = ? AND list_id = ?').run(getInboxId(userId), nowISO(), userId, id);
  db.prepare('DELETE FROM lists WHERE user_id = ? AND id = ?').run(userId, id);
}

function descendantIds(userId: string, id: string): string[] {
  const out: string[] = [];
  let frontier = [id];
  while (frontier.length) {
    const ph = frontier.map(() => '?').join(',');
    const kids = (
      db.prepare(`SELECT id FROM tasks WHERE user_id = ? AND parent_id IN (${ph})`).all(userId, ...frontier) as any[]
    ).map((r) => r.id);
    out.push(...kids);
    frontier = kids;
  }
  return out;
}

const MAX_TASK_TREE_DEPTH = 5;

function taskDepthIncludingSelf(userId: string, id: string): number {
  let depth = 0;
  let current: string | null = id;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) throw new AppError(409, 'hierarchy_cycle', 'task hierarchy contains a cycle');
    seen.add(current);
    depth++;
    const row = db.prepare('SELECT parent_id FROM tasks WHERE user_id = ? AND id = ? AND deleted_at IS NULL').get(userId, current) as
      | { parent_id: string | null }
      | undefined;
    if (!row) break;
    current = row.parent_id ?? null;
  }
  return depth;
}

function taskSubtreeDepth(userId: string, id: string): number {
  let maxDepth = 1;
  let frontier: Array<{ id: string; depth: number }> = [{ id, depth: 1 }];
  const seen = new Set<string>([id]);
  while (frontier.length) {
    const current = frontier;
    frontier = [];
    const ids = current.map((item) => item.id);
    const ph = ids.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, parent_id FROM tasks WHERE user_id = ? AND parent_id IN (${ph}) AND deleted_at IS NULL`)
      .all(userId, ...ids) as Array<{ id: string; parent_id: string }>;
    const depthById = new Map(current.map((item) => [item.id, item.depth]));
    for (const row of rows) {
      if (seen.has(row.id)) throw new AppError(409, 'hierarchy_cycle', 'task hierarchy contains a cycle');
      seen.add(row.id);
      const depth = (depthById.get(row.parent_id) ?? 1) + 1;
      maxDepth = Math.max(maxDepth, depth);
      frontier.push({ id: row.id, depth });
    }
  }
  return maxDepth;
}

function nextChildSortOrder(userId: string, parentId: string): number {
  const row = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS value FROM tasks WHERE user_id = ? AND parent_id = ?').get(userId, parentId) as {
    value: number;
  };
  return (row.value ?? 0) + 1;
}

function assertTaskCanMoveUnder(userId: string, taskId: string, parentId: string | null): void {
  if (!parentId) return;
  if (parentId === taskId) throw new AppError(400, 'invalid', 'task cannot be its own parent');
  const parent = db.prepare('SELECT id, status FROM tasks WHERE user_id = ? AND id = ? AND deleted_at IS NULL').get(userId, parentId) as
    | { id: string; status: TaskStatus }
    | undefined;
  if (!parent) throw new AppError(404, 'not_found', 'parent task not found');
  if (parent.status === 'skipped') throw new AppError(400, 'invalid', 'skipped task cannot be a parent');
  if (descendantIds(userId, taskId).includes(parentId)) {
    throw new AppError(409, 'hierarchy_cycle', 'task cannot be moved under its descendant');
  }
  const nextDepth = taskDepthIncludingSelf(userId, parentId) + taskSubtreeDepth(userId, taskId);
  if (nextDepth > MAX_TASK_TREE_DEPTH) {
    throw new AppError(400, 'max_depth_exceeded', `task hierarchy can contain at most ${MAX_TASK_TREE_DEPTH} levels`);
  }
}

function attachStats(userId: string, tasks: TaskDTO[]): TaskDTO[] {
  if (!tasks.length) return tasks;
  const ids = tasks.map((t) => t.id);
  const ph = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT parent_id, completed, estimated_minutes FROM tasks WHERE user_id = ? AND parent_id IN (${ph}) AND deleted_at IS NULL`)
    .all(userId, ...ids) as any[];
  const stat = new Map<string, { total: number; done: number; est: number; estDone: number; allEst: boolean }>();
  for (const r of rows) {
    let s = stat.get(r.parent_id);
    if (!s) {
      s = { total: 0, done: 0, est: 0, estDone: 0, allEst: true };
      stat.set(r.parent_id, s);
    }
    s.total++;
    if (r.completed) s.done++;
    const e = r.estimated_minutes;
    if (e && e > 0) {
      s.est += e;
      if (r.completed) s.estDone += e;
    } else s.allEst = false;
  }
  for (const t of tasks) {
    const s = stat.get(t.id);
    if (s) {
      t.subtaskTotal = s.total;
      t.subtaskDone = s.done;
      const useEst =
        t.subtaskConfig.progressMode === 'estimate' || (t.subtaskConfig.progressMode === 'auto' && s.allEst && s.est > 0);
      t.rollupProgress = useEst ? (s.est ? s.estDone / s.est : 0) : s.total ? s.done / s.total : 0;
    }
  }
  const checklistRows = db
    .prepare(
      `SELECT task_id, COUNT(*) AS total, SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) AS done
       FROM task_checklist_items
       WHERE user_id = ? AND task_id IN (${ph})
       GROUP BY task_id`,
    )
    .all(userId, ...ids) as Array<{ task_id: string; total: number; done: number | null }>;
  const checklistStat = new Map(checklistRows.map((r) => [r.task_id, { total: r.total, done: r.done ?? 0 }]));
  for (const t of tasks) {
    const s = checklistStat.get(t.id);
    if (!s) continue;
    t.checklistTotal = s.total;
    t.checklistDone = s.done;
    if (t.subtaskTotal === 0) t.rollupProgress = s.total ? s.done / s.total : t.rollupProgress;
  }
  return tasks;
}

function attachMetadata(userId: string, tasks: TaskDTO[]): TaskDTO[] {
  if (!tasks.length) return tasks;
  const ids = tasks.map((t) => t.id);
  const ph = ids.map(() => '?').join(',');
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const tagRows = db
    .prepare(
      `SELECT tt.task_id, tags.*
       FROM task_tags tt
       JOIN tags ON tags.id = tt.tag_id AND tags.user_id = tt.user_id
       WHERE tt.user_id = ? AND tt.task_id IN (${ph})
       ORDER BY tags.sort_order ASC, tags.created_at ASC`,
    )
    .all(userId, ...ids) as any[];
  for (const r of tagRows) {
    const task = byId.get(r.task_id);
    if (task) task.tags.push(mapTag(r));
  }
  const reminderRows = db
    .prepare(
      `SELECT * FROM task_reminders
       WHERE user_id = ? AND task_id IN (${ph})
       ORDER BY remind_at ASC, created_at ASC`,
    )
    .all(userId, ...ids) as any[];
  for (const r of reminderRows) {
    const task = byId.get(r.task_id);
    if (task) task.reminders.push(mapReminder(r));
  }
  const attachmentRows = db
    .prepare(
      `SELECT * FROM attachments
       WHERE user_id = ? AND task_id IN (${ph})
       ORDER BY created_at ASC`,
    )
    .all(userId, ...ids) as any[];
  for (const r of attachmentRows) {
    const task = byId.get(r.task_id);
    if (task) task.attachments.push(mapAttachment(r));
  }
  return tasks;
}

function attachHierarchy(userId: string, tasks: TaskDTO[]): TaskDTO[] {
  if (!tasks.length) return tasks;
  const cache = new Map<string, { id: string; title: string; parentId: string | null } | null>();
  const load = (id: string) => {
    if (!cache.has(id)) {
      const row = db.prepare('SELECT id, title, parent_id FROM tasks WHERE user_id = ? AND id = ? AND deleted_at IS NULL').get(userId, id) as
        | { id: string; title: string; parent_id: string | null }
        | undefined;
      cache.set(id, row ? { id: row.id, title: row.title, parentId: row.parent_id ?? null } : null);
    }
    return cache.get(id) ?? null;
  };
  for (const task of tasks) {
    const parents: string[] = [];
    const seen = new Set<string>([task.id]);
    let parentId = task.parentId;
    for (let guard = 0; parentId && guard < 20 && !seen.has(parentId); guard++) {
      seen.add(parentId);
      const parent = load(parentId);
      if (!parent) break;
      parents.unshift(parent.title);
      if (parent.id === task.parentId) task.parentTitle = parent.title;
      parentId = parent.parentId;
    }
    task.hierarchyPath = [...parents, task.title];
  }
  return tasks;
}

function hydrateTasks(userId: string, rows: any[]): TaskDTO[] {
  return attachHierarchy(userId, attachMetadata(userId, attachStats(userId, rows.map(mapTask))));
}

function listTaskOrder(userId: string): { order: string; params: unknown[] } {
  const { overduePosition } = getSettings(userId).taskDefaults;
  const base = 'sort_order ASC, created_at ASC';
  if (overduePosition === 'top' || overduePosition === 'grouped') {
    return { order: '(due_date IS NOT NULL AND due_date < ?) DESC, ' + base, params: [startOfTodayISO()] };
  }
  return { order: base, params: [] };
}

function nextTopLevelSortOrder(userId: string, listId: string, addPosition: Settings['taskDefaults']['addPosition']): number {
  if (addPosition === 'bottom') {
    const row = db
      .prepare('SELECT COALESCE(MAX(sort_order), 0) AS value FROM tasks WHERE user_id = ? AND list_id = ? AND parent_id IS NULL AND deleted_at IS NULL')
      .get(userId, listId) as { value: number };
    return (row.value ?? 0) + 1;
  }
  const row = db
    .prepare('SELECT COALESCE(MIN(sort_order), 0) AS value FROM tasks WHERE user_id = ? AND list_id = ? AND parent_id IS NULL AND deleted_at IS NULL')
    .get(userId, listId) as { value: number };
  return (row.value ?? 0) - 1;
}

function reconcileParent(userId: string, parentId: string): void {
  const parent = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND id = ?').get(userId, parentId) as any;
  if (!parent) return;
  if (!parseConfig(parent.subtask_config).autoCompleteParent) return;
  const kids = db.prepare("SELECT completed FROM tasks WHERE user_id = ? AND parent_id = ? AND deleted_at IS NULL AND status <> 'skipped'").all(userId, parentId) as any[];
  if (!kids.length) return;
  const allDone = kids.every((k) => k.completed);
  const ts = nowISO();
  if (allDone && !parent.completed) {
    db.prepare('UPDATE tasks SET completed = 1, completed_at = ?, updated_at = ? WHERE user_id = ? AND id = ?').run(ts, ts, userId, parentId);
  } else if (!allDone && parent.completed) {
    db.prepare('UPDATE tasks SET completed = 0, completed_at = NULL, updated_at = ? WHERE user_id = ? AND id = ?').run(ts, userId, parentId);
  }
}

export function getTasks(
  userId: string,
  opts: {
    view?: string;
    listId?: string;
    from?: string;
    to?: string;
    parentId?: string;
    tagId?: string;
    priority?: number;
    status?: TaskStatus;
    q?: string;
    dateFilter?: 'today' | 'next7days' | 'undated';
  },
): TaskDTO[] {
  const inboxId = getInboxId(userId);
  if (opts.parentId) {
    const kids = db
      .prepare("SELECT * FROM tasks WHERE user_id = ? AND parent_id = ? AND deleted_at IS NULL AND status <> 'skipped' ORDER BY sort_order ASC, created_at ASC")
      .all(userId, opts.parentId) as any[];
    return hydrateTasks(userId, kids);
  }
  assertTaskStatus(opts.status);

  let where: string;
  let order: string;
  let orderParams: unknown[] = [];
  let params: unknown[] = [userId];
  if (opts.view) {
    switch (opts.view) {
      case 'inbox':
        where = "user_id = ? AND list_id = ? AND completed = 0 AND deleted_at IS NULL AND status <> 'skipped'";
        params = [userId, inboxId];
        ({ order, params: orderParams } = listTaskOrder(userId));
        break;
      case 'active':
        where = "user_id = ? AND completed = 0 AND deleted_at IS NULL AND status <> 'skipped'";
        order = 'priority DESC, created_at DESC';
        break;
      case 'today':
        where = "user_id = ? AND completed = 0 AND deleted_at IS NULL AND status <> 'skipped' AND due_date IS NOT NULL AND due_date <= ?";
        params = [userId, endOfTodayISO()];
        order = 'due_date ASC, priority DESC';
        break;
      case 'next7days':
        where = "user_id = ? AND completed = 0 AND deleted_at IS NULL AND status <> 'skipped' AND due_date >= ? AND due_date <= ?";
        params = [userId, startOfTodayISO(), endOfDayOffsetISO(6)];
        order = 'due_date ASC, priority DESC';
        break;
      case 'completed':
        where = 'user_id = ? AND completed = 1 AND deleted_at IS NULL';
        order = 'completed_at DESC';
        break;
      case 'trash':
        where = 'user_id = ? AND deleted_at IS NOT NULL';
        order = 'deleted_at DESC';
        break;
      case 'undated':
        where = "user_id = ? AND due_date IS NULL AND completed = 0 AND deleted_at IS NULL AND status <> 'skipped'";
        order = 'priority DESC, created_at DESC';
        break;
      case 'matrix':
        where = "user_id = ? AND deleted_at IS NULL AND status <> 'skipped' AND is_important IS NOT NULL AND is_urgent IS NOT NULL";
        order = 'completed ASC, priority DESC, created_at DESC';
        break;
      case 'unclassified':
        where = "user_id = ? AND completed = 0 AND deleted_at IS NULL AND status <> 'skipped' AND (is_important IS NULL OR is_urgent IS NULL)";
        order = 'priority DESC, created_at DESC';
        break;
      default:
        throw new AppError(400, 'bad_view', `unknown view: ${opts.view}`);
    }
  } else if (opts.listId) {
    where = "user_id = ? AND list_id = ? AND completed = 0 AND deleted_at IS NULL AND status <> 'skipped'";
    params = [userId, opts.listId];
    ({ order, params: orderParams } = listTaskOrder(userId));
  } else if (opts.from && opts.to) {
    where = "user_id = ? AND deleted_at IS NULL AND status <> 'skipped'";
    order = 'start_date ASC, due_date ASC';
  } else {
    throw new AppError(400, 'missing_query', 'either view or listId is required');
  }

  const filters: string[] = [];
  const filterParams: unknown[] = [];
  if (opts.from && opts.to) {
    filters.push(
      '((start_date IS NOT NULL AND start_date <= ? AND due_date >= ?) OR (start_date IS NULL AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ?))',
    );
    filterParams.push(opts.to, opts.from, opts.from, opts.to);
  }
  if (opts.dateFilter === 'today') {
    filters.push(
      '((start_date IS NOT NULL AND start_date <= ? AND due_date >= ?) OR (start_date IS NULL AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ?))',
    );
    filterParams.push(endOfTodayISO(), startOfTodayISO(), startOfTodayISO(), endOfTodayISO());
  } else if (opts.dateFilter === 'next7days') {
    filters.push(
      '((start_date IS NOT NULL AND start_date <= ? AND due_date >= ?) OR (start_date IS NULL AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ?))',
    );
    filterParams.push(endOfDayOffsetISO(6), startOfTodayISO(), startOfTodayISO(), endOfDayOffsetISO(6));
  } else if (opts.dateFilter === 'undated') {
    filters.push('start_date IS NULL AND due_date IS NULL');
  }
  if (opts.tagId) {
    filters.push('EXISTS (SELECT 1 FROM task_tags tt WHERE tt.user_id = tasks.user_id AND tt.task_id = tasks.id AND tt.tag_id = ?)');
    filterParams.push(opts.tagId);
  }
  if (opts.priority != null) {
    filters.push('priority = ?');
    filterParams.push(opts.priority);
  }
  if (opts.status) {
    filters.push('status = ?');
    filterParams.push(opts.status);
  }
  if (opts.q?.trim()) {
    const q = `%${opts.q.trim()}%`;
    filters.push('(title LIKE ? OR note LIKE ?)');
    filterParams.push(q, q);
  }
  const extra = filters.length ? ` AND ${filters.join(' AND ')}` : '';
  const calendarRangeQuery = !!opts.from && !!opts.to && !opts.view && !opts.listId;
  const topLevelOnly = calendarRangeQuery ? '' : ' AND parent_id IS NULL';
  const rows = db
    .prepare(`SELECT * FROM tasks WHERE (${where})${topLevelOnly}${extra} ORDER BY pinned DESC, ${order}`)
    .all(...(params as any[]), ...(filterParams as any[]), ...(orderParams as any[])) as any[];
  return hydrateTasks(userId, rows);
}

export function getTask(userId: string, id: string): TaskDTO | null {
  const row = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND id = ?').get(userId, id);
  if (!row) return null;
  return hydrateTasks(userId, [row])[0];
}

export function listTaskActivity(userId: string, taskId: string, limit = 50): TaskActivityDTO[] {
  const task = db.prepare('SELECT id FROM tasks WHERE user_id = ? AND id = ?').get(userId, taskId);
  if (!task) throw new AppError(404, 'not_found', 'task not found');
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 50));
  return (
    db
      .prepare('SELECT * FROM task_activity_logs WHERE user_id = ? AND task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(userId, taskId, safeLimit) as any[]
  ).map(mapTaskActivity);
}

type TaskDefaultSettings = Settings['taskDefaults'];

function startOfLocalDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addLocalDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function atLocalTime(date: Date, hhmm: string): Date {
  const [hour, minute] = hhmm.split(':').map(Number);
  const d = startOfLocalDay(date);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function defaultDateBase(defaults: TaskDefaultSettings, now: Date): Date | null {
  if (defaults.defaultDate === 'none') return null;
  if (defaults.defaultDate === 'today') return startOfLocalDay(now);
  if (defaults.defaultDate === 'tomorrow') return addLocalDays(startOfLocalDay(now), 1);
  if (!defaults.customDate) return null;
  const custom = new Date(defaults.customDate);
  return Number.isNaN(custom.getTime()) ? null : startOfLocalDay(custom);
}

function computeDefaultTaskSchedule(
  defaults: TaskDefaultSettings,
  now: Date,
): { startDate: string | null; dueDate: string | null; isAllDay: boolean } {
  const base = defaultDateBase(defaults, now);
  if (!base) return { startDate: null, dueDate: null, isAllDay: true };
  if (defaults.dateMode === 'timeBlock') {
    const start = atLocalTime(base, defaults.defaultTimeBlockStart);
    const due = new Date(start.getTime() + defaults.defaultTimeBlockMinutes * 60_000);
    return { startDate: start.toISOString(), dueDate: due.toISOString(), isAllDay: false };
  }
  return { startDate: null, dueDate: startOfLocalDay(base).toISOString(), isAllDay: true };
}

function computeDefaultReminderAt(
  defaults: TaskDefaultSettings,
  task: { startDate: string | null; dueDate: string | null; isAllDay: boolean },
): string | null {
  if (!task.dueDate) return null;
  if (!task.isAllDay && task.startDate) {
    if (defaults.timedReminder === 'none') return null;
    const start = new Date(task.startDate);
    const offset =
      defaults.timedReminder === 'at_start'
        ? 0
        : defaults.timedReminder === '5m_before'
          ? 5
          : defaults.timedReminder === '30m_before'
            ? 30
            : defaults.timedReminderCustomMinutes;
    return new Date(start.getTime() - offset * 60_000).toISOString();
  }
  if (defaults.allDayReminder === 'none') return null;
  const dueDay = startOfLocalDay(new Date(task.dueDate));
  const reminderDay = defaults.allDayReminder === '1d_before' ? addLocalDays(dueDay, -1) : dueDay;
  return atLocalTime(reminderDay, defaults.allDayReminderTime).toISOString();
}

export function createTask(
  userId: string,
  input: {
    title: string;
    note?: string | null;
    listId?: string | null;
    tagIds?: string[];
    priority?: number;
    dueDate?: string | null;
    startDate?: string | null;
    isAllDay?: boolean;
    isImportant?: boolean | null;
    isUrgent?: boolean | null;
    parentId?: string | null;
    estimatedMinutes?: number | null;
    scheduleEnergyType?: 'high' | 'medium' | 'low' | null;
    scheduleTaskType?: string | null;
    isSplittable?: boolean;
    minScheduleMinutes?: number | null;
    recurrenceRule?: string | null;
    source?: string | null;
    manualProgress?: number | null;
    pinned?: boolean;
    status?: TaskStatus;
  },
): TaskDTO {
  assertTaskStatus(input.status);
  assertManualProgress(input.manualProgress);
  assertScheduleEnergyType(input.scheduleEnergyType);
  assertScheduleMinutes(input.estimatedMinutes, 'estimatedMinutes');
  assertScheduleMinutes(input.minScheduleMinutes, 'minScheduleMinutes');
  const id = randomUUID();
  const ts = nowISO();
  const defaults = getSettings(userId).taskDefaults;
  const hasOwn = (key: keyof typeof input) => Object.prototype.hasOwnProperty.call(input, key);
  const defaultSchedule = computeDefaultTaskSchedule(defaults, new Date(ts));
  const status = input.status ?? 'todo';
  const completed = status === 'done' ? 1 : 0;
  const parentId = input.parentId ?? null;
  const tagIds = hasOwn('tagIds') ? input.tagIds ?? [] : parentId ? [] : defaults.defaultTagIds;
  const normalizedTagIds = Array.from(new Set(tagIds));
  for (const tagId of normalizedTagIds) ensureTag(userId, tagId);
  let listId = hasOwn('listId') ? input.listId ?? null : defaults.listId;
  const priority = hasOwn('priority') ? input.priority ?? 0 : defaults.priority;
  let dueDate = hasOwn('dueDate') ? input.dueDate ?? null : defaultSchedule.dueDate;
  let startDate = hasOwn('startDate') ? input.startDate ?? null : defaultSchedule.startDate;
  let isAllDay = hasOwn('isAllDay') ? input.isAllDay ?? true : defaultSchedule.isAllDay;
  let sortOrder = 0;
  if (parentId) {
    const p = db.prepare('SELECT list_id FROM tasks WHERE user_id = ? AND id = ?').get(userId, parentId) as
      | { list_id: string }
      | undefined;
    if (!p) throw new AppError(404, 'not_found', 'parent task not found');
    if (taskDepthIncludingSelf(userId, parentId) + 1 > MAX_TASK_TREE_DEPTH) {
      throw new AppError(400, 'max_depth_exceeded', `task hierarchy can contain at most ${MAX_TASK_TREE_DEPTH} levels`);
    }
    if (!listId) listId = p.list_id ?? getInboxId(userId);
    sortOrder = nextChildSortOrder(userId, parentId);
  }
  if (!listId) listId = getInboxId(userId);
  if (startDate && dueDate && startDate > dueDate) throw new AppError(400, 'invalid', 'startDate must be on or before dueDate');
  const list = db.prepare('SELECT id FROM lists WHERE user_id = ? AND id = ?').get(userId, listId);
  if (!list) throw new AppError(404, 'not_found', 'list not found');
  if (listTypeFor(userId, listId) === 'note' && completed) {
    throw new AppError(400, 'note_list_no_completion', 'note lists only store records and cannot contain completed tasks');
  }
  if (!parentId) sortOrder = nextTopLevelSortOrder(userId, listId, defaults.addPosition);
  const scheduleTaskType = input.scheduleTaskType == null ? null : String(input.scheduleTaskType).trim() || null;
  db.prepare(
    `INSERT INTO tasks
       (id, user_id, title, note, list_id, parent_id, priority, due_date, start_date, is_all_day, is_important, is_urgent, estimated_minutes, schedule_energy_type, schedule_task_type, is_splittable, min_schedule_minutes, subtask_config, recurrence_rule, source, manual_progress, pinned, status, completed, completed_at, deleted_at, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    id,
    userId,
    input.title,
    input.note ?? null,
    listId,
    parentId,
    priority,
    dueDate,
    startDate,
    isAllDay ? 1 : 0,
    input.isImportant == null ? null : input.isImportant ? 1 : 0,
    input.isUrgent == null ? null : input.isUrgent ? 1 : 0,
    input.estimatedMinutes ?? null,
    input.scheduleEnergyType ?? null,
    scheduleTaskType,
    input.isSplittable ? 1 : 0,
    input.minScheduleMinutes ?? null,
    input.recurrenceRule ?? null,
    input.source ?? 'manual',
    input.manualProgress ?? null,
    input.pinned ? 1 : 0,
    status,
    completed,
    completed ? ts : null,
    sortOrder,
    ts,
    ts,
  );
  recordTaskActivity(userId, id, 'task_created', parentId ? 'Created subtask' : 'Created task', {
    title: input.title,
    parentId,
    source: input.source ?? 'manual',
  });
  for (const tagId of normalizedTagIds) {
    const tag = db.prepare('SELECT name FROM tags WHERE user_id = ? AND id = ?').get(userId, tagId) as { name: string } | undefined;
    db.prepare('INSERT OR IGNORE INTO task_tags (user_id, task_id, tag_id, created_at) VALUES (?, ?, ?, ?)').run(userId, id, tagId, ts);
    recordTaskActivity(userId, id, 'tag_added', `Added tag "${tag?.name ?? tagId}"`, { tagId, tagName: tag?.name ?? null, source: 'task_default' });
  }
  const shouldApplyDefaultReminder =
    !hasOwn('dueDate') &&
    !hasOwn('startDate') &&
    !hasOwn('isAllDay') &&
    !completed &&
    !!dueDate;
  if (shouldApplyDefaultReminder) {
    const remindAt = computeDefaultReminderAt(defaults, { startDate, dueDate, isAllDay });
    if (remindAt) createTaskReminder(userId, id, { remindAt, channel: 'email' });
  }
  return getTask(userId, id)!;
}

function addRecurrenceDate(iso: string | null, rule: string | null): string | null {
  if (!iso || !rule) return null;
  const freq = rule.match(/FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/i)?.[1]?.toUpperCase();
  if (!freq) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  if (freq === 'DAILY') date.setDate(date.getDate() + 1);
  else if (freq === 'WEEKLY') date.setDate(date.getDate() + 7);
  else if (freq === 'MONTHLY') date.setMonth(date.getMonth() + 1);
  else if (freq === 'YEARLY') date.setFullYear(date.getFullYear() + 1);
  return date.toISOString();
}

function createNextRecurringTaskInstance(userId: string, row: any, completedTaskId: string): TaskDTO | null {
  const recurrenceRule = row.recurrence_rule as string | null;
  if (!recurrenceRule) return null;
  const nextDueDate = addRecurrenceDate(row.due_date ?? null, recurrenceRule);
  const nextStartDate = addRecurrenceDate(row.start_date ?? null, recurrenceRule);
  if (!nextDueDate && !nextStartDate) return null;
  const anchorBefore = row.due_date ?? row.start_date ?? null;
  const anchorAfter = nextDueDate ?? nextStartDate ?? null;
  const reminderOffset = anchorBefore && anchorAfter ? Date.parse(anchorAfter) - Date.parse(anchorBefore) : null;
  const tagIds = (
    db.prepare('SELECT tag_id FROM task_tags WHERE user_id = ? AND task_id = ? ORDER BY created_at ASC').all(userId, completedTaskId) as any[]
  ).map((tag) => tag.tag_id as string);
  const next = createTask(userId, {
    title: row.title,
    note: row.note ?? null,
    listId: row.list_id ?? null,
    tagIds,
    priority: row.priority ?? 0,
    dueDate: nextDueDate,
    startDate: nextStartDate,
    isAllDay: !!row.is_all_day,
    isImportant: row.is_important == null ? null : !!row.is_important,
    isUrgent: row.is_urgent == null ? null : !!row.is_urgent,
    parentId: row.parent_id ?? null,
    estimatedMinutes: row.estimated_minutes ?? null,
    scheduleEnergyType: row.schedule_energy_type ?? null,
    scheduleTaskType: row.schedule_task_type ?? null,
    isSplittable: !!row.is_splittable,
    minScheduleMinutes: row.min_schedule_minutes ?? null,
    recurrenceRule,
    source: 'recurrence',
    manualProgress: null,
    pinned: !!row.pinned,
    status: 'todo',
  });
  if (reminderOffset != null && Number.isFinite(reminderOffset)) {
    const reminders = db.prepare('SELECT remind_at, channel FROM task_reminders WHERE user_id = ? AND task_id = ? ORDER BY remind_at ASC').all(
      userId,
      completedTaskId,
    ) as any[];
    for (const reminder of reminders) {
      const remindAt = new Date(Date.parse(reminder.remind_at) + reminderOffset).toISOString();
      createTaskReminder(userId, next.id, { remindAt, channel: reminder.channel ?? 'email' });
    }
  }
  recordTaskActivity(userId, completedTaskId, 'recurrence_instance_created', 'Created next recurring task instance', {
    recurrenceRule,
    nextTaskId: next.id,
    nextStartDate,
    nextDueDate,
  });
  return getTask(userId, next.id)!;
}

export function updateTask(userId: string, id: string, patch: Record<string, unknown>): TaskDTO | null {
  if ('status' in patch) assertTaskStatus(patch.status);
  if ('manualProgress' in patch) assertManualProgress(patch.manualProgress);
  if ('scheduleEnergyType' in patch) assertScheduleEnergyType(patch.scheduleEnergyType);
  if ('estimatedMinutes' in patch) assertScheduleMinutes(patch.estimatedMinutes, 'estimatedMinutes');
  if ('minScheduleMinutes' in patch) assertScheduleMinutes(patch.minScheduleMinutes, 'minScheduleMinutes');
  if ('completed' in patch && 'status' in patch && Boolean(patch.completed) !== (patch.status === 'done')) {
    throw new AppError(400, 'invalid', 'completed and status disagree');
  }
  if ('parentId' in patch) {
    const { parentId: rawParentId, ...rest } = patch;
    const restKeys = Object.keys(rest);
    if (restKeys.length) {
      const updated = updateTask(userId, id, rest);
      if (!updated) return null;
    }
    const parentId = rawParentId == null || rawParentId === '' ? null : String(rawParentId);
    return reparentTask(userId, id, parentId);
  }
  const before = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND id = ?').get(userId, id) as any;
  if (!before) return null;

  if ('startDate' in patch || 'dueDate' in patch) {
    const cur = getTask(userId, id);
    if (cur) {
      const finalStart = 'startDate' in patch ? (patch.startDate as string | null) : cur.startDate;
      const finalDue = 'dueDate' in patch ? (patch.dueDate as string | null) : cur.dueDate;
      if (finalStart && finalDue && finalStart > finalDue) {
        throw new AppError(400, 'invalid', 'startDate must be on or before dueDate');
      }
    }
  }
  if ('listId' in patch && patch.listId) {
    const list = db.prepare('SELECT id FROM lists WHERE user_id = ? AND id = ?').get(userId, patch.listId as string);
    if (!list) throw new AppError(404, 'not_found', 'list not found');
  }
  const finalListId = 'listId' in patch ? (patch.listId as string | null | undefined) : (before.list_id as string | null);
  if (listTypeFor(userId, finalListId) === 'note') {
    const finalCompleted =
      'completed' in patch ? Boolean(patch.completed) : 'status' in patch ? patch.status === 'done' : Boolean(before.completed);
    if (finalCompleted) {
      throw new AppError(400, 'note_list_no_completion', 'note lists only store records and cannot contain completed tasks');
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
    parentId: 'parent_id',
    goalId: 'goal_id',
    rootTaskId: 'root_task_id',
    level: 'level',
    plannedStartAt: 'planned_start_at',
    plannedEndAt: 'planned_end_at',
    actualStartAt: 'actual_start_at',
    actualEndAt: 'actual_end_at',
    dependencyTaskIds: 'dependency_task_ids',
    autoScheduleEnabled: 'auto_schedule_enabled',
    isLockedSchedule: 'is_locked_schedule',
    estimatedMinutes: 'estimated_minutes',
    scheduleEnergyType: 'schedule_energy_type',
    scheduleTaskType: 'schedule_task_type',
    isSplittable: 'is_splittable',
    minScheduleMinutes: 'min_schedule_minutes',
    recurrenceRule: 'recurrence_rule',
    source: 'source',
    manualProgress: 'manual_progress',
    pinned: 'pinned',
    status: 'status',
    completed: 'completed',
    sortOrder: 'sort_order',
  };
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) {
      let v = patch[k];
      if (
        k === 'isAllDay' ||
        k === 'completed' ||
        k === 'pinned' ||
        k === 'autoScheduleEnabled' ||
        k === 'isLockedSchedule' ||
        k === 'isSplittable'
      )
        v = v ? 1 : 0;
      else if (k === 'isImportant' || k === 'isUrgent') v = v == null ? null : v ? 1 : 0;
      else if (k === 'dependencyTaskIds') v = JSON.stringify(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
      else if (k === 'scheduleTaskType') v = v == null ? null : String(v).trim() || null;
      cols.push(`${col} = ?`);
      vals.push(v ?? null);
    }
  }
  if ('subtaskConfig' in patch && patch.subtaskConfig && typeof patch.subtaskConfig === 'object') {
    const cur = db.prepare('SELECT subtask_config FROM tasks WHERE user_id = ? AND id = ?').get(userId, id) as
      | { subtask_config: any }
      | undefined;
    const merged = { ...parseConfig(cur?.subtask_config), ...(patch.subtaskConfig as object) };
    cols.push('subtask_config = ?');
    vals.push(JSON.stringify(merged));
  }
  if ('completed' in patch) {
    cols.push('completed_at = ?');
    vals.push(patch.completed ? nowISO() : null);
    if (!('status' in patch)) {
      cols.push('status = ?');
      vals.push(patch.completed ? 'done' : 'todo');
    }
  } else if ('status' in patch) {
    cols.push('completed = ?');
    vals.push(patch.status === 'done' ? 1 : 0);
    cols.push('completed_at = ?');
    vals.push(patch.status === 'done' ? nowISO() : null);
  }
  if (!cols.length) return getTask(userId, id);
  cols.push('updated_at = ?');
  vals.push(nowISO(), userId, id);
  const info = db.prepare(`UPDATE tasks SET ${cols.join(', ')} WHERE user_id = ? AND id = ?`).run(...(vals as any[]));
  if (info.changes === 0) return null;
  const updated = getTask(userId, id);
  if ('completed' in patch && updated?.parentId) reconcileParent(userId, updated.parentId);
  if (updated && before) {
    const changedFields = Object.keys(patch).filter((key) => key !== 'subtaskConfig');
    if ('subtaskConfig' in patch) changedFields.push('subtaskConfig');
    const action =
      before.completed !== 1 && updated.completed
        ? 'task_completed'
        : before.completed === 1 && !updated.completed
          ? 'task_reopened'
          : 'task_updated';
    const summary =
      action === 'task_completed'
        ? 'Completed task'
        : action === 'task_reopened'
          ? 'Reopened task'
          : `Updated ${changedFields.map((field) => ACTIVITY_FIELD_LABELS[field] ?? field).join(', ')}`;
    recordTaskActivity(
      userId,
      id,
      action,
      summary,
      compactDetails({
        changedFields,
        beforeTitle: before.title,
        afterTitle: updated.title,
        beforeCompleted: !!before.completed,
        afterCompleted: updated.completed,
      }),
    );
  }
  if (updated && before && before.completed !== 1 && updated.completed && before.recurrence_rule) {
    createNextRecurringTaskInstance(userId, before, id);
  }
  return updated;
}

export function reparentTask(userId: string, id: string, parentId: string | null): TaskDTO | null {
  const task = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND id = ? AND deleted_at IS NULL').get(userId, id) as any;
  if (!task) return null;
  const normalizedParentId = parentId?.trim() || null;
  assertTaskCanMoveUnder(userId, id, normalizedParentId);
  if ((task.parent_id ?? null) === normalizedParentId) return getTask(userId, id);

  const oldParentId = task.parent_id as string | null;
  let listId = task.list_id as string | null;
  let sortOrder: number;
  if (normalizedParentId) {
    const parent = db.prepare('SELECT list_id FROM tasks WHERE user_id = ? AND id = ? AND deleted_at IS NULL').get(userId, normalizedParentId) as
      | { list_id: string | null }
      | undefined;
    if (!parent) throw new AppError(404, 'not_found', 'parent task not found');
    listId = parent.list_id ?? listId ?? getInboxId(userId);
    sortOrder = nextChildSortOrder(userId, normalizedParentId);
  } else {
    listId = listId ?? getInboxId(userId);
    sortOrder = nextTopLevelSortOrder(userId, listId, getSettings(userId).taskDefaults.addPosition);
  }

  const ts = nowISO();
  const info = db
    .prepare('UPDATE tasks SET parent_id = ?, list_id = ?, sort_order = ?, updated_at = ? WHERE user_id = ? AND id = ? AND deleted_at IS NULL')
    .run(normalizedParentId, listId, sortOrder, ts, userId, id);
  if (info.changes === 0) return null;
  if (oldParentId) reconcileParent(userId, oldParentId);
  if (normalizedParentId) reconcileParent(userId, normalizedParentId);
  const updated = getTask(userId, id)!;
  recordTaskActivity(
    userId,
    id,
    'task_reparented',
    normalizedParentId ? 'Moved task under parent task' : 'Promoted task to independent task',
    compactDetails({
      beforeParentId: oldParentId,
      afterParentId: normalizedParentId,
      listId,
      sortOrder,
    }),
  );
  return updated;
}

function requireTaskRow(userId: string, taskId: string): any {
  const task = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND id = ? AND deleted_at IS NULL').get(userId, taskId);
  if (!task) throw new AppError(404, 'not_found', 'task not found');
  return task;
}

function touchTask(userId: string, taskId: string): void {
  db.prepare('UPDATE tasks SET updated_at = ? WHERE user_id = ? AND id = ?').run(nowISO(), userId, taskId);
}

export function deferRecurringTask(userId: string, taskId: string): TaskDTO {
  const row = requireTaskRow(userId, taskId);
  const recurrenceRule = row.recurrence_rule as string | null;
  if (!recurrenceRule) throw new AppError(400, 'invalid', 'task is not recurring');
  const nextDueDate = addRecurrenceDate(row.due_date ?? null, recurrenceRule);
  const nextStartDate = addRecurrenceDate(row.start_date ?? null, recurrenceRule);
  if (!nextDueDate && !nextStartDate) throw new AppError(400, 'invalid', 'recurring task needs a startDate or dueDate');
  const anchorBefore = row.due_date ?? row.start_date ?? null;
  const anchorAfter = nextDueDate ?? nextStartDate ?? null;
  const reminderOffset = anchorBefore && anchorAfter ? Date.parse(anchorAfter) - Date.parse(anchorBefore) : null;
  const ts = nowISO();
  db.prepare('UPDATE tasks SET start_date = ?, due_date = ?, updated_at = ? WHERE user_id = ? AND id = ?').run(
    nextStartDate,
    nextDueDate,
    ts,
    userId,
    taskId,
  );
  if (reminderOffset != null && Number.isFinite(reminderOffset)) {
    const reminders = db.prepare('SELECT id, remind_at FROM task_reminders WHERE user_id = ? AND task_id = ?').all(userId, taskId) as any[];
    for (const reminder of reminders) {
      const remindAt = new Date(Date.parse(reminder.remind_at) + reminderOffset).toISOString();
      db.prepare("UPDATE task_reminders SET remind_at = ?, status = 'scheduled', updated_at = ? WHERE user_id = ? AND id = ?").run(
        remindAt,
        ts,
        userId,
        reminder.id,
      );
    }
  }
  recordTaskActivity(userId, taskId, 'recurrence_instance_deferred', 'Deferred recurring task instance', {
    recurrenceRule,
    nextStartDate,
    nextDueDate,
  });
  return getTask(userId, taskId)!;
}

export function skipRecurringTask(userId: string, taskId: string): { task: TaskDTO; nextTask: TaskDTO | null } {
  const row = requireTaskRow(userId, taskId);
  const recurrenceRule = row.recurrence_rule as string | null;
  if (!recurrenceRule) throw new AppError(400, 'invalid', 'task is not recurring');
  if (!row.start_date && !row.due_date) throw new AppError(400, 'invalid', 'recurring task needs a startDate or dueDate');
  if (row.status === 'skipped') return { task: getTask(userId, taskId)!, nextTask: null };
  const nextTask = createNextRecurringTaskInstance(userId, row, taskId);
  if (!nextTask) throw new AppError(400, 'invalid', 'recurrence rule is not supported');
  const ts = nowISO();
  db.prepare("UPDATE tasks SET status = 'skipped', completed = 0, completed_at = NULL, updated_at = ? WHERE user_id = ? AND id = ?").run(
    ts,
    userId,
    taskId,
  );
  db.prepare("UPDATE task_reminders SET status = 'cancelled', updated_at = ? WHERE user_id = ? AND task_id = ? AND status = 'scheduled'").run(
    ts,
    userId,
    taskId,
  );
  recordTaskActivity(userId, taskId, 'recurrence_instance_skipped', 'Skipped recurring task instance', {
    recurrenceRule,
    nextTaskId: nextTask.id,
  });
  return { task: getTask(userId, taskId)!, nextTask };
}

export function listChecklistItems(userId: string, taskId: string): TaskChecklistItemDTO[] {
  requireTaskRow(userId, taskId);
  return (
    db
      .prepare('SELECT * FROM task_checklist_items WHERE user_id = ? AND task_id = ? ORDER BY sort_order ASC, created_at ASC')
      .all(userId, taskId) as any[]
  ).map(mapChecklistItem);
}

export function createChecklistItem(
  userId: string,
  taskId: string,
  input: { title: string; sortOrder?: number | null },
): TaskChecklistItemDTO {
  requireTaskRow(userId, taskId);
  const title = input.title.trim();
  if (!title) throw new AppError(400, 'invalid', 'checklist item title is required');
  const max = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM task_checklist_items WHERE user_id = ? AND task_id = ?')
    .get(userId, taskId) as { m: number };
  const id = randomUUID();
  const ts = nowISO();
  db.prepare(
    `INSERT INTO task_checklist_items (id, user_id, task_id, title, completed, sort_order, converted_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
  ).run(id, userId, taskId, title, input.sortOrder ?? (max.m ?? 0) + 1, ts, ts);
  touchTask(userId, taskId);
  recordTaskActivity(userId, taskId, 'checklist_item_created', `Added checklist item "${title}"`, { itemId: id, title });
  return mapChecklistItem(db.prepare('SELECT * FROM task_checklist_items WHERE user_id = ? AND id = ?').get(userId, id));
}

export function updateChecklistItem(
  userId: string,
  taskId: string,
  itemId: string,
  patch: Record<string, unknown>,
): TaskChecklistItemDTO | null {
  requireTaskRow(userId, taskId);
  const before = db.prepare('SELECT * FROM task_checklist_items WHERE user_id = ? AND task_id = ? AND id = ?').get(userId, taskId, itemId) as any;
  const cols: string[] = [];
  const vals: unknown[] = [];
  if ('title' in patch) {
    const title = String(patch.title ?? '').trim();
    if (!title) throw new AppError(400, 'invalid', 'checklist item title is required');
    cols.push('title = ?');
    vals.push(title);
  }
  if ('completed' in patch) {
    cols.push('completed = ?');
    vals.push(patch.completed ? 1 : 0);
  }
  if ('sortOrder' in patch) {
    cols.push('sort_order = ?');
    vals.push(Number(patch.sortOrder ?? 0));
  }
  if (!cols.length) {
    const row = db.prepare('SELECT * FROM task_checklist_items WHERE user_id = ? AND task_id = ? AND id = ?').get(userId, taskId, itemId);
    return row ? mapChecklistItem(row) : null;
  }
  cols.push('updated_at = ?');
  vals.push(nowISO(), userId, taskId, itemId);
  const info = db
    .prepare(`UPDATE task_checklist_items SET ${cols.join(', ')} WHERE user_id = ? AND task_id = ? AND id = ?`)
    .run(...(vals as any[]));
  if (info.changes === 0) return null;
  touchTask(userId, taskId);
  const item = mapChecklistItem(db.prepare('SELECT * FROM task_checklist_items WHERE user_id = ? AND task_id = ? AND id = ?').get(userId, taskId, itemId));
  const action =
    before && before.completed !== 1 && item.completed
      ? 'checklist_item_completed'
      : before && before.completed === 1 && !item.completed
        ? 'checklist_item_reopened'
        : 'checklist_item_updated';
  recordTaskActivity(
    userId,
    taskId,
    action,
    action === 'checklist_item_completed'
      ? `Completed checklist item "${item.title}"`
      : action === 'checklist_item_reopened'
        ? `Reopened checklist item "${item.title}"`
        : `Updated checklist item "${item.title}"`,
    compactDetails({
      itemId,
      changedFields: Object.keys(patch),
      beforeTitle: before?.title,
      afterTitle: item.title,
      beforeCompleted: before ? !!before.completed : undefined,
      afterCompleted: item.completed,
    }),
  );
  return item;
}

export function deleteChecklistItem(userId: string, taskId: string, itemId: string): boolean {
  requireTaskRow(userId, taskId);
  const before = db.prepare('SELECT title FROM task_checklist_items WHERE user_id = ? AND task_id = ? AND id = ?').get(userId, taskId, itemId) as
    | { title: string }
    | undefined;
  const info = db.prepare('DELETE FROM task_checklist_items WHERE user_id = ? AND task_id = ? AND id = ?').run(userId, taskId, itemId);
  if (info.changes > 0) {
    touchTask(userId, taskId);
    recordTaskActivity(userId, taskId, 'checklist_item_deleted', `Deleted checklist item "${before?.title ?? itemId}"`, {
      itemId,
      title: before?.title ?? null,
    });
  }
  return info.changes > 0;
}

export function convertChecklistItemToSubtask(
  userId: string,
  taskId: string,
  itemId: string,
): { item: TaskChecklistItemDTO; task: TaskDTO } | null {
  const parent = requireTaskRow(userId, taskId);
  const row = db.prepare('SELECT * FROM task_checklist_items WHERE user_id = ? AND task_id = ? AND id = ?').get(userId, taskId, itemId) as any;
  if (!row) return null;
  if (row.converted_task_id) {
    const existing = getTask(userId, row.converted_task_id);
    if (existing) return { item: mapChecklistItem(row), task: existing };
  }
  const task = createTask(userId, {
    title: row.title,
    note: null,
    listId: parent.list_id ?? null,
    priority: parent.priority ?? 0,
    dueDate: null,
    startDate: null,
    isAllDay: true,
    isImportant: parent.is_important == null ? null : !!parent.is_important,
    isUrgent: parent.is_urgent == null ? null : !!parent.is_urgent,
    parentId: taskId,
    estimatedMinutes: null,
    recurrenceRule: null,
    source: 'checklist',
    manualProgress: null,
    pinned: false,
    status: row.completed ? 'done' : 'todo',
  });
  db.prepare('UPDATE task_checklist_items SET converted_task_id = ?, updated_at = ? WHERE user_id = ? AND task_id = ? AND id = ?').run(
    task.id,
    nowISO(),
    userId,
    taskId,
    itemId,
  );
  touchTask(userId, taskId);
  recordTaskActivity(userId, taskId, 'checklist_converted_to_subtask', `Converted checklist item "${row.title}" to subtask`, {
    itemId,
    convertedTaskId: task.id,
    title: row.title,
  });
  return {
    item: mapChecklistItem(db.prepare('SELECT * FROM task_checklist_items WHERE user_id = ? AND task_id = ? AND id = ?').get(userId, taskId, itemId)),
    task,
  };
}

export function softDeleteTask(userId: string, id: string): boolean {
  const ts = nowISO();
  const ids = [id, ...descendantIds(userId, id)];
  const ph = ids.map(() => '?').join(',');
  const before = db.prepare('SELECT title FROM tasks WHERE user_id = ? AND id = ?').get(userId, id) as { title: string } | undefined;
  const info = db
    .prepare(`UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND id IN (${ph}) AND deleted_at IS NULL`)
    .run(ts, ts, userId, ...ids);
  if (info.changes > 0) {
    recordTaskActivity(userId, id, 'task_deleted', `Moved task "${before?.title ?? id}" to trash`, {
      title: before?.title ?? null,
      affectedTasks: info.changes,
    });
  }
  return info.changes > 0;
}

export function restoreTask(userId: string, id: string): TaskDTO | null {
  const ids = [id, ...descendantIds(userId, id)];
  const ph = ids.map(() => '?').join(',');
  const before = db.prepare('SELECT title FROM tasks WHERE user_id = ? AND id = ?').get(userId, id) as { title: string } | undefined;
  const info = db
    .prepare(`UPDATE tasks SET deleted_at = NULL, updated_at = ? WHERE user_id = ? AND id IN (${ph})`)
    .run(nowISO(), userId, ...ids);
  if (info.changes === 0) return null;
  recordTaskActivity(userId, id, 'task_restored', `Restored task "${before?.title ?? id}"`, {
    title: before?.title ?? null,
    affectedTasks: info.changes,
  });
  return getTask(userId, id);
}

export function hardDeleteTask(userId: string, id: string): boolean {
  const ids = [id, ...descendantIds(userId, id)];
  const ph = ids.map(() => '?').join(',');
  const before = db.prepare('SELECT title FROM tasks WHERE user_id = ? AND id = ?').get(userId, id) as { title: string } | undefined;
  const info = db.prepare(`DELETE FROM tasks WHERE user_id = ? AND id IN (${ph})`).run(userId, ...ids);
  if (info.changes > 0) {
    recordTaskActivity(userId, id, 'task_purged', `Permanently deleted task "${before?.title ?? id}"`, {
      title: before?.title ?? null,
      affectedTasks: info.changes,
    });
  }
  return info.changes > 0;
}

function normalizeRetentionDays(value: unknown): number {
  if (value == null || value === '') return 30;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 3650) {
    throw new AppError(400, 'invalid', 'retentionDays must be an integer from 1 to 3650');
  }
  return n;
}

function deletedBeforeISO(retentionDays: number): string {
  return new Date(Date.now() - retentionDays * 86_400_000).toISOString();
}

export function getTrashSummary(userId: string, retentionDaysInput?: unknown): TrashSummaryDTO {
  const retentionDays = normalizeRetentionDays(retentionDaysInput);
  const cutoff = deletedBeforeISO(retentionDays);
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS trashCount,
         SUM(CASE WHEN deleted_at <= ? THEN 1 ELSE 0 END) AS expiredCount,
         MIN(deleted_at) AS oldestDeletedAt
       FROM tasks
       WHERE user_id = ? AND deleted_at IS NOT NULL`,
    )
    .get(cutoff, userId) as { trashCount: number; expiredCount: number | null; oldestDeletedAt: string | null };
  return {
    trashCount: row.trashCount,
    expiredCount: row.expiredCount ?? 0,
    retentionDays,
    oldestDeletedAt: row.oldestDeletedAt,
  };
}

export function emptyTrash(userId: string): TrashCleanupResultDTO {
  const before = getTrashSummary(userId);
  const info = db.prepare('DELETE FROM tasks WHERE user_id = ? AND deleted_at IS NOT NULL').run(userId);
  const purgedCount = Number(info.changes);
  if (purgedCount > 0) {
    recordTaskActivity(userId, 'trash', 'trash_emptied', `Emptied trash (${purgedCount} task${purgedCount === 1 ? '' : 's'})`, {
      purgedCount,
      oldestDeletedAt: before.oldestDeletedAt,
    });
  }
  return { ...getTrashSummary(userId), purgedCount, clearedAt: nowISO() };
}

export function purgeExpiredTrash(userId: string, retentionDaysInput?: unknown): TrashCleanupResultDTO {
  const retentionDays = normalizeRetentionDays(retentionDaysInput);
  const before = getTrashSummary(userId, retentionDays);
  const cutoff = deletedBeforeISO(retentionDays);
  const info = db.prepare('DELETE FROM tasks WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?').run(userId, cutoff);
  const purgedCount = Number(info.changes);
  if (purgedCount > 0) {
    recordTaskActivity(userId, 'trash', 'trash_expired_purged', `Purged ${purgedCount} expired trash task${purgedCount === 1 ? '' : 's'}`, {
      purgedCount,
      retentionDays,
      cutoff,
      previousExpiredCount: before.expiredCount,
    });
  }
  return { ...getTrashSummary(userId, retentionDays), purgedCount, clearedAt: nowISO() };
}

export function batchTasks(
  userId: string,
  input: { taskIds: string[]; action: 'update' | 'delete' | 'restore' | 'purge'; patch?: Record<string, unknown> },
): { affected: number; tasks: TaskDTO[] } {
  const ids = Array.from(new Set(input.taskIds.filter((id) => typeof id === 'string' && id)));
  ensureTaskIds(userId, ids);
  if (input.action === 'update') {
    const patch = input.patch ?? {};
    if ('listId' in patch) patch.listId = ensureList(userId, patch.listId as string | null | undefined);
    const tasks: TaskDTO[] = [];
    db.exec('BEGIN');
    try {
      for (const id of ids) {
        const task = updateTask(userId, id, patch);
        if (!task) throw new AppError(404, 'not_found', 'task not found');
        tasks.push(task);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { affected: tasks.length, tasks };
  }
  let affected = 0;
  db.exec('BEGIN');
  try {
    for (const id of ids) {
      const ok =
        input.action === 'delete'
          ? softDeleteTask(userId, id)
          : input.action === 'restore'
            ? !!restoreTask(userId, id)
            : hardDeleteTask(userId, id);
      if (ok) affected += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { affected, tasks: [] };
}

function ensureTask(userId: string, taskId: string): void {
  const row = db.prepare('SELECT id FROM tasks WHERE user_id = ? AND id = ?').get(userId, taskId);
  if (!row) throw new AppError(404, 'not_found', 'task not found');
}

function ensureTaskIds(userId: string, ids: string[]): void {
  if (!ids.length) throw new AppError(400, 'invalid', 'taskIds must not be empty');
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id FROM tasks WHERE user_id = ? AND id IN (${ph})`).all(userId, ...ids) as Array<{ id: string }>;
  if (rows.length !== new Set(ids).size) throw new AppError(404, 'not_found', 'one or more tasks were not found');
}

function ensureList(userId: string, listId: string | null | undefined): string | null {
  if (!listId) return null;
  const row = db.prepare('SELECT id FROM lists WHERE user_id = ? AND id = ?').get(userId, listId);
  if (!row) throw new AppError(404, 'not_found', 'list not found');
  return listId;
}

function listTypeFor(userId: string, listId: string | null | undefined): ListDTO['type'] {
  if (!listId) return 'task';
  const row = db.prepare('SELECT type FROM lists WHERE user_id = ? AND id = ?').get(userId, listId) as { type: string } | undefined;
  if (!row) throw new AppError(404, 'not_found', 'list not found');
  return row.type === 'note' ? 'note' : 'task';
}

function ensureTag(userId: string, tagId: string): void {
  const row = db.prepare('SELECT id FROM tags WHERE user_id = ? AND id = ?').get(userId, tagId);
  if (!row) throw new AppError(404, 'not_found', 'tag not found');
}

function tagHasAncestor(userId: string, tagId: string, ancestorId: string): boolean {
  let current = tagId;
  const seen = new Set<string>();
  for (let guard = 0; guard < 50 && current && !seen.has(current); guard++) {
    seen.add(current);
    const row = db.prepare('SELECT parent_id FROM tags WHERE user_id = ? AND id = ?').get(userId, current) as
      | { parent_id: string | null }
      | undefined;
    if (!row?.parent_id) return false;
    if (row.parent_id === ancestorId) return true;
    current = row.parent_id;
  }
  return false;
}

function assertTagParent(userId: string, tagId: string | null, parentId: string | null): void {
  if (!parentId) return;
  ensureTag(userId, parentId);
  if (tagId && parentId === tagId) throw new AppError(400, 'invalid', 'tag cannot be its own parent');
  if (tagId && tagHasAncestor(userId, parentId, tagId)) throw new AppError(400, 'invalid', 'tag parent would create a cycle');
}

export function listTags(userId: string): TagDTO[] {
  return (
    db.prepare('SELECT * FROM tags WHERE user_id = ? ORDER BY parent_id IS NOT NULL, sort_order ASC, created_at ASC').all(userId) as any[]
  ).map(mapTag);
}

export function createTag(userId: string, input: { name: string; color?: string | null; parentId?: string | null }): TagDTO {
  const name = input.name.trim();
  if (!name) throw new AppError(400, 'invalid', 'name is required');
  const exists = db.prepare('SELECT id FROM tags WHERE user_id = ? AND name = ?').get(userId, name);
  if (exists) throw new AppError(409, 'conflict', 'tag name already exists');
  const parentId = input.parentId ?? null;
  assertTagParent(userId, null, parentId);
  const id = randomUUID();
  const ts = nowISO();
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM tags WHERE user_id = ?').get(userId) as { m: number };
  db.prepare(
    `INSERT INTO tags (id, user_id, name, color, parent_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, name, input.color ?? null, parentId, (max.m ?? 0) + 1, ts, ts);
  return mapTag(db.prepare('SELECT * FROM tags WHERE user_id = ? AND id = ?').get(userId, id));
}

export function updateTag(userId: string, id: string, patch: Record<string, unknown>): TagDTO | null {
  const cols: string[] = [];
  const vals: unknown[] = [];
  if ('name' in patch) {
    const name = String(patch.name ?? '').trim();
    if (!name) throw new AppError(400, 'invalid', 'name is required');
    const exists = db.prepare('SELECT id FROM tags WHERE user_id = ? AND name = ? AND id <> ?').get(userId, name, id);
    if (exists) throw new AppError(409, 'conflict', 'tag name already exists');
    cols.push('name = ?');
    vals.push(name);
  }
  if ('color' in patch) {
    cols.push('color = ?');
    vals.push(patch.color ?? null);
  }
  if ('parentId' in patch) {
    const parentId = patch.parentId == null ? null : String(patch.parentId);
    assertTagParent(userId, id, parentId);
    cols.push('parent_id = ?');
    vals.push(parentId);
  }
  if ('sortOrder' in patch) {
    cols.push('sort_order = ?');
    vals.push(patch.sortOrder ?? 0);
  }
  if (!cols.length) {
    const row = db.prepare('SELECT * FROM tags WHERE user_id = ? AND id = ?').get(userId, id);
    return row ? mapTag(row) : null;
  }
  cols.push('updated_at = ?');
  vals.push(nowISO(), userId, id);
  const info = db.prepare(`UPDATE tags SET ${cols.join(', ')} WHERE user_id = ? AND id = ?`).run(...(vals as any[]));
  if (info.changes === 0) return null;
  return mapTag(db.prepare('SELECT * FROM tags WHERE user_id = ? AND id = ?').get(userId, id));
}

export function deleteTag(userId: string, id: string): boolean {
  const info = db.prepare('DELETE FROM tags WHERE user_id = ? AND id = ?').run(userId, id);
  return info.changes > 0;
}

export function mergeTag(userId: string, sourceId: string, targetId: string) {
  if (sourceId === targetId) throw new AppError(400, 'invalid', 'source and target tags must be different');
  ensureTag(userId, sourceId);
  ensureTag(userId, targetId);
  if (tagHasAncestor(userId, targetId, sourceId)) throw new AppError(400, 'invalid', 'cannot merge a tag into its descendant');
  const ts = nowISO();
  const sourceTaskTags = db.prepare('SELECT task_id FROM task_tags WHERE user_id = ? AND tag_id = ?').all(userId, sourceId) as any[];
  let movedTaskTags = 0;
  let skippedDuplicates = 0;
  for (const row of sourceTaskTags) {
    const insert = db.prepare('INSERT OR IGNORE INTO task_tags (user_id, task_id, tag_id, created_at) VALUES (?, ?, ?, ?)').run(
      userId,
      row.task_id,
      targetId,
      ts,
    );
    if (insert.changes > 0) movedTaskTags += 1;
    else skippedDuplicates += 1;
    db.prepare('DELETE FROM task_tags WHERE user_id = ? AND task_id = ? AND tag_id = ?').run(userId, row.task_id, sourceId);
  }
  const reparented = db.prepare('UPDATE tags SET parent_id = ?, updated_at = ? WHERE user_id = ? AND parent_id = ?').run(
    targetId,
    ts,
    userId,
    sourceId,
  );
  db.prepare('DELETE FROM tags WHERE user_id = ? AND id = ?').run(userId, sourceId);
  return {
    sourceId,
    targetTag: mapTag(db.prepare('SELECT * FROM tags WHERE user_id = ? AND id = ?').get(userId, targetId)),
    movedTaskTags,
    skippedDuplicates,
    reparentedChildTags: reparented.changes,
  };
}

export function addTaskTag(userId: string, taskId: string, tagId: string): TaskDTO {
  ensureTask(userId, taskId);
  ensureTag(userId, tagId);
  const tag = db.prepare('SELECT name FROM tags WHERE user_id = ? AND id = ?').get(userId, tagId) as { name: string } | undefined;
  const info = db.prepare('INSERT OR IGNORE INTO task_tags (user_id, task_id, tag_id, created_at) VALUES (?, ?, ?, ?)').run(
    userId,
    taskId,
    tagId,
    nowISO(),
  );
  if (info.changes > 0) {
    recordTaskActivity(userId, taskId, 'tag_added', `Added tag "${tag?.name ?? tagId}"`, { tagId, tagName: tag?.name ?? null });
  }
  return getTask(userId, taskId)!;
}

export function removeTaskTag(userId: string, taskId: string, tagId: string): TaskDTO {
  ensureTask(userId, taskId);
  const tag = db.prepare('SELECT name FROM tags WHERE user_id = ? AND id = ?').get(userId, tagId) as { name: string } | undefined;
  const info = db.prepare('DELETE FROM task_tags WHERE user_id = ? AND task_id = ? AND tag_id = ?').run(userId, taskId, tagId);
  if (info.changes > 0) {
    recordTaskActivity(userId, taskId, 'tag_removed', `Removed tag "${tag?.name ?? tagId}"`, { tagId, tagName: tag?.name ?? null });
  }
  return getTask(userId, taskId)!;
}

export function listTaskReminders(userId: string, taskId: string): TaskReminderDTO[] {
  ensureTask(userId, taskId);
  return (
    db.prepare('SELECT * FROM task_reminders WHERE user_id = ? AND task_id = ? ORDER BY remind_at ASC, created_at ASC').all(userId, taskId) as any[]
  ).map(mapReminder);
}

export function createTaskReminder(
  userId: string,
  taskId: string,
  input: { remindAt: string; channel?: 'email' },
): TaskReminderDTO {
  ensureTask(userId, taskId);
  const id = randomUUID();
  const ts = nowISO();
  db.prepare(
    `INSERT INTO task_reminders (id, user_id, task_id, remind_at, channel, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
  ).run(id, userId, taskId, input.remindAt, input.channel ?? 'email', ts, ts);
  recordTaskActivity(userId, taskId, 'reminder_created', 'Added task reminder', { reminderId: id, remindAt: input.remindAt });
  return mapReminder(db.prepare('SELECT * FROM task_reminders WHERE user_id = ? AND id = ?').get(userId, id));
}

export function deleteTaskReminder(userId: string, taskId: string, reminderId: string): boolean {
  ensureTask(userId, taskId);
  const before = db.prepare('SELECT remind_at FROM task_reminders WHERE user_id = ? AND task_id = ? AND id = ?').get(userId, taskId, reminderId) as
    | { remind_at: string }
    | undefined;
  const info = db.prepare('DELETE FROM task_reminders WHERE user_id = ? AND task_id = ? AND id = ?').run(userId, taskId, reminderId);
  if (info.changes > 0) {
    recordTaskActivity(userId, taskId, 'reminder_deleted', 'Deleted task reminder', {
      reminderId,
      remindAt: before?.remind_at ?? null,
    });
  }
  return info.changes > 0;
}

export function createTaskAttachment(
  userId: string,
  taskId: string,
  input: { fileName: string; mimeType?: string | null; contentBase64: string },
): AttachmentDTO {
  ensureTask(userId, taskId);
  const fileName = basename(input.fileName).trim();
  if (!fileName || fileName === '.' || fileName === '..') throw new AppError(400, 'invalid', 'fileName is required');
  if (typeof input.contentBase64 !== 'string' || !input.contentBase64) {
    throw new AppError(400, 'invalid', 'contentBase64 is required');
  }
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (!bytes.length) throw new AppError(400, 'invalid', 'attachment file is empty');

  const id = randomUUID();
  const ts = nowISO();
  const dir = resolve(ATTACHMENTS_DIR, userId);
  mkdirSync(dir, { recursive: true });
  const storagePath = resolve(dir, id);
  writeFileSync(storagePath, bytes);
  db.prepare(
    `INSERT INTO attachments (id, user_id, task_id, file_name, mime_type, size_bytes, storage_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, taskId, fileName, input.mimeType ?? null, bytes.length, storagePath, ts);
  recordTaskActivity(userId, taskId, 'attachment_added', `Added attachment "${fileName}"`, {
    attachmentId: id,
    fileName,
    sizeBytes: bytes.length,
  });
  return mapAttachment(db.prepare('SELECT * FROM attachments WHERE user_id = ? AND id = ?').get(userId, id));
}

export function getAttachmentFile(userId: string, id: string): (AttachmentDTO & { storagePath: string }) | null {
  const row = db.prepare('SELECT * FROM attachments WHERE user_id = ? AND id = ?').get(userId, id) as any;
  if (!row) return null;
  return { ...mapAttachment(row), storagePath: row.storage_path };
}

export function listNotificationSounds(userId: string, purpose?: string | null): NotificationSoundDTO[] {
  const allowedPurpose = purpose === 'reminder' || purpose === 'completion' ? purpose : null;
  const rows = allowedPurpose
    ? (db
        .prepare("SELECT * FROM notification_sounds WHERE user_id = ? AND (purpose = ? OR purpose = 'both') ORDER BY created_at DESC")
        .all(userId, allowedPurpose) as any[])
    : (db.prepare('SELECT * FROM notification_sounds WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[]);
  return rows.map(mapNotificationSound);
}

export function createNotificationSound(
  userId: string,
  input: { name: string; purpose?: string | null; mimeType?: string | null; contentBase64: string },
): NotificationSoundDTO {
  const name = basename(input.name).trim();
  if (!name || name === '.' || name === '..') throw new AppError(400, 'invalid_notification_sound', 'name is required');
  const purpose = input.purpose === 'reminder' || input.purpose === 'completion' || input.purpose === 'both' ? input.purpose : 'both';
  const mimeType = (input.mimeType ?? '').toLowerCase();
  if (!AUDIO_MIME_TYPES.has(mimeType)) throw new AppError(400, 'invalid_notification_sound', 'mimeType must be an audio type');
  if (typeof input.contentBase64 !== 'string' || !input.contentBase64.trim()) {
    throw new AppError(400, 'invalid_notification_sound', 'contentBase64 is required');
  }
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (!bytes.length) throw new AppError(400, 'invalid_notification_sound', 'notification sound file is empty');
  if (bytes.length > MAX_NOTIFICATION_SOUND_BYTES) {
    throw new AppError(400, 'invalid_notification_sound', 'notification sound file must be at most 2MB');
  }
  const id = randomUUID();
  const ts = nowISO();
  const dir = resolve(NOTIFICATION_SOUNDS_DIR, userId);
  mkdirSync(dir, { recursive: true });
  const storagePath = resolve(dir, id);
  writeFileSync(storagePath, bytes);
  db.prepare(
    `INSERT INTO notification_sounds (id, user_id, name, purpose, mime_type, size_bytes, storage_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, name, purpose, mimeType, bytes.length, storagePath, ts);
  return mapNotificationSound(db.prepare('SELECT * FROM notification_sounds WHERE user_id = ? AND id = ?').get(userId, id));
}

export function getNotificationSoundFile(userId: string, id: string): (NotificationSoundDTO & { storagePath: string }) | null {
  const row = db.prepare('SELECT * FROM notification_sounds WHERE user_id = ? AND id = ?').get(userId, id) as any;
  if (!row) return null;
  return { ...mapNotificationSound(row), storagePath: row.storage_path };
}

export function listGoals(userId: string): GoalDTO[] {
  return (
    db
      .prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY status ASC, priority DESC, deadline_at IS NULL ASC, deadline_at ASC, created_at DESC')
      .all(userId) as any[]
  ).map(mapGoal);
}

export function getGoal(userId: string, id: string): GoalDTO | null {
  const row = db.prepare('SELECT * FROM goals WHERE user_id = ? AND id = ?').get(userId, id);
  return row ? mapGoal(row) : null;
}

export function getDayPilotDashboard(userId: string, input: { date?: string | null } = {}): DayPilotDashboardDTO {
  const range = dashboardDayRange(input.date);
  const activeGoalRows = db
    .prepare(
      `SELECT
         g.*,
         (SELECT COUNT(*) FROM tasks t
          WHERE t.user_id = g.user_id AND t.goal_id = g.id AND t.completed = 0 AND t.deleted_at IS NULL AND t.status <> 'skipped') open_task_count,
         (SELECT COUNT(*) FROM tasks t
          WHERE t.user_id = g.user_id AND t.goal_id = g.id AND t.completed = 0 AND t.deleted_at IS NULL AND t.status <> 'skipped'
            AND t.is_all_day = 0 AND t.start_date IS NOT NULL AND t.due_date IS NOT NULL AND t.start_date <= ? AND t.due_date >= ?) scheduled_today_count,
         (SELECT COUNT(*) FROM tasks t
          WHERE t.user_id = g.user_id AND t.goal_id = g.id AND t.completed = 0 AND t.deleted_at IS NULL AND t.status <> 'skipped'
            AND t.auto_schedule_enabled = 1 AND t.is_locked_schedule = 0
            AND (t.start_date IS NULL OR t.is_all_day = 1) AND t.planned_start_at IS NULL) unscheduled_task_count
       FROM goals g
       WHERE g.user_id = ? AND g.status IN ('active','not_started')
        ORDER BY
          g.priority DESC,
          CASE WHEN g.deadline_at IS NULL THEN 1 ELSE 0 END ASC,
         g.deadline_at ASC,
         g.created_at DESC
       LIMIT 8`,
    )
    .all(range.to, range.from, userId) as Array<any & { open_task_count: number; scheduled_today_count: number; unscheduled_task_count: number }>;
  const activeGoals = activeGoalRows.map((row) => ({
    id: row.id,
    title: row.title,
    deadlineAt: row.deadline_at ?? null,
    priority: (row.priority ?? 0) as Priority,
    status: row.status ?? 'not_started',
    scheduledTodayCount: row.scheduled_today_count ?? 0,
    unscheduledTaskCount: row.unscheduled_task_count ?? 0,
    openTaskCount: row.open_task_count ?? 0,
  }));

  const baseTaskWhere = `
    FROM tasks t
    JOIN goals g ON g.user_id = t.user_id AND g.id = t.goal_id
    WHERE t.user_id = ?
      AND g.status IN ('active','not_started')
      AND t.completed = 0
      AND t.deleted_at IS NULL
      AND t.status <> 'skipped'
      AND NOT EXISTS (
        SELECT 1 FROM tasks child
        WHERE child.user_id = t.user_id AND child.parent_id = t.id AND child.deleted_at IS NULL AND child.status <> 'skipped'
      )`;
  const topTasks = attachDashboardDependencyState(userId, (
    db
      .prepare(
        `SELECT t.*, g.title goal_title
         ${baseTaskWhere}
         ORDER BY
           CASE
             WHEN t.due_date IS NOT NULL AND t.due_date < ? THEN 0
             WHEN t.due_date IS NOT NULL AND t.due_date <= ? THEN 1
             ELSE 2
           END ASC,
           t.priority DESC,
           COALESCE(t.due_date, g.deadline_at, '9999-12-31T23:59:59.999Z') ASC,
           t.created_at ASC
         LIMIT 3`,
      )
      .all(userId, range.from, range.to) as any[]
  ).map(mapDashboardTask));
  const scheduledTasks = attachDashboardDependencyState(userId, (
    db
      .prepare(
        `SELECT t.*, g.title goal_title
         ${baseTaskWhere}
           AND t.is_all_day = 0
           AND t.start_date IS NOT NULL
           AND t.due_date IS NOT NULL
           AND t.start_date <= ?
           AND t.due_date >= ?
         ORDER BY t.start_date ASC, t.priority DESC
         LIMIT 8`,
      )
      .all(userId, range.to, range.from) as any[]
  ).map(mapDashboardTask));
  const unscheduledTasks = attachDashboardDependencyState(userId, (
    db
      .prepare(
        `SELECT t.*, g.title goal_title
         ${baseTaskWhere}
           AND t.auto_schedule_enabled = 1
           AND t.is_locked_schedule = 0
           AND (t.start_date IS NULL OR t.is_all_day = 1)
           AND t.planned_start_at IS NULL
         ORDER BY
           CASE WHEN t.due_date IS NOT NULL AND t.due_date <= ? THEN 0 ELSE 1 END ASC,
           t.priority DESC,
           COALESCE(t.due_date, g.deadline_at, '9999-12-31T23:59:59.999Z') ASC,
           t.created_at ASC
         LIMIT 8`,
      )
      .all(userId, range.to) as any[]
  ).map(mapDashboardTask));

  const ruleRows = db
    .prepare('SELECT id, name, priority, status FROM personal_schedule_rules WHERE user_id = ?')
    .all(userId) as Array<{ id: string; name: string; priority: 'hard' | 'normal' | 'preference'; status: 'enabled' | 'disabled' }>;
  const ruleMap = new Map(ruleRows.map((rule) => [rule.id, rule]));
  const relatedRules = (ruleIds: string[]) =>
    Array.from(new Set(ruleIds.filter((id) => typeof id === 'string' && id)))
      .map((id) => ruleMap.get(id))
      .filter((rule): rule is NonNullable<typeof rule> => !!rule);
  const proposalRows = db
    .prepare(
      `SELECT p.id, p.goal_id, g.title goal_title, p.status, p.changes_json, p.conflicts_json, p.created_at
       FROM schedule_proposals p
       LEFT JOIN goals g ON g.user_id = p.user_id AND g.id = p.goal_id
       WHERE p.user_id = ?
       ORDER BY p.created_at DESC
       LIMIT 20`,
    )
    .all(userId) as Array<{
      id: string;
      goal_id: string | null;
      goal_title: string | null;
      status: 'draft' | 'confirmed' | 'discarded' | 'undone';
      changes_json: string;
      conflicts_json: string;
      created_at: string;
    }>;
  const proposalConflicts: Array<{
    goalId: string | null;
    goalTitle: string | null;
    type: string;
    severity: 'warning' | 'blocking';
    taskId: string | null;
    ruleIds: string[];
    message: string;
    suggestions: string[];
  }> = [];
  for (const proposal of proposalRows) {
    for (const conflict of parseJsonArraySafe(proposal.conflicts_json)) {
      if (!conflict || typeof conflict !== 'object') continue;
      const row = conflict as { type?: string; severity?: string; taskId?: string | null; ruleIds?: unknown; message?: string; suggestions?: unknown };
      if (row.severity !== 'blocking' && row.severity !== 'warning') continue;
      proposalConflicts.push({
        goalId: proposal.goal_id,
        goalTitle: proposal.goal_title,
        type: typeof row.type === 'string' ? row.type : 'rule_conflict',
        severity: row.severity,
        taskId: row.taskId ?? null,
        ruleIds: Array.isArray(row.ruleIds) ? row.ruleIds.filter((id): id is string => typeof id === 'string') : [],
        message: typeof row.message === 'string' ? row.message : '最近排期方案存在规则或日程冲突。',
        suggestions: Array.isArray(row.suggestions) ? row.suggestions.filter((item): item is string => typeof item === 'string').slice(0, 4) : [],
      });
    }
  }
  const taskTitleCache = new Map<string, string | null>();
  const taskTitle = (taskId: string | null | undefined): string | null => {
    if (!taskId) return null;
    if (!taskTitleCache.has(taskId)) {
      const row = db.prepare('SELECT title FROM tasks WHERE user_id = ? AND id = ?').get(userId, taskId) as { title: string } | undefined;
      taskTitleCache.set(taskId, row?.title ?? null);
    }
    return taskTitleCache.get(taskId) ?? null;
  };
  const ruleImpacts: DayPilotDashboardRuleImpactDTO[] = [];
  const seenRuleImpacts = new Set<string>();
  for (const proposal of proposalRows) {
    for (const change of parseJsonArraySafe(proposal.changes_json)) {
      if (!change || typeof change !== 'object') continue;
      const row = change as {
        changeKey?: string;
        taskId?: string | null;
        title?: string;
        plannedStartAt?: string;
        plannedEndAt?: string;
        ruleIds?: unknown;
        avoidedBlocks?: unknown;
        reason?: string | null;
      };
      if (typeof row.plannedStartAt !== 'string' || typeof row.plannedEndAt !== 'string') continue;
      if (row.plannedStartAt > range.to || row.plannedEndAt < range.from) continue;
      const ruleIds = Array.from(new Set(Array.isArray(row.ruleIds) ? row.ruleIds.filter((id): id is string => typeof id === 'string' && !!id) : []));
      const avoidedBlocks = Array.isArray(row.avoidedBlocks) ? row.avoidedBlocks.filter((block) => !!block && typeof block === 'object') : [];
      const hasRuleAvoidance = avoidedBlocks.some((block) => (block as { source?: unknown }).source === 'rule');
      if (!ruleIds.length && !hasRuleAvoidance) continue;
      const key = `${proposal.id}:${row.changeKey ?? row.taskId ?? row.title ?? row.plannedStartAt}`;
      if (seenRuleImpacts.has(key)) continue;
      seenRuleImpacts.add(key);
      ruleImpacts.push({
        proposalId: proposal.id,
        proposalStatus: proposal.status,
        goalId: proposal.goal_id,
        goalTitle: proposal.goal_title,
        taskId: row.taskId ?? null,
        taskTitle: taskTitle(row.taskId) ?? row.title ?? 'Untitled task',
        plannedStartAt: row.plannedStartAt,
        plannedEndAt: row.plannedEndAt,
        ruleIds,
        rules: relatedRules(ruleIds),
        avoidedBlocks: avoidedBlocks as DayPilotDashboardRuleImpactDTO['avoidedBlocks'],
        reason: typeof row.reason === 'string' ? row.reason : null,
        createdAt: proposal.created_at,
      });
      if (ruleImpacts.length >= 8) break;
    }
    if (ruleImpacts.length >= 8) break;
  }
  ruleImpacts.sort((a, b) => (a.plannedStartAt === b.plannedStartAt ? b.createdAt.localeCompare(a.createdAt) : a.plannedStartAt.localeCompare(b.plannedStartAt)));
  const conflictForTask = (task: DayPilotDashboardTaskDTO) =>
    proposalConflicts.find((conflict) => conflict.taskId === task.id) ??
    proposalConflicts.find((conflict) => conflict.goalId === task.goalId && conflict.ruleIds.length > 0);

  const risks: DayPilotDashboardRiskDTO[] = [];
  const deadlineRows = db
    .prepare(
      `SELECT
         g.id goal_id,
         g.title goal_title,
         g.deadline_at,
         COUNT(t.id) open_count,
         SUM(CASE WHEN (t.start_date IS NULL OR t.is_all_day = 1) AND t.planned_start_at IS NULL THEN 1 ELSE 0 END) unscheduled_count
       FROM goals g
       JOIN tasks t ON t.user_id = g.user_id AND t.goal_id = g.id
       WHERE g.user_id = ?
         AND g.status IN ('active','not_started')
         AND g.deadline_at IS NOT NULL
         AND g.deadline_at <= ?
         AND t.completed = 0
         AND t.deleted_at IS NULL
         AND t.status <> 'skipped'
       GROUP BY g.id
       ORDER BY g.deadline_at ASC
       LIMIT 5`,
    )
    .all(userId, range.to) as Array<{ goal_id: string; goal_title: string; deadline_at: string; open_count: number; unscheduled_count: number | null }>;
  for (const row of deadlineRows) {
    risks.push({
      type: 'deadline_risk',
      severity: row.deadline_at < range.from ? 'blocking' : 'warning',
      goalId: row.goal_id,
      goalTitle: row.goal_title,
      taskId: null,
      taskTitle: null,
      ruleIds: [],
      rules: [],
      message: `计划「${row.goal_title}」截止前仍有 ${row.open_count} 个未完成任务，其中 ${row.unscheduled_count ?? 0} 个还未进入日程。`,
      suggestions: ['生成今日排期方案', '放宽个人规则或调整计划截止时间'],
    });
  }
  for (const task of unscheduledTasks.filter((item) => item.dueDate && item.dueDate <= range.to).slice(0, 3)) {
    const conflict = conflictForTask(task);
    const ruleIds = conflict?.ruleIds ?? [];
    const rules = relatedRules(ruleIds);
    risks.push({
      type: 'unscheduled_today',
      severity: conflict?.severity ?? 'warning',
      goalId: task.goalId,
      goalTitle: task.goalTitle,
      taskId: task.id,
      taskTitle: task.title,
      ruleIds,
      rules,
      message: conflict
        ? `任务「${task.title}」今天到期但未排入日程；最近排期提示：${conflict.message}`
        : `任务「${task.title}」今天到期，但还没有明确时间块。`,
      suggestions: conflict?.suggestions.length ? conflict.suggestions : ['把任务加入今日排期方案', '修改任务截止时间或预计耗时'],
    });
  }
  const dependencyRiskSeen = new Set<string>();
  for (const task of [...topTasks, ...unscheduledTasks, ...scheduledTasks]) {
    if (risks.length >= 10) break;
    if (!task.blockingDependencies.length || dependencyRiskSeen.has(task.id)) continue;
    dependencyRiskSeen.add(task.id);
    const waitingOn = task.blockingDependencies.map((dependency) => dependency.title).join('、');
    risks.push({
      type: 'dependency_blocked',
      severity: 'warning',
      goalId: task.goalId,
      goalTitle: task.goalTitle,
      taskId: task.id,
      taskTitle: task.title,
      ruleIds: [],
      rules: [],
      message: `任务「${task.title}」正在等待前置任务：${waitingOn}。`,
      suggestions: ['先完成前置任务', '调整任务依赖后重新生成排期方案'],
    });
  }
  for (const conflict of proposalConflicts) {
      if (risks.length >= 10) break;
      const rules = relatedRules(conflict.ruleIds);
      risks.push({
        type: 'rule_conflict',
        severity: conflict.severity,
        goalId: conflict.goalId,
        goalTitle: conflict.goalTitle,
        taskId: conflict.taskId,
        taskTitle: taskTitle(conflict.taskId),
        ruleIds: conflict.ruleIds,
        rules,
        message: rules.length ? `${conflict.message} 相关规则：${rules.map((rule) => rule.name).join('、')}。` : conflict.message,
        suggestions: conflict.suggestions,
      });
  }
  const finalRisks = risks.slice(0, 10);
  return {
    date: range.date,
    range: { from: range.from, to: range.to },
    summary: {
      topTaskCount: topTasks.length,
      activeGoalCount: activeGoals.length,
      scheduledTodayCount: scheduledTasks.length,
      unscheduledTaskCount: unscheduledTasks.length,
      riskCount: finalRisks.length,
      ruleImpactCount: ruleImpacts.length,
    },
    topTasks,
    activeGoals,
    scheduledTasks,
    unscheduledTasks,
    risks: finalRisks,
    ruleImpacts,
  };
}

export function createGoal(
  userId: string,
  input: {
    title: string;
    description?: string | null;
    startAt?: string | null;
    deadlineAt?: string | null;
    priority?: Priority | null;
    totalEstimatedMinutes?: number | null;
    availableTimeRule?: string | null;
    progressMode?: 'auto' | 'manual';
    status?: GoalDTO['status'];
  },
): GoalDTO {
  const title = input.title.trim();
  if (!title) throw new AppError(400, 'invalid', 'title is required');
  assertProgressMode(input.progressMode);
  assertGoalStatus(input.status);
  assertGoalPriority(input.priority);
  const id = randomUUID();
  const ts = nowISO();
  db.prepare(
    `INSERT INTO goals
       (id, user_id, title, description, start_at, deadline_at, priority, total_estimated_minutes, available_time_rule, progress_mode, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    title,
    input.description ?? null,
    input.startAt ?? null,
    input.deadlineAt ?? null,
    Number(input.priority ?? 0),
    input.totalEstimatedMinutes ?? null,
    input.availableTimeRule ?? null,
    input.progressMode ?? 'auto',
    input.status ?? 'active',
    ts,
    ts,
  );
  return getGoal(userId, id)!;
}

const MAX_INITIAL_GOAL_TASKS = 100;
const MAX_INITIAL_GOAL_TASK_TITLE_LENGTH = 200;

type InitialGoalTaskInput = {
  title: string;
  estimatedMinutes?: number | null;
  scheduleEnergyType?: 'high' | 'medium' | 'low' | null;
  scheduleTaskType?: string | null;
  isSplittable?: boolean;
  minScheduleMinutes?: number | null;
};

function cleanInitialTaskTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/^\s*(?:[-*•]+|\d+[.)]|[[(]?\s?[xX ]\s?[\])])\s*/, '')
    .trim();
}

function parseInitialGoalTasks(input: {
  tasksText?: unknown;
  initialTasks?: unknown;
}): InitialGoalTaskInput[] {
  const tasks: InitialGoalTaskInput[] = [];
  if (typeof input.tasksText === 'string') {
    for (const line of input.tasksText.split(/\r?\n/)) {
      const title = cleanInitialTaskTitle(line);
      if (title) tasks.push({ title });
    }
  }
  if (Array.isArray(input.initialTasks)) {
    for (const item of input.initialTasks) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new AppError(400, 'invalid_goal_tasks', 'initialTasks must contain objects');
      }
      const raw = item as Record<string, unknown>;
      const title = cleanInitialTaskTitle(raw.title);
      if (!title) throw new AppError(400, 'invalid_goal_tasks', 'initial task title is required');
      tasks.push({
        title,
        estimatedMinutes: raw.estimatedMinutes == null ? null : Number(raw.estimatedMinutes),
        scheduleEnergyType: raw.scheduleEnergyType as InitialGoalTaskInput['scheduleEnergyType'],
        scheduleTaskType: typeof raw.scheduleTaskType === 'string' ? raw.scheduleTaskType : null,
        isSplittable: raw.isSplittable === true,
        minScheduleMinutes: raw.minScheduleMinutes == null ? null : Number(raw.minScheduleMinutes),
      });
    }
  }
  if (tasks.length > MAX_INITIAL_GOAL_TASKS) {
    throw new AppError(400, 'too_many_goal_tasks', `a goal can be created with at most ${MAX_INITIAL_GOAL_TASKS} tasks`);
  }
  for (const task of tasks) {
    if (task.title.length > MAX_INITIAL_GOAL_TASK_TITLE_LENGTH) {
      throw new AppError(400, 'invalid_goal_tasks', `initial task title can contain at most ${MAX_INITIAL_GOAL_TASK_TITLE_LENGTH} characters`);
    }
    assertScheduleEnergyType(task.scheduleEnergyType);
    assertScheduleMinutes(task.estimatedMinutes, 'estimatedMinutes');
    assertScheduleMinutes(task.minScheduleMinutes, 'minScheduleMinutes');
  }
  return tasks;
}

export function createGoalWithInitialTasks(
  userId: string,
  input: Parameters<typeof createGoal>[1] & {
    tasksText?: unknown;
    initialTasks?: unknown;
  },
): { goal: GoalDTO; tasks: TaskDTO[] } {
  const initialTasks = parseInitialGoalTasks(input);
  db.exec('BEGIN');
  try {
    const goal = createGoal(userId, input);
    const tasks = initialTasks.map((task) =>
      createGoalTask(userId, goal.id, {
        title: task.title,
        estimatedMinutes: task.estimatedMinutes ?? null,
        scheduleEnergyType: task.scheduleEnergyType ?? null,
        scheduleTaskType: task.scheduleTaskType ?? null,
        isSplittable: task.isSplittable ?? false,
        minScheduleMinutes: task.minScheduleMinutes ?? null,
        source: 'manual',
      }),
    );
    db.exec('COMMIT');
    return { goal, tasks };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function updateGoal(userId: string, id: string, patch: Record<string, unknown>): GoalDTO | null {
  assertProgressMode(patch.progressMode);
  assertGoalStatus(patch.status);
  assertGoalPriority(patch.priority);
  const map: Record<string, string> = {
    title: 'title',
    description: 'description',
    startAt: 'start_at',
    deadlineAt: 'deadline_at',
    priority: 'priority',
    totalEstimatedMinutes: 'total_estimated_minutes',
    availableTimeRule: 'available_time_rule',
    progressMode: 'progress_mode',
    status: 'status',
  };
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) {
      const value = k === 'title' ? String(patch[k] ?? '').trim() : k === 'priority' ? Number(patch[k] ?? 0) : patch[k];
      if (k === 'title' && !value) throw new AppError(400, 'invalid', 'title is required');
      cols.push(`${col} = ?`);
      vals.push(value ?? null);
    }
  }
  if (!cols.length) return getGoal(userId, id);
  cols.push('updated_at = ?');
  vals.push(nowISO(), userId, id);
  const info = db.prepare(`UPDATE goals SET ${cols.join(', ')} WHERE user_id = ? AND id = ?`).run(...(vals as any[]));
  if (info.changes === 0) return null;
  return getGoal(userId, id);
}

export function deleteGoal(userId: string, id: string): boolean {
  const ts = nowISO();
  db.prepare('UPDATE tasks SET goal_id = NULL, root_task_id = NULL, level = 1, updated_at = ? WHERE user_id = ? AND goal_id = ?').run(
    ts,
    userId,
    id,
  );
  const info = db.prepare('DELETE FROM goals WHERE user_id = ? AND id = ?').run(userId, id);
  return info.changes > 0;
}

function listGoalTaskScheduleInsights(userId: string, goalId: string): GoalTaskScheduleInsightDTO[] {
  const ruleRows = db
    .prepare('SELECT id, name, priority, status FROM personal_schedule_rules WHERE user_id = ?')
    .all(userId) as Array<{ id: string; name: string; priority: 'hard' | 'normal' | 'preference'; status: 'enabled' | 'disabled' }>;
  const ruleMap = new Map(ruleRows.map((rule) => [rule.id, rule]));
  const relatedRules = (ruleIds: string[]) =>
    Array.from(new Set(ruleIds.filter((id) => typeof id === 'string' && id)))
      .map((id) => ruleMap.get(id))
      .filter((rule): rule is NonNullable<typeof rule> => !!rule);
  const proposalRows = db
    .prepare(
      `SELECT id, status, changes_json, explanations_json, created_at
       FROM schedule_proposals
       WHERE user_id = ? AND goal_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
    )
    .all(userId, goalId) as Array<{
      id: string;
      status: 'draft' | 'confirmed' | 'discarded' | 'undone';
      changes_json: string;
      explanations_json: string;
      created_at: string;
    }>;
  const insights = new Map<string, GoalTaskScheduleInsightDTO>();
  for (const proposal of proposalRows) {
    const explanations = new Map<string, { message: string; ruleIds: string[] }>();
    for (const explanation of parseJsonArraySafe(proposal.explanations_json)) {
      if (!explanation || typeof explanation !== 'object') continue;
      const row = explanation as { taskId?: unknown; message?: unknown; ruleIds?: unknown };
      if (typeof row.taskId !== 'string') continue;
      explanations.set(row.taskId, {
        message: typeof row.message === 'string' ? row.message : '',
        ruleIds: Array.isArray(row.ruleIds) ? row.ruleIds.filter((ruleId): ruleId is string => typeof ruleId === 'string') : [],
      });
    }
    for (const change of parseJsonArraySafe(proposal.changes_json)) {
      if (!change || typeof change !== 'object') continue;
      const row = change as {
        taskId?: unknown;
        plannedStartAt?: unknown;
        plannedEndAt?: unknown;
        reason?: unknown;
        ruleIds?: unknown;
        avoidedBlocks?: unknown;
      };
      if (typeof row.taskId !== 'string' || insights.has(row.taskId)) continue;
      if (typeof row.plannedStartAt !== 'string' || typeof row.plannedEndAt !== 'string') continue;
      const explanation = explanations.get(row.taskId);
      const ruleIds = Array.from(
        new Set([
          ...(Array.isArray(row.ruleIds) ? row.ruleIds.filter((ruleId): ruleId is string => typeof ruleId === 'string' && !!ruleId) : []),
          ...(explanation?.ruleIds ?? []),
        ]),
      );
      insights.set(row.taskId, {
        taskId: row.taskId,
        proposalId: proposal.id,
        proposalStatus: proposal.status,
        plannedStartAt: row.plannedStartAt,
        plannedEndAt: row.plannedEndAt,
        reason: typeof row.reason === 'string' ? row.reason : null,
        explanation: explanation?.message || null,
        ruleIds,
        rules: relatedRules(ruleIds),
        avoidedBlocks: Array.isArray(row.avoidedBlocks) ? (row.avoidedBlocks.filter((block) => !!block && typeof block === 'object') as GoalTaskScheduleInsightDTO['avoidedBlocks']) : [],
        createdAt: proposal.created_at,
      });
    }
  }
  return [...insights.values()];
}

export function getGoalTree(userId: string, id: string): { goal: GoalDTO; tasks: TaskDTO[]; scheduleInsights: GoalTaskScheduleInsightDTO[] } | null {
  const goal = getGoal(userId, id);
  if (!goal) return null;
  const rows = db
    .prepare('SELECT * FROM tasks WHERE user_id = ? AND goal_id = ? AND deleted_at IS NULL ORDER BY level ASC, sort_order ASC, created_at ASC')
    .all(userId, id) as any[];
  return { goal, tasks: hydrateTasks(userId, rows), scheduleInsights: listGoalTaskScheduleInsights(userId, id) };
}

export function createGoalTask(
  userId: string,
  goalId: string,
  input: {
    title: string;
    note?: string | null;
    parentId?: string | null;
    priority?: number;
    startDate?: string | null;
    dueDate?: string | null;
    isAllDay?: boolean;
    estimatedMinutes?: number | null;
    scheduleEnergyType?: 'high' | 'medium' | 'low' | null;
    scheduleTaskType?: string | null;
    isSplittable?: boolean;
    minScheduleMinutes?: number | null;
    source?: string | null;
  },
): TaskDTO {
  const goal = getGoal(userId, goalId);
  if (!goal) throw new AppError(404, 'not_found', 'goal not found');
  let rootTaskId: string | null = null;
  let level = 1;
  if (input.parentId) {
    const parent = db.prepare('SELECT id, goal_id, root_task_id, level FROM tasks WHERE user_id = ? AND id = ?').get(userId, input.parentId) as
      | { id: string; goal_id: string | null; root_task_id: string | null; level: number }
      | undefined;
    if (!parent) throw new AppError(404, 'not_found', 'parent task not found');
    if (parent.goal_id !== goalId) throw new AppError(400, 'invalid', 'parent task must belong to the same goal');
    rootTaskId = parent.root_task_id ?? parent.id;
    level = (parent.level ?? 1) + 1;
  }
  const task = createTask(userId, {
    title: input.title,
    note: input.note ?? null,
    listId: null,
    priority: input.priority ?? 0,
    dueDate: input.dueDate ?? null,
    startDate: input.startDate ?? null,
    isAllDay: input.isAllDay ?? true,
    parentId: input.parentId ?? null,
    estimatedMinutes: input.estimatedMinutes ?? null,
    scheduleEnergyType: input.scheduleEnergyType ?? null,
    scheduleTaskType: input.scheduleTaskType ?? null,
    isSplittable: input.isSplittable ?? false,
    minScheduleMinutes: input.minScheduleMinutes ?? null,
    source: input.source ?? 'manual',
  });
  const root = rootTaskId ?? task.id;
  db.prepare('UPDATE tasks SET goal_id = ?, root_task_id = ?, level = ?, updated_at = ? WHERE user_id = ? AND id = ?').run(
    goalId,
    root,
    level,
    nowISO(),
    userId,
    task.id,
  );
  return getTask(userId, task.id)!;
}

function parseTimeRule(rule: string | null): { startHour: number; endHour: number } {
  if (!rule) return { startHour: 9, endHour: 18 };
  try {
    const value = JSON.parse(rule) as { startHour?: number; endHour?: number };
    const startHour = Number.isFinite(value.startHour) ? Number(value.startHour) : 9;
    const endHour = Number.isFinite(value.endHour) ? Number(value.endHour) : 18;
    if (startHour < 0 || startHour > 23 || endHour <= startHour || endHour > 24) return { startHour: 9, endHour: 18 };
    return { startHour, endHour };
  } catch {
    return { startHour: 9, endHour: 18 };
  }
}

function alignToWindow(input: Date, rule: { startHour: number; endHour: number }): Date {
  const d = new Date(input);
  const start = new Date(d);
  start.setHours(rule.startHour, 0, 0, 0);
  const end = new Date(d);
  end.setHours(rule.endHour, 0, 0, 0);
  if (d < start) return start;
  if (d >= end) {
    start.setDate(start.getDate() + 1);
    return start;
  }
  return d;
}

function orderByDependencies(rows: any[]): any[] {
  const remaining = new Map(rows.map((r) => [r.id, r]));
  const ordered: any[] = [];
  while (remaining.size) {
    const next = [...remaining.values()].find((r) =>
      parseIdList(r.dependency_task_ids).every((dep) => !remaining.has(dep)),
    );
    if (!next) throw new AppError(409, 'dependency_cycle', 'task dependencies contain a cycle');
    ordered.push(next);
    remaining.delete(next.id);
  }
  return ordered;
}

export function autoScheduleGoal(userId: string, goalId: string): { goal: GoalDTO; scheduled: TaskDTO[] } {
  const goal = getGoal(userId, goalId);
  if (!goal) throw new AppError(404, 'not_found', 'goal not found');
  if (goal.status !== 'active' && goal.status !== 'not_started') {
    throw new AppError(409, 'goal_not_schedulable', 'only active or not-started goals can be automatically scheduled');
  }
  const rows = db
    .prepare(
      `SELECT t.*
       FROM tasks t
       WHERE t.user_id = ?
         AND t.goal_id = ?
         AND t.deleted_at IS NULL
         AND t.completed = 0
         AND t.auto_schedule_enabled = 1
         AND t.is_locked_schedule = 0
         AND NOT EXISTS (
           SELECT 1 FROM tasks child
           WHERE child.user_id = t.user_id AND child.parent_id = t.id AND child.deleted_at IS NULL
         )
       ORDER BY t.priority DESC, t.created_at ASC`,
    )
    .all(userId, goalId) as any[];
  const ordered = orderByDependencies(rows);
  const rule = parseTimeRule(goal.availableTimeRule);
  let cursor = alignToWindow(goal.startAt ? new Date(goal.startAt) : new Date(), rule);
  const deadline = goal.deadlineAt ? new Date(goal.deadlineAt) : null;
  const scheduledIds: string[] = [];
  for (const task of ordered) {
    const duration = Math.max(15, Number(task.estimated_minutes) || 60);
    cursor = alignToWindow(cursor, rule);
    const dayEnd = new Date(cursor);
    dayEnd.setHours(rule.endHour, 0, 0, 0);
    if (cursor.getTime() + duration * 60000 > dayEnd.getTime()) {
      const next = new Date(cursor);
      next.setDate(next.getDate() + 1);
      next.setHours(rule.startHour, 0, 0, 0);
      cursor = next;
    }
    const end = new Date(cursor.getTime() + duration * 60000);
    if (deadline && end > deadline) {
      throw new AppError(409, 'schedule_overflow', 'available time is not enough before the deadline');
    }
    const startISO = cursor.toISOString();
    const endISO = end.toISOString();
    db.prepare(
      `UPDATE tasks
       SET planned_start_at = ?, planned_end_at = ?, start_date = ?, due_date = ?, is_all_day = 0, updated_at = ?
       WHERE user_id = ? AND id = ?`,
    ).run(startISO, endISO, startISO, endISO, nowISO(), userId, task.id);
    scheduledIds.push(task.id);
    cursor = end;
  }
  return { goal, scheduled: scheduledIds.map((id) => getTask(userId, id)!).filter(Boolean) };
}

function dependencyIdsForTask(userId: string, taskId: string, override?: { taskId: string; dependencyIds: string[] }): string[] {
  if (override && override.taskId === taskId) return override.dependencyIds;
  const row = db
    .prepare('SELECT dependency_task_ids FROM tasks WHERE user_id = ? AND id = ? AND deleted_at IS NULL')
    .get(userId, taskId) as { dependency_task_ids: string | null } | undefined;
  return row ? parseIdList(row.dependency_task_ids) : [];
}

function assertDependencyAcyclic(userId: string, taskId: string, dependencyIds: string[]): void {
  const seen = new Set<string>();
  const override = { taskId, dependencyIds };
  const visit = (currentId: string) => {
    if (currentId === taskId) {
      throw new AppError(409, 'dependency_cycle', 'task dependency would create a cycle');
    }
    if (seen.has(currentId)) return;
    seen.add(currentId);
    for (const dependencyId of dependencyIdsForTask(userId, currentId, override)) {
      visit(dependencyId);
    }
  };
  for (const dependencyId of dependencyIds) {
    visit(dependencyId);
  }
}

export function addTaskDependency(userId: string, taskId: string, dependencyId: string): TaskDTO {
  if (taskId === dependencyId) throw new AppError(400, 'invalid', 'task cannot depend on itself');
  ensureTask(userId, taskId);
  ensureTask(userId, dependencyId);
  const task = getTask(userId, taskId)!;
  const next = Array.from(new Set([...task.dependencyTaskIds, dependencyId]));
  assertDependencyAcyclic(userId, taskId, next);
  updateTask(userId, taskId, { dependencyTaskIds: next });
  if (!task.dependencyTaskIds.includes(dependencyId)) {
    recordTaskActivity(userId, taskId, 'dependency_added', 'Added task dependency', { dependencyId });
  }
  return getTask(userId, taskId)!;
}

export function removeTaskDependency(userId: string, taskId: string, dependencyId: string): TaskDTO {
  ensureTask(userId, taskId);
  const task = getTask(userId, taskId)!;
  updateTask(userId, taskId, { dependencyTaskIds: task.dependencyTaskIds.filter((id) => id !== dependencyId) });
  if (task.dependencyTaskIds.includes(dependencyId)) {
    recordTaskActivity(userId, taskId, 'dependency_removed', 'Removed task dependency', { dependencyId });
  }
  return getTask(userId, taskId)!;
}

export function listNotifications(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}): NotificationDTO[] {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 100));
  const where = opts.unreadOnly ? 'user_id = ? AND read_at IS NULL' : 'user_id = ?';
  return (
    db.prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC LIMIT ?`).all(userId, limit) as any[]
  ).map(mapNotification);
}

export function markNotificationRead(userId: string, id: string): NotificationDTO | null {
  const ts = nowISO();
  const info = db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE user_id = ? AND id = ?').run(ts, userId, id);
  if (info.changes === 0) return null;
  const row = db.prepare('SELECT * FROM notifications WHERE user_id = ? AND id = ?').get(userId, id);
  return row ? mapNotification(row) : null;
}

export function snoozeNotification(userId: string, id: string, snoozedUntil: string): NotificationDTO | null {
  const info = db
    .prepare("UPDATE notifications SET scheduled_at = ?, read_at = NULL, action_state = 'snoozed' WHERE user_id = ? AND id = ?")
    .run(snoozedUntil, userId, id);
  if (info.changes === 0) return null;
  const row = db.prepare('SELECT * FROM notifications WHERE user_id = ? AND id = ?').get(userId, id);
  return row ? mapNotification(row) : null;
}

const NOTIFICATION_PERMISSION = 'system-notifications';
const NOTIFICATION_PERMISSION_STATUSES = new Set<NotificationPermissionStatus>([
  'unknown',
  'default',
  'granted',
  'denied',
  'unsupported',
]);
const NOTIFICATION_PERMISSION_REASONS = new Set<NotificationPermissionPromptReason>([
  'settings',
  'task_reminder',
  'habit_reminder',
  'focus_reminder',
]);

function notificationGuidance(status: NotificationPermissionStatus): NotificationPermissionDTO['guidance'] {
  if (status === 'granted') return 'enabled';
  if (status === 'denied') return 'blocked';
  if (status === 'unsupported') return 'unsupported';
  return 'request_when_needed';
}

function notificationPermissionDto(row?: {
  status: string;
  prompt_reason: string | null;
  last_prompted_at: string | null;
  updated_at: string | null;
}): NotificationPermissionDTO {
  const status = NOTIFICATION_PERMISSION_STATUSES.has(row?.status as NotificationPermissionStatus)
    ? (row!.status as NotificationPermissionStatus)
    : 'unknown';
  return {
    permission: NOTIFICATION_PERMISSION,
    status,
    promptReason: NOTIFICATION_PERMISSION_REASONS.has(row?.prompt_reason as NotificationPermissionPromptReason)
      ? (row!.prompt_reason as NotificationPermissionPromptReason)
      : null,
    lastPromptedAt: row?.last_prompted_at ?? null,
    updatedAt: row?.updated_at ?? null,
    shouldPrompt: status === 'unknown' || status === 'default',
    guidance: notificationGuidance(status),
  };
}

export function getNotificationPermission(userId: string): NotificationPermissionDTO {
  const row = db
    .prepare('SELECT status, prompt_reason, last_prompted_at, updated_at FROM notification_permissions WHERE user_id = ? AND permission = ?')
    .get(userId, NOTIFICATION_PERMISSION) as
    | { status: string; prompt_reason: string | null; last_prompted_at: string | null; updated_at: string | null }
    | undefined;
  return notificationPermissionDto(row);
}

export function updateNotificationPermission(
  userId: string,
  input: { status?: unknown; promptReason?: unknown },
): NotificationPermissionDTO {
  if (typeof input.status !== 'string' || !NOTIFICATION_PERMISSION_STATUSES.has(input.status as NotificationPermissionStatus)) {
    throw new AppError(400, 'invalid_notification_permission', 'status is invalid');
  }
  let promptReason: NotificationPermissionPromptReason | null = null;
  if (input.promptReason != null) {
    if (typeof input.promptReason !== 'string' || !NOTIFICATION_PERMISSION_REASONS.has(input.promptReason as NotificationPermissionPromptReason)) {
      throw new AppError(400, 'invalid_notification_permission', 'promptReason is invalid');
    }
    promptReason = input.promptReason as NotificationPermissionPromptReason;
  }
  const ts = nowISO();
  db.prepare(
    `INSERT INTO notification_permissions (user_id, permission, status, prompt_reason, last_prompted_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, permission) DO UPDATE SET
       status = excluded.status,
       prompt_reason = COALESCE(excluded.prompt_reason, notification_permissions.prompt_reason),
       last_prompted_at = COALESCE(excluded.last_prompted_at, notification_permissions.last_prompted_at),
       updated_at = excluded.updated_at`,
  ).run(userId, NOTIFICATION_PERMISSION, input.status, promptReason, promptReason ? ts : null, ts);
  return getNotificationPermission(userId);
}

function minutesOfDay(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

function isInDoNotDisturbWindow(now: Date, start: string | null, end: string | null): boolean {
  if (!start || !end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  const startMin = minutesOfDay(start);
  const endMin = minutesOfDay(end);
  if (startMin === endMin) return true;
  if (startMin < endMin) return current >= startMin && current < endMin;
  return current >= startMin || current < endMin;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function localDateString(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function localTimeString(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function localDateTimeISO(date: string, time: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

function daysOfWeekIncludes(daysOfWeek: string, day: number): boolean {
  return daysOfWeek
    .split(',')
    .map((value) => Number(value.trim()))
    .some((value) => value === day);
}

function insertNotification(
  userId: string,
  input: { type: string; title: string; body: string; targetType: string; targetId: string; scheduledAt: string; deliveredAt: string },
): NotificationDTO | null {
  const id = randomUUID();
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO notifications
        (id, user_id, type, title, body, target_type, target_id, scheduled_at, delivered_at, read_at, action_state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'created', ?)`,
    )
    .run(id, userId, input.type, input.title, input.body, input.targetType, input.targetId, input.scheduledAt, input.deliveredAt, nowISO());
  if (info.changes === 0) return null;
  const row = db.prepare('SELECT * FROM notifications WHERE user_id = ? AND id = ?').get(userId, id);
  return row ? mapNotification(row) : null;
}

const IMPORTANT_REMINDER_REPEAT_MINUTES = 10;

function taskReminderRepeatPattern(reminderId: string) {
  return `${reminderId}:repeat:%`;
}

function taskReminderAcknowledged(userId: string, reminderId: string) {
  const row = db.prepare(`
    SELECT id FROM notifications
    WHERE user_id = ?
      AND target_type = 'task_reminder'
      AND (target_id = ? OR target_id LIKE ?)
      AND read_at IS NOT NULL
    LIMIT 1
  `).get(userId, reminderId, taskReminderRepeatPattern(reminderId));
  return !!row;
}

function taskReminderNotificationCount(userId: string, reminderId: string) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM notifications
    WHERE user_id = ?
      AND target_type = 'task_reminder'
      AND (target_id = ? OR target_id LIKE ?)
  `).get(userId, reminderId, taskReminderRepeatPattern(reminderId)) as { count: number };
  return Number(row?.count || 0);
}

function completeTaskReminder(userId: string, reminderId: string, ts: string) {
  db.prepare("UPDATE task_reminders SET status = 'sent', updated_at = ? WHERE user_id = ? AND id = ?").run(ts, userId, reminderId);
}

export function runReminderTick(userId: string): { created: number; notifications: NotificationDTO[] } {
  const ts = nowISO();
  const notificationSettings = getSettings(userId).notifications;
  if (!notificationSettings.enabled) return { created: 0, notifications: [] };
  if (
    notificationSettings.doNotDisturb &&
    isInDoNotDisturbWindow(new Date(ts), notificationSettings.doNotDisturbStart, notificationSettings.doNotDisturbEnd)
  ) {
    return { created: 0, notifications: [] };
  }
  const out: NotificationDTO[] = [];

  if (notificationSettings.taskReminders) {
    const due = db
      .prepare(
        `SELECT
           r.id AS reminder_id,
           r.task_id,
           r.remind_at,
           t.title AS task_title,
           t.priority,
           t.is_important,
           t.completed
         FROM task_reminders r
         JOIN tasks t ON t.user_id = r.user_id AND t.id = r.task_id
         WHERE r.user_id = ?
           AND r.status = 'scheduled'
           AND r.remind_at <= ?
           AND t.deleted_at IS NULL`,
      )
      .all(userId, ts) as any[];
    for (const r of due) {
      const isImportantReminder = Number(r.priority || 0) >= 3 || !!r.is_important;
      if (r.completed) {
        completeTaskReminder(userId, r.reminder_id, ts);
        continue;
      }
      if (isImportantReminder && taskReminderAcknowledged(userId, r.reminder_id)) {
        completeTaskReminder(userId, r.reminder_id, ts);
        continue;
      }
      const existingCount = isImportantReminder ? taskReminderNotificationCount(userId, r.reminder_id) : 0;
      const targetId = isImportantReminder && existingCount > 0 ? `${r.reminder_id}:repeat:${r.remind_at}` : r.reminder_id;
      const created = insertNotification(userId, {
        type: 'task_reminder',
        title: isImportantReminder ? `重要任务提醒：${r.task_title}` : `任务提醒：${r.task_title}`,
        body: isImportantReminder ? '重要任务仍未完成，确认提醒或完成任务后停止重复提醒。' : '你设置的任务提醒已到时间。',
        targetType: 'task_reminder',
        targetId,
        scheduledAt: r.remind_at,
        deliveredAt: ts,
      });
      if (isImportantReminder) {
        const nextAt = new Date(Date.parse(ts) + IMPORTANT_REMINDER_REPEAT_MINUTES * 60 * 1000).toISOString();
        db.prepare("UPDATE task_reminders SET remind_at = ?, status = 'scheduled', updated_at = ? WHERE user_id = ? AND id = ?").run(
          nextAt,
          ts,
          userId,
          r.reminder_id,
        );
      } else {
        completeTaskReminder(userId, r.reminder_id, ts);
      }
      if (created) out.push(created);
    }
  }

  const now = new Date(ts);
  const today = localDateString(now);
  const currentTime = localTimeString(now);
  if (notificationSettings.habitReminders) {
    const habits = db
      .prepare(
        `SELECT h.id, h.name, h.days_of_week, h.reminder_time
         FROM habits h
         LEFT JOIN habit_checkins c ON c.user_id = h.user_id AND c.habit_id = h.id AND c.date = ?
         WHERE h.user_id = ?
           AND h.archived = 0
           AND h.reminder_time IS NOT NULL
           AND h.reminder_time <= ?
           AND (h.start_date IS NULL OR h.start_date <= ?)
           AND c.id IS NULL`,
      )
      .all(today, userId, currentTime, today) as any[];
    for (const habit of habits) {
      if (!daysOfWeekIncludes(habit.days_of_week, now.getDay())) continue;
      const created = insertNotification(userId, {
        type: 'habit_reminder',
        title: `习惯提醒：${habit.name}`,
        body: '你设置的习惯打卡提醒已到时间。',
        targetType: 'habit_reminder',
        targetId: `${habit.id}:${today}`,
        scheduledAt: localDateTimeISO(today, habit.reminder_time),
        deliveredAt: ts,
      });
      if (created) out.push(created);
    }
  }

  if (notificationSettings.goalReminders) {
    const goals = db
      .prepare(
        `SELECT id, title, deadline_at
         FROM goals
         WHERE user_id = ?
           AND deadline_at IS NOT NULL
           AND deadline_at <= ?
           AND status NOT IN ('completed', 'archived')`,
      )
      .all(userId, ts) as any[];
    for (const goal of goals) {
      const created = insertNotification(userId, {
        type: 'goal_reminder',
        title: `目标提醒：${goal.title}`,
        body: '目标截止时间已到，请检查目标任务进展。',
        targetType: 'goal_reminder',
        targetId: goal.id,
        scheduledAt: goal.deadline_at,
        deliveredAt: ts,
      });
      if (created) out.push(created);
    }
  }

  return { created: out.length, notifications: out };
}

export function searchAll(
  userId: string,
  input: { q: string; types?: string[]; limit?: number },
): SearchResultDTO[] {
  const q = input.q.trim();
  if (!q) return [];
  const allowed = new Set(['tasks', 'lists', 'tags', 'habits', 'countdowns', 'goals']);
  const requested = input.types?.length ? input.types.filter((t) => allowed.has(t)) : [...allowed];
  const typeSet = new Set(requested);
  const like = `%${q}%`;
  const limit = Math.max(1, Math.min(100, input.limit ?? 50));
  const out: SearchResultDTO[] = [];
  const push = (type: SearchResultDTO['type'], id: string, title: string, subtitle: string | null, fields: string[], updatedAt: string) => {
    out.push({ type, id, title, subtitle, matchedFields: fields, updatedAt });
  };
  if (typeSet.has('tasks')) {
    const rows = db
      .prepare(
        `SELECT id, title, note, updated_at FROM tasks
         WHERE user_id = ? AND deleted_at IS NULL AND (title LIKE ? OR note LIKE ?)
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(userId, like, like, limit) as any[];
    for (const r of rows) push('tasks', r.id, r.title, r.note ?? null, [r.title?.includes(q) ? 'title' : 'note'], r.updated_at);
  }
  if (typeSet.has('lists')) {
    const rows = db
      .prepare('SELECT id, name, updated_at FROM lists WHERE user_id = ? AND is_inbox = 0 AND name LIKE ? ORDER BY updated_at DESC LIMIT ?')
      .all(userId, like, limit) as any[];
    for (const r of rows) push('lists', r.id, r.name, null, ['name'], r.updated_at);
  }
  if (typeSet.has('tags')) {
    const rows = db.prepare('SELECT id, name, updated_at FROM tags WHERE user_id = ? AND name LIKE ? ORDER BY updated_at DESC LIMIT ?').all(userId, like, limit) as any[];
    for (const r of rows) push('tags', r.id, r.name, null, ['name'], r.updated_at);
  }
  if (typeSet.has('habits')) {
    const rows = db
      .prepare('SELECT id, name, note, updated_at FROM habits WHERE user_id = ? AND archived = 0 AND (name LIKE ? OR note LIKE ?) ORDER BY updated_at DESC LIMIT ?')
      .all(userId, like, like, limit) as any[];
    for (const r of rows) push('habits', r.id, r.name, r.note ?? null, [r.name?.includes(q) ? 'name' : 'note'], r.updated_at);
  }
  if (typeSet.has('countdowns')) {
    const rows = db
      .prepare('SELECT id, title, note, updated_at FROM countdowns WHERE user_id = ? AND (title LIKE ? OR note LIKE ?) ORDER BY updated_at DESC LIMIT ?')
      .all(userId, like, like, limit) as any[];
    for (const r of rows) push('countdowns', r.id, r.title, r.note ?? null, [r.title?.includes(q) ? 'title' : 'note'], r.updated_at);
  }
  if (typeSet.has('goals')) {
    const rows = db
      .prepare('SELECT id, title, description, updated_at FROM goals WHERE user_id = ? AND (title LIKE ? OR description LIKE ?) ORDER BY updated_at DESC LIMIT ?')
      .all(userId, like, like, limit) as any[];
    for (const r of rows) push('goals', r.id, r.title, r.description ?? null, [r.title?.includes(q) ? 'title' : 'description'], r.updated_at);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}

export function listSavedFilters(userId: string): SavedFilterDTO[] {
  return (
    db.prepare('SELECT * FROM saved_filters WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC').all(userId) as any[]
  ).map(mapSavedFilter);
}

export function createSavedFilter(userId: string, input: { name: string; query: Record<string, unknown>; sortOrder?: number }): SavedFilterDTO {
  const name = input.name.trim();
  if (!name) throw new AppError(400, 'invalid', 'name is required');
  if (!input.query || typeof input.query !== 'object' || Array.isArray(input.query)) {
    throw new AppError(400, 'invalid', 'query must be an object');
  }
  const exists = db.prepare('SELECT id FROM saved_filters WHERE user_id = ? AND name = ?').get(userId, name);
  if (exists) throw new AppError(409, 'conflict', 'filter name already exists');
  const id = randomUUID();
  const ts = nowISO();
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM saved_filters WHERE user_id = ?').get(userId) as { m: number };
  db.prepare(
    `INSERT INTO saved_filters (id, user_id, name, query_json, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, name, JSON.stringify(input.query), input.sortOrder ?? (max.m ?? 0) + 1, ts, ts);
  return mapSavedFilter(db.prepare('SELECT * FROM saved_filters WHERE user_id = ? AND id = ?').get(userId, id));
}

export function updateSavedFilter(userId: string, id: string, patch: Record<string, unknown>): SavedFilterDTO | null {
  const cols: string[] = [];
  const vals: unknown[] = [];
  if ('name' in patch) {
    const name = String(patch.name ?? '').trim();
    if (!name) throw new AppError(400, 'invalid', 'name is required');
    const exists = db.prepare('SELECT id FROM saved_filters WHERE user_id = ? AND name = ? AND id <> ?').get(userId, name, id);
    if (exists) throw new AppError(409, 'conflict', 'filter name already exists');
    cols.push('name = ?');
    vals.push(name);
  }
  if ('query' in patch) {
    if (!patch.query || typeof patch.query !== 'object' || Array.isArray(patch.query)) {
      throw new AppError(400, 'invalid', 'query must be an object');
    }
    cols.push('query_json = ?');
    vals.push(JSON.stringify(patch.query));
  }
  if ('sortOrder' in patch) {
    cols.push('sort_order = ?');
    vals.push(patch.sortOrder ?? 0);
  }
  if (!cols.length) {
    const row = db.prepare('SELECT * FROM saved_filters WHERE user_id = ? AND id = ?').get(userId, id);
    return row ? mapSavedFilter(row) : null;
  }
  cols.push('updated_at = ?');
  vals.push(nowISO(), userId, id);
  const info = db.prepare(`UPDATE saved_filters SET ${cols.join(', ')} WHERE user_id = ? AND id = ?`).run(...(vals as any[]));
  if (info.changes === 0) return null;
  return mapSavedFilter(db.prepare('SELECT * FROM saved_filters WHERE user_id = ? AND id = ?').get(userId, id));
}

export function deleteSavedFilter(userId: string, id: string): boolean {
  return db.prepare('DELETE FROM saved_filters WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
}

function count(where: string, params: unknown[]): number {
  const r = db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE ${where}`).get(...(params as any[])) as { c: number };
  return r.c;
}

export function smartCounts(userId: string): SmartCounts {
  const inboxId = getInboxId(userId);
  return {
    inbox: count("user_id = ? AND list_id = ? AND completed = 0 AND deleted_at IS NULL AND parent_id IS NULL AND status <> 'skipped'", [userId, inboxId]),
    today: count("user_id = ? AND completed = 0 AND deleted_at IS NULL AND parent_id IS NULL AND status <> 'skipped' AND due_date IS NOT NULL AND due_date <= ?", [
      userId,
      endOfTodayISO(),
    ]),
    next7days: count("user_id = ? AND completed = 0 AND deleted_at IS NULL AND parent_id IS NULL AND status <> 'skipped' AND due_date >= ? AND due_date <= ?", [
      userId,
      startOfTodayISO(),
      endOfDayOffsetISO(6),
    ]),
    completed: count('user_id = ? AND completed = 1 AND deleted_at IS NULL AND parent_id IS NULL', [userId]),
    trash: count('user_id = ? AND deleted_at IS NOT NULL AND parent_id IS NULL', [userId]),
  };
}
