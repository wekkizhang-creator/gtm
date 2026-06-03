import { Router } from 'express';
import * as habits from '../habitsRepo';
import { AppError } from '../types';
import { requireUserId } from '../authMiddleware';

const router = Router();

// GET /api/habits?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/', (req, res) => {
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  res.json({ habits: habits.listHabits(requireUserId(req), from, to) });
});

// POST /api/habits
router.post('/', (req, res) => {
  const b = req.body ?? {};
  if (typeof b.name !== 'string' || !b.name.trim()) {
    throw new AppError(400, 'invalid', 'name is required');
  }
  const habit = habits.createHabit(requireUserId(req), {
    name: b.name.trim(),
    icon: b.icon ?? null,
    color: b.color ?? null,
    daysOfWeek: Array.isArray(b.daysOfWeek) ? b.daysOfWeek : null,
    targetType: b.targetType ?? 'check',
    targetValue: b.targetValue ?? null,
    targetUnit: b.targetUnit ?? null,
    startDate: b.startDate ?? null,
    groupName: b.groupName ?? null,
    reminderTime: b.reminderTime ?? null,
    note: b.note ?? null,
  });
  res.status(201).json({ habit });
});

// GET /api/habits/:id
router.get('/:id', (req, res) => {
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  const habit = habits.getHabit(requireUserId(req), req.params.id, from, to);
  if (!habit) throw new AppError(404, 'not_found', 'habit not found');
  res.json({ habit });
});

// GET /api/habits/:id/stats?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/:id/stats', (req, res) => {
  const from = typeof req.query.from === 'string' ? req.query.from : '';
  const to = typeof req.query.to === 'string' ? req.query.to : '';
  res.json({ stats: habits.habitStats(requireUserId(req), req.params.id, from, to) });
});

// POST /api/habits/:id/archive
router.post('/:id/archive', (req, res) => {
  const habit = habits.archiveHabit(requireUserId(req), req.params.id);
  if (!habit) throw new AppError(404, 'not_found', 'habit not found');
  res.json({ habit });
});

// PATCH /api/habits/:id
router.patch('/:id', (req, res) => {
  const habit = habits.updateHabit(requireUserId(req), req.params.id, req.body ?? {});
  if (!habit) throw new AppError(404, 'not_found', 'habit not found');
  res.json({ habit });
});

// DELETE /api/habits/:id
router.delete('/:id', (req, res) => {
  if (!habits.deleteHabit(requireUserId(req), req.params.id)) throw new AppError(404, 'not_found', 'habit not found');
  res.status(204).end();
});

// POST /api/habits/:id/toggle  { date }
router.post('/:id/toggle', (req, res) => {
  const date = req.body?.date;
  if (typeof date !== 'string') throw new AppError(400, 'invalid', 'date is required');
  res.json(habits.toggleCheckin(requireUserId(req), req.params.id, date, req.body?.value ?? null, req.body?.note ?? null));
});

export default router;
