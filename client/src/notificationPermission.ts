import { api } from './api/client';
import type { NotificationPermissionPromptReason, NotificationPermissionState, NotificationPermissionStatus } from './types';

type BrowserNotificationRuntime = {
  permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission> | NotificationPermission;
};

type PermissionApi = {
  updateNotificationPermission: (input: {
    status: NotificationPermissionStatus;
    promptReason?: NotificationPermissionPromptReason;
  }) => Promise<NotificationPermissionState>;
};

function browserNotification(): BrowserNotificationRuntime | null {
  if (typeof window === 'undefined' || !('Notification' in window)) return null;
  return window.Notification;
}

function normalizeStatus(status: NotificationPermission | NotificationPermissionStatus): NotificationPermissionStatus {
  return status === 'granted' || status === 'denied' || status === 'default' ? status : 'unknown';
}

export async function ensureNotificationPermission(
  promptReason: NotificationPermissionPromptReason,
  runtime: BrowserNotificationRuntime | null = browserNotification(),
  permissionApi: PermissionApi = api,
): Promise<NotificationPermissionState> {
  if (!runtime) {
    return permissionApi.updateNotificationPermission({ status: 'unsupported', promptReason });
  }
  let status = normalizeStatus(runtime.permission);
  if (status === 'default') {
    status = normalizeStatus(await runtime.requestPermission());
  }
  return permissionApi.updateNotificationPermission({ status, promptReason });
}
