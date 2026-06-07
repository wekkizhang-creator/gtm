import { createHmac, createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { db, getInboxId, nowISO } from './db';
import { sendVerificationEmail } from './smtp';
import { sendVerificationSms } from './sms';
import { exchangeOAuthCode, fetchOAuthProfile } from './oauth';
import {
  AppError,
  type AccountDeletionPreviewDTO,
  type AccountDeletionRequestDTO,
  type AccountIdentityDTO,
  type AccountOnboardingDTO,
  type AuthContext,
  type LocalCacheClearResultDTO,
  type LocalCacheSummaryDTO,
  type SessionDTO,
  type UserDTO,
} from './types';

const ACCESS_COOKIE = 'el_access';
const REFRESH_COOKIE = 'el_refresh';
const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_SEC = 30 * 24 * 60 * 60;
const CODE_TTL_SEC = 10 * 60;
const RESEND_AFTER_SEC = 60;
const MAX_ATTEMPTS = 5;
const DELETE_COOLING_DAYS = 7;
type ReRegistrationPolicy = 'allow' | 'block';

export interface AuthRiskContext {
  ip?: string | null;
  userAgent?: string | string[] | null;
  deviceId?: string | null;
}

function tokenSecret(): string {
  return process.env.AUTH_TOKEN_SECRET ?? 'development-auth-token-secret-change-me';
}

function identifierSecret(): string {
  return process.env.AUTH_IDENTIFIER_SECRET ?? tokenSecret();
}

function splitConfigList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function codeIdentifierWindowSec(): number {
  return positiveIntEnv('AUTH_CODE_IDENTIFIER_WINDOW_SEC', 60 * 60);
}

function codeIdentifierMaxPerWindow(): number {
  return positiveIntEnv('AUTH_CODE_IDENTIFIER_MAX_PER_WINDOW', 5);
}

function codeIpWindowSec(): number {
  return positiveIntEnv('AUTH_CODE_IP_WINDOW_SEC', 5 * 60);
}

function codeIpMaxPerWindow(): number {
  return positiveIntEnv('AUTH_CODE_IP_MAX_PER_WINDOW', 30);
}

function codeDeviceWindowSec(): number {
  return positiveIntEnv('AUTH_CODE_DEVICE_WINDOW_SEC', 5 * 60);
}

function codeDeviceMaxPerWindow(): number {
  return positiveIntEnv('AUTH_CODE_DEVICE_MAX_PER_WINDOW', 10);
}

function passwordMaxFailedAttempts(): number {
  return positiveIntEnv('AUTH_PASSWORD_MAX_FAILED_ATTEMPTS', 5);
}

function passwordLockSec(): number {
  return positiveIntEnv('AUTH_PASSWORD_LOCK_SEC', 15 * 60);
}

function reRegistrationPolicy(): ReRegistrationPolicy {
  const raw = (process.env.ACCOUNT_REREGISTRATION_POLICY ?? 'allow').trim().toLowerCase();
  return raw === 'block' ? 'block' : 'allow';
}

function hmac(value: string, secret = tokenSecret()): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertPassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new AppError(400, 'invalid_password', 'password must be 8 to 128 characters');
  }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${key}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const [, salt, key] = encoded.split(':');
  if (!salt || !key) return false;
  const expected = Buffer.from(key, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function sign(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${hmac(body)}`;
}

function verifySigned(token: string): Record<string, any> | null {
  const [body, sig] = token.split('.');
  if (!body || !sig || hmac(body) !== sig) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function codeHash(challengeId: string, code: string): string {
  return hmac(`${challengeId}:${code}`);
}

function riskHash(scope: 'ip' | 'device', value: string | null | undefined): string | null {
  const v = typeof value === 'string' ? value.trim() : '';
  return v ? hmac(`auth-code-rate:${scope}:${v}`, identifierSecret()) : null;
}

function secondsUntilWindowClears(createdAt: string, windowSec: number, now: string): number {
  const ms = Date.parse(createdAt) + windowSec * 1000 - Date.parse(now);
  return Math.max(1, Math.ceil(ms / 1000));
}

function rateLimited(createdAt: string, windowSec: number, now: string): never {
  const wait = secondsUntilWindowClears(createdAt, windowSec, now);
  throw new AppError(429, 'rate_limited', `please wait ${wait} seconds before requesting another code`);
}

function assertIdentifierCodeRate(type: 'email' | 'phone', identifierHashValue: string, now: string): void {
  const windowSec = codeIdentifierWindowSec();
  const max = codeIdentifierMaxPerWindow();
  const since = addSeconds(now, -windowSec);
  const rows = db
    .prepare(
      `SELECT created_at FROM verification_codes
       WHERE type = ? AND identifier_hash = ? AND created_at >= ?
       ORDER BY created_at ASC`,
    )
    .all(type, identifierHashValue, since) as Array<{ created_at: string }>;
  if (rows.length >= max) rateLimited(rows[0].created_at, windowSec, now);
}

function assertRequesterCodeRate(column: 'requester_ip_hash' | 'requester_device_hash', hash: string | null, windowSec: number, max: number, now: string): void {
  if (!hash) return;
  const since = addSeconds(now, -windowSec);
  const rows = db
    .prepare(
      `SELECT created_at FROM verification_codes
       WHERE ${column} = ? AND created_at >= ?
       ORDER BY created_at ASC`,
    )
    .all(hash, since) as Array<{ created_at: string }>;
  if (rows.length >= max) rateLimited(rows[0].created_at, windowSec, now);
}

function normalizeEmail(v: string): string {
  return v.trim().toLowerCase();
}

function normalizePhone(v: string): string {
  return v.replace(/[^\d+]/g, '');
}

function identifierHash(type: string, identifier: string): string {
  return hmac(`${type}:${identifier}`, identifierSecret());
}

function assertIdentityReusable(type: string, identifierHashValue: string): void {
  if (reRegistrationPolicy() !== 'block') return;
  const reserved = db
    .prepare(
      `SELECT id FROM deleted_identity_reservations
       WHERE type = ? AND identifier_hash = ? AND policy = 'block'
       LIMIT 1`,
    )
    .get(type, identifierHashValue);
  if (reserved) {
    throw new AppError(423, 'identity_re_registration_blocked', 'identity is reserved after account deletion');
  }
}

function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!domain) return email;
  const visible = name.slice(0, Math.min(2, name.length));
  return `${visible}${'*'.repeat(Math.max(2, name.length - visible.length))}@${domain}`;
}

function maskPhone(phone: string): string {
  return phone.length <= 6 ? phone.replace(/\d/g, '*') : `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function normalizeIdentifier(type: string, identifier: string): { normalized: string; masked: string } {
  if (type === 'email') {
    const normalized = normalizeEmail(identifier);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new AppError(400, 'invalid_identifier', 'email format is invalid');
    }
    return { normalized, masked: maskEmail(normalized) };
  }
  if (type === 'phone') {
    const normalized = normalizePhone(identifier);
    if (!/^\+?\d{8,15}$/.test(normalized)) {
      throw new AppError(400, 'invalid_identifier', 'phone format is invalid');
    }
    return { normalized, masked: maskPhone(normalized) };
  }
  throw new AppError(400, 'invalid_identifier', 'type must be email or phone');
}

function riskSupportMessage(): string {
  const contact = process.env.AUTH_RISK_SUPPORT_CONTACT?.trim() || 'support@example.com';
  return `账号验证受限，请联系 ${contact} 或通过反馈入口申诉`;
}

function userAgentString(value: string | string[] | null | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value ?? undefined;
}

function blockByRisk(reason: string, targetType: string, targetId: string | null, context?: AuthRiskContext): never {
  audit(null, `auth_risk_${reason}`, targetType, targetId ?? undefined, context?.ip ?? undefined, userAgentString(context?.userAgent));
  throw new AppError(423, 'auth_risk_restricted', riskSupportMessage());
}

function assertIdentifierRiskAllowed(
  type: 'email' | 'phone',
  normalized: string,
  identifierHashValue: string,
  context?: AuthRiskContext,
): void {
  const blocked = new Set(splitConfigList(process.env.AUTH_RISK_BLOCKED_IDENTIFIERS).map((item) => item.toLowerCase()));
  if (!blocked.size) return;
  if (blocked.has(normalized.toLowerCase()) || blocked.has(`${type}:${normalized}`.toLowerCase()) || blocked.has(identifierHashValue)) {
    blockByRisk('identifier_blocked', type, identifierHashValue, context);
  }
}

function assertDeviceRiskAllowed(deviceId: string, context?: AuthRiskContext): void {
  const blocked = new Set(splitConfigList(process.env.AUTH_RISK_BLOCKED_DEVICE_IDS));
  if (!blocked.size) return;
  if (blocked.has(deviceId)) blockByRisk('device_blocked', 'device', deviceId, context);
}

function mapUser(r: any): UserDTO {
  return {
    id: r.id,
    nickname: r.nickname ?? null,
    avatarUrl: r.avatar_url ?? null,
    phoneMasked: r.phone_masked ?? null,
    emailMasked: r.email_masked ?? null,
    status: r.status,
    registeredAt: r.registered_at,
    lastLoginAt: r.last_login_at ?? null,
    deleteRequestedAt: r.delete_requested_at ?? null,
    deleteScheduledAt: r.delete_scheduled_at ?? null,
  };
}

function mapSession(r: any, currentId?: string): SessionDTO {
  return {
    id: r.id,
    userId: r.user_id,
    deviceId: r.device_id,
    deviceName: r.device_name ?? null,
    platform: r.platform ?? null,
    appVersion: r.app_version ?? null,
    loginAt: r.login_at,
    lastActiveAt: r.last_active_at,
    accessTokenExpiresAt: r.access_token_expires_at,
    refreshTokenExpiresAt: r.refresh_token_expires_at,
    isCurrentDevice: r.id === currentId,
    revokedAt: r.revoked_at ?? null,
  };
}

function userById(id: string): UserDTO | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row ? mapUser(row) : null;
}

