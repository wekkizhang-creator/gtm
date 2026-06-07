import {
  authOfflineEnterProperties,
  consumeQueuedAuthOfflineEnter,
  queueAuthOfflineEnter,
  recordSuccessfulSyncAt,
  type AuthOfflineAnalyticsStorage,
} from '../client/src/authOfflineAnalytics';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function memoryStorage(seed: Record<string, string> = {}): AuthOfflineAnalyticsStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
  };
}

function main() {
  const storage = memoryStorage();
  const noSync = authOfflineEnterProperties('user-1', 3, Date.parse('2030-01-01T00:00:00.000Z'), storage);
  assert(noSync.pending_sync_count === 3, 'offline enter should record pending sync count');
  assert(noSync.last_sync_interval === null, 'missing successful sync time should produce null interval');

  recordSuccessfulSyncAt('user-1', '2030-01-01T00:00:00.000Z', storage);
  const afterSync = authOfflineEnterProperties('user-1', -2, Date.parse('2030-01-01T00:01:30.000Z'), storage);
  assert(afterSync.pending_sync_count === 0, 'negative pending count should normalize to zero');
  assert(afterSync.last_sync_interval === 90, 'last sync interval should be seconds since successful sync');

  queueAuthOfflineEnter('user-1', { pending_sync_count: 4, last_sync_interval: 120 }, storage);
  const consumed = consumeQueuedAuthOfflineEnter('user-1', storage);
  assert(consumed?.pending_sync_count === 4 && consumed.last_sync_interval === 120, 'queued offline event should be consumed');
  assert(consumeQueuedAuthOfflineEnter('user-1', storage) === null, 'queued offline event should be removed after consumption');

  const serialized = JSON.stringify([noSync, afterSync, consumed]);
  assert(!serialized.includes('@'), 'offline analytics must not include identifiers');
  assert(!/token|code|password|secret/i.test(serialized), 'offline analytics must not include auth secrets');

  console.log('auth-offline-analytics-client: all assertions passed');
}

main();
