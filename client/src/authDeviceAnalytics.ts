import type { AuthSession } from './types';

export function authDeviceListViewProperties(sessions: Pick<AuthSession, 'id'>[]): { device_count: number } {
  return { device_count: sessions.length };
}

export function authDeviceLogoutProperties(
  session: Pick<AuthSession, 'platform' | 'isCurrentDevice'>,
  success: boolean,
): { target_platform: string; is_current_device: boolean; success: boolean } {
  return {
    target_platform: session.platform || 'unknown',
    is_current_device: session.isCurrentDevice,
    success,
  };
}
