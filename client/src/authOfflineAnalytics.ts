export interface AuthOfflineAnalyticsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AuthOfflineEnterProperties extends Record<string, unknown> {
  pending_sync_count: number;
  last_sync_interval: number | null;
}

function browserStorage(): AuthOfflineAnalyticsStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function lastSyncKey(userId: string): string {
  return `efficiency-list.lastSuccessfulSyncAt.${userId}`;
}

function offlineEnterKey(userId: string): string {
  return `efficiency-list.authOfflineEnter.${userId}`;
}

export function recordSuccessfulSyncAt(
  userId: string,
  syncedAt = new Date().toISOString(),
  storage: AuthOfflineAnalyticsStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(lastSyncKey(userId), syncedAt);
  } catch {
    /* ignore storage errors */
  }
}

export function authOfflineEnterProperties(
  userId: string,
  pendingSyncCount: number,
  nowMs = Date.now(),
  storage: AuthOfflineAnalyticsStorage | null = browserStorage(),
): AuthOfflineEnterProperties {
  let lastSyncInterval: number | null = null;
  try {
    const raw = storage?.getItem(lastSyncKey(userId)) ?? null;
    const lastMs = raw ? Date.parse(raw) : Number.NaN;
    if (Number.isFinite(lastMs)) lastSyncInterval = Math.max(0, Math.floor((nowMs - lastMs) / 1000));
  } catch {
    lastSyncInterval = null;
  }
  return {
    pending_sync_count: Math.max(0, pendingSyncCount),
    last_sync_interval: lastSyncInterval,
  };
}

export function queueAuthOfflineEnter(
  userId: string,
  properties: AuthOfflineEnterProperties,
  storage: AuthOfflineAnalyticsStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(offlineEnterKey(userId), JSON.stringify(properties));
  } catch {
    /* ignore storage errors */
  }
}

export function consumeQueuedAuthOfflineEnter(
  userId: string,
  storage: AuthOfflineAnalyticsStorage | null = browserStorage(),
): AuthOfflineEnterProperties | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(offlineEnterKey(userId));
    storage.removeItem(offlineEnterKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthOfflineEnterProperties>;
    if (typeof parsed.pending_sync_count !== 'number') return null;
    return {
      pending_sync_count: Math.max(0, parsed.pending_sync_count),
      last_sync_interval: typeof parsed.last_sync_interval === 'number' ? Math.max(0, parsed.last_sync_interval) : null,
    };
  } catch {
    return null;
  }
}
