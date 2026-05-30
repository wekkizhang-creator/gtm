import { Router } from 'express';
import * as focus from '../focusRepo';
import { AppError } from '../types';

const router = Router();

// GET /api/focus/sessions?limit=100
router.get('/sessions', (req, res) => {
  const raw = Number(req.query.limit ?? 100);
  const limit = Math.min(500, Math.max(1, Number.isFinite(raw) ? raw : 100));
  res.json({ sessions: focus.listSessions(limit) });
});

// POST /api/focus/sessions
router.post('/sessions', (req, res) => {
  const b = req.body ?? {};
  const session = focus.createSession({
    taskId: b.taskId ?? null,
    mode: b.mode,
    startedAt: b.startedAt,
    endedAt: b.endedAt,
    durationSec: b.durationSec,
    isPomodoro: !!b.isPomodoro,
    note: b.note ?? null,
  });
  res.status(201).json({ session });
});

// DELETE /api/focus/sessions/:id
router.delete('/sessions/:id', (req, res) => {
  if (!focus.deleteSession(req.params.id)) throw new AppError(404, 'not_found', 'session not found');
  res.status(204).end();
});

// GET /api/focus/stats
router.get('/stats', (_req, res) => {
  res.json({ stats: focus.stats() });
});

export default router;
