import { Router } from 'express';
import { requireUserId } from '../authMiddleware';
import * as ai from '../aiRepo';

const router = Router();

router.post('/task-breakdown', async (req, res, next) => {
  try {
    const result = await ai.breakdownTask(requireUserId(req), {
      taskId: req.body?.taskId ?? null,
      title: req.body?.title ?? null,
      note: req.body?.note ?? null,
      maxItems: req.body?.maxItems ?? null,
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post('/quadrant-suggestion', async (req, res, next) => {
  try {
    const result = await ai.suggestQuadrant(requireUserId(req), {
      taskId: req.body?.taskId ?? null,
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post('/weekly-review', async (req, res, next) => {
  try {
    const result = await ai.weeklyReview(requireUserId(req), {
      from: req.body?.from ?? null,
      to: req.body?.to ?? null,
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post('/schedule-suggestion', async (req, res, next) => {
  try {
    const result = await ai.scheduleSuggestions(requireUserId(req), {
      goalId: req.body?.goalId ?? null,
      taskIds: Array.isArray(req.body?.taskIds) ? req.body.taskIds : null,
      from: req.body?.from ?? null,
      to: req.body?.to ?? null,
    });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
