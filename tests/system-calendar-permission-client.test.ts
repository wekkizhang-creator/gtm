import { ensureSystemCalendarPermission, type SystemCalendarRuntime } from '../client/src/systemCalendarPermission';
import type { SystemCalendarPermission, SystemCalendarPermissionReason, SystemCalendarPermissionStatus } from '../client/src/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function permissionApi(calls: Array<{ status: SystemCalendarPermissionStatus; promptReason?: SystemCalendarPermissionReason }>) {
  return {
    async updateSystemCalendarPermission(input: { status: SystemCalendarPermissionStatus; promptReason?: SystemCalendarPermissionReason }) {
      calls.push(input);
      return {
        permission: 'system-calendar-readonly',
        status: input.status,
        promptReason: input.promptReason ?? null,
        lastPromptedAt: input.promptReason ? new Date(0).toISOString() : null,
        updatedAt: new Date(0).toISOString(),
        shouldPrompt: input.status === 'unknown',
        guidance:
          input.status === 'granted'
            ? 'enabled'
            : input.status === 'denied'
              ? 'blocked'
              : input.status === 'unsupported'
                ? 'unsupported'
                : 'request_when_needed',
      } satisfies SystemCalendarPermission;
    },
  };
}

async function main() {
  const unsupportedCalls: Array<{ status: SystemCalendarPermissionStatus; promptReason?: SystemCalendarPermissionReason }> = [];
  const unsupported = await ensureSystemCalendarPermission('system_calendar_subscription', null, permissionApi(unsupportedCalls));
  assert(unsupported.status === 'unsupported', `expected unsupported without native bridge, got ${unsupported.status}`);
  assert(unsupportedCalls[0].promptReason === 'system_calendar_subscription', 'unsupported status should include prompt reason');

  const requestCalls: Array<{ status: SystemCalendarPermissionStatus; promptReason?: SystemCalendarPermissionReason }> = [];
  let requested = 0;
  const runtime: SystemCalendarRuntime = {
    getPermissionStatus: () => 'unknown',
    requestReadOnlyAccess: async () => {
      requested += 1;
      return 'granted';
    },
  };
  const granted = await ensureSystemCalendarPermission('system_calendar_subscription', runtime, permissionApi(requestCalls));
  assert(requested === 1, `expected one native permission request, got ${requested}`);
  assert(granted.status === 'granted', `expected granted after request, got ${granted.status}`);

  const deniedCalls: Array<{ status: SystemCalendarPermissionStatus; promptReason?: SystemCalendarPermissionReason }> = [];
  await ensureSystemCalendarPermission(
    'system_calendar_subscription',
    {
      getPermissionStatus: () => 'denied',
      requestReadOnlyAccess: () => {
        throw new Error('requestReadOnlyAccess should not be called after denied status');
      },
    },
    permissionApi(deniedCalls),
  );
  assert(deniedCalls[0].status === 'denied', 'denied native status should be reported directly');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
