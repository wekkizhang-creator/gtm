import { ensureNotificationPermission } from '../client/src/notificationPermission';
import type { NotificationPermissionPromptReason, NotificationPermissionState, NotificationPermissionStatus } from '../client/src/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function permissionApi(calls: Array<{ status: NotificationPermissionStatus; promptReason?: NotificationPermissionPromptReason }>) {
  return {
    async updateNotificationPermission(input: { status: NotificationPermissionStatus; promptReason?: NotificationPermissionPromptReason }) {
      calls.push(input);
      return {
        permission: 'system-notifications',
        status: input.status,
        promptReason: input.promptReason ?? null,
        lastPromptedAt: input.promptReason ? new Date(0).toISOString() : null,
        updatedAt: new Date(0).toISOString(),
        shouldPrompt: input.status === 'unknown' || input.status === 'default',
        guidance:
          input.status === 'granted'
            ? 'enabled'
            : input.status === 'denied'
              ? 'blocked'
              : input.status === 'unsupported'
                ? 'unsupported'
                : 'request_when_needed',
      } satisfies NotificationPermissionState;
    },
  };
}

async function main() {
  const defaultCalls: Array<{ status: NotificationPermissionStatus; promptReason?: NotificationPermissionPromptReason }> = [];
  let requested = 0;
  const defaultResult = await ensureNotificationPermission(
    'task_reminder',
    {
      permission: 'default',
      requestPermission: async () => {
        requested += 1;
        return 'granted';
      },
    },
    permissionApi(defaultCalls),
  );
  assert(requested === 1, `expected one browser permission request, got ${requested}`);
  assert(defaultResult.status === 'granted', `expected granted after request, got ${defaultResult.status}`);
  assert(defaultCalls[0].promptReason === 'task_reminder', 'task reminder prompt reason was not sent to API');

  const grantedCalls: Array<{ status: NotificationPermissionStatus; promptReason?: NotificationPermissionPromptReason }> = [];
  await ensureNotificationPermission(
    'focus_reminder',
    {
      permission: 'granted',
      requestPermission: async () => {
        throw new Error('requestPermission should not be called for granted status');
      },
    },
    permissionApi(grantedCalls),
  );
  assert(grantedCalls[0].status === 'granted', 'granted browser status should be reported directly');
  assert(grantedCalls[0].promptReason === 'focus_reminder', 'focus reminder prompt reason was not sent to API');

  const unsupportedCalls: Array<{ status: NotificationPermissionStatus; promptReason?: NotificationPermissionPromptReason }> = [];
  const unsupported = await ensureNotificationPermission('habit_reminder', null, permissionApi(unsupportedCalls));
  assert(unsupported.status === 'unsupported', `expected unsupported without browser Notification, got ${unsupported.status}`);
  assert(unsupportedCalls[0].promptReason === 'habit_reminder', 'habit reminder prompt reason was not sent to API');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
