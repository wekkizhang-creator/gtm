import { authMethodSelectProperties, type AuthMethodSelectEntry } from '../client/src/authMethodAnalytics';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main() {
  const entries: AuthMethodSelectEntry[] = ['login_tab', 'register_tab', 'password_reset_tab', 'forgot_password_link'];

  for (const entry of entries) {
    const payload = authMethodSelectProperties(entry);
    assert(payload.method === 'email_password', `${entry} should record the email-password method`);
    assert(payload.entry === entry, `${entry} should preserve the select entry`);
    const keys = Object.keys(payload);
    assert(keys.join('|') === 'method|entry', `method analytics should only include safe keys, got ${keys.join(',')}`);
  }

  const serialized = JSON.stringify(entries.map((entry) => authMethodSelectProperties(entry)));
  assert(!serialized.includes('@'), 'method analytics must not include email addresses');
  assert(!/phone|code|password":|token|secret/i.test(serialized), 'method analytics must not include auth secrets or phone identifiers');

  console.log('auth-method-analytics-client: all assertions passed');
}

main();
