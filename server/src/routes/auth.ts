import { Router, type Request } from 'express';
import * as auth from '../authRepo';
import { optionalAuth } from '../authMiddleware';
import { AppError } from '../types';
import * as analytics from '../analyticsRepo';

const router = Router();

function failReason(err: unknown): string {
  return err instanceof AppError ? err.code : 'internal';
}

function track(
  req: Parameters<typeof analytics.recordServerEvent>[1],
  name: string,
  properties: Record<string, unknown>,
  userId?: string | null,
  sessionId?: string | null,
): void {
  try {
    analytics.recordServerEvent(userId && sessionId ? { userId, sessionId } : null, req, name, properties);
  } catch (err) {
    console.error('[analytics] failed to record auth event:', err);
  }
}

function passwordLoginRequiredError(): AppError {
  return new AppError(400, 'password_login_required', 'email verification login is disabled; use email and password');
}

function emailPasswordOnlyError(): AppError {
  return new AppError(400, 'email_password_only', 'registration and login only support email and password');
}

function deviceFromBody(body: any) {
  const device = body?.device ?? {};
  if (typeof device.deviceId !== 'string' || !device.deviceId.trim()) {
    throw new AppError(400, 'invalid', 'device.deviceId is required');
  }
  return {
    deviceId: device.deviceId,
    deviceName: typeof device.deviceName === 'string' ? device.deviceName : null,
    platform: typeof device.platform === 'string' ? device.platform : null,
    appVersion: typeof device.appVersion === 'string' ? device.appVersion : null,
  };
}

function optionalDeviceIdFromBody(body: any): string | null {
  const raw = body?.device?.deviceId ?? body?.deviceId;
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new AppError(400, 'invalid', 'deviceId must be a string');
  const trimmed = raw.trim();
  return trimmed || null;
}

function riskFromRequest(req: Request, body: any): auth.AuthRiskContext {
  return {
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    deviceId: optionalDeviceIdFromBody(body),
  };
}

router.get('/session', optionalAuth, (req, res) => {
  if (!req.auth) throw new AppError(401, 'unauthenticated', 'please sign in');
  res.json(auth.currentSession(req.auth));
});

router.post('/verification-codes', async (req, res, next) => {
  const b = req.body ?? {};
  try {
    if (b.type !== 'email' && b.type !== 'phone') throw new AppError(400, 'invalid_identifier', 'type must be email or phone');
    if (typeof b.identifier !== 'string') throw new AppError(400, 'invalid_identifier', 'identifier is required');
    const purpose = typeof b.purpose === 'string' ? b.purpose : 'login';
    if (purpose === 'login') throw passwordLoginRequiredError();
    if (!['account_bind', 'account_delete'].includes(purpose)) {
      throw new AppError(400, 'invalid', 'use the dedicated registration or password reset endpoint');
    }
    const challenge = await auth.createVerificationCode({
      type: b.type,
      identifier: b.identifier,
      purpose,
      risk: riskFromRequest(req, b),
    });
    auth.audit(null, 'verification_code_requested', b.type, challenge.challengeId, req.ip, req.headers['user-agent']);
    track(req, 'auth_code_send', { method: b.type, success: true, purpose, is_new_identifier: challenge.isNewIdentifier });
    res.status(201).json(challenge);
  } catch (e) {
    if (b.type === 'email' || b.type === 'phone') {
      track(req, 'auth_code_send', {
        method: b.type,
        success: false,
        fail_reason: failReason(e),
        purpose: typeof b.purpose === 'string' ? b.purpose : 'login',
      });
    }
    next(e);
  }
});

router.post('/register/start', async (req, res, next) => {
  const b = req.body ?? {};
  try {
    if (typeof b.email !== 'string') throw new AppError(400, 'invalid_identifier', 'email is required');
    const challenge = await auth.startEmailRegistration({
      email: b.email,
      risk: riskFromRequest(req, b),
    });
    auth.audit(null, 'registration_code_requested', 'email', challenge.challengeId, req.ip, req.headers['user-agent']);
    track(req, 'auth_code_send', { method: 'email', success: true, purpose: 'register', is_new_identifier: challenge.isNewIdentifier });
    res.status(201).json(challenge);
  } catch (e) {
    track(req, 'auth_code_send', { method: 'email', success: false, purpose: 'register', fail_reason: failReason(e) });
    next(e);
  }
});

router.post('/register/complete', (req, res, next) => {
  const b = req.body ?? {};
  try {
    if (typeof b.challengeId !== 'string') throw new AppError(400, 'invalid', 'challengeId is required');
    if (typeof b.code !== 'string') throw new AppError(400, 'invalid', 'code is required');
    const result = auth.completeEmailRegistration({
      challengeId: b.challengeId,
      code: b.code,
      password: b.password,
      agreedToTerms: !!b.agreedToTerms,
      device: deviceFromBody(b),
      res,
      risk: { ip: req.ip, userAgent: req.headers['user-agent'] },
    });
    auth.audit(result.user.id, result.isNewUser ? 'account_registered' : 'account_password_set', 'session', result.session.id, req.ip, req.headers['user-agent']);
    track(req, 'auth_register_success', { method: 'email_password', init_success: true, is_new_user: result.isNewUser }, result.user.id, result.session.id);
    track(req, 'auth_login_success', { method: 'email_password', is_new_user: result.isNewUser, has_local_cache: false }, result.user.id, result.session.id);
    res.status(result.isNewUser ? 201 : 200).json(result);
  } catch (e) {
    track(req, 'auth_register_result', { method: 'email_password', success: false, fail_reason: failReason(e) });
    next(e);
  }
});

