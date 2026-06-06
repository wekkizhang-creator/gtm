export const TEST_PASSWORD = 'Password123!';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function json(res: Response): Promise<any> {
  const body = await res.text();
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    throw new Error(`invalid JSON ${res.status}: ${body}`);
  }
}

function cookiesFrom(res: Response): string {
  const h: any = res.headers as any;
  const all: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  const joined = all.join(', ');
  const found = joined.match(/el_(?:access|refresh)=[^;,\s]+/g) ?? [];
  assert(found.length >= 2, `expected auth cookies, got ${joined}`);
  return found.join('; ');
}

async function req(base: string, path: string, init: RequestInit = {}): Promise<{ res: Response; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) };
  const res = await fetch(`${base}${path}`, { ...init, headers });
  return { res, body: await json(res) };
}

export async function waitForEmailCode(messages: string[], start: number): Promise<string> {
  for (let i = 0; i < 20 && messages.length === start; i++) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const code = (messages.at(-1) ?? '').match(/\b\d{6}\b/)?.[0];
  assert(code, 'SMTP message did not include a 6-digit code');
  return code;
}

export async function loginByEmailPassword(
  base: string,
  email: string,
  smtpMessages: string[],
  device: { deviceId: string; deviceName?: string; platform?: string; appVersion?: string } = {
    deviceId: `test-${email}`,
    deviceName: 'Integration test',
    platform: 'Web',
    appVersion: 'test',
  },
): Promise<{ cookie: string; userId: string }> {
  const login = await fetch(`${base}/api/auth/login/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: TEST_PASSWORD, device }),
  });
  const loginBody = await json(login);
  if (login.status === 200) return { cookie: cookiesFrom(login), userId: loginBody.user.id };
  if (login.status !== 401 && login.status !== 409) {
    throw new Error(`password login failed before register: ${login.status} ${JSON.stringify(loginBody)}`);
  }

  const codeStart = smtpMessages.length;
  const challenge = await req(base, '/api/auth/register/start', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  assert(challenge.res.status === 201, `registration start failed: ${challenge.res.status} ${JSON.stringify(challenge.body)}`);
  const code = await waitForEmailCode(smtpMessages, codeStart);
  const complete = await fetch(`${base}/api/auth/register/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.body.challengeId,
      code,
      password: TEST_PASSWORD,
      agreedToTerms: true,
      device,
    }),
  });
  const completeBody = await json(complete);
  assert(complete.status === 201 || complete.status === 200, `registration complete failed: ${complete.status} ${JSON.stringify(completeBody)}`);
  return { cookie: cookiesFrom(complete), userId: completeBody.user.id };
}

export async function loginCookie(
  base: string,
  email: string,
  smtpMessages: string[],
  device?: { deviceId: string; deviceName?: string; platform?: string; appVersion?: string },
): Promise<string> {
  return (await loginByEmailPassword(base, email, smtpMessages, device)).cookie;
}
