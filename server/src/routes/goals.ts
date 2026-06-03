import { Router } from 'express';
import { requireUserId } from '../authMiddleware';
import * as repo from '../repo';
import { AppError } from '../types';

const router = Router();

router.get('/', (req, res) => {
  res.json({ goals: repo.listGoals(requireUserId(req)) });
});

router.post('/', (req, res) => {
  const b = req.body ?? {};
  if (typeof b.title !== 'string' || !b.title.trim()) {
    throw new AppError(400, 'invalid', 'title is required');
  }
  const goal = repo.createGoal(requireUserId(req), {
    title: b.title,
    description: b.description ?? null,
    startAt: b.startAt ?? null,
    deadlineAt: b.deadlineAt ?? null,
    totalEstimatedMinutes: b.totalEstimatedMinutes ?? null,
    availableTimeRule: b.availableTimeRule ?? null,
    progressMode: b.progressMode ?? 'auto',
    status: b.status ?? 'active',
  });
  res.status(201).json({ goal });
});

router.get('/:id/tree', (req, res) => {
  const tree = repo.getGoalTree(requireUserId(req), req.params.id);
  if (!tree) throw new AppError(404, 'not_found', 'goal not found');
  res.json(tree);
});

router.post('/:id/tasks', (req, res) => {
  const b = req.body ?? {};
  if (typeof b.title !== 'string' || !b.title.trim()) {
    throw new AppError(400, 'invalid', 'title is required');
  }
  const task = repo.createGoalTask(requireUserId(req), req.params.id, {
    title: b.title,
    note: b.note ?? null,
    parentId: b.parentId ?? null,
    priority: b.priority ?? 0,
    estimatedMinutes: b.estimatedMinutes ?? null,
  });
  res.status(201).json({ task });
});

router.post('/:id/auto-schedule', (req, res) => {
  res.json(repo.autoScheduleGoal(requireUserId(req), req.params.id));
});

router.patch('/:id', (req, res) => {
  const goal = repo.updateGoal(requireUserId(req), req.params.id, req.body ?? {});
  if (!goal) throw new AppError(404, 'not_found', 'goal not found');
  res.json({ goal });
});

router.delete('/:id', (req, res) => {
  const ok = repo.deleteGoal(requireUserId(req), req.params.id);
  if (!ok) throw new AppError(404, 'not_found', 'goal not found');
  res.status(204).end();
});

export default router;
