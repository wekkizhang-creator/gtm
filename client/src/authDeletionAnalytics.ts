export function authDeleteAccountStartProperties(entry = 'settings'): { entry: string } {
  return { entry };
}

export function authDeleteAccountVerifyProperties(
  method: 'email' | 'phone' | 'oauth',
  success: boolean,
  failReason?: string | null,
): { method: 'email' | 'phone' | 'oauth'; success: boolean; fail_reason: string | null } {
  return {
    method,
    success,
    fail_reason: success ? null : failReason || 'unknown',
  };
}

export function authDeleteAccountConfirmProperties(
  hasExportPrompt: boolean,
  coolingPeriodDays: number,
): { has_export_prompt: boolean; cooling_period_days: number } {
  return {
    has_export_prompt: hasExportPrompt,
    cooling_period_days: coolingPeriodDays,
  };
}

export function authDeleteAccountCancelProperties(
  deleteRequestedAt: string | null,
  nowMs = Date.now(),
): { days_since_request: number | null } {
  if (!deleteRequestedAt) return { days_since_request: null };
  const requestedMs = Date.parse(deleteRequestedAt);
  if (!Number.isFinite(requestedMs)) return { days_since_request: null };
  const elapsedDays = Math.max(0, Math.floor((nowMs - requestedMs) / 86_400_000));
  return { days_since_request: elapsedDays };
}
