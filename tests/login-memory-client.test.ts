import { LOGIN_MEMORY_KEYS, maskRememberedEmail, readLoginMemory, rememberEmailLogin, type LoginMemoryStorage } from '../client/src/loginMemory';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function memoryStorage(seed: Record<string, string> = {}): LoginMemoryStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
  };
}

function main() {
  assert(maskRememberedEmail('Wekki@qq.com') === 'we***@qq.com', 'email mask should normalize and hide the local part');
  assert(maskRememberedEmail('a@example.com') === 'a**@example.com', 'short local parts should still be masked');
  assert(maskRememberedEmail('not-an-email') === null, 'invalid email should not be remembered as a display hint');

  const storage = memoryStorage();
  const remembered = rememberEmailLogin('alice@example.com', storage);
  assert(remembered.method === 'email_password' && remembered.maskedEmail === 'al***@example.com', 'remembered login should return masked email');
  assert(storage.getItem(LOGIN_MEMORY_KEYS.legacyEmail) === null, 'legacy raw email key should not be written');
  assert(storage.getItem(LOGIN_MEMORY_KEYS.method) === 'email_password', 'login method should be remembered');
  assert(storage.getItem(LOGIN_MEMORY_KEYS.emailMasked) === 'al***@example.com', 'only masked email should be persisted');

  const loaded = readLoginMemory(storage);
  assert(loaded.method === 'email_password' && loaded.maskedEmail === 'al***@example.com', 'stored memory should be readable');

  const legacy = memoryStorage({ [LOGIN_MEMORY_KEYS.legacyEmail]: 'legacy.user@example.com' });
  const migrated = readLoginMemory(legacy);
  assert(migrated.method === 'email_password' && migrated.maskedEmail === 'le*********@example.com', 'legacy raw email should migrate to a masked hint');
  assert(legacy.getItem(LOGIN_MEMORY_KEYS.legacyEmail) === null, 'legacy raw email should be removed during migration');
  assert(legacy.getItem(LOGIN_MEMORY_KEYS.emailMasked) === 'le*********@example.com', 'migration should persist only masked email');

  console.log('login-memory-client: all assertions passed');
}

main();
