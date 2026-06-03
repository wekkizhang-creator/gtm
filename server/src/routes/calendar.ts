import { Router } from 'express';
import { requireUserId } from '../authMiddleware';
import * as calendar from '../calendarRepo';
import { getCalendarDayInfo } from '../calendarInfo';
import { AppError } from '../types';

const router = Router();

router.get('/events', (req, res) => {
  const from = typeof req.query.from === 'string' ? req.query.from : '';
  const to = typeof req.query.to === 'string' ? req.query.to : '';
  if (!from || !to) throw new AppError(400, 'invalid', 'from and to are required');
  res.json({ events: calendar.listEvents(requireUserId(req), from, to) });
});

router.get('/day-info', (req, res) => {
  const from = typeof req.query.from === 'string' ? req.query.from : '';
  const to = typeof req.query.to === 'string' ? req.query.to : '';
  if (!from || !to) throw new AppError(400, 'invalid', 'from and to are required');
  requireUserId(req);
  res.json({ days: getCalendarDayInfo({ from, to }) });
});

router.get('/subscriptions', (req, res) => {
  res.json({ subscriptions: calendar.listSubscriptions(requireUserId(req)) });
});

router.get('/system-permission', (req, res) => {
  res.json({ permission: calendar.getSystemCalendarPermission(requireUserId(req)) });
});

router.post('/system-permission', (req, res) => {
  res.json({ permission: calendar.updateSystemCalendarPermission(requireUserId(req), req.body ?? {}) });
});

router.post('/system-subscription', async (req, res, next) => {
  try {
    const result = await calendar.createSystemSubscription(requireUserId(req), req.body ?? {});
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

router.post('/subscriptions', (req, res) => {
  const b = req.body ?? {};
  if (typeof b.name !== 'string' || !b.name.trim()) throw new AppError(400, 'invalid', 'name is required');
  const subscription = calendar.createSubscription(requireUserId(req), {
    type: b.type ?? 'ics',
    name: b.name,
    url: b.url ?? null,
    color: b.color ?? null,
    enabled: b.enabled ?? true,
  });
  res.status(201).json({ subscription });
});

router.patch('/subscriptions/:id', (req, res) => {
  const subscription = calendar.updateSubscription(requireUserId(req), req.params.id, req.body ?? {});
  if (!subscription) throw new AppError(404, 'not_found', 'subscription not found');
  res.json({ subscription });
});

router.delete('/subscriptions/:id', (req, res) => {
  if (!calendar.deleteSubscription(requireUserId(req), req.params.id)) throw new AppError(404, 'not_found', 'subscription not found');
  res.status(204).end();
});

router.post('/subscriptions/:id/sync', async (req, res) => {
  res.json(await calendar.syncSubscription(requireUserId(req), req.params.id, { icsText: req.body?.icsText ?? null }));
});

export default router;
