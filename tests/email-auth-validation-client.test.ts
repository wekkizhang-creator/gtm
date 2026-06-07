import { EMAIL_FORMAT_ERROR, isValidEmailInput, normalizeEmailInput, validateEmailInput } from '../client/src/emailAuthValidation';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main() {
  assert(normalizeEmailInput('  Wekki@QQ.COM  ') === 'wekki@qq.com', 'email input should trim and normalize casing');
  assert(isValidEmailInput('wekki@qq.com'), 'ordinary mailbox should be valid');
  assert(isValidEmailInput('  name+tag@example.co  '), 'trimmed plus-address mailbox should be valid');
  assert(!isValidEmailInput('not-an-email'), 'missing domain should be invalid');
  assert(!isValidEmailInput('name@example'), 'domain without dot should be invalid');
  assert(!isValidEmailInput('name @example.com'), 'spaces inside email should be invalid');

  const valid = validateEmailInput(' User@Example.COM ');
  assert(valid.ok && valid.email === 'user@example.com', 'valid email should return normalized value');
  const invalid = validateEmailInput('bad-email');
  assert(!invalid.ok && invalid.error === EMAIL_FORMAT_ERROR, 'invalid email should return localized format error');

  console.log('email-auth-validation-client: all assertions passed');
}

main();
