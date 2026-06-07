export type AuthMethodSelectEntry = 'login_tab' | 'register_tab' | 'password_reset_tab' | 'forgot_password_link';

export interface AuthMethodSelectProperties extends Record<string, unknown> {
  method: 'email_password';
  entry: AuthMethodSelectEntry;
}

export function authMethodSelectProperties(entry: AuthMethodSelectEntry): AuthMethodSelectProperties {
  return {
    method: 'email_password',
    entry,
  };
}
