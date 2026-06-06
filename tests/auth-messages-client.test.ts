import { describeAuthError, passwordScore } from '../client/src/authMessages';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function codeError(code: string, message = 'english internal error'): Error & { code?: string } {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

function networkError(): Error & { isNetworkError?: boolean } {
  const err = new Error('network_unavailable') as Error & { isNetworkError?: boolean };
  err.isNetworkError = true;
  return err;
}

function main() {
  // Known backend codes localize to Chinese, never leaking the English server message.
  assert(describeAuthError(codeError('invalid_credentials')) === '邮箱或密码不正确', 'invalid_credentials should localize');
  assert(describeAuthError(codeError('email_already_registered')) === '该邮箱已注册，请直接登录', 'email_already_registered should localize');
  assert(describeAuthError(codeError('code_expired')) === '验证码已过期，请重新获取', 'code_expired should localize');
  assert(describeAuthError(codeError('rate_limited')) === '操作过于频繁，请稍后再试', 'rate_limited should localize');

  // Network failures get a friendly Chinese message instead of the raw 'network_unavailable'.
  assert(describeAuthError(networkError()) === '网络连接不可用，请检查网络后重试', 'network error should localize');

  // Server messages that are already Chinese (e.g. risk control) pass through verbatim,
  // keeping the '账号验证受限' marker the auth screen keys its support link off of.
  const riskMsg = '账号验证受限，请联系 security@example.com 或通过反馈入口申诉';
  assert(describeAuthError(codeError('auth_risk_restricted', riskMsg)) === riskMsg, 'localized server message should pass through');
  assert(describeAuthError(codeError('auth_risk_restricted', riskMsg)).includes('账号验证受限'), 'risk passthrough keeps the UI marker');

  // Unknown codes with an English message fall back to generic Chinese (no English leak to users).
  const unknown = describeAuthError(codeError('some_future_code', 'totally internal english error'));
  assert(unknown === '操作失败，请稍后重试', `unknown code should use generic Chinese, got ${unknown}`);

  // Password strength tiers.
  assert(passwordScore('').level === 0, 'empty password has no strength');
  assert(passwordScore('abc123').level === 1 && passwordScore('abc123').label === '弱', 'short simple password is weak');
  assert(passwordScore('Abcd1234').level === 2 && passwordScore('Abcd1234').label === '中', 'mixed 8-char password is medium');
  assert(passwordScore('Abcd1234!xyz').level === 3 && passwordScore('Abcd1234!xyz').label === '强', 'long varied password is strong');

  console.log('auth-messages-client: all assertions passed');
}

main();
