export const AUTH_OFFLINE_NOTICE = '网络连接不可用，请检查网络后重试。已填写内容会保留。';

export function authOfflineNotice(isOnline: boolean): string | null {
  return isOnline ? null : AUTH_OFFLINE_NOTICE;
}

export function resolveBrowserOnlineStatus(hasWindow: boolean, onlineValue: unknown): boolean {
  if (!hasWindow) return true;
  return typeof onlineValue === 'boolean' ? onlineValue : true;
}

export function browserOnlineStatus(): boolean {
  try {
    return resolveBrowserOnlineStatus(typeof window !== 'undefined', typeof navigator === 'undefined' ? undefined : navigator.onLine);
  } catch {
    return true;
  }
}
