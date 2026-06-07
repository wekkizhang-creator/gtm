export const SESSION_EXPIRED_EVENT = 'efficiency-list:session-expired';

export interface SessionExpiredEventDetail {
  path: string;
  status: number;
  code: string | null;
}

const SESSION_EXPIRED_CODES = new Set(['unauthenticated', 'invalid_refresh_token']);

function isAuthFlowPath(path: string): boolean {
  return path === '/auth/session' || path === '/auth/refresh' || path === '/auth/logout' || path.startsWith('/auth/');
}

export function shouldEmitSessionExpired(path: string, status: number, code?: string | null): boolean {
  if (status !== 401) return false;
  if (!code || !SESSION_EXPIRED_CODES.has(code)) return false;
  return !isAuthFlowPath(path);
}

export function sessionExpiredMessage(code?: string | null): string {
  if (code === 'invalid_refresh_token') return '登录状态已失效，请重新登录。';
  return '登录已过期或已在其他设备被撤销，请重新登录。';
}

export function emitSessionExpired(path: string, status: number, code?: string | null): boolean {
  if (!shouldEmitSessionExpired(path, status, code)) return false;
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return false;
  const detail: SessionExpiredEventDetail = { path, status, code: code ?? null };
  const event =
    typeof CustomEvent === 'function'
      ? new CustomEvent<SessionExpiredEventDetail>(SESSION_EXPIRED_EVENT, { detail })
      : ({ type: SESSION_EXPIRED_EVENT, detail } as CustomEvent<SessionExpiredEventDetail>);
  window.dispatchEvent(event);
  return true;
}
