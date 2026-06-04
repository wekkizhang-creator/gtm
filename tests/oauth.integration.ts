import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import http from 'node:http';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => resolvePromise(typeof addr === 'object' && addr ? addr.port : 0));
    });
    s.on('error', reject);
  });
}

async function startSmtp(): Promise<{ port: number; messages: string[]; close: () => Promise<void> }> {
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    let mode: 'line' | 'data' = 'line';
    let data = '';
    socket.write('220 test.smtp.local ESMTP\r\n');
    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (mode === 'data') {
        data += text;
        if (data.includes('\r\n.\r\n')) {
          messages.push(data.slice(0, data.indexOf('\r\n.\r\n')));
          data = '';
          mode = 'line';
          socket.write('250 queued\r\n');
        }
        return;
      }
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) socket.write('250-test\r\n250 AUTH PLAIN\r\n');
        else if (cmd.startsWith('MAIL FROM')) socket.write('250 sender ok\r\n');
        else if (cmd.startsWith('RCPT TO')) socket.write('250 recipient ok\r\n');
        else if (cmd === 'DATA') {
          mode = 'data';
          socket.write('354 end with dot\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('250 ok\r\n');
      }
    });
  });
  const port = await new Promise<number>((resolvePromise, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolvePromise(typeof addr === 'object' && addr ? addr.port : 0);
    });
    server.on('error', reject);
  });
  return { port, messages, close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())) };
}

async function startOAuthProvider(): Promise<{
  userInfoUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  requests: string[];
  tokenRequests: URLSearchParams[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const profiles: Record<string, unknown> = {
    'token-alice': { sub: 'alice-sub', email: 'oauth-alice@example.com', name: 'OAuth Alice' },
    'token-bound': { sub: 'bound-sub', email: 'bound-oauth@example.com', name: 'Bound OAuth' },
    'token-code': { sub: 'code-sub', email: 'oauth-code@example.com', name: 'OAuth Code' },
    'token-bind-code': { sub: 'bind-code-sub', email: 'oauth-bind-code@example.com', name: 'OAuth Bind Code' },
  };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/token') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        tokenRequests.push(params);
        const code = params.get('code');
        const redirectUri = params.get('redirect_uri');
        const accessToken =
          code === 'valid-code' && redirectUri === 'http://127.0.0.1/oauth/callback'
            ? 'token-code'
            : code === 'bind-code' && redirectUri === 'http://127.0.0.1/account/oauth/callback'
              ? 'token-bind-code'
              : null;
        const valid =
          params.get('grant_type') === 'authorization_code' &&
          !!accessToken &&
          params.get('client_id') === 'oauth-test-client' &&
          params.get('client_secret') === 'oauth-test-secret' &&
          (params.get('code_verifier') ?? '').length >= 32;
        if (!valid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_request' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: accessToken, token_type: 'Bearer' }));
      });
      return;
    }
    requests.push(req.headers.authorization ?? '');
    if (req.method === 'GET' && req.url?.startsWith('/authorize')) {
      res.writeHead(204);
      res.end();
      return;
    }
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const profile = profiles[token];
    if (req.url === '/userinfo' && profile) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(profile));
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid token' }));
  });
  const port = await new Promise<number>((resolvePromise, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolvePromise(typeof addr === 'object' && addr ? addr.port : 0);
    });
    server.on('error', reject);
  });
  return {
    userInfoUrl: `http://127.0.0.1:${port}/userinfo`,
    authorizeUrl: `http://127.0.0.1:${port}/authorize`,
    tokenUrl: `http://127.0.0.1:${port}/token`,
    requests,
    tokenRequests,
    close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())),
  };
}

async function waitForHealth(base: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    }
  }
  throw new Error('server did not become healthy');
}

function cookiesFrom(res: Response): string {
  const h: any = res.headers as any;
  const all: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  const joined = all.join(', ');
  const found = joined.match(/el_(?:access|refresh)=[^;,\s]+/g) ?? [];
  assert(found.length >= 2, `expected auth cookies, got ${joined}`);
  return found.join('; ');
}

async function json(res: Response): Promise<any> {
  const body = await res.text();
  return body ? JSON.parse(body) : null;
}

async function req(base: string, path: string, init: RequestInit & { cookie?: string } = {}): Promise<{ res: Response; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) };
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await fetch(`${base}${path}`, { ...init, headers });
  return { res, body: await json(res) };
}

