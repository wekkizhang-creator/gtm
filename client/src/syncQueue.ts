import { api, type CreateTaskInput, type SyncOperationInput, type SyncOperationResult } from './api/client';

type QueueItem = SyncOperationInput & { lastError?: string | null };

function key(userId: string): string {
  return `efficiency-list.syncQueue.${userId}`;
}

function read(userId: string): QueueItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key(userId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => item?.clientOperationId && item?.entityType === 'task') : [];
  } catch {
    return [];
  }
}

function write(userId: string, items: QueueItem[]): void {
  localStorage.setItem(key(userId), JSON.stringify(items));
}

export function pendingSyncCount(userId: string): number {
  return read(userId).length;
}

export function clearSyncQueue(userId: string): number {
  const count = read(userId).length;
  localStorage.removeItem(key(userId));
  return count;
}

function operationId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function enqueueTaskCreate(userId: string, input: CreateTaskInput): number {
  const items = read(userId);
  items.push({
    clientOperationId: operationId(),
    entityType: 'task',
    action: 'create',
    clientCreatedAt: new Date().toISOString(),
    payload: { ...input, source: input.source ?? 'offline_sync' },
  });
  write(userId, items);
  return items.length;
}

export async function flushSyncQueue(userId: string): Promise<{ results: SyncOperationResult[]; pending: number }> {
  const items = read(userId);
  if (!items.length) return { results: [], pending: 0 };
  const { results } = await api.pushSyncOperations(items);
  const done = new Set(
    results
      .filter((result) => result.status === 'applied' || result.status === 'duplicate')
      .map((result) => result.clientOperationId),
  );
  const byId = new Map(results.map((result) => [result.clientOperationId, result]));
  const pending = items
    .filter((item) => !done.has(item.clientOperationId))
    .map((item) => {
      const result = byId.get(item.clientOperationId);
      return { ...item, lastError: result?.error?.message ?? result?.status ?? null };
    });
  write(userId, pending);
  return { results, pending: pending.length };
}
