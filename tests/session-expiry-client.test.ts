import {
  SESSION_EXPIRED_EVENT,
  emitSessionExpired,
  sessionExpiredMessage,
  shouldEmitSessionExpired,
} from '../client/src/sessionExpiry';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main() {
  assert(shouldEmitSessionExpired('/tasks', 401, 'unauthenticated'), 'authenticated API 401 should emit');
  assert(shouldEmitSessionExpired('/account/sessions', 401, 'unauthenticated'), 'account API 401 should emit');
  assert(!shouldEmitSessionExpired('/tasks', 403, 'unauthenticated'), 'non-401 should not emit');
  assert(!shouldEmitSessionExpired('/tasks', 401, 'invalid_credentials'), 'credential failures should not emit');
  assert(!shouldEmitSessionExpired('/auth/session', 401, 'unauthenticated'), 'session probe should not emit');
  assert(!shouldEmitSessionExpired('/auth/refresh', 401, 'invalid_refresh_token'), 'refresh failure should not recurse');
  assert(!shouldEmitSessionExpired('/auth/login/password', 401, 'invalid_credentials'), 'login failure should not emit');
  assert(sessionExpiredMessage('unauthenticated').includes('重新登录'), 'expired session copy should guide back to login');
  assert(sessionExpiredMessage('invalid_refresh_token').includes('重新登录'), 'invalid refresh copy should guide back to login');

  const previousWindow = (globalThis as { window?: unknown }).window;
  const dispatched: Array<{ type?: string; detail?: unknown }> = [];
  try {
    (globalThis as { window?: unknown }).window = {
      dispatchEvent(event: { type?: string; detail?: unknown }) {
        dispatched.push(event);
        return true;
      },
    };
    assert(emitSessionExpired('/tasks', 401, 'unauthenticated'), 'emit should return true for session-expired API errors');
    assert(dispatched.length === 1, 'one event should be dispatched');
    assert(dispatched[0]?.type === SESSION_EXPIRED_EVENT, 'event type should match');
    const detail = dispatched[0]?.detail as { path?: string; status?: number; code?: string | null };
    assert(detail.path === '/tasks' && detail.status === 401 && detail.code === 'unauthenticated', 'event detail should include backend error context');
    assert(!emitSessionExpired('/auth/session', 401, 'unauthenticated'), 'auth session probe should stay silent');
    assert(dispatched.length === 1, 'silent paths should not dispatch events');
  } finally {
    if (previousWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = previousWindow;
    }
  }

  console.log('session-expiry-client: all assertions passed');
}

main();