async function requestEmailCode(base: string, email: string, smtpMessages: string[]): Promise<{ challengeId: string; code: string }> {
  const start = smtpMessages.length;
  const challenge = await req(base, '/api/auth/verification-codes', {
    method: 'POST',
    body: JSON.stringify({ type: 'email', identifier: email, purpose: 'login' }),
  });
  assert(challenge.res.status === 201, `verification code failed: ${challenge.res.status}`);
  for (let i = 0; i < 20 && smtpMessages.length === start; i++) await new Promise((r) => setTimeout(r, 50));
  const code = (smtpMessages.at(-1) ?? '').match(/\b\d{6}\b/)?.[0];
  assert(code, 'SMTP message did not include code');
  return { challengeId: challenge.body.challengeId, code };
}

async function loginEmail(base: string, email: string, smtpMessages: string[]): Promise<{ cookie: string; userId: string }> {
  const challenge = await requestEmailCode(base, email, smtpMessages);
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...challenge,
      agreedToTerms: true,
      device: { deviceId: `oauth-email-${email}`, deviceName: 'OAuth integration test', platform: 'Web', appVersion: 'test' },
    }),
  });
  const body = await json(loginRes);
  assert(loginRes.status === 201 || loginRes.status === 200, `email login failed: ${loginRes.status}`);
  return { cookie: cookiesFrom(loginRes), userId: body.user.id };
}

