import { Router } from 'express';
import { requireUserId } from '../authMiddleware';
import * as repo from '../repo';
import { AppError } from '../types';

const router = Router();

router.get('/', (req, res) => {
  const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json({ notifications: repo.listNotifications(requireUserId(req), { unreadOnly, limit }) });
});

router.get('/permission', (req, res) => {
  res.json({ permission: repo.getNotificationPermission(requireUserId(req)) });
});

router.post('/permission', (req, res) => {
  res.json({ permission: repo.updateNotificationPermission(requireUserId(req), req.body ?? {}) });
});

router.post('/:id/read', (req, res) => {
  const notification = repo.markNotificationRead(requireUserId(req), req.params.id);
  if (!notification) throw new AppError(404, 'not_found', 'notification not found');
  res.json({ notification });
});

router.post('/:id/snooze', (req, res) => {
  const snoozedUntil = req.body?.snoozedUntil;
  if (typeof snoozedUntil !== 'string' || Number.isNaN(Date.parse(snoozedUntil))) {
    throw new AppError(400, 'invalid', 'snoozedUntil must be an ISO date string');
  }
  const notification = repo.snoozeNotification(requireUserId(req), req.params.id, snoozedUntil);
  if (!notification) throw new AppError(404, 'not_found', 'notification not found');
  res.json({ notification });
});

export default router;
