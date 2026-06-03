import { randomUUID } from 'node:crypto';
import { db, nowISO } from './db';
import * as repo from './repo';
import { AppError, type AccountSyncHealth, type AccountSyncStatusDTO, type SyncOperationResultDTO, type TaskDTO } from './types';

type SyncAction = 'create' | 'update' | 'delete';

const TASK_SYNC_UPDATE_KEYS = new Set([
  'title',
  'note',
  'listId',
  'priority',
  'dueDate',
  'startDate',
  'isAllDay',
  'isImportant',
  'isUrgent',
  'parentId',
  'estimatedMinutes',
  'recurrenceRule',
  'source',
  'manualProgress',
  'plannedStartAt',
  'plannedEndAt',
  'actualStartAt',
  'actualEndAt',
  'dependencyTaskIds',
  'autoScheduleEnabled',
  'isLockedSchedule',
  'pinned',
  'status',
  'completed',
  'sortOrder',
  'subtaskConfig',
]);

interface SyncOperationInput {
  clientOperationId?: unknown;
  entityType?: unknown;
  action?: unknown;
  entityId?: unknown;
  baseUpdatedAt?: unknown;
  clientCreatedAt?: unknown;
  payload?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError(400, 'invalid_sync_operation', `${field} is required`);
  return value.trim();
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function actionValue(value: unknown): SyncAction {
  if (value !== 'create' && value !== 'update' && value !== 'delete') {
    throw new AppError(400, 'invalid_sync_operation', 'action must be create, update, or delete');
  }
  return value;
}

function taskInput(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) throw new AppError(400, 'invalid_sync_operation', 'payload must be an object');
  return payload;
}

function taskPatchPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (TASK_SYNC_UPDATE_KEYS.has(key)) patch[key] = value;
  }
  return patch;
}

function comparable(value: unknown): unknown {
  return value === undefined ? null : value;
}

function equalValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}

function clientWins(clientCreatedAt: string | null, serverUpdatedAt: string): boolean {
  if (!clientCreatedAt) return false;
  const clientTime = Date.parse(clientCreatedAt);
  const serverTime = Date.parse(serverUpdatedAt);
  return Number.isFinite(clientTime) && Number.isFinite(serverTime) && clientTime >= serverTime;
}

function mergeStaleTaskPatch(
  current: TaskDTO,
  payload: Record<string, unknown>,
  clientCreatedAt: string | null,
): { patch: Record<string, unknown>; details: Record<string, unknown> } | null {
  const baseSnapshot = isRecord(payload.baseSnapshot) ? payload.baseSnapshot : null;
  if (!baseSnapshot) return null;

  const patch: Record<string, unknown> = {};
  const mergedFields: string[] = [];
  const clientWonFields: string[] = [];
  const serverKeptFields: string[] = [];
  const shouldClientWin = clientWins(clientCreatedAt, current.updatedAt);

  for (const [key, incomingValue] of Object.entries(taskPatchPayload(payload))) {
    const currentValue = (current as unknown as Record<string, unknown>)[key];
    const baseValue = baseSnapshot[key];
    if (equalValue(currentValue, baseValue)) {
      patch[key] = incomingValue;
      mergedFields.push(key);
    } else if (shouldClientWin) {
      patch[key] = incomingValue;
      clientWonFields.push(key);
    } else {
      serverKeptFields.push(key);
    }
  }

  return {
    patch,
    details: {
      strategy: 'field_merge_lww',
      mergedFields,
      clientWonFields,
      serverKeptFields,
    },
  };
}

function createTaskFromPayload(userId: string, payload: Record<string, unknown>): TaskDTO {
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  if (!title) throw new AppError(400, 'invalid_sync_operation', 'task title is required');
  return repo.createTask(userId, {
    title,
    note: typeof payload.note === 'string' ? payload.note : null,
    listId: nullableString(payload.listId),
    priority: typeof payload.priority === 'number' ? payload.priority : 0,
    dueDate: nullableString(payload.dueDate),
    startDate: nullableString(payload.startDate),
    isAllDay: payload.isAllDay !== false,
    isImportant: typeof payload.isImportant === 'boolean' ? payload.isImportant : null,
    isUrgent: typeof payload.isUrgent === 'boolean' ? payload.isUrgent : null,
    parentId: nullableString(payload.parentId),
    estimatedMinutes: typeof payload.estimatedMinutes === 'number' ? payload.estimatedMinutes : null,
    recurrenceRule: nullableString(payload.recurrenceRule),
    source: typeof payload.source === 'string' ? payload.source : 'offline_sync',
    manualProgress: typeof payload.manualProgress === 'number' ? payload.manualProgress : null,
    pinned: payload.pinned === true,
    status: payload.status as any,
  });
}