function sessionById(id: string): SessionDTO | null {
  const row = db.prepare('SELECT * FROM login_sessions WHERE id = ?').get(id);
  return row ? mapSession(row, id) : null;
}

function assertActiveUser(user: UserDTO): void {
  if (user.status !== 'normal') throw new AppError(423, 'account_restricted', `account status is ${user.status}`);
}

function assertSessionAllowedUser(user: UserDTO): void {
  if (user.status !== 'normal' && user.status !== 'deleting') {
    throw new AppError(423, 'account_restricted', `account status is ${user.status}`);
  }
}

function setCookie(res: Response, name: string, value: string, maxAgeSec: number): void {
  const secure = process.env.AUTH_COOKIE_SECURE === '1' || process.env.AUTH_COOKIE_SECURE === 'true';
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
    secure ? 'Secure' : '',
  ].filter(Boolean);
  res.append('Set-Cookie', parts.join('; '));
}

export function clearAuthCookies(res: Response): void {
  res.append('Set-Cookie', `${ACCESS_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.append('Set-Cookie', `${REFRESH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function createTokens(sessionId: string, userId: string, now = nowISO()): { accessToken: string; refreshToken: string; accessExp: string; refreshExp: string } {
  const accessExp = addSeconds(now, ACCESS_TTL_SEC);
  const refreshExp = addSeconds(now, REFRESH_TTL_SEC);
  return {
    accessToken: sign({ sid: sessionId, uid: userId, exp: accessExp }),
    refreshToken: randomToken(),
    accessExp,
    refreshExp,
  };
}

function createSessionForUser(
  userId: string,
  device: { deviceId: string; deviceName?: string | null; platform?: string | null; appVersion?: string | null },
  res: Response,
  now = nowISO(),
): SessionDTO {
  const sessionId = randomUUID();
  const tokens = createTokens(sessionId, userId, now);
  db.prepare(
    `INSERT INTO login_sessions
       (id, user_id, device_id, device_name, platform, app_version, refresh_token_hash, login_at, last_active_at, access_token_expires_at, refresh_token_expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    sessionId,
    userId,
    device.deviceId,
    device.deviceName ?? null,
    device.platform ?? null,
    device.appVersion ?? null,
    sha(tokens.refreshToken),
    now,
    now,
    tokens.accessExp,
    tokens.refreshExp,
  );
  setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
  return sessionById(sessionId)!;
}

function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  setCookie(res, ACCESS_COOKIE, accessToken, ACCESS_TTL_SEC);
  setCookie(res, REFRESH_COOKIE, refreshToken, REFRESH_TTL_SEC);
}

function emailIdentityForHash(idHash: string):
  | {
      id: string;
      user_id: string;
      display_identifier: string;
      status: string;
      password_hash: string | null;
      failed_attempt_count: number | null;
      locked_until: string | null;
      last_failed_at: string | null;
    }
  | undefined {
  return db
    .prepare(
      `SELECT
         ai.id,
         ai.user_id,
         ai.display_identifier,
         u.status,
         pc.password_hash,
         pc.failed_attempt_count,
         pc.locked_until,
         pc.last_failed_at
       FROM auth_identities ai
       JOIN users u ON u.id = ai.user_id
       LEFT JOIN auth_password_credentials pc ON pc.user_id = ai.user_id
       WHERE ai.type = 'email' AND ai.identifier_hash = ? AND ai.unbound_at IS NULL
       LIMIT 1`,
    )
    .get(idHash) as
    | {
        id: string;
        user_id: string;
        display_identifier: string;
        status: string;
        password_hash: string | null;
        failed_attempt_count: number | null;
        locked_until: string | null;
        last_failed_at: string | null;
      }
    | undefined;
}

function setPasswordCredential(userId: string, password: string, ts = nowISO()): void {
  db.prepare(
    `INSERT INTO auth_password_credentials
       (user_id, password_hash, failed_attempt_count, locked_until, last_failed_at, created_at, updated_at)
     VALUES (?, ?, 0, NULL, NULL, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       password_hash = excluded.password_hash,
       failed_attempt_count = 0,
       locked_until = NULL,
       last_failed_at = NULL,
       updated_at = excluded.updated_at`,
  ).run(userId, hashPassword(password), ts, ts);
}

function assertPasswordCredentialNotLocked(credential: { locked_until?: string | null }): void {
  if (credential.locked_until && credential.locked_until > nowISO()) {
    throw new AppError(423, 'password_login_locked', 'password login is temporarily locked');
  }
}

function recordPasswordFailure(userId: string, ts = nowISO()): void {
  const row = db.prepare('SELECT failed_attempt_count, locked_until FROM auth_password_credentials WHERE user_id = ?').get(userId) as
    | { failed_attempt_count: number; locked_until: string | null }
    | undefined;
  if (!row) throw new AppError(401, 'invalid_credentials', 'email or password is incorrect');
  if (row.locked_until && row.locked_until > ts) {
    throw new AppError(423, 'password_login_locked', 'password login is temporarily locked');
  }
  const previousAttempts = row.locked_until && row.locked_until <= ts ? 0 : Math.max(0, Number(row.failed_attempt_count) || 0);
  const attempts = previousAttempts + 1;
  const lockedUntil = attempts >= passwordMaxFailedAttempts() ? addSeconds(ts, passwordLockSec()) : null;
  db.prepare(
    `UPDATE auth_password_credentials
     SET failed_attempt_count = ?, locked_until = ?, last_failed_at = ?, updated_at = ?
     WHERE user_id = ?`,
  ).run(attempts, lockedUntil, ts, ts, userId);
  if (lockedUntil) {
    audit(userId, 'password_login_locked', 'user', userId, undefined, undefined);
    throw new AppError(423, 'password_login_locked', 'password login is temporarily locked');
  }
}

function resetPasswordFailures(userId: string, ts = nowISO()): void {
  db.prepare(
    `UPDATE auth_password_credentials
     SET failed_attempt_count = 0, locked_until = NULL, last_failed_at = NULL, updated_at = ?
     WHERE user_id = ?`,
  ).run(ts, userId);
}

function normalizeDeviceInput(device: { deviceId: string; deviceName?: string | null; platform?: string | null; appVersion?: string | null }) {
  if (typeof device.deviceId !== 'string' || !device.deviceId.trim()) {
    throw new AppError(400, 'invalid', 'device.deviceId is required');
  }
  return {
    deviceId: device.deviceId.trim(),
    deviceName: typeof device.deviceName === 'string' ? device.deviceName : null,
    platform: typeof device.platform === 'string' ? device.platform : null,
    appVersion: typeof device.appVersion === 'string' ? device.appVersion : null,
  };
}

export async function startEmailRegistration(input: {
  email: string;
  risk?: AuthRiskContext;
}): Promise<{ challengeId: string; maskedIdentifier: string; expiresAt: string; resendAfterSec: number; isNewIdentifier: boolean }> {
  const { normalized } = normalizeIdentifier('email', input.email);
  const idHash = identifierHash('email', normalized);
  assertIdentifierRiskAllowed('email', normalized, idHash, input.risk);
  const existing = emailIdentityForHash(idHash);
  if (existing?.password_hash) throw new AppError(409, 'email_already_registered', 'email is already registered');
  if (!existing) assertIdentityReusable('email', idHash);
  return createVerificationCode({ type: 'email', identifier: normalized, purpose: 'register', risk: input.risk });
}

export async function startPasswordReset(input: {
  email: string;
  risk?: AuthRiskContext;
}): Promise<{ challengeId: string; maskedIdentifier: string; expiresAt: string; resendAfterSec: number; isNewIdentifier: boolean }> {
  const { normalized } = normalizeIdentifier('email', input.email);
  const idHash = identifierHash('email', normalized);
  assertIdentifierRiskAllowed('email', normalized, idHash, input.risk);
  const existing = emailIdentityForHash(idHash);
  if (!existing) throw new AppError(404, 'email_not_registered', 'email is not registered');
  if (!existing.password_hash) throw new AppError(409, 'password_not_set', 'email account has not set a password');
  return createVerificationCode({ type: 'email', identifier: normalized, purpose: 'password_reset', risk: input.risk });
}

export async function createVerificationCode(input: {
  type: 'email' | 'phone';
  identifier: string;
  purpose?: string;
  risk?: AuthRiskContext;
}): Promise<{ challengeId: string; maskedIdentifier: string; expiresAt: string; resendAfterSec: number; isNewIdentifier: boolean }> {
  const { normalized, masked } = normalizeIdentifier(input.type, input.identifier);
  const idHash = identifierHash(input.type, normalized);
  assertIdentifierRiskAllowed(input.type, normalized, idHash, input.risk);
  const now = nowISO();
  const requesterIpHash = riskHash('ip', input.risk?.ip);
  const requesterDeviceHash = riskHash('device', input.risk?.deviceId);
  const existingIdentity = db
    .prepare('SELECT id FROM auth_identities WHERE type = ? AND identifier_hash = ? AND unbound_at IS NULL LIMIT 1')
    .get(input.type, idHash);
  const purpose = input.purpose ?? 'login';
  if (!existingIdentity && (purpose === 'login' || purpose === 'account_bind')) assertIdentityReusable(input.type, idHash);
  const latest = db
    .prepare(
      `SELECT resend_after_at FROM verification_codes
       WHERE type = ? AND identifier_hash = ? AND purpose = ? AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.type, idHash, purpose) as { resend_after_at: string } | undefined;
  if (latest && latest.resend_after_at > now) {
    throw new AppError(429, 'rate_limited', 'please wait before requesting another code');
  }
  assertIdentifierCodeRate(input.type, idHash, now);
  assertRequesterCodeRate('requester_ip_hash', requesterIpHash, codeIpWindowSec(), codeIpMaxPerWindow(), now);
  assertRequesterCodeRate('requester_device_hash', requesterDeviceHash, codeDeviceWindowSec(), codeDeviceMaxPerWindow(), now);

  const challengeId = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = addSeconds(now, CODE_TTL_SEC);
  db.prepare(
    `INSERT INTO verification_codes
       (id, type, identifier_hash, display_identifier, requester_ip_hash, requester_device_hash, code_hash, purpose, expires_at, resend_after_at, attempts, consumed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
  ).run(
    challengeId,
    input.type,
    idHash,
    masked,
    requesterIpHash,
    requesterDeviceHash,
    codeHash(challengeId, code),
    purpose,
    expiresAt,
    addSeconds(now, RESEND_AFTER_SEC),
    now,
  );

  try {
    if (input.type === 'email') await sendVerificationEmail(normalized, code);
    else await sendVerificationSms(normalized, code, purpose);
  } catch (err) {
    db.prepare('DELETE FROM verification_codes WHERE id = ?').run(challengeId);
    throw err;
  }
  return { challengeId, maskedIdentifier: masked, expiresAt, resendAfterSec: RESEND_AFTER_SEC, isNewIdentifier: !existingIdentity };
}

export function verificationMethod(challengeId: string): 'email' | 'phone' | null {
  const row = db.prepare('SELECT type FROM verification_codes WHERE id = ?').get(challengeId) as { type: 'email' | 'phone' } | undefined;
  return row?.type ?? null;
}

function createOrLoadUserForIdentity(
  type: string,
  idHash: string,
  masked: string,
  agreedToTerms: boolean,
  provider: string | null = null,
): { user: UserDTO; isNewUser: boolean } {
  const existing = db
    .prepare(
      `SELECT u.* FROM auth_identities ai
       JOIN users u ON u.id = ai.user_id
       WHERE ai.type = ? AND ai.identifier_hash = ? AND ai.unbound_at IS NULL`,
    )
    .get(type, idHash);
  if (existing) return { user: mapUser(existing), isNewUser: false };

  assertIdentityReusable(type, idHash);
  if (!agreedToTerms) throw new AppError(400, 'terms_required', 'new account registration requires agreement to terms');
  const userId = randomUUID();
  const identityId = randomUUID();
  const ts = nowISO();
  db.prepare(
    `INSERT INTO users (id, nickname, avatar_url, phone_masked, email_masked, status, registered_at, last_login_at)
     VALUES (?, NULL, NULL, ?, ?, 'normal', ?, ?)`,
  ).run(userId, type === 'phone' ? masked : null, type === 'email' || (type === 'oauth' && masked.includes('@')) ? masked : null, ts, ts);
  db.prepare(
    `INSERT INTO auth_identities (id, user_id, type, provider, identifier_hash, display_identifier, is_primary, verified_at, bound_at, unbound_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
  ).run(identityId, userId, type, provider, idHash, masked, ts, ts);
  getInboxId(userId);
  return { user: userById(userId)!, isNewUser: true };
}

export function completeEmailRegistration(input: {
  challengeId: string;
  code: string;
  password: unknown;
  agreedToTerms: boolean;
  device: { deviceId: string; deviceName?: string | null; platform?: string | null; appVersion?: string | null };
  res: Response;
  risk?: AuthRiskContext;
}): { user: UserDTO; session: SessionDTO; isNewUser: boolean } {
  assertPassword(input.password);
  const device = normalizeDeviceInput(input.device);
  assertDeviceRiskAllowed(device.deviceId, input.risk);
  const codeRow = verifyPendingCode(input.challengeId, input.code, 'register');
  if (codeRow.type !== 'email') throw new AppError(400, 'invalid_identity_type', 'registration requires an email verification code');
  const existing = emailIdentityForHash(codeRow.identifier_hash);
  if (existing?.password_hash) throw new AppError(409, 'email_already_registered', 'email is already registered');
  const masked = existing?.display_identifier ?? codeRow.display_identifier ?? 'verified@email';
  const ts = nowISO();
  let user: UserDTO;
  let isNewUser = false;
  let session: SessionDTO;
  db.exec('BEGIN');
  try {
    const result = createOrLoadUserForIdentity('email', codeRow.identifier_hash, masked, input.agreedToTerms);
    user = result.user;
    isNewUser = result.isNewUser;
    assertSessionAllowedUser(user);
    setPasswordCredential(user.id, input.password, ts);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(ts, user.id);
    db.prepare('UPDATE verification_codes SET consumed_at = ? WHERE id = ?').run(ts, input.challengeId);
    session = createSessionForUser(user.id, device, input.res, ts);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { user: userById(user!.id)!, session: session!, isNewUser };
}

export function loginWithPassword(input: {
  email: string;
  password: unknown;
  device: { deviceId: string; deviceName?: string | null; platform?: string | null; appVersion?: string | null };
  res: Response;
  risk?: AuthRiskContext;
}): { user: UserDTO; session: SessionDTO; isNewUser: false } {
  if (typeof input.password !== 'string') throw new AppError(401, 'invalid_credentials', 'email or password is incorrect');
  const { normalized } = normalizeIdentifier('email', input.email);
  const idHash = identifierHash('email', normalized);
  assertIdentifierRiskAllowed('email', normalized, idHash, input.risk);
  const device = normalizeDeviceInput(input.device);
  assertDeviceRiskAllowed(device.deviceId, input.risk);
  const identity = emailIdentityForHash(idHash);
  if (!identity) throw new AppError(401, 'invalid_credentials', 'email or password is incorrect');
  if (!identity.password_hash) throw new AppError(409, 'password_not_set', 'email account has not set a password');
  assertPasswordCredentialNotLocked(identity);
  if (!verifyPassword(input.password, identity.password_hash)) {
    recordPasswordFailure(identity.user_id);
    throw new AppError(401, 'invalid_credentials', 'email or password is incorrect');
  }
  const user = userById(identity.user_id);
  if (!user) throw new AppError(401, 'invalid_credentials', 'email or password is incorrect');
  assertSessionAllowedUser(user);
  const ts = nowISO();
  resetPasswordFailures(user.id, ts);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(ts, user.id);
  const session = createSessionForUser(user.id, device, input.res, ts);
  return { user: userById(user.id)!, session, isNewUser: false };
}

export function completePasswordReset(input: {
  challengeId: string;
  code: string;
  password: unknown;
  device: { deviceId: string; deviceName?: string | null; platform?: string | null; appVersion?: string | null };
  res: Response;
  risk?: AuthRiskContext;
}): { user: UserDTO; session: SessionDTO; isNewUser: false } {
  assertPassword(input.password);
  const device = normalizeDeviceInput(input.device);
  assertDeviceRiskAllowed(device.deviceId, input.risk);
  const codeRow = verifyPendingCode(input.challengeId, input.code, 'password_reset');
  if (codeRow.type !== 'email') throw new AppError(400, 'invalid_identity_type', 'password reset requires an email verification code');
  const identity = emailIdentityForHash(codeRow.identifier_hash);
  if (!identity) throw new AppError(404, 'email_not_registered', 'email is not registered');
  if (!identity.password_hash) throw new AppError(409, 'password_not_set', 'email account has not set a password');
  const user = userById(identity.user_id);
  if (!user) throw new AppError(404, 'email_not_registered', 'email is not registered');
  assertSessionAllowedUser(user);
  const ts = nowISO();
  let session: SessionDTO;
  db.exec('BEGIN');
  try {
    setPasswordCredential(user.id, input.password, ts);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(ts, user.id);
    db.prepare('UPDATE verification_codes SET consumed_at = ? WHERE id = ?').run(ts, input.challengeId);
    session = createSessionForUser(user.id, device, input.res, ts);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { user: userById(user.id)!, session: session!, isNewUser: false };
}

export function authFromAccessToken(token: string | undefined): AuthContext | null {
  if (!token) return null;
  const payload = verifySigned(token);
  if (!payload?.sid || !payload?.uid || !payload?.exp || payload.exp < nowISO()) return null;
  const row = db
    .prepare('SELECT revoked_at FROM login_sessions WHERE id = ? AND user_id = ?')
    .get(payload.sid, payload.uid) as { revoked_at: string | null } | undefined;
  if (!row || row.revoked_at) return null;
  db.prepare('UPDATE login_sessions SET last_active_at = ? WHERE id = ?').run(nowISO(), payload.sid);
  return { userId: payload.uid, sessionId: payload.sid };
}

export function currentAuthFromCookie(cookieHeader: string | undefined): AuthContext | null {
  return authFromAccessToken(parseCookies(cookieHeader)[ACCESS_COOKIE]);
}

export function currentSession(auth: AuthContext): { user: UserDTO; session: SessionDTO } {
  const user = userById(auth.userId);
  const session = sessionById(auth.sessionId);
  if (!user || !session || session.revokedAt) throw new AppError(401, 'unauthenticated', 'please sign in');
  assertSessionAllowedUser(user);
  return { user, session };
}

export function refreshSession(cookieHeader: string | undefined, res: Response): { user: UserDTO; session: SessionDTO } {
  const refreshToken = parseCookies(cookieHeader)[REFRESH_COOKIE];
  if (!refreshToken) throw new AppError(401, 'invalid_refresh_token', 'refresh token is invalid');
  const row = db
    .prepare('SELECT * FROM login_sessions WHERE refresh_token_hash = ? AND revoked_at IS NULL')
    .get(sha(refreshToken)) as any;
  if (!row || row.refresh_token_expires_at < nowISO()) {
    throw new AppError(401, 'invalid_refresh_token', 'refresh token is invalid');
  }
  const user = userById(row.user_id);
  if (!user) throw new AppError(401, 'invalid_refresh_token', 'refresh token is invalid');
  assertSessionAllowedUser(user);
  const tokens = createTokens(row.id, row.user_id);
  db.prepare(
    `UPDATE login_sessions
     SET refresh_token_hash = ?, last_active_at = ?, access_token_expires_at = ?, refresh_token_expires_at = ?
     WHERE id = ?`,
  ).run(sha(tokens.refreshToken), nowISO(), tokens.accessExp, tokens.refreshExp, row.id);
  setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
  return { user, session: sessionById(row.id)! };
}

export function logout(auth: AuthContext | null, res: Response): void {
  if (auth) db.prepare('UPDATE login_sessions SET revoked_at = ? WHERE id = ?').run(nowISO(), auth.sessionId);
  clearAuthCookies(res);
}

export function getAccount(userId: string): UserDTO {
  const user = userById(userId);
  if (!user) throw new AppError(404, 'not_found', 'user not found');
  return user;
}

export function accountOnboardingStatus(userId: string): AccountOnboardingDTO {
  getAccount(userId);
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS totalTaskCount,
         SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS activeTaskCount
       FROM tasks
       WHERE user_id = ?`,
    )
    .get(userId) as { totalTaskCount: number; activeTaskCount: number | null } | undefined;
  const totalTaskCount = Number(row?.totalTaskCount ?? 0);
  const activeTaskCount = Number(row?.activeTaskCount ?? 0);
  return {
    firstTaskCreated: totalTaskCount > 0,
    showFirstTaskGuide: totalTaskCount === 0,
    totalTaskCount,
    activeTaskCount,
  };
}

export function updateAccount(userId: string, patch: { nickname?: unknown; avatarUrl?: unknown }): UserDTO {
  const cols: string[] = [];
  const vals: unknown[] = [];
  if ('nickname' in patch) {
    if (patch.nickname != null && typeof patch.nickname !== 'string') throw new AppError(400, 'invalid', 'nickname must be a string');
    cols.push('nickname = ?');
    vals.push(patch.nickname ? String(patch.nickname).trim() : null);
  }
  if ('avatarUrl' in patch) {
    if (patch.avatarUrl != null && typeof patch.avatarUrl !== 'string') throw new AppError(400, 'invalid', 'avatarUrl must be a string');
    cols.push('avatar_url = ?');
    vals.push(patch.avatarUrl || null);
  }
  if (cols.length) db.prepare(`UPDATE users SET ${cols.join(', ')} WHERE id = ?`).run(...(vals as any[]), userId);
  return getAccount(userId);
}

function mapIdentity(row: any): AccountIdentityDTO {
  return {
    id: row.id,
    type: row.type,
    provider: row.provider ?? null,
    displayIdentifier: row.display_identifier,
    isPrimary: !!row.is_primary,
    verifiedAt: row.verified_at,
    boundAt: row.bound_at,
  };
}

export function listIdentities(userId: string): AccountIdentityDTO[] {
  return (
    db
      .prepare(
        `SELECT * FROM auth_identities
         WHERE user_id = ? AND unbound_at IS NULL
         ORDER BY is_primary DESC, bound_at DESC`,
      )
      .all(userId) as any[]
  ).map(mapIdentity);
}

function verifyPendingCode(challengeId: string, code: string, purpose: string): any {
  const row = db.prepare('SELECT * FROM verification_codes WHERE id = ? AND purpose = ?').get(challengeId, purpose) as any;
  if (!row || row.consumed_at) throw new AppError(400, 'invalid_code', 'verification code is invalid');
  const now = nowISO();
  if (row.expires_at < now) throw new AppError(400, 'code_expired', 'verification code has expired');
  if (row.attempts >= MAX_ATTEMPTS) throw new AppError(429, 'rate_limited', 'too many verification attempts');
  if (row.code_hash !== codeHash(challengeId, code)) {
    db.prepare('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?').run(challengeId);
    throw new AppError(400, 'invalid_code', 'verification code is invalid');
  }
  return row;
}

export function bindEmail(
  userId: string,
  input: { challengeId?: unknown; code?: unknown },
): { user: UserDTO; identities: AccountIdentityDTO[] } {
  if (typeof input.challengeId !== 'string' || typeof input.code !== 'string') {
    throw new AppError(400, 'invalid', 'challengeId and code are required');
  }
  const user = getAccount(userId);
  if (user.status !== 'normal') throw new AppError(423, 'account_restricted', `account status is ${user.status}`);
  const codeRow = verifyPendingCode(input.challengeId, input.code, 'account_bind');
  if (codeRow.type !== 'email') throw new AppError(400, 'invalid_identity_type', 'only email binding is supported here');
  const existing = db
    .prepare('SELECT * FROM auth_identities WHERE type = ? AND identifier_hash = ?')
    .get('email', codeRow.identifier_hash) as any;
  if (existing && existing.user_id !== userId) throw new AppError(409, 'identity_already_bound', 'email is already bound to another account');
  if (!existing) assertIdentityReusable('email', codeRow.identifier_hash);
  const ts = nowISO();
  const identityId = existing?.id ?? randomUUID();
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE auth_identities SET is_primary = 0 WHERE user_id = ? AND type = 'email' AND id <> ?").run(userId, identityId);
    if (existing) {
      db.prepare(
        `UPDATE auth_identities
         SET display_identifier = ?, is_primary = 1, verified_at = ?, bound_at = ?, unbound_at = NULL
         WHERE id = ? AND user_id = ?`,
      ).run(codeRow.display_identifier, ts, ts, identityId, userId);
    } else {
      db.prepare(
        `INSERT INTO auth_identities
           (id, user_id, type, identifier_hash, display_identifier, is_primary, verified_at, bound_at, unbound_at)
         VALUES (?, ?, 'email', ?, ?, 1, ?, ?, NULL)`,
      ).run(identityId, userId, codeRow.identifier_hash, codeRow.display_identifier, ts, ts);
    }
    db.prepare('UPDATE users SET email_masked = ? WHERE id = ?').run(codeRow.display_identifier, userId);
    db.prepare('UPDATE verification_codes SET consumed_at = ? WHERE id = ?').run(ts, input.challengeId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  audit(userId, 'email_bound', 'identity', identityId);
  return { user: getAccount(userId), identities: listIdentities(userId) };
}

export function bindPhone(
  userId: string,
  input: { challengeId?: unknown; code?: unknown },
): { user: UserDTO; identities: AccountIdentityDTO[] } {
  if (typeof input.challengeId !== 'string' || typeof input.code !== 'string') {
    throw new AppError(400, 'invalid', 'challengeId and code are required');
  }
  const user = getAccount(userId);
  if (user.status !== 'normal') throw new AppError(423, 'account_restricted', `account status is ${user.status}`);
  const codeRow = verifyPendingCode(input.challengeId, input.code, 'account_bind');
  if (codeRow.type !== 'phone') throw new AppError(400, 'invalid_identity_type', 'phone binding requires a phone verification code');
  const existing = db
    .prepare('SELECT * FROM auth_identities WHERE type = ? AND identifier_hash = ?')
    .get('phone', codeRow.identifier_hash) as any;
  if (existing && existing.user_id !== userId) throw new AppError(409, 'identity_already_bound', 'phone is already bound to another account');
  if (!existing) assertIdentityReusable('phone', codeRow.identifier_hash);
  const ts = nowISO();
  const identityId = existing?.id ?? randomUUID();
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE auth_identities SET is_primary = 0 WHERE user_id = ? AND type = 'phone' AND id <> ?").run(userId, identityId);
    if (existing) {
      db.prepare(
        `UPDATE auth_identities
         SET display_identifier = ?, is_primary = 1, verified_at = ?, bound_at = ?, unbound_at = NULL
         WHERE id = ? AND user_id = ?`,
      ).run(codeRow.display_identifier, ts, ts, identityId, userId);
    } else {
      db.prepare(
        `INSERT INTO auth_identities
           (id, user_id, type, identifier_hash, display_identifier, is_primary, verified_at, bound_at, unbound_at)
         VALUES (?, ?, 'phone', ?, ?, 1, ?, ?, NULL)`,
      ).run(identityId, userId, codeRow.identifier_hash, codeRow.display_identifier, ts, ts);
    }
    db.prepare('UPDATE users SET phone_masked = ? WHERE id = ?').run(codeRow.display_identifier, userId);
    db.prepare('UPDATE verification_codes SET consumed_at = ? WHERE id = ?').run(ts, input.challengeId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  audit(userId, 'phone_bound', 'identity', identityId);
  return { user: getAccount(userId), identities: listIdentities(userId) };
}

export async function bindOAuth(
  userId: string,
  provider: string,
  input: { accessToken?: unknown },
): Promise<{ user: UserDTO; identities: AccountIdentityDTO[] }> {
  if (typeof input.accessToken !== 'string') throw new AppError(400, 'invalid_oauth_token', 'accessToken is required');
  const user = getAccount(userId);
  if (user.status !== 'normal') throw new AppError(423, 'account_restricted', `account status is ${user.status}`);
  const profile = await fetchOAuthProfile(provider, input.accessToken);
  const idHash = identifierHash('oauth', `${profile.provider}:${profile.subject}`);
  const displayIdentifier = profile.email ? maskEmail(profile.email) : profile.displayIdentifier;
  const existing = db.prepare('SELECT * FROM auth_identities WHERE type = ? AND identifier_hash = ?').get('oauth', idHash) as any;
  if (existing && existing.user_id !== userId) throw new AppError(409, 'identity_already_bound', 'third-party account is already bound to another account');
  if (!existing) assertIdentityReusable('oauth', idHash);
  const ts = nowISO();
  const identityId = existing?.id ?? randomUUID();
  db.exec('BEGIN');
  try {
    if (existing) {
      db.prepare(
        `UPDATE auth_identities
         SET provider = ?, display_identifier = ?, is_primary = 1, verified_at = ?, bound_at = ?, unbound_at = NULL
         WHERE id = ? AND user_id = ?`,
      ).run(profile.provider, displayIdentifier, ts, ts, identityId, userId);
    } else {
      db.prepare(
        `INSERT INTO auth_identities
           (id, user_id, type, provider, identifier_hash, display_identifier, is_primary, verified_at, bound_at, unbound_at)
         VALUES (?, ?, 'oauth', ?, ?, ?, 1, ?, ?, NULL)`,
      ).run(identityId, userId, profile.provider, idHash, displayIdentifier, ts, ts);
    }
    if (profile.email && !user.emailMasked) db.prepare('UPDATE users SET email_masked = ? WHERE id = ?').run(maskEmail(profile.email), userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  audit(userId, 'oauth_bound', 'identity', identityId);
  return { user: getAccount(userId), identities: listIdentities(userId) };
}

export async function bindOAuthCode(
  userId: string,
  provider: string,
  input: { state?: unknown; code?: unknown; redirectUri?: unknown },
): Promise<{ user: UserDTO; identities: AccountIdentityDTO[] }> {
  const accessToken = await exchangeOAuthCode(provider, {
    state: input.state,
    code: input.code,
    redirectUri: input.redirectUri,
    expectedPurpose: 'account_bind',
    userId,
  });
  return bindOAuth(userId, provider, { accessToken });
}

export async function loginWithOAuth(input: {
  provider: string;
  accessToken?: unknown;
  agreedToTerms: boolean;
  device: { deviceId: string; deviceName?: string | null; platform?: string | null; appVersion?: string | null };
  res: Response;
  risk?: AuthRiskContext;
}): Promise<{ user: UserDTO; session: SessionDTO; isNewUser: boolean }> {
  if (typeof input.accessToken !== 'string') throw new AppError(400, 'invalid_oauth_token', 'accessToken is required');
  assertDeviceRiskAllowed(input.device.deviceId, input.risk);
  const profile = await fetchOAuthProfile(input.provider, input.accessToken);
  const idHash = identifierHash('oauth', `${profile.provider}:${profile.subject}`);
  const displayIdentifier = profile.email ? maskEmail(profile.email) : profile.displayIdentifier;
  const { user, isNewUser } = createOrLoadUserForIdentity('oauth', idHash, displayIdentifier, input.agreedToTerms, profile.provider);
  assertSessionAllowedUser(user);
  const now = nowISO();
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, user.id);
  const session = createSessionForUser(user.id, input.device, input.res, now);
  return { user: userById(user.id)!, session, isNewUser };
}

export async function loginWithOAuthCode(input: {
  provider: string;
  state?: unknown;
  code?: unknown;
  redirectUri?: unknown;
  agreedToTerms: boolean;
  device: { deviceId: string; deviceName?: string | null; platform?: string | null; appVersion?: string | null };
  res: Response;
  risk?: AuthRiskContext;
}): Promise<{ user: UserDTO; session: SessionDTO; isNewUser: boolean }> {
  const accessToken = await exchangeOAuthCode(input.provider, {
    state: input.state,
    code: input.code,
    redirectUri: input.redirectUri,
  });
  return loginWithOAuth({
    provider: input.provider,
    accessToken,
    agreedToTerms: input.agreedToTerms,
    device: input.device,
    res: input.res,
    risk: input.risk,
  });
}

export function unbindIdentity(userId: string, identityId: string): { user: UserDTO; identities: AccountIdentityDTO[] } {
  const identity = db
    .prepare('SELECT * FROM auth_identities WHERE user_id = ? AND id = ? AND unbound_at IS NULL')
    .get(userId, identityId) as any;
  if (!identity) throw new AppError(404, 'not_found', 'identity not found');
  const active = db
    .prepare('SELECT COUNT(*) c FROM auth_identities WHERE user_id = ? AND unbound_at IS NULL')
    .get(userId) as { c: number };
  if (active.c <= 1) throw new AppError(409, 'last_identity_required', 'account must keep at least one login method');

  const ts = nowISO();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE auth_identities SET unbound_at = ?, is_primary = 0 WHERE user_id = ? AND id = ?').run(ts, userId, identityId);
    if (identity.type === 'phone') {
      const replacement = db
        .prepare(
          `SELECT id, display_identifier FROM auth_identities
           WHERE user_id = ? AND type = 'phone' AND unbound_at IS NULL
           ORDER BY is_primary DESC, bound_at DESC LIMIT 1`,
        )
        .get(userId) as { id: string; display_identifier: string } | undefined;
      if (replacement) db.prepare('UPDATE auth_identities SET is_primary = 1 WHERE user_id = ? AND id = ?').run(userId, replacement.id);
      db.prepare('UPDATE users SET phone_masked = ? WHERE id = ?').run(replacement?.display_identifier ?? null, userId);
    } else {
      const emailLikeReplacement = db
        .prepare(
          `SELECT id, display_identifier FROM auth_identities
           WHERE user_id = ?
             AND unbound_at IS NULL
             AND (type = 'email' OR (type = 'oauth' AND display_identifier LIKE '%@%'))
           ORDER BY CASE WHEN type = 'email' THEN 0 ELSE 1 END, is_primary DESC, bound_at DESC
           LIMIT 1`,
        )
        .get(userId) as { id: string; display_identifier: string } | undefined;
      if (emailLikeReplacement) {
        db.prepare('UPDATE auth_identities SET is_primary = 1 WHERE user_id = ? AND id = ?').run(userId, emailLikeReplacement.id);
      }
      db.prepare('UPDATE users SET email_masked = ? WHERE id = ?').run(emailLikeReplacement?.display_identifier ?? null, userId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  audit(userId, 'identity_unbound', 'identity', identityId);
  return { user: getAccount(userId), identities: listIdentities(userId) };
}

export function listSessions(userId: string, currentSessionId: string): SessionDTO[] {
  const rows = db
    .prepare('SELECT * FROM login_sessions WHERE user_id = ? ORDER BY last_active_at DESC')
    .all(userId) as any[];
  return rows.map((r) => mapSession(r, currentSessionId));
}

export function revokeSession(userId: string, sessionId: string): boolean {
  const info = db
    .prepare('UPDATE login_sessions SET revoked_at = ? WHERE user_id = ? AND id = ? AND revoked_at IS NULL')
    .run(nowISO(), userId, sessionId);
  return info.changes > 0;
}

function countFor(userId: string, sql: string): number {
  const row = db.prepare(sql).get(userId) as { c: number } | undefined;
  return row?.c ?? 0;
}

export function accountDeletionPreview(userId: string): AccountDeletionPreviewDTO {
  return {
    user: getAccount(userId),
    coolingDays: DELETE_COOLING_DAYS,
    deletionImpact: {
      lists: countFor(userId, 'SELECT COUNT(*) c FROM lists WHERE user_id = ?'),
      tasks: countFor(userId, 'SELECT COUNT(*) c FROM tasks WHERE user_id = ?'),
      goals: countFor(userId, 'SELECT COUNT(*) c FROM goals WHERE user_id = ?'),
      tags: countFor(userId, 'SELECT COUNT(*) c FROM tags WHERE user_id = ?'),
      attachments: countFor(userId, 'SELECT COUNT(*) c FROM attachments WHERE user_id = ?'),
      notifications: countFor(userId, 'SELECT COUNT(*) c FROM notifications WHERE user_id = ?'),
      focusSessions: countFor(userId, 'SELECT COUNT(*) c FROM focus_sessions WHERE user_id = ?'),
      habits: countFor(userId, 'SELECT COUNT(*) c FROM habits WHERE user_id = ?'),
      countdowns: countFor(userId, 'SELECT COUNT(*) c FROM countdowns WHERE user_id = ?'),
      notes: countFor(userId, 'SELECT COUNT(*) c FROM sticky_notes WHERE user_id = ?'),
      searchHistory: countFor(userId, 'SELECT COUNT(*) c FROM search_history WHERE user_id = ?'),
      settings: countFor(userId, 'SELECT COUNT(*) c FROM settings WHERE user_id = ?'),
    },
  };
}

export function localCacheSummary(userId: string): LocalCacheSummaryDTO {
  const soundCache = db.prepare('SELECT COUNT(*) c FROM user_sound_cache WHERE user_id = ?').get(userId) as { c: number };
  return {
    soundCacheCount: soundCache.c,
    soundCacheBytes: 0,
    attachmentCacheCount: 0,
    attachmentCacheBytes: 0,
  };
}

export function clearLocalCache(userId: string): LocalCacheClearResultDTO {
  const soundCacheCleared = Number(db.prepare('DELETE FROM user_sound_cache WHERE user_id = ?').run(userId).changes);
  return {
    ...localCacheSummary(userId),
    soundCacheCleared,
    attachmentCacheCleared: 0,
    clearedAt: nowISO(),
  };
}

function consumeIdentityVerification(userId: string, challengeId: string, code: string, purpose: string): void {
  const row = db.prepare('SELECT * FROM verification_codes WHERE id = ? AND purpose = ?').get(challengeId, purpose) as any;
  if (!row || row.consumed_at) throw new AppError(400, 'invalid_code', 'verification code is invalid');
  const now = nowISO();
  if (row.expires_at < now) throw new AppError(400, 'code_expired', 'verification code has expired');
  if (row.attempts >= MAX_ATTEMPTS) throw new AppError(429, 'rate_limited', 'too many verification attempts');
  if (row.code_hash !== codeHash(challengeId, code)) {
    db.prepare('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?').run(challengeId);
    throw new AppError(400, 'invalid_code', 'verification code is invalid');
  }
  const identity = db
    .prepare(
      `SELECT id FROM auth_identities
       WHERE user_id = ? AND type = ? AND identifier_hash = ? AND unbound_at IS NULL`,
    )
    .get(userId, row.type, row.identifier_hash);
  if (!identity) throw new AppError(403, 'identity_mismatch', 'verification code does not match current account');
  db.prepare('UPDATE verification_codes SET consumed_at = ? WHERE id = ?').run(now, challengeId);
}

export function requestAccountDeletion(
  userId: string,
  input: { challengeId?: unknown; code?: unknown; confirmText?: unknown; exportAcknowledged?: unknown },
): AccountDeletionRequestDTO {
  if (input.confirmText !== 'DELETE') throw new AppError(400, 'confirm_required', 'confirmText must be DELETE');
  if (input.exportAcknowledged !== true) throw new AppError(400, 'export_acknowledgement_required', 'export acknowledgement is required');
  if (typeof input.challengeId !== 'string' || typeof input.code !== 'string') {
    throw new AppError(400, 'invalid', 'challengeId and code are required');
  }
  const user = getAccount(userId);
  if (user.status !== 'normal') throw new AppError(423, 'account_restricted', `account status is ${user.status}`);
  consumeIdentityVerification(userId, input.challengeId, input.code, 'account_delete');
  const now = nowISO();
  const scheduledAt = addDays(now, DELETE_COOLING_DAYS);
  db.prepare(
    `UPDATE users
     SET status = 'deleting', delete_requested_at = ?, delete_scheduled_at = ?
     WHERE id = ? AND status = 'normal'`,
  ).run(now, scheduledAt, userId);
  db.prepare('UPDATE login_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId);
  audit(userId, 'account_deletion_requested', 'user', userId);
  return { user: getAccount(userId), deleteScheduledAt: scheduledAt, coolingDays: DELETE_COOLING_DAYS };
}

export function cancelAccountDeletion(userId: string): UserDTO {
  const user = getAccount(userId);
  if (user.status !== 'deleting') throw new AppError(409, 'account_not_deleting', 'account is not pending deletion');
  db.prepare(
    "UPDATE users SET status = 'normal', delete_requested_at = NULL, delete_scheduled_at = NULL WHERE id = ? AND status = 'deleting'",
  ).run(userId);
  audit(userId, 'account_deletion_cancelled', 'user', userId);
  return getAccount(userId);
}

export function finalizeDueAccountDeletions(now = nowISO()): { finalized: number; users: string[] } {
  const users = db
    .prepare("SELECT id FROM users WHERE status = 'deleting' AND delete_scheduled_at IS NOT NULL AND delete_scheduled_at <= ?")
    .all(now) as Array<{ id: string }>;
  const tableDeletes = [
    'login_sessions',
    'verification_codes',
    'oauth_login_states',
    'auth_identities',
    'auth_password_credentials',
    'analytics_events',
    'diagnostic_log_uploads',
    'sync_operations',
    'list_folders',
    'lists',
    'tasks',
    'goals',
    'tags',
    'task_tags',
    'task_reminders',
    'task_checklist_items',
    'task_activity_logs',
    'attachments',
    'notifications',
    'notification_permissions',
    'notification_sounds',
    'saved_filters',
    'search_history',
    'desktop_widgets',
    'desktop_shortcuts',
    'desktop_shell_state',
    'desktop_app_lock_credentials',
    'ai_generation_logs',
    'sticky_notes',
    'focus_rest_cycles',
    'focus_sessions',
    'user_sound_cache',
    'calendar_permissions',
    'calendar_subscriptions',
    'external_calendar_events',
    'habits',
    'habit_checkins',
    'countdowns',
    'settings',
  ];
  const ids = users.map((u) => u.id);
  db.exec('BEGIN');
  try {
    for (const id of ids) {
      if (reRegistrationPolicy() === 'block') {
        const identities = db
          .prepare(
            `SELECT type, provider, identifier_hash, display_identifier
             FROM auth_identities
             WHERE user_id = ? AND unbound_at IS NULL`,
          )
          .all(id) as Array<{ type: string; provider: string | null; identifier_hash: string; display_identifier: string | null }>;
        for (const identity of identities) {
          db.prepare(
            `INSERT OR IGNORE INTO deleted_identity_reservations
               (id, deleted_user_id, type, provider, identifier_hash, display_identifier, reserved_at, policy)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'block')`,
          ).run(randomUUID(), id, identity.type, identity.provider ?? null, identity.identifier_hash, identity.display_identifier ?? null, now);
        }
      }
      for (const table of tableDeletes) {
        const col = table === 'verification_codes' ? null : 'user_id';
        if (col) db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(id);
      }
      db.prepare(
        "UPDATE users SET nickname = NULL, avatar_url = NULL, phone_masked = NULL, email_masked = NULL, status = 'deleted' WHERE id = ?",
      ).run(id);
      audit(id, 'account_deletion_finalized', 'user', id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { finalized: users.length, users: users.map((u) => u.id) };
}

export function audit(userId: string | null, action: string, targetType?: string, targetId?: string, ip?: string, userAgent?: string): void {
  db.prepare(
    `INSERT INTO security_audit_logs (id, user_id, action, target_type, target_id, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), userId, action, targetType ?? null, targetId ?? null, ip ?? null, userAgent ?? null, nowISO());
}
