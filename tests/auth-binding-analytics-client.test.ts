import {
  authBindingResultProperties,
  authUnbindResultProperties,
  identityTypeForAnalytics,
} from '../client/src/authBindingAnalytics';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main() {
  const emailSuccess = authBindingResultProperties('email', true);
  assert(emailSuccess.identity_type === 'email' && emailSuccess.success === true, 'email binding success should be recorded');
  assert(emailSuccess.fail_reason === null && emailSuccess.conflict_type === null, 'successful binding should not include failure metadata');

  const conflict = authBindingResultProperties('phone', false, 'identity_conflict');
  assert(conflict.identity_type === 'phone' && conflict.success === false, 'phone binding failure should be recorded');
  assert(conflict.fail_reason === 'identity_conflict', 'binding failure reason should be preserved');
  assert(conflict.conflict_type === 'identifier_occupied', 'identity conflicts should map to occupied identifier conflict type');

  const oauthFailure = authBindingResultProperties('oauth', false);
  assert(oauthFailure.fail_reason === 'unknown', 'missing binding failure reason should normalize to unknown');

  const unbindSuccess = authUnbindResultProperties('oauth', true, 2);
  assert(unbindSuccess.remaining_identity_count === 2 && unbindSuccess.fail_reason === null, 'unbind success should record remaining identity count only');
  const unbindFailure = authUnbindResultProperties('email', false, 1, 'last_identity_required');
  assert(unbindFailure.success === false && unbindFailure.fail_reason === 'last_identity_required', 'unbind failure should preserve failure reason');

  assert(identityTypeForAnalytics({ type: 'email' }) === 'email', 'email identity should stay email');
  assert(identityTypeForAnalytics({ type: 'phone' }) === 'phone', 'phone identity should stay phone');
  assert(identityTypeForAnalytics({ type: 'oauth' }) === 'oauth', 'oauth identity should stay oauth');
  assert(identityTypeForAnalytics(undefined) === 'oauth', 'missing identity should fall back to oauth without exposing identifiers');

  const serialized = JSON.stringify([emailSuccess, conflict, oauthFailure, unbindSuccess, unbindFailure]);
  assert(!serialized.includes('@'), 'binding analytics must not include email addresses');
  assert(!/token|code|password|secret/i.test(serialized), 'binding analytics must not include sensitive auth values');

  console.log('auth-binding-analytics-client: all assertions passed');
}

main();