function resultFromRow(row: any, duplicate = true): SyncOperationResultDTO {
  const parsed = row.result_json ? JSON.parse(row.result_json) : {};
  return {
    clientOperationId: row.client_operation_id,
    entityType: row.entity_type,
    action: row.action,
    status: duplicate && row.status === 'applied' ? 'duplicate' : row.status,
    entityId: row.entity_id ?? parsed.entityId ?? null,
    task: parsed.task ?? null,
    conflict: parsed.conflict ?? null,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? row.error_code } : parsed.error ?? null,
    appliedAt: row.applied_at ?? null,
  };
}

function recordOperation(input: {
  userId: string;
  clientOperationId: string;
  entityType: 'task';
  entityId: string | null;
  action: SyncAction;
  status: SyncOperationResultDTO['status'];
  baseUpdatedAt: string | null;
  clientCreatedAt: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  error?: { code: string; message: string } | null;
  receivedAt: string;
  appliedAt: string | null;
}): void {
  db.prepare(
    `INSERT INTO sync_operations
       (id, user_id, client_operation_id, entity_type, entity_id, action, status, base_updated_at, client_created_at, payload_json, result_json, error_code, error_message, received_at, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.userId,
    input.clientOperationId,
    input.entityType,
    input.entityId,
    input.action,
    input.status,
    input.baseUpdatedAt,
    input.clientCreatedAt,
    JSON.stringify(input.payload),
    JSON.stringify(input.result),
    input.error?.code ?? null,
    input.error?.message ?? null,
    input.receivedAt,
    input.appliedAt,
  );
}

function applyOne(userId: string, raw: SyncOperationInput): SyncOperationResultDTO {
  const clientOperationId = stringValue(raw.clientOperationId, 'clientOperationId');
  const existing = db.prepare('SELECT * FROM sync_operations WHERE user_id = ? AND client_operation_id = ?').get(userId, clientOperationId);
  if (existing) return resultFromRow(existing);

  if (raw.entityType !== 'task') throw new AppError(400, 'invalid_sync_operation', 'only task sync operations are supported');
  const action = actionValue(raw.action);
  const entityId = nullableString(raw.entityId);
  const baseUpdatedAt = nullableString(raw.baseUpdatedAt);
  const clientCreatedAt = nullableString(raw.clientCreatedAt);
  const payload = taskInput(raw.payload ?? {});
  const receivedAt = nowISO();

  try {
    let task: TaskDTO | null = null;
    let status: SyncOperationResultDTO['status'] = 'applied';
    let result: Record<string, unknown> = {};
    let finalEntityId = entityId;
    if (action === 'create') {
      task = createTaskFromPayload(userId, payload);
      finalEntityId = task.id;
      result = { entityId: task.id, task };
    } else {
      if (!entityId) throw new AppError(400, 'invalid_sync_operation', 'entityId is required');
      const current = repo.getTask(userId, entityId);
      if (!current) throw new AppError(404, 'not_found', 'task not found');
      if (baseUpdatedAt && current.updatedAt !== baseUpdatedAt) {
        if (action !== 'update') {
          status = 'conflict';
          result = { entityId, task: null, conflict: { serverTask: current, baseUpdatedAt } };
        } else {
          const merged = mergeStaleTaskPatch(current, payload, clientCreatedAt);
          if (!merged) {
            status = 'conflict';
            result = { entityId, task: null, conflict: { serverTask: current, baseUpdatedAt } };
          } else {
            task = Object.keys(merged.patch).length ? repo.updateTask(userId, entityId, merged.patch) : current;
            if (!task) throw new AppError(404, 'not_found', 'task not found');
            result = { entityId, task, merge: merged.details };
          }
        }
      } else if (action === 'update') {
        task = repo.updateTask(userId, entityId, taskPatchPayload(payload));
        if (!task) throw new AppError(404, 'not_found', 'task not found');
        result = { entityId, task };
      } else {
        repo.softDeleteTask(userId, entityId);
        task = repo.getTask(userId, entityId);
        result = { entityId, task };
      }
    }
    const appliedAt = status === 'applied' ? nowISO() : null;
    recordOperation({
      userId,
      clientOperationId,
      entityType: 'task',
      entityId: finalEntityId,
      action,
      status,
      baseUpdatedAt,
      clientCreatedAt,
      payload,
      result,
      receivedAt,
      appliedAt,
    });
    return {
      clientOperationId,
      entityType: 'task',
      action,
      status,
      entityId: finalEntityId,
      task: task ?? null,
      conflict: (result.conflict as SyncOperationResultDTO['conflict']) ?? null,
      error: null,
      appliedAt,
    };
  } catch (err) {
    const code = err instanceof AppError ? err.code : 'internal';
    const message = err instanceof Error ? err.message : String(err);
    recordOperation({
      userId,
      clientOperationId,
      entityType: 'task',
      entityId,
      action,
      status: 'failed',
      baseUpdatedAt,
      clientCreatedAt,
      payload,
      result: { entityId, error: { code, message } },
      error: { code, message },
      receivedAt,
      appliedAt: null,
    });
    return {
      clientOperationId,
      entityType: 'task',
      action,
      status: 'failed',
      entityId,
      task: null,
      conflict: null,
      error: { code, message },
      appliedAt: null,
    };
  }
}

export function applyOperations(userId: string, input: unknown): { results: SyncOperationResultDTO[] } {
  const operations = isRecord(input) && Array.isArray(input.operations) ? input.operations : [];
  if (!operations.length || operations.length > 50) {
    throw new AppError(400, 'invalid_sync_operation', 'operations must contain 1-50 items');
  }
  const results: SyncOperationResultDTO[] = [];
  db.exec('BEGIN');
  try {
    for (const raw of operations) results.push(applyOne(userId, raw as SyncOperationInput));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { results };
}

function healthFor(status: string | null): AccountSyncHealth {
  if (!status) return 'never_synced';
  if (status === 'applied') return 'synced';
  if (status === 'conflict') return 'conflict';
  return 'failed';
}

export function accountSyncStatus(userId: string): AccountSyncStatusDTO {
  const last = db
    .prepare(
      `SELECT client_operation_id, entity_type, entity_id, action, status, error_code, error_message, received_at, applied_at
       FROM sync_operations
       WHERE user_id = ?
       ORDER BY received_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(userId) as
    | {
        client_operation_id: string;
        entity_type: 'task';
        entity_id: string | null;
        action: 'create' | 'update' | 'delete';
        status: Exclude<SyncOperationResultDTO['status'], 'duplicate'>;
        error_code: string | null;
        error_message: string | null;
        received_at: string;
        applied_at: string | null;
      }
    | undefined;
  const lastSuccess = db
    .prepare("SELECT MAX(applied_at) AS value FROM sync_operations WHERE user_id = ? AND status = 'applied'")
    .get(userId) as { value: string | null };
  const rows = db
    .prepare("SELECT status, COUNT(*) AS count FROM sync_operations WHERE user_id = ? AND status IN ('applied', 'conflict', 'failed') GROUP BY status")
    .all(userId) as { status: 'applied' | 'conflict' | 'failed'; count: number }[];
  const statusCounts = { applied: 0, conflict: 0, failed: 0 };
  for (const row of rows) statusCounts[row.status] = row.count;
  return {
    health: healthFor(last?.status ?? null),
    lastSyncAt: last?.received_at ?? null,
    lastSuccessfulSyncAt: lastSuccess.value ?? null,
    pendingServerOperationCount: statusCounts.conflict + statusCounts.failed,
    statusCounts,
    lastOperation: last
      ? {
          clientOperationId: last.client_operation_id,
          entityType: last.entity_type,
          action: last.action,
          status: last.status,
          entityId: last.entity_id,
          error: last.error_code ? { code: last.error_code, message: last.error_message ?? last.error_code } : null,
          receivedAt: last.received_at,
          appliedAt: last.applied_at,
        }
      : null,
  };
}
