import {
  authDeleteAccountCancelProperties,
  authDeleteAccountConfirmProperties,
  authDeleteAccountStartProperties,
  authDeleteAccountVerifyProperties,
} from '../client/src/authDeletionAnalytics';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main() {
  const start = authDeleteAccountStartProperties();
  assert(start.entry === 'settings', 'delete-account start should default to settings entry');

  const verifySuccess = authDeleteAccountVerifyProperties('email', true);
  assert(verifySuccess.method === 'email' && verifySuccess.success === true, 'verify success should record method and success');
  assert(verifySuccess.fail_reason === null, 'verify success should not include failure reason');
  const verifyFailure = authDeleteAccountVerifyProperties('email', false, 'invalid_code');
  assert(verifyFailure.fail_reason === 'invalid_code', 'verify failure should preserve failure reason');

  const confirm = authDeleteAccountConfirmProperties(true, 7);
  assert(confirm.has_export_prompt === true && confirm.cooling_period_days === 7, 'confirm should record export prompt and cooling period');

  const cancel = authDeleteAccountCancelProperties('2030-01-01T00:00:00.000Z', Date.parse('2030-01-04T12:00:00.000Z'));
  assert(cancel.days_since_request === 3, 'cancel should floor elapsed cooling-period days');
  assert(authDeleteAccountCancelProperties(null).days_since_request === null, 'missing request time should stay null');
  assert(authDeleteAccountCancelProperties('not-a-date').days_since_request === null, 'invalid request time should stay null');

  const serialized = JSON.stringify([start, verifySuccess, verifyFailure, confirm, cancel]);
  assert(!serialized.includes('@'), 'delete-account analytics must not include email addresses');
  assert(!/token|password|secret/i.test(serialized), 'delete-account analytics must not include auth secrets');

  console.log('auth-deletion-analytics-client: all assertions passed');
}

main();
