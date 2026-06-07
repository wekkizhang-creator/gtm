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
  let snoozedUntil: string | null = null;
  const minutes = req.body?.minutes;
  if (minutes !== undefined) {
    const n = Number(minutes);
    if (!Number.isInteger(n) || n <= 0 || n > 1440) {
      throw new AppError(400, 'invalid_snooze_minutes', 'minutes must be an integer from 1 to 1440');
    }
    snoozedUntil = new Date(Date.now() + n * 60_000).toISOString();
  } else if (typeof req.body?.snoozedUntil === 'string' && !Number.isNaN(Date.parse(req.body.snoozedUntil))) {
    snoozedUntil = new Date(req.body.snoozedUntil).toISOString();
  }
  if (!snoozedUntil) {
    throw new AppError(400, 'invalid_snooze_until', 'snoozedUntil must be an ISO date string or minutes must be provided');
  }
  if (Date.parse(snoozedUntil) <= Date.now()) {
    throw new AppError(400, 'invalid_snooze_until', 'snoozedUntil must be in the future');
  }
  const notification = repo.snoozeNotification(requireUserId(req), req.params.id, snoozedUntil);
  if (!notification) throw new AppError(404, 'not_found', 'notification not found');
  res.json({ notification });
});

export default router;
