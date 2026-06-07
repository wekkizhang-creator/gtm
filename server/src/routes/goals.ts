import { Router } from 'express';
import { requireUserId } from '../authMiddleware';
import * as aiRepo from '../aiRepo';
import * as repo from '../repo';
import * as scheduleRulesRepo from '../scheduleRulesRepo';
import { AppError } from '../types';

const router = Router();

router.get('/', (req, res) => {
  res.json({ goals: repo.listGoals(requireUserId(req)) });
});

router.get('/daypilot-dashboard', (req, res) => {
  res.json({ dashboard: repo.getDayPilotDashboard(requireUserId(req), { date: typeof req.query.date === 'string' ? req.query.date : null }) });
});

router.post('/', (req, res) => {
  const b = req.body ?? {};
  if (typeof b.title !== 'string' || !b.title.trim()) {
    throw new AppError(400, 'invalid', 'title is required');
  }
  const result = repo.createGoalWithInitialTasks(requireUserId(req), {
    title: b.title,
    description: b.description ?? null,
    startAt: b.startAt ?? null,
    deadlineAt: b.deadlineAt ?? null,
    priority: b.priority ?? 0,
    totalEstimatedMinutes: b.totalEstimatedMinutes ?? null,
    availableTimeRule: b.availableTimeRule ?? null,
    progressMode: b.progressMode ?? 'auto',
    status: b.status ?? 'active',
    tasksText: b.tasksText ?? null,
    initialTasks: b.initialTasks ?? null,
  });
  res.status(201).json(result);
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
    scheduleEnergyType: b.scheduleEnergyType ?? null,
    scheduleTaskType: b.scheduleTaskType ?? null,
    isSplittable: b.isSplittable ?? false,
    minScheduleMinutes: b.minScheduleMinutes ?? null,
  });
  res.status(201).json({ task });
});

router.post('/:id/tasks/structure', async (req, res, next) => {
  try {
    const result = await aiRepo.structureGoalTasks(requireUserId(req), {
      goalId: req.params.id,
      taskIds: Array.isArray(req.body?.taskIds) ? req.body.taskIds : null,
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post('/:id/auto-schedule', (req, res) => {
  res.json(repo.autoScheduleGoal(requireUserId(req), req.params.id));
});

router.post('/:id/schedule-proposals', (req, res) => {
  const proposal = scheduleRulesRepo.createScheduleProposal(requireUserId(req), req.params.id, req.body ?? {});
  res.status(201).json({ proposal });
});

router.get('/:id/schedule-proposals/recent-confirmed', (req, res) => {
  const proposal = scheduleRulesRepo.getLatestConfirmedScheduleProposal(requireUserId(req), req.params.id);
  res.json({ proposal });
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
