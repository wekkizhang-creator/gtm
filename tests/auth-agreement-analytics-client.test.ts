import { AUTH_AGREEMENT_ENTRY, authAgreementCheckProperties, authAgreementClickProperties } from '../client/src/authAgreementAnalytics';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main() {
  const terms = authAgreementClickProperties('terms');
  assert(terms.agreement_type === 'terms', 'terms click should record agreement_type=terms');
  assert(terms.entry === AUTH_AGREEMENT_ENTRY, 'terms click should use the registration entry');

  const privacy = authAgreementClickProperties('privacy', 'settings_account');
  assert(privacy.agreement_type === 'privacy', 'privacy click should record agreement_type=privacy');
  assert(privacy.entry === 'settings_account', 'custom entry should be preserved');

  const checked = authAgreementCheckProperties(true);
  assert(checked.checked === true, 'checked agreement should record checked=true');
  assert(checked.entry === AUTH_AGREEMENT_ENTRY, 'checked agreement should use the registration entry');
  const unchecked = authAgreementCheckProperties(false, 'register_modal');
  assert(unchecked.checked === false, 'unchecked agreement should record checked=false');
  assert(unchecked.entry === 'register_modal', 'custom check entry should be preserved');

  const serialized = JSON.stringify([terms, privacy, checked, unchecked]);
  assert(!serialized.includes('@'), 'agreement analytics must not include email addresses');
  for (const payload of [terms, privacy]) {
    const keys = Object.keys(payload);
    assert(keys.join('|') === 'agreement_type|entry', `agreement analytics should only include safe keys, got ${keys.join(',')}`);
    assert(!('code' in payload) && !('password' in payload) && !('token' in payload) && !('secret' in payload), 'agreement analytics must not include sensitive auth fields');
  }
  for (const payload of [checked, unchecked]) {
    const keys = Object.keys(payload);
    assert(keys.join('|') === 'checked|entry', `agreement check analytics should only include safe keys, got ${keys.join(',')}`);
    assert(!('code' in payload) && !('password' in payload) && !('token' in payload) && !('secret' in payload), 'agreement check analytics must not include sensitive auth fields');
  }

  console.log('auth-agreement-analytics-client: all assertions passed');
}

main();
