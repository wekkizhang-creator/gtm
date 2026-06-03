import { Router } from 'express';
import * as cd from '../countdownsRepo';
import { AppError } from '../types';
import { requireUserId } from '../authMiddleware';

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  if (typeof b.targetDate !== 'string' || !DATE_RE.test(b.targetDate)) {
    throw new AppError(400, 'invalid', 'targetDate must be YYYY-MM-DD');
  }
  const countdown = cd.createCountdown(requireUserId(req), {
    title: b.title.trim(),
    targetDate: b.targetDate,
    icon: b.icon ?? null,
    color: b.color ?? null,
    repeatYearly: !!b.repeatYearly,
    pinned: !!b.pinned,
    note: b.note ?? null,
  });
  res.status(201).json({ countdown });
});

// PATCH /api/countdowns/:id
router.patch('/:id', (req, res) => {
  if (typeof req.body?.targetDate === 'string' && !DATE_RE.test(req.body.targetDate)) {
    throw new AppError(400, 'invalid', 'targetDate must be YYYY-MM-DD');
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
