import { Router } from 'express';
import * as settings from '../settingsRepo';
import { AppError } from '../types';
import { requireUserId } from '../authMiddleware';

const router = Router();

// GET /api/settings
router.get('/', (req, res) => {
  res.json({ settings: settings.getSettings(requireUserId(req)) });
});

// PATCH /api/settings  (deep-merge partial settings; ai.apiKey:'' deletes the key)
router.patch('/', (req, res) => {
  res.json({ settings: settings.patchSettings(requireUserId(req), req.body ?? {}) });
});

// POST /api/settings/reset  { group }
router.post('/reset', (req, res) => {
  const group = req.body?.group;
  if (typeof group !== 'string') throw new AppError(400, 'invalid', 'group is required');
  res.json({ settings: settings.resetGroup(requireUserId(req), group) });
});

// POST /api/settings/ai/test — real connectivity check against the stored AI config
router.post('/ai/test', async (req, res) => {
  const userId = requireUserId(req);
  const cfg = settings.getSettings(userId).ai;
  const key = settings.getRawApiKey(userId);
  if (!cfg.baseUrl) {
    res.json({ ok: false, message: '未配置 Base URL' });
    return;
  }
  if (!key) {
    res.json({ ok: false, message: '未配置 API Key' });
    return;
  }
  const url = cfg.baseUrl.replace(/\/$/, '') + '/models';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: ctrl.signal });
    res.json({ ok: r.ok, message: r.ok ? `连接成功（HTTP ${r.status}）` : `连接失败：HTTP ${r.status}` });
  } catch (e) {
    res.json({ ok: false, message: '连接失败：' + (e instanceof Error ? e.message : String(e)) });
  } finally {
    clearTimeout(timer);
  }
});

// GET /api/settings/export — download all data as JSON
router.get('/export', (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="efficiency-list-export.json"');
  const req = _req;
  res.json(settings.exportAll(requireUserId(req)));
});

export default router;
