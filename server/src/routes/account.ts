import { Router } from 'express';
import * as auth from '../authRepo';
import * as sync from '../syncRepo';
import { requireAuth } from '../authMiddleware';
import { AppError } from '../types';
import * as analytics from '../analyticsRepo';
import { createOAuthAuthorization } from '../oauth';

const router = Router();

function failReason(err: unknown): string {
  return err instanceof AppError ? err.code : 'internal';
}

function track(req: Parameters<typeof analytics.recordServerEvent>[1], name: string, properties: Record<string, unknown>): void {
  try {
    analytics.recordServerEvent(req.auth ?? null, req, name, properties);
  } catch (err) {
    console.error('[analytics] failed to record account event:', err);
  }
}

router.post('/deletion/finalize-due', (req, res) => {
  const token = req.headers['x-runner-token'];
  const expected = process.env.ACCOUNT_DELETION_RUNNER_TOKEN;
  if (!expected || token !== expected) throw new AppError(403, 'forbidden', 'runner token is invalid');
  res.json(auth.finalizeDueAccountDeletions(typeof req.body?.now === 'string' ? req.body.now : undefined));
});

router.use(requireAuth);

router.get('/', (req, res) => {
  res.json({ user: auth.getAccount(req.auth!.userId) });
});

router.get('/onboarding', (req, res) => {
  res.json({ onboarding: auth.accountOnboardingStatus(req.auth!.userId) });
});

router.patch('/', (req, res) => {
  const user = auth.updateAccount(req.auth!.userId, req.body ?? {});
  auth.audit(user.id, 'account_updated', 'user', user.id, req.ip, req.headers['user-agent']);
  res.json({ user });
});

router.get('/sessions', (req, res) => {
  res.json({ sessions: auth.listSessions(req.auth!.userId, req.auth!.sessionId) });
});

router.get('/identities', (req, res) => {
  res.json({ identities: auth.listIdentities(req.auth!.userId) });
});

router.get('/local-cache', (req, res) => {
  res.json({ cache: auth.localCacheSummary(req.auth!.userId) });
});

router.get('/sync-status', (req, res) => {
  res.json({ syncStatus: sync.accountSyncStatus(req.auth!.userId) });
});

router.post('/local-cache/clear', (req, res) => {
  const result = auth.clearLocalCache(req.auth!.userId);
  track(req, 'auth_cache_clear', { cache_type: 'all', success: true, sound_cache_cleared: result.soundCacheCleared });
  res.json({ cache: result });
});

router.post('/email/bind', (req, res, next) => {
  try {
    const result = auth.bindEmail(req.auth!.userId, req.body ?? {});
    track(req, 'auth_binding_result', { identity_type: 'email', success: true, remaining_identity_count: result.identities.length });
    res.json(result);
  } catch (e) {
    track(req, 'auth_binding_result', { identity_type: 'email', success: false, fail_reason: failReason(e), conflict_type: failReason(e) === 'identity_already_bound' ? 'identity' : null });
    next(e);
  }
});

router.post('/phone/bind', (req, res, next) => {
  try {
    const result = auth.bindPhone(req.auth!.userId, req.body ?? {});
    track(req, 'auth_binding_result', { identity_type: 'phone', success: true, remaining_identity_count: result.identities.length });
    res.json(result);
  } catch (e) {
    track(req, 'auth_binding_result', { identity_type: 'phone', success: false, fail_reason: failReason(e), conflict_type: failReason(e) === 'identity_already_bound' ? 'identity' : null });
    next(e);
  }
});

router.post('/oauth/:provider/bind', async (req, res, next) => {
  try {
    const result = await auth.bindOAuth(req.auth!.userId, req.params.provider, req.body ?? {});
    track(req, 'auth_binding_result', { identity_type: 'oauth', provider: req.params.provider, success: true, remaining_identity_count: result.identities.length });
    res.json(result);
  } catch (e) {
    track(req, 'auth_binding_result', {
      identity_type: 'oauth',
      provider: req.params.provider,
      success: false,
      fail_reason: failReason(e),
      conflict_type: failReason(e) === 'identity_already_bound' ? 'identity' : null,
    });
    next(e);
  }
});

router.post('/oauth/:provider/authorize', (req, res, next) => {
  try {
    const authorization = createOAuthAuthorization(req.params.provider, {
      redirectUri: req.body?.redirectUri,
      scope: req.body?.scope,
      purpose: 'account_bind',
      userId: req.auth!.userId,
    });
    track(req, 'auth_binding_start', { identity_type: 'oauth', provider: req.params.provider, entry: 'settings', flow: 'authorization_code' });
    res.status(201).json(authorization);
  } catch (e) {
    track(req, 'auth_binding_result', {
      identity_type: 'oauth',
      provider: req.params.provider,
      success: false,
      fail_reason: failReason(e),
      flow: 'authorization_code',
    });
    next(e);
  }
});

router.post('/oauth/:provider/callback', async (req, res, next) => {
  try {
    const result = await auth.bindOAuthCode(req.auth!.userId, req.params.provider, req.body ?? {});
    track(req, 'auth_binding_result', {
      identity_type: 'oauth',
      provider: req.params.provider,
      success: true,
      remaining_identity_count: result.identities.length,
      flow: 'authorization_code',
    });
    res.json(result);
  } catch (e) {
    track(req, 'auth_binding_result', {
      identity_type: 'oauth',
      provider: req.params.provider,
      success: false,
      fail_reason: failReason(e),
      conflict_type: failReason(e) === 'identity_already_bound' ? 'identity' : null,
      flow: 'authorization_code',
    });
    next(e);
  }
});

router.delete('/identities/:id', (req, res, next) => {
  const before = auth.listIdentities(req.auth!.userId).find((identity) => identity.id === req.params.id);
  try {
    const result = auth.unbindIdentity(req.auth!.userId, req.params.id);
    track(req, 'auth_unbind_result', { identity_type: before?.type ?? 'unknown', success: true, remaining_identity_count: result.identities.length });
    res.json(result);
  } catch (e) {
    track(req, 'auth_unbind_result', {
      identity_type: before?.type ?? 'unknown',
      success: false,
      fail_reason: failReason(e),
      remaining_identity_count: auth.listIdentities(req.auth!.userId).length,
    });
    next(e);
  }
});

router.delete('/sessions/:id', (req, res) => {
  if (!auth.revokeSession(req.auth!.userId, req.params.id)) throw new AppError(404, 'not_found', 'session not found');
  auth.audit(req.auth!.userId, 'session_revoked', 'session', req.params.id, req.ip, req.headers['user-agent']);
  track(req, 'auth_device_logout', { target_session_id: req.params.id, is_current_device: req.params.id === req.auth!.sessionId, success: true });
  res.status(204).end();
});

router.get('/deletion/preview', (req, res) => {
  res.json(auth.accountDeletionPreview(req.auth!.userId));
});

router.post('/deletion/request', (req, res) => {
  const result = auth.requestAccountDeletion(req.auth!.userId, req.body ?? {});
  auth.clearAuthCookies(res);
  track(req, 'auth_delete_account_confirm', { has_export_prompt: true, cooling_period_days: result.coolingDays });
  res.json(result);
});

router.post('/deletion/cancel', (req, res) => {
  const user = auth.cancelAccountDeletion(req.auth!.userId);
  track(req, 'auth_delete_account_cancel', { days_since_request: 0 });
  res.json({ user });
});

export default router;
