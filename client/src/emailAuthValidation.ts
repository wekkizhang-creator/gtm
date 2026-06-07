export const EMAIL_FORMAT_ERROR = '邮箱格式不正确';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmailInput(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmailInput(value: string): boolean {
  return EMAIL_RE.test(normalizeEmailInput(value));
}

export function validateEmailInput(value: string): { ok: true; email: string } | { ok: false; error: string } {
  const email = normalizeEmailInput(value);
  if (!EMAIL_RE.test(email)) return { ok: false, error: EMAIL_FORMAT_ERROR };
  return { ok: true, email };
}
