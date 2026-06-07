import { authDeviceListViewProperties, authDeviceLogoutProperties } from '../client/src/authDeviceAnalytics';
import type { AuthSession } from '../client/src/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function session(input: Partial<AuthSession>): AuthSession {
  return {
    id: input.id ?? 'session-1',
    userId: input.userId ?? 'user-1',
    deviceId: input.deviceId ?? 'device-secret',
    deviceName: input.deviceName === undefined ? 'Alice Laptop' : input.deviceName,
    platform: input.platform === undefined ? 'Web' : input.platform,
    appVersion: input.appVersion ?? '0.6.0',
    loginAt: input.loginAt ?? '2030-01-01T00:00:00.000Z',
    lastActiveAt: input.lastActiveAt ?? '2030-01-01T00:00:00.000Z',
    accessTokenExpiresAt: input.accessTokenExpiresAt ?? '2030-01-01T00:10:00.000Z',
    refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? '2030-01-08T00:00:00.000Z',
    isCurrentDevice: input.isCurrentDevice ?? false,
    revokedAt: input.revokedAt ?? null,
  };
}

function main() {
  const sessions = [session({ id: 'a' }), session({ id: 'b', platform: 'Windows' })];
  assert(authDeviceListViewProperties(sessions).device_count === 2, 'device list view should record only the session count');

  const success = authDeviceLogoutProperties(session({ platform: 'Windows', isCurrentDevice: false }), true);
  assert(success.target_platform === 'Windows', 'device logout should record target platform');
  assert(success.is_current_device === false && success.success === true, 'remote device logout success should be recorded');

  const failure = authDeviceLogoutProperties(session({ platform: null, isCurrentDevice: true }), false);
  assert(failure.target_platform === 'unknown', 'missing platform should be normalized');
  assert(failure.is_current_device === true && failure.success === false, 'current-device logout failure shape should be safe');

  const serialized = JSON.stringify([authDeviceListViewProperties(sessions), success, failure]);
  assert(!serialized.includes('device-secret'), 'device analytics must not include device IDs');
  assert(!serialized.includes('Alice Laptop'), 'device analytics must not include device names');

  console.log('auth-device-analytics-client: all assertions passed');
}

main();
