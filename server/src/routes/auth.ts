import { Router } from 'express';
import * as auth from '../authRepo';
import { optionalAuth } from '../authMiddleware';
import { AppError } from '../types';
import * as analytics from '../analyticsRepo';

const router = Router();

function failReason(err: unknown): string {
  return err instanceof AppError ? err.code : 'internal';
}

function track(req: Parameters<typeof analytics.recordServerEvent>[1], name: string, properties: Record<string, unknown>, userId?: string | null, sessionId?: string | null): void {
  try {
    analytics.recordServerEvent(userId && sessionId ? { userId, sessionId } : null, req, name, properties);
  } catch (err) {
    console.error('[analytics] failed to record auth event:', err);
  }
}

function emailLoginOnlyError(): AppError {
  return new AppError(400, 'email_login_only', 'registration and login only support email verification');
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
    if (purpose === 'login' && b.type !== 'email') {
      throw emailLoginOnlyError();
    }
    const challenge = await auth.createVerificationCode({
      type: b.type,
      identifier: b.identifier,
      purpose,
      risk: { ip: req.ip, userAgent: req.headers['user-agent'] },
    });
    auth.audit(null, 'verification_code_requested', b.type, challenge.challengeId, req.ip, req.headers['user-agent']);
    track(req, 'auth_code_send', { method: b.type, success: true, purpose, is_new_identifier: challenge.isNewIdentifier });
    res.status(201).json(challenge);
  } catch (e) {
    if (b.type === 'email' || b.type === 'phone') {
      track(req, 'auth_code_send', { method: b.type, success: false, fail_reason: failReason(e), purpose: typeof b.purpose === 'string' ? b.purpose : 'login' });
    }
    next(e);
  }
});

router.post('/login', (req, res, next) => {
  const b = req.body ?? {};
  const method = typeof b.challengeId === 'string' ? auth.verificationMethod(b.challengeId) : null;
  try {
    if (typeof b.challengeId !== 'string') throw new AppError(400, 'invalid', 'challengeId is required');
    if (typeof b.code !== 'string') throw new AppError(400, 'invalid', 'code is required');
    const device = b.device ?? {};
    if (typeof device.deviceId !== 'string' || !device.deviceId.trim()) {
      throw new AppError(400, 'invalid', 'device.deviceId is required');
    }
    const result = auth.loginWithCode({
      challengeId: b.challengeId,
      code: b.code,
      agreedToTerms: !!b.agreedToTerms,
      device: {
        deviceId: device.deviceId,
        deviceName: typeof device.deviceName === 'string' ? device.deviceName : null,
        platform: typeof device.platform === 'string' ? device.platform : null,
        appVersion: typeof device.appVersion === 'string' ? device.appVersion : null,
      },
      res,
      risk: { ip: req.ip, userAgent: req.headers['user-agent'] },
    });
    auth.audit(result.user.id, result.isNewUser ? 'account_registered' : 'account_login', 'session', result.session.id, req.ip, req.headers['user-agent']);
    track(req, 'auth_code_verify', { method: result.method, success: true }, result.user.id, result.session.id);
    track(req, 'auth_login_success', { method: result.method, is_new_user: result.isNewUser, has_local_cache: false }, result.user.id, result.session.id);
    if (result.isNewUser) track(req, 'auth_register_success', { method: result.method, init_success: true }, result.user.id, result.session.id);
    res.status(result.isNewUser ? 201 : 200).json(result);
  } catch (e) {
    track(req, 'auth_code_verify', { method: method ?? 'unknown', success: false, fail_reason: failReason(e) });
    next(e);
  }
});

router.post('/oauth/:provider/login', (req, _res, next) => {
  const err = emailLoginOnlyError();
  track(req, 'auth_third_party_result', { provider: req.params.provider, success: false, fail_reason: err.code, is_new_user: false });
  next(err);
});

router.post('/oauth/:provider/authorize', (req, _res, next) => {
  const err = emailLoginOnlyError();
  track(req, 'auth_third_party_start', { provider: req.params.provider, entry: 'oauth_authorize', success: false, fail_reason: err.code });
  next(err);
});

router.post('/oauth/:provider/callback', (req, _res, next) => {
  const err = emailLoginOnlyError();
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
