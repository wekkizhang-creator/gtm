export type AuthAgreementType = 'terms' | 'privacy';

export const AUTH_AGREEMENT_ENTRY = 'email_password_register';

export function authAgreementClickProperties(agreementType: AuthAgreementType, entry = AUTH_AGREEMENT_ENTRY): {
  agreement_type: AuthAgreementType;
  entry: string;
} {
  return {
    agreement_type: agreementType,
    entry,
  };
}

export function authAgreementCheckProperties(checked: boolean, entry = AUTH_AGREEMENT_ENTRY): {
  checked: boolean;
  entry: string;
} {
  return {
    checked,
    entry,
  };
}
