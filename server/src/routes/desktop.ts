import { Router } from 'express';
import { requireUserId } from '../authMiddleware';
import * as desktop from '../desktopRepo';
import { AppError } from '../types';

const router = Router();

router.get('/status', (req, res) => {
  res.json({ status: desktop.getDesktopStatus(requireUserId(req)) });
});

router.patch('/state', (req, res) => {
  res.json({ status: desktop.patchDesktopState(requireUserId(req), req.body ?? {}) });
});

router.post('/window/close-intent', (req, res) => {
  res.json(desktop.resolveWindowCloseIntent(requireUserId(req)));
});

router.get('/widgets', (req, res) => {
  res.json({ widgets: desktop.listWidgets(requireUserId(req)) });
});

router.get('/widget-templates', (_req, res) => {
  res.json({ widgetTemplates: desktop.listWidgetTemplates() });
});

router.post('/widgets', (req, res) => {
  const body = req.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'invalid_desktop_widget', 'body must be an object');
  res.status(201).json({ widget: desktop.createWidget(requireUserId(req), body) });
});

router.get('/widgets/:id/data', (req, res) => {
  res.json({ data: desktop.getWidgetData(requireUserId(req), req.params.id) });
});

router.post('/widgets/:id/actions', (req, res) => {
  res.json(desktop.runWidgetAction(requireUserId(req), req.params.id, req.body ?? {}));
});

router.patch('/widgets/:id', (req, res) => {
  const body = req.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'invalid_desktop_widget', 'body must be an object');
  const widget = desktop.updateWidget(requireUserId(req), req.params.id, body);
  if (!widget) throw new AppError(404, 'not_found', 'widget not found');
  res.json({ widget });
});

router.delete('/widgets/:id', (req, res) => {
  if (!desktop.deleteWidget(requireUserId(req), req.params.id)) throw new AppError(404, 'not_found', 'widget not found');
  res.status(204).end();
});

router.get('/shortcuts', (req, res) => {
  res.json({ shortcuts: desktop.listShortcuts(requireUserId(req)) });
});

router.get('/shortcut-templates', (_req, res) => {
  res.json({ shortcutTemplates: desktop.listShortcutTemplates() });
});

router.post('/shortcuts', (req, res) => {
  const body = req.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'invalid_desktop_shortcut', 'body must be an object');
  res.status(201).json({ shortcut: desktop.createShortcut(requireUserId(req), body) });
});

router.post('/shortcuts/reset', (req, res) => {
  res.json({ shortcuts: desktop.resetShortcuts(requireUserId(req)) });
});

router.patch('/shortcuts/:id', (req, res) => {
  const body = req.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'invalid_desktop_shortcut', 'body must be an object');
  const shortcut = desktop.updateShortcut(requireUserId(req), req.params.id, body);
  if (!shortcut) throw new AppError(404, 'not_found', 'shortcut not found');
  res.json({ shortcut });
});

router.delete('/shortcuts/:id', (req, res) => {
  if (!desktop.deleteShortcut(requireUserId(req), req.params.id)) throw new AppError(404, 'not_found', 'shortcut not found');
  res.status(204).end();
});

router.post('/shortcuts/:id/register', (req, res) => {
  const shortcut = desktop.registerShortcut(requireUserId(req), req.params.id);
  if (!shortcut) throw new AppError(404, 'not_found', 'shortcut not found');
  res.json({ shortcut, status: desktop.getDesktopStatus(requireUserId(req)) });
});

router.post('/app-lock/lock', (req, res) => {
  res.json({ status: desktop.setBridgeLock(requireUserId(req), true) });
});

router.post('/app-lock/unlock', (req, res) => {
  res.json({ status: desktop.setBridgeLock(requireUserId(req), false, req.body ?? {}) });
});

router.put('/app-lock/password', (req, res) => {
  res.json({ status: desktop.setAppLockPassword(requireUserId(req), req.body ?? {}) });
});

router.delete('/app-lock/password', (req, res) => {
  res.json({ status: desktop.clearAppLockPassword(requireUserId(req), req.body ?? {}) });
});

router.post('/app-lock/activity', (req, res) => {
  res.json({ status: desktop.recordBridgeActivity(requireUserId(req), req.body?.occurredAt ?? undefined) });
});

router.post('/app-lock/auto-lock-check', (req, res) => {
  res.json({ status: desktop.evaluateAutoLock(requireUserId(req)) });
});

export default router;
