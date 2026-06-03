import { flushSyncQueue, pendingSyncCount } from './syncQueue';

export type PendingLogoutAction = 'sync' | 'continue' | 'cancel';

export interface LogoutFlowResult {
  shouldLogout: boolean;
  pendingBefore: number;
  pendingAfter: number;
  action: 'confirmed' | PendingLogoutAction | 'sync_failed' | 'forced';
  error?: string | null;
}

interface LogoutFlowDeps {
  pendingCount?: (userId: string) => number;
  flushPending?: (userId: string) => Promise<{ pending: number }>;
  confirm?: (message: string) => boolean;
  choosePendingAction?: (count: number) => PendingLogoutAction;
}

function defaultConfirm(message: string): boolean {
  return window.confirm(message);
}

export function defaultPendingLogoutAction(count: number): PendingLogoutAction {
  const choice = window.prompt(
    `仍有 ${count} 条未同步内容。输入 1 立即同步，输入 2 继续退出，输入 3 取消。`,
    '1',
  );
  if (choice === null) return 'cancel';
  const normalized = choice.trim().toLowerCase();
  if (normalized === '1' || normalized === 'sync' || normalized.includes('同步')) return 'sync';
  if (normalized === '2' || normalized === 'exit' || normalized.includes('退出') || normalized.includes('继续')) return 'continue';
  return 'cancel';
}

export async function resolveLogoutFlow(
  userId: string,
  options: { confirmRequired?: boolean } = {},
  deps: LogoutFlowDeps = {},
): Promise<LogoutFlowResult> {
  const pendingCount = deps.pendingCount ?? pendingSyncCount;
  const confirm = deps.confirm ?? defaultConfirm;
  const choosePendingAction = deps.choosePendingAction ?? defaultPendingLogoutAction;
  const flushPending = deps.flushPending ?? flushSyncQueue;
  const confirmRequired = options.confirmRequired !== false;
  const pendingBefore = pendingCount(userId);

  if (!confirmRequired) {
    return { shouldLogout: true, pendingBefore, pendingAfter: pendingBefore, action: 'forced' };
  }

  if (pendingBefore <= 0) {
    const shouldLogout = confirm('确认退出登录？');
    return { shouldLogout, pendingBefore, pendingAfter: pendingBefore, action: shouldLogout ? 'confirmed' : 'cancel' };
  }

  const action = choosePendingAction(pendingBefore);
  if (action === 'cancel') return { shouldLogout: false, pendingBefore, pendingAfter: pendingBefore, action };
  if (action === 'continue') return { shouldLogout: true, pendingBefore, pendingAfter: pendingBefore, action };

  try {
    const flushed = await flushPending(userId);
    if (flushed.pending <= 0) {
      return { shouldLogout: true, pendingBefore, pendingAfter: 0, action: 'sync' };
    }
    const shouldLogout = confirm(`仍有 ${flushed.pending} 条未同步内容没有完成。继续退出？`);
    return { shouldLogout, pendingBefore, pendingAfter: flushed.pending, action: shouldLogout ? 'continue' : 'cancel' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const shouldLogout = confirm(`立即同步失败：${message}。继续退出？`);
    return { shouldLogout, pendingBefore, pendingAfter: pendingCount(userId), action: shouldLogout ? 'sync_failed' : 'cancel', error: message };
  }
}
