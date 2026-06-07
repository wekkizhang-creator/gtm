import { Router } from 'express';
import * as cd from '../countdownsRepo';
import { isValidCountdownDate } from '../countdownDates';
import { AppError } from '../types';
import { requireUserId } from '../authMiddleware';

const router = Router();

// GET /api/countdowns
router.get('/', (req, res) => {
  res.json({ countdowns: cd.listCountdowns(requireUserId(req)) });
});

// POST /api/countdowns
router.post('/', (req, res) => {
  const b = req.body ?? {};
  if (typeof b.title !== 'string' || !b.title.trim()) {
    throw new AppError(400, 'invalid', 'title is required');
  }
  if (typeof b.targetDate !== 'string' || !isValidCountdownDate(b.targetDate)) {
    throw new AppError(400, 'invalid_countdown_date', 'targetDate must be a real YYYY-MM-DD date');
  }
  const countdown = cd.createCountdown(requireUserId(req), {
    title: b.title.trim(),
    targetDate: b.targetDate,
    mode: b.mode,
    icon: b.icon ?? null,
    color: b.color ?? null,
    repeatYearly: !!b.repeatYearly,
    pinned: !!b.pinned,
    note: b.note ?? null,
  });
  res.status(201).json({ countdown });
});

// POST /api/countdowns/reorder
router.post('/reorder', (req, res) => {
  const orderedIds = req.body?.orderedIds;
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'string')) {
    throw new AppError(400, 'invalid_countdown_order', 'orderedIds must be a string array');
  }
  res.json({ countdowns: cd.reorderCountdowns(requireUserId(req), orderedIds) });
});

// PATCH /api/countdowns/:id
router.patch('/:id', (req, res) => {
  if ('targetDate' in (req.body ?? {}) && !isValidCountdownDate(req.body.targetDate)) {
    throw new AppError(400, 'invalid_countdown_date', 'targetDate must be a real YYYY-MM-DD date');
  }
  const countdown = cd.updateCountdown(requireUserId(req), req.params.id, req.body ?? {});
  if (!countdown) throw new AppError(404, 'not_found', 'countdown not found');
  res.json({ countdown });
});

// DELETE /api/countdowns/:id
router.delete('/:id', (req, res) => {
  if (!cd.deleteCountdown(requireUserId(req), req.params.id)) throw new AppError(404, 'not_found', 'countdown not found');
  res.status(204).end();
});

export default router;
