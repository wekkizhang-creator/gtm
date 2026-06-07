import type { AccountIdentity } from './types';

export type AuthBindingIdentityType = 'email' | 'phone' | 'oauth';

export function authBindingResultProperties(
  identityType: AuthBindingIdentityType,
  success: boolean,
  failReason?: string | null,
): { identity_type: AuthBindingIdentityType; success: boolean; fail_reason: string | null; conflict_type: string | null } {
  return {
    identity_type: identityType,
    success,
    fail_reason: success ? null : failReason || 'unknown',
    conflict_type: failReason === 'identity_conflict' || failReason === 'email_already_registered' ? 'identifier_occupied' : null,
  };
}

export function authUnbindResultProperties(
  identityType: AuthBindingIdentityType,
  success: boolean,
  remainingIdentityCount: number,
  failReason?: string | null,
): { identity_type: AuthBindingIdentityType; success: boolean; fail_reason: string | null; remaining_identity_count: number } {
  return {
    identity_type: identityType,
    success,
    fail_reason: success ? null : failReason || 'unknown',
    remaining_identity_count: remainingIdentityCount,
  };
}

export function identityTypeForAnalytics(identity: Pick<AccountIdentity, 'type'> | undefined): AuthBindingIdentityType {
  if (!identity) return 'oauth';
  return identity.type === 'phone' || identity.type === 'email' ? identity.type : 'oauth';
}
