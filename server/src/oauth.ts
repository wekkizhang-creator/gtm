import { createHash, randomBytes } from 'node:crypto';
import { db, nowISO } from './db';
import { AppError } from './types';

export interface OAuthProfile {
  provider: string;
  subject: string;
  displayIdentifier: string;
  email: string | null;
  name: string | null;
}

function envKey(provider: string): string {
  if (!/^[a-z0-9_-]{2,32}$/i.test(provider)) throw new AppError(400, 'invalid_oauth_provider', 'OAuth provider is invalid');
  return provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function challenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

function oauthConfig(provider: string): {
  provider: string;
  key: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string | null;
  scope: string;
} {
  const key = envKey(provider);
  const authorizeUrl = process.env[`OAUTH_${key}_AUTHORIZE_URL`];
  const tokenUrl = process.env[`OAUTH_${key}_TOKEN_URL`];
  const clientId = process.env[`OAUTH_${key}_CLIENT_ID`];
  if (!authorizeUrl || !tokenUrl || !clientId) {
    throw new AppError(501, 'oauth_provider_not_configured', 'OAuth authorization code flow is not configured');
  }
  return {
    provider,
    key,
    authorizeUrl,
    tokenUrl,
    clientId,
    clientSecret: process.env[`OAUTH_${key}_CLIENT_SECRET`] ?? null,
    scope: process.env[`OAUTH_${key}_SCOPE`] ?? 'openid email profile',
  };
}

function field(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function fetchOAuthProfile(provider: string, accessToken: string): Promise<OAuthProfile> {
  if (!accessToken.trim()) throw new AppError(400, 'invalid_oauth_token', 'OAuth access token is required');
  const key = envKey(provider);
  const userInfoUrl = process.env[`OAUTH_${key}_USERINFO_URL`];
  if (!userInfoUrl) throw new AppError(501, 'oauth_provider_not_configured', 'third-party account binding is not configured');
  const res = await fetch(userInfoUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!res.ok) throw new AppError(res.status >= 500 ? 502 : 400, 'oauth_provider_error', `OAuth provider returned HTTP ${res.status}`);

  const subField = process.env[`OAUTH_${key}_SUB_FIELD`] ?? 'sub';
  const emailField = process.env[`OAUTH_${key}_EMAIL_FIELD`] ?? 'email';
  const nameField = process.env[`OAUTH_${key}_NAME_FIELD`] ?? 'name';
  const subject = field(body, subField) ?? field(body, 'id');
  if (!subject) throw new AppError(502, 'oauth_invalid_profile', 'OAuth profile did not include a subject');
  const email = field(body, emailField);
  const name = field(body, nameField);
  return {
    provider,
    subject,
    email,
    name,
    displayIdentifier: email ?? name ?? subject,
  };
}

export function createOAuthAuthorization(provider: string, input: { redirectUri?: unknown; scope?: unknown; purpose?: 'login' | 'account_bind'; userId?: string | null }): {
  authorizationUrl: string;
  state: string;
  expiresAt: string;
} {
  if (typeof input.redirectUri !== 'string' || !input.redirectUri.trim()) {
    throw new AppError(400, 'invalid_oauth_redirect_uri', 'redirectUri is required');
  }
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(input.redirectUri);
  } catch {
    throw new AppError(400, 'invalid_oauth_redirect_uri', 'redirectUri is invalid');
  }
  if (redirectUrl.protocol !== 'http:' && redirectUrl.protocol !== 'https:') {
    throw new AppError(400, 'invalid_oauth_redirect_uri', 'redirectUri must be http or https');
  }
  const cfg = oauthConfig(provider);
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(32));
  const scope = typeof input.scope === 'string' && input.scope.trim() ? input.scope.trim() : cfg.scope;
  const purpose = input.purpose ?? 'login';
  const now = nowISO();
  const expiresAt = addSeconds(now, 10 * 60);
  db.prepare(
    `INSERT INTO oauth_login_states (state, provider, user_id, purpose, code_verifier, redirect_uri, scope, created_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(state, cfg.provider, input.userId ?? null, purpose, verifier, redirectUrl.toString(), scope, now, expiresAt);
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', redirectUrl.toString());
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return { authorizationUrl: url.toString(), state, expiresAt };
}

export async function exchangeOAuthCode(
  provider: string,
  input: { state?: unknown; code?: unknown; redirectUri?: unknown; expectedPurpose?: 'login' | 'account_bind'; userId?: string | null },
): Promise<string> {
  if (typeof input.state !== 'string' || !input.state.trim()) throw new AppError(400, 'invalid_oauth_state', 'state is required');
  if (typeof input.code !== 'string' || !input.code.trim()) throw new AppError(400, 'invalid_oauth_code', 'code is required');
  if (typeof input.redirectUri !== 'string' || !input.redirectUri.trim()) {
    throw new AppError(400, 'invalid_oauth_redirect_uri', 'redirectUri is required');
  }
  const cfg = oauthConfig(provider);
  const state = db.prepare('SELECT * FROM oauth_login_states WHERE state = ? AND provider = ?').get(input.state, cfg.provider) as any;
  if (!state || state.consumed_at) throw new AppError(400, 'invalid_oauth_state', 'state is invalid');
  if ((state.purpose ?? 'login') !== (input.expectedPurpose ?? 'login')) throw new AppError(400, 'invalid_oauth_state', 'state purpose is invalid');
  if (input.userId !== undefined && (state.user_id ?? null) !== (input.userId ?? null)) {
    throw new AppError(400, 'invalid_oauth_state', 'state does not belong to the current account');
  }
  if (state.expires_at < nowISO()) throw new AppError(400, 'oauth_state_expired', 'OAuth state has expired');
  if (state.redirect_uri !== input.redirectUri) throw new AppError(400, 'invalid_oauth_redirect_uri', 'redirectUri does not match the authorization request');

  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', input.code);
  body.set('redirect_uri', state.redirect_uri);
  body.set('client_id', cfg.clientId);
  body.set('code_verifier', state.code_verifier);
  if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret);
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  if (!res.ok) throw new AppError(res.status >= 500 ? 502 : 400, 'oauth_token_exchange_failed', `OAuth token endpoint returned HTTP ${res.status}`);
  const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token : null;
  if (!accessToken) throw new AppError(502, 'oauth_token_exchange_failed', 'OAuth token endpoint did not return access_token');
  db.prepare('UPDATE oauth_login_states SET consumed_at = ? WHERE state = ? AND provider = ?').run(nowISO(), input.state, cfg.provider);
  return accessToken;
}
