export type LoginMethod = 'email_password';

export interface LoginMemory {
  method: LoginMethod | null;
  maskedEmail: string | null;
}

export interface LoginMemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const LOGIN_MEMORY_KEYS = {
  legacyEmail: 'el_last_email',
  method: 'el_last_login_method',
  emailMasked: 'el_last_email_masked',
} as const;

export function maskRememberedEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  const [name, domain] = normalized.split('@');
  if (!name || !domain || normalized.split('@').length !== 2) return null;
  const visible = name.slice(0, Math.min(2, name.length));
  return `${visible}${'*'.repeat(Math.max(2, name.length - visible.length))}@${domain}`;
}

function emptyMemory(): LoginMemory {
  return { method: null, maskedEmail: null };
}

function browserStorage(): LoginMemoryStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readLoginMemory(storage: LoginMemoryStorage | null = browserStorage()): LoginMemory {
  if (!storage) return emptyMemory();
  try {
    const legacyEmail = storage.getItem(LOGIN_MEMORY_KEYS.legacyEmail);
    if (legacyEmail) {
      const masked = maskRememberedEmail(legacyEmail);
      storage.removeItem(LOGIN_MEMORY_KEYS.legacyEmail);
      storage.setItem(LOGIN_MEMORY_KEYS.method, 'email_password');
      if (masked) storage.setItem(LOGIN_MEMORY_KEYS.emailMasked, masked);
      return { method: 'email_password', maskedEmail: masked };
    }
    const method = storage.getItem(LOGIN_MEMORY_KEYS.method);
    if (method !== 'email_password') return emptyMemory();
    const maskedEmail = storage.getItem(LOGIN_MEMORY_KEYS.emailMasked);
    return { method, maskedEmail: maskedEmail || null };
  } catch {
    return emptyMemory();
  }
}

export function rememberEmailLogin(email: string, storage: LoginMemoryStorage | null = browserStorage()): LoginMemory {
  const maskedEmail = maskRememberedEmail(email);
  if (!storage) return { method: 'email_password', maskedEmail };
  try {
    storage.removeItem(LOGIN_MEMORY_KEYS.legacyEmail);
    storage.setItem(LOGIN_MEMORY_KEYS.method, 'email_password');
    if (maskedEmail) storage.setItem(LOGIN_MEMORY_KEYS.emailMasked, maskedEmail);
    else storage.removeItem(LOGIN_MEMORY_KEYS.emailMasked);
  } catch {
    /* ignore storage errors (private mode etc.) */
  }
  return { method: 'email_password', maskedEmail };
}