router.post('/login/password', (req, res, next) => {
  const b = req.body ?? {};
  try {
    if (typeof b.email !== 'string') throw new AppError(400, 'invalid_identifier', 'email is required');
    const result = auth.loginWithPassword({
      email: b.email,
      password: b.password,
      device: deviceFromBody(b),
      res,
      risk: { ip: req.ip, userAgent: req.headers['user-agent'] },
    });
    auth.audit(result.user.id, 'account_login', 'session', result.session.id, req.ip, req.headers['user-agent']);
    track(req, 'auth_login_success', { method: 'email_password', is_new_user: false, has_local_cache: false }, result.user.id, result.session.id);
    res.json(result);
  } catch (e) {
    track(req, 'auth_login_result', { method: 'email_password', success: false, fail_reason: failReason(e) });
    next(e);
  }
});

router.post('/password-reset/start', async (req, res, next) => {
  const b = req.body ?? {};
  try {
    if (typeof b.email !== 'string') throw new AppError(400, 'invalid_identifier', 'email is required');
    const challenge = await auth.startPasswordReset({
      email: b.email,
      risk: riskFromRequest(req, b),
    });
    auth.audit(null, 'password_reset_code_requested', 'email', challenge.challengeId, req.ip, req.headers['user-agent']);
    track(req, 'auth_code_send', { method: 'email', success: true, purpose: 'password_reset', is_new_identifier: challenge.isNewIdentifier });
    res.status(201).json(challenge);
  } catch (e) {
    track(req, 'auth_code_send', { method: 'email', success: false, purpose: 'password_reset', fail_reason: failReason(e) });
    next(e);
  }
});

router.post('/password-reset/complete', (req, res, next) => {
  const b = req.body ?? {};
  try {
    if (typeof b.challengeId !== 'string') throw new AppError(400, 'invalid', 'challengeId is required');
    if (typeof b.code !== 'string') throw new AppError(400, 'invalid', 'code is required');
    const result = auth.completePasswordReset({
      challengeId: b.challengeId,
      code: b.code,
      password: b.password,
      device: deviceFromBody(b),
      res,
      risk: { ip: req.ip, userAgent: req.headers['user-agent'] },
    });
    auth.audit(result.user.id, 'account_password_reset', 'session', result.session.id, req.ip, req.headers['user-agent']);
    track(req, 'auth_password_reset_success', { method: 'email_password' }, result.user.id, result.session.id);
    track(req, 'auth_login_success', { method: 'email_password', is_new_user: false, has_local_cache: false }, result.user.id, result.session.id);
    res.json(result);
  } catch (e) {
    track(req, 'auth_password_reset_result', { method: 'email_password', success: false, fail_reason: failReason(e) });
    next(e);
  }
});

router.post('/login', (req, _res, next) => {
  const err = passwordLoginRequiredError();
  track(req, 'auth_code_verify', { method: 'legacy_code', success: false, fail_reason: err.code });
  next(err);
});

router.post('/oauth/:provider/login', (req, _res, next) => {
  const err = emailPasswordOnlyError();
  track(req, 'auth_third_party_result', { provider: req.params.provider, success: false, fail_reason: err.code, is_new_user: false });
  next(err);
});

router.post('/oauth/:provider/authorize', (req, _res, next) => {
  const err = emailPasswordOnlyError();
  track(req, 'auth_third_party_start', { provider: req.params.provider, entry: 'oauth_authorize', success: false, fail_reason: err.code });
  next(err);
});

router.post('/oauth/:provider/callback', (req, _res, next) => {
  const err = emailPasswordOnlyError();
  track(req, 'auth_third_party_result', {
    provider: req.params.provider,
    success: false,
    fail_reason: err.code,
    is_new_user: false,
    flow: 'authorization_code',
  });
  next(err);
});

router.post('/refresh', (req, res, next) => {
  try {
    const result = auth.refreshSession(req.headers.cookie, res);
    track(req, 'auth_token_refresh', { success: true }, result.user.id, result.session.id);
    res.json(result);
  } catch (e) {
    track(req, 'auth_token_refresh', { success: false, fail_reason: failReason(e) });
    next(e);
  }
});

router.post('/logout', optionalAuth, (req, res) => {
  const current = req.auth ?? null;
  auth.logout(req.auth ?? null, res);
  track(req, 'auth_logout_success', { device: 'web', cache_status: 'preserved' }, current?.userId, current?.sessionId);
  res.status(204).end();
});

export default router;
