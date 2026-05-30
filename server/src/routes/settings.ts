import { Router } from 'express';
import * as settings from '../settingsRepo';
import { AppError } from '../types';

const router = Router();

// GET /api/settings
router.get('/', (_req, res) => {
  res.json({ settings: settings.getSettings() });
});

// PATCH /api/settings  (deep-merge partial settings; ai.apiKey:'' deletes the key)
router.patch('/', (req, res) => {
  res.json({ settings: settings.patchSettings(req.body ?? {}) });
});

// POST /api/settings/reset  { group }
router.post('/reset', (req, res) => {
  const group = req.body?.group;
  if (typeof group !== 'string') throw new AppError(400, 'invalid', 'group is required');
  res.json({ settings: settings.resetGroup(group) });
});

// POST /api/settings/ai/test — real connectivity check against the stored AI config
router.post('/ai/test', async (_req, res) => {
  const cfg = settings.getSettings().ai;
  const key = settings.getRawApiKey();
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
  res.json(settings.exportAll());
});

export default router;
