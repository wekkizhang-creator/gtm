import { api } from './api/client';
import type { SystemCalendarPermission, SystemCalendarPermissionReason, SystemCalendarPermissionStatus } from './types';

type NativeStatus = SystemCalendarPermissionStatus | 'default';

export type SystemCalendarRuntime = {
  getPermissionStatus?: () => Promise<NativeStatus> | NativeStatus;
  requestReadOnlyAccess: () => Promise<NativeStatus> | NativeStatus;
};

type PermissionApi = {
  updateSystemCalendarPermission: (input: {
    status: SystemCalendarPermissionStatus;
    promptReason?: SystemCalendarPermissionReason;
  }) => Promise<SystemCalendarPermission>;
};

function runtimeFromWindow(): SystemCalendarRuntime | null {
  if (typeof window === 'undefined') return null;
  const maybeWindow = window as Window & { efficiencyListSystemCalendar?: SystemCalendarRuntime };
  return maybeWindow.efficiencyListSystemCalendar ?? null;
}

function normalizeStatus(status: NativeStatus): SystemCalendarPermissionStatus {
  if (status === 'granted' || status === 'denied' || status === 'unsupported') return status;
  return 'unknown';
}

export async function ensureSystemCalendarPermission(
  promptReason: SystemCalendarPermissionReason = 'system_calendar_subscription',
  runtime: SystemCalendarRuntime | null = runtimeFromWindow(),
  permissionApi: PermissionApi = api,
): Promise<SystemCalendarPermission> {
  if (!runtime) return permissionApi.updateSystemCalendarPermission({ status: 'unsupported', promptReason });
  const current = runtime.getPermissionStatus ? normalizeStatus(await runtime.getPermissionStatus()) : 'unknown';
  const status = current === 'unknown' ? normalizeStatus(await runtime.requestReadOnlyAccess()) : current;
  return permissionApi.updateSystemCalendarPermission({ status, promptReason });
}