async function main() {
  const smtp = await startSmtp();
  const oauth = await startOAuthProvider();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `oauth-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    OAUTH_TEST_USERINFO_URL: oauth.userInfoUrl,
    OAUTH_TEST_AUTHORIZE_URL: oauth.authorizeUrl,
    OAUTH_TEST_TOKEN_URL: oauth.tokenUrl,
    OAUTH_TEST_CLIENT_ID: 'oauth-test-client',
    OAUTH_TEST_CLIENT_SECRET: 'oauth-test-secret',
    AUTH_TOKEN_SECRET: 'oauth-token-secret',
    AUTH_IDENTIFIER_SECRET: 'oauth-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const oauthLogin = await req(base, '/api/auth/oauth/test/login', {
      method: 'POST',
      body: JSON.stringify({
        accessToken: 'token-alice',
        agreedToTerms: true,
        device: { deviceId: 'oauth-alice-device', deviceName: 'OAuth login', platform: 'Web' },
      }),
    });
    assert(oauthLogin.res.status === 400, `OAuth login should be blocked by email-only policy, got ${oauthLogin.res.status}`);
    assert(oauthLogin.body.error.code === 'email_login_only', 'OAuth login should return email_login_only');

    const redirectUri = 'http://127.0.0.1/oauth/callback';
    const authorization = await req(base, '/api/auth/oauth/test/authorize', {
      method: 'POST',
      body: JSON.stringify({ redirectUri }),
    });
    assert(authorization.res.status === 400, `OAuth authorization login should be blocked, got ${authorization.res.status}`);
    assert(authorization.body.error.code === 'email_login_only', 'OAuth authorization login should return email_login_only');

    const codeLogin = await req(base, '/api/auth/oauth/test/callback', {
      method: 'POST',
      body: JSON.stringify({
        state: 'blocked-state',
        code: 'valid-code',
        redirectUri,
        agreedToTerms: true,
        device: { deviceId: 'oauth-code-device', deviceName: 'OAuth code login', platform: 'Web' },
      }),
    });
    assert(codeLogin.res.status === 400, `OAuth code login should be blocked, got ${codeLogin.res.status}`);
    assert(codeLogin.body.error.code === 'email_login_only', 'OAuth code login should return email_login_only');
    assert(oauth.requests.length === 0, 'blocked OAuth login must not call the OAuth provider');
    assert(oauth.tokenRequests.length === 0, 'blocked OAuth login must not call the token endpoint');

    const emailUser = await loginEmail(base, 'oauth-bind@example.com', smtp.messages);
    const otherEmailUser = await loginEmail(base, 'oauth-other@example.com', smtp.messages);
    const bind = await req(base, '/api/account/oauth/test/bind', {
      method: 'POST',
      cookie: emailUser.cookie,
      body: JSON.stringify({ accessToken: 'token-bound' }),
    });
    assert(bind.res.status === 200, `OAuth bind failed: ${bind.res.status} ${JSON.stringify(bind.body)}`);
    assert(bind.body.identities.some((i: any) => i.type === 'oauth' && i.provider === 'test'), 'OAuth identity missing after bind');

    const bindRedirectUri = 'http://127.0.0.1/account/oauth/callback';
    const wrongUserAuthorization = await req(base, '/api/account/oauth/test/authorize', {
      method: 'POST',
      cookie: emailUser.cookie,
      body: JSON.stringify({ redirectUri: bindRedirectUri }),
    });
    assert(wrongUserAuthorization.res.status === 201, `OAuth bind authorization failed: ${wrongUserAuthorization.res.status}`);
    const wrongUserBinding = await req(base, '/api/account/oauth/test/callback', {
      method: 'POST',
      cookie: otherEmailUser.cookie,
      body: JSON.stringify({
        state: wrongUserAuthorization.body.state,
        code: 'bind-code',
        redirectUri: bindRedirectUri,
      }),
    });
    assert(wrongUserBinding.res.status === 400, `OAuth bind state should be account-scoped, got ${wrongUserBinding.res.status}`);
    assert(oauth.tokenRequests.length === 0, 'wrong-user bind callback should not call the token endpoint');

    const bindAuthorization = await req(base, '/api/account/oauth/test/authorize', {
      method: 'POST',
      cookie: emailUser.cookie,
      body: JSON.stringify({ redirectUri: bindRedirectUri }),
    });
    assert(bindAuthorization.res.status === 201, `OAuth bind authorization failed: ${bindAuthorization.res.status}`);
    const bindUrl = new URL(bindAuthorization.body.authorizationUrl);
    assert(bindUrl.searchParams.get('state') === bindAuthorization.body.state, 'bind authorization state mismatch');
    assert(bindUrl.searchParams.get('code_challenge_method') === 'S256', 'bind authorization should use PKCE');
    const bindCode = await req(base, '/api/account/oauth/test/callback', {
      method: 'POST',
      cookie: emailUser.cookie,
      body: JSON.stringify({
        state: bindAuthorization.body.state,
        code: 'bind-code',
        redirectUri: bindRedirectUri,
      }),
    });
    assert(bindCode.res.status === 200, `OAuth code bind failed: ${bindCode.res.status} ${JSON.stringify(bindCode.body)}`);
    assert(bindCode.body.identities.some((i: any) => i.type === 'oauth' && i.provider === 'test'), 'OAuth code identity missing after bind');
    assert(oauth.requests.includes('Bearer token-bind-code'), 'OAuth bind code flow did not fetch UserInfo with exchanged access token');
    assert(oauth.tokenRequests.length === 1, `expected one successful OAuth token exchange, got ${oauth.tokenRequests.length}`);

    const conflict = await req(base, '/api/account/oauth/test/bind', {
      method: 'POST',
      cookie: otherEmailUser.cookie,
      body: JSON.stringify({ accessToken: 'token-bound' }),
    });
    assert(conflict.res.status === 409, `OAuth bind conflict should be 409, got ${conflict.res.status}`);

    const boundOAuthIdentity = bind.body.identities.find((i: any) => i.type === 'oauth' && i.provider === 'test');
    assert(boundOAuthIdentity, 'bound OAuth identity id missing');
    const unbind = await req(base, `/api/account/identities/${boundOAuthIdentity.id}`, {
      method: 'DELETE',
      cookie: emailUser.cookie,
    });
    assert(unbind.res.status === 200, `OAuth unbind failed: ${unbind.res.status} ${JSON.stringify(unbind.body)}`);
    assert(unbind.body.user.emailMasked, 'unbinding OAuth should not clear the bound email identity');
    assert(unbind.body.identities.some((i: any) => i.type === 'email'), 'email identity should remain active after OAuth unbind');
    assert(!unbind.body.identities.some((i: any) => i.id === boundOAuthIdentity.id), 'OAuth identity should be inactive after unbind');

    const db = new DatabaseSync(dbPath);
    try {
      const oauthRows = db.prepare("SELECT COUNT(*) c FROM auth_identities WHERE type = 'oauth' AND provider = 'test'").get() as { c: number };
      assert(oauthRows.c === 2, `expected two OAuth identities, got ${oauthRows.c}`);
      const activeOAuthRows = db
        .prepare("SELECT COUNT(*) c FROM auth_identities WHERE type = 'oauth' AND provider = 'test' AND unbound_at IS NULL")
        .get() as { c: number };
      assert(activeOAuthRows.c === 1, `expected one active OAuth identity after code bind and unbind, got ${activeOAuthRows.c}`);
      const consumedStates = db
        .prepare("SELECT COUNT(*) c FROM oauth_login_states WHERE provider = 'test' AND consumed_at IS NOT NULL")
        .get() as { c: number };
      assert(consumedStates.c === 1, `expected one consumed OAuth state, got ${consumedStates.c}`);
      const bindState = db
        .prepare("SELECT COUNT(*) c FROM oauth_login_states WHERE provider = 'test' AND purpose = 'account_bind' AND user_id IS NOT NULL")
        .get() as { c: number };
      assert(bindState.c === 2, `expected two account-scoped bind states, got ${bindState.c}`);
    } finally {
      db.close();
    }
  } finally {
    await new Promise((resolvePromise) => server.close(() => resolvePromise(null)));
    const dbModule = await import(pathToFileURL(resolve(root, 'server', 'src', 'db.ts')).href);
    dbModule.db.close();
    await smtp.close();
    await oauth.close();
    for (const suffix of ['', '-shm', '-wal']) {
      const p = dbPath + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
