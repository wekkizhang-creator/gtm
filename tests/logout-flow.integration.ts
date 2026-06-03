import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const { resolveLogoutFlow } = await import(pathToFileURL(resolve(root, 'client', 'src', 'logoutFlow.ts')).href);
  const userId = 'logout-user';

  const noPending = await resolveLogoutFlow(
    userId,
    { confirmRequired: true },
    {
      pendingCount: () => 0,
      confirm: () => true,
    },
  );
  assert(noPending.shouldLogout === true && noPending.action === 'confirmed', 'no-pending logout should use normal confirmation');

  const cancelNoPending = await resolveLogoutFlow(
    userId,
    { confirmRequired: true },
    {
      pendingCount: () => 0,
      confirm: () => false,
    },
  );
  assert(cancelNoPending.shouldLogout === false && cancelNoPending.action === 'cancel', 'normal confirmation cancel should stop logout');

  let syncCalled = false;
  const synced = await resolveLogoutFlow(
    userId,
    { confirmRequired: true },
    {
      pendingCount: () => 2,
      choosePendingAction: () => 'sync',
      flushPending: async () => {
        syncCalled = true;
        return { pending: 0 };
      },
    },
  );
  assert(syncCalled, 'choosing sync should flush pending operations');
  assert(synced.shouldLogout === true && synced.pendingAfter === 0 && synced.action === 'sync', 'successful sync should allow logout');

  const partialSyncCancel = await resolveLogoutFlow(
    userId,
    { confirmRequired: true },
    {
      pendingCount: () => 3,
      choosePendingAction: () => 'sync',
      flushPending: async () => ({ pending: 1 }),
      confirm: () => false,
    },
  );
  assert(partialSyncCancel.shouldLogout === false && partialSyncCancel.pendingAfter === 1, 'remaining pending operations should allow cancel');

  const continueLogout = await resolveLogoutFlow(
    userId,
    { confirmRequired: true },
    {
      pendingCount: () => 4,
      choosePendingAction: () => 'continue',
      flushPending: async () => {
        throw new Error('should not flush when continuing');
      },
    },
  );
  assert(continueLogout.shouldLogout === true && continueLogout.action === 'continue', 'continue choice should logout without flushing');

  const cancelPending = await resolveLogoutFlow(
    userId,
    { confirmRequired: true },
    {
      pendingCount: () => 4,
      choosePendingAction: () => 'cancel',
    },
  );
  assert(cancelPending.shouldLogout === false && cancelPending.action === 'cancel', 'cancel choice should keep the session');

  const failedSyncContinue = await resolveLogoutFlow(
    userId,
    { confirmRequired: true },
    {
      pendingCount: () => 5,
      choosePendingAction: () => 'sync',
      flushPending: async () => {
        throw new Error('network_unavailable');
      },
      confirm: () => true,
    },
  );
  assert(failedSyncContinue.shouldLogout === true, 'user can continue logout after failed sync');
  assert(failedSyncContinue.action === 'sync_failed' && failedSyncContinue.error === 'network_unavailable', 'failed sync should be reported');

  const forced = await resolveLogoutFlow(
    userId,
    { confirmRequired: false },
    {
      pendingCount: () => 6,
      confirm: () => {
        throw new Error('forced logout should not confirm');
      },
    },
  );
  assert(forced.shouldLogout === true && forced.action === 'forced' && forced.pendingBefore === 6, 'forced logout should bypass prompts');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
