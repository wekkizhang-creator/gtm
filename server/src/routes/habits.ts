import { Router } from 'express';
import * as habits from '../habitsRepo';
import { AppError } from '../types';

const router = Router();

// GET /api/habits?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/', (req, res) => {
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  res.json({ habits: habits.listHabits(from, to) });
});

// POST /api/habits
router.post('/', (req, res) => {
  const b = req.body ?? {};
  if (typeof b.name !== 'string' || !b.name.trim()) {
    throw new AppError(400, 'invalid', 'name is required');
  }
  const habit = habits.createHabit({
    name: b.name.trim(),
    icon: b.icon ?? null,
    color: b.color ?? null,
    daysOfWeek: Array.isArray(b.daysOfWeek) ? b.daysOfWeek : null,
    note: b.note ?? null,
  });
  res.status(201).json({ habit });
});

// PATCH /api/habits/:id
router.patch('/:id', (req, res) => {
  const habit = habits.updateHabit(req.params.id, req.body ?? {});
  if (!habit) throw new AppError(404, 'not_found', 'habit not found');
  res.json({ habit });
});

// DELETE /api/habits/:id
router.delete('/:id', (req, res) => {
  if (!habits.deleteHabit(req.params.id)) throw new AppError(404, 'not_found', 'habit not found');
  res.status(204).end();
});

// POST /api/habits/:id/toggle  { date }
router.post('/:id/toggle', (req, res) => {
  const date = req.body?.date;
  if (typeof date !== 'string') throw new AppError(400, 'invalid', 'date is required');
  res.json(habits.toggleCheckin(req.params.id, date));
});

export default router;
