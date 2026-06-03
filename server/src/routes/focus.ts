import { Router } from 'express';
import * as focus from '../focusRepo';
import { AppError } from '../types';
import { requireUserId } from '../authMiddleware';

const router = Router();

// GET /api/focus/sessions?limit=100
router.get('/sessions', (req, res) => {
  const raw = Number(req.query.limit ?? 100);
  const limit = Math.min(500, Math.max(1, Number.isFinite(raw) ? raw : 100));
  res.json({ sessions: focus.listSessions(requireUserId(req), limit) });
});

// POST /api/focus/sessions
router.post('/sessions', (req, res) => {
  const b = req.body ?? {};
  const session = focus.createSession(requireUserId(req), {
    taskId: b.taskId ?? null,
    mode: b.mode,
    startedAt: b.startedAt,
    endedAt: b.endedAt,
    durationSec: b.durationSec,
    isPomodoro: !!b.isPomodoro,
    backgroundSoundId: Object.prototype.hasOwnProperty.call(b, 'backgroundSoundId') ? b.backgroundSoundId : undefined,
    backgroundVolume: Object.prototype.hasOwnProperty.call(b, 'backgroundVolume') ? b.backgroundVolume : undefined,
    soundPlayedDuration: Object.prototype.hasOwnProperty.call(b, 'soundPlayedDuration') ? b.soundPlayedDuration : undefined,
    isMuted: !!b.isMuted,
    note: b.note ?? null,
  });
  res.status(201).json({ session });
});

// DELETE /api/focus/sessions/:id
router.delete('/sessions/:id', (req, res) => {
  if (!focus.deleteSession(requireUserId(req), req.params.id)) throw new AppError(404, 'not_found', 'session not found');
  res.status(204).end();
});

router.get('/rest-cycles', (req, res) => {
  const raw = Number(req.query.limit ?? 100);
  const limit = Math.min(500, Math.max(1, Number.isFinite(raw) ? raw : 100));
  res.json({ restCycles: focus.listRestCycles(requireUserId(req), limit) });
});

router.post('/rest-cycles', (req, res) => {
  const cycle = focus.createRestCycle(requireUserId(req), req.body ?? {});
  res.status(201).json({ restCycle: cycle });
});

// GET /api/focus/stats
router.get('/stats', (req, res) => {
  res.json({ stats: focus.stats(requireUserId(req)) });
});

router.get('/sounds', (req, res) => {
  res.json({ sounds: focus.listSounds(requireUserId(req)) });
});

router.post('/sounds/:id/cache', (req, res) => {
  res.json({ sound: focus.cacheSound(requireUserId(req), req.params.id) });
});

router.delete('/sounds/:id/cache', (req, res) => {
  if (!focus.deleteCachedSound(requireUserId(req), req.params.id)) throw new AppError(404, 'not_found', 'cached sound not found');
  res.status(204).end();
});

router.get('/reports', (req, res) => {
  const range = req.query.range === 'week' || req.query.range === 'month' ? req.query.range : 'day';
  res.json({ report: focus.report(requireUserId(req), range) });
});

router.get('/achievements', (req, res) => {
  res.json({ achievements: focus.achievements(requireUserId(req)) });
});

export default router;
