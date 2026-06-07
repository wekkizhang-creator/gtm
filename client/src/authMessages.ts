// Auth copy helpers. Kept dependency-free (no React, no api/client) so they can be
// unit-tested directly under Node/tsx like the other *-client tests.

// Mirrors api/client.isNetworkError without importing the client module (which reads
// import.meta.env and is not loadable outside Vite).
function isNetworkError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { isNetworkError?: boolean }).isNetworkError === true;
}

// Map backend error codes to friendly Chinese copy. Server messages are English;
// surfacing them raw to users is a UX defect for a Chinese product.
export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: '邮箱或密码不正确',
  email_already_registered: '该邮箱已注册，请直接登录',
  email_not_registered: '该邮箱尚未注册，请先注册',
  password_not_set: '该邮箱尚未设置密码，请用“忘记密码”设置后登录',
  password_login_locked: '密码错误次数过多，账号已临时锁定，请稍后再试或重置密码',
  invalid_password: '密码需为 8 到 128 个字符',
  invalid_code: '验证码不正确，请重新输入',
  verification_code_locked: '验证码错误次数过多，请稍后重新获取或重试',
  code_expired: '验证码已过期，请重新获取',
  rate_limited: '操作过于频繁，请稍后再试',
  invalid_identifier: '邮箱格式不正确',
  terms_required: '请先同意用户协议与隐私政策',
  account_restricted: '账号状态异常，暂时无法登录',
  account_not_deleting: '账号当前不在注销流程中',
  auth_delivery_not_configured: '验证码服务暂未配置，请稍后再试或联系客服',
};

export function describeAuthError(err: unknown): string {
  if (isNetworkError(err)) return '网络连接不可用，请检查网络后重试';
  const code = (err as { code?: string }).code;
  if (code && AUTH_ERROR_MESSAGES[code]) return AUTH_ERROR_MESSAGES[code];
  const message = err instanceof Error ? err.message : String(err);
  // Pass through server messages that are already localized (e.g. risk control).
  if (/[一-龥]/.test(message)) return message;
  return '操作失败，请稍后重试';
}

export function passwordScore(pw: string): { level: 0 | 1 | 2 | 3; label: string } {
  if (!pw) return { level: 0, label: '' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const level = score <= 2 ? 1 : score === 3 ? 2 : 3;
  return { level, label: level === 1 ? '弱' : level === 2 ? '中' : '强' };
}
