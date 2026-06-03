import { Router } from 'express';
import * as auth from '../authRepo';
import { optionalAuth } from '../authMiddleware';
import { AppError } from '../types';
import * as analytics from '../analyticsRepo';
import { createOAuthAuthorization } from '../oauth';

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

router.post('/oauth/:provider/login', async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const device = b.device ?? {};
    if (typeof device.deviceId !== 'string' || !device.deviceId.trim()) {
      throw new AppError(400, 'invalid', 'device.deviceId is required');
    }
    const result = await auth.loginWithOAuth({
      provider: req.params.provider,
      accessToken: b.accessToken,
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
    auth.audit(result.user.id, result.isNewUser ? 'oauth_account_registered' : 'oauth_account_login', 'session', result.session.id, req.ip, req.headers['user-agent']);
    track(req, 'auth_third_party_result', { provider: req.params.provider, success: true, is_new_user: result.isNewUser }, result.user.id, result.session.id);
    track(req, 'auth_login_success', { method: 'oauth', is_new_user: result.isNewUser, has_local_cache: false }, result.user.id, result.session.id);
    if (result.isNewUser) track(req, 'auth_register_success', { method: 'oauth', init_success: true }, result.user.id, result.session.id);
    res.status(result.isNewUser ? 201 : 200).json(result);
  } catch (e) {
    track(req, 'auth_third_party_result', { provider: req.params.provider, success: false, fail_reason: failReason(e), is_new_user: false });
    next(e);
  }
});

router.post('/oauth/:provider/authorize', (req, res, next) => {
  try {
    const authorization = createOAuthAuthorization(req.params.provider, {
      redirectUri: req.body?.redirectUri,
      scope: req.body?.scope,
    });
    track(req, 'auth_third_party_start', { provider: req.params.provider, entry: 'oauth_authorize' });
    res.status(201).json(authorization);
  } catch (e) {
    track(req, 'auth_third_party_start', { provider: req.params.provider, entry: 'oauth_authorize', success: false, fail_reason: failReason(e) });
    next(e);
  }
});

router.post('/oauth/:provider/callback', async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const device = b.device ?? {};
    if (typeof device.deviceId !== 'string' || !device.deviceId.trim()) {
      throw new AppError(400, 'invalid', 'device.deviceId is required');
    }
    const result = await auth.loginWithOAuthCode({
      provider: req.params.provider,
      state: b.state,
      code: b.code,
      redirectUri: b.redirectUri,
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
    auth.audit(result.user.id, result.isNewUser ? 'oauth_code_account_registered' : 'oauth_code_account_login', 'session', result.session.id, req.ip, req.headers['user-agent']);
    track(req, 'auth_third_party_result', { provider: req.params.provider, success: true, is_new_user: result.isNewUser, flow: 'authorization_code' }, result.user.id, result.session.id);
    track(req, 'auth_login_success', { method: 'oauth_code', is_new_user: result.isNewUser, has_local_cache: false }, result.user.id, result.session.id);
    if (result.isNewUser) track(req, 'auth_register_success', { method: 'oauth_code', init_success: true }, result.user.id, result.session.id);
    res.status(result.isNewUser ? 201 : 200).json(result);
  } catch (e) {
    track(req, 'auth_third_party_result', {
      provider: req.params.provider,
      success: false,
      fail_reason: failReason(e),
      is_new_user: false,
      flow: 'authorization_code',
    });
    next(e);
  }
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
