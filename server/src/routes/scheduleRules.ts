import { Router } from 'express';
import { requireUserId } from '../authMiddleware';
import * as aiRepo from '../aiRepo';
import * as repo from '../scheduleRulesRepo';
import { AppError } from '../types';

const router = Router();

router.get('/', (req, res) => {
  res.json({ rules: repo.listScheduleRules(requireUserId(req), { includeDeleted: req.query.includeDeleted === '1' }) });
});

router.get('/templates', (_req, res) => {
  res.json({ templates: repo.listScheduleRuleTemplates() });
});

router.post('/', (req, res) => {
  const rule = repo.createScheduleRule(requireUserId(req), req.body ?? {});
  res.status(201).json({ rule });
});

router.post('/preview', (req, res) => {
  res.json({ preview: repo.previewScheduleRule(requireUserId(req), req.body ?? {}) });
});

router.post('/parse-natural-language', async (req, res, next) => {
  try {
    res.json(await aiRepo.parseScheduleRuleNaturalLanguage(requireUserId(req), req.body ?? {}));
  } catch (e) {
    next(e);
  }
});

router.get('/conflicts', (req, res) => {
  const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
  res.json(repo.listScheduleRuleConflicts(requireUserId(req), { limit }));
});

router.get('/:id/details', (req, res) => {
  const details = repo.getScheduleRuleDetails(requireUserId(req), req.params.id);
  if (!details) throw new AppError(404, 'not_found', 'rule not found');
  res.json({ details });
});

router.get('/:id', (req, res) => {
  const rule = repo.getScheduleRule(requireUserId(req), req.params.id);
  if (!rule) throw new AppError(404, 'not_found', 'rule not found');
  res.json({ rule });
});

router.patch('/:id', (req, res) => {
  const rule = repo.updateScheduleRule(requireUserId(req), req.params.id, req.body ?? {});
  if (!rule) throw new AppError(404, 'not_found', 'rule not found');
  res.json({ rule });
});

router.delete('/:id', (req, res) => {
  const ok = repo.deleteScheduleRule(requireUserId(req), req.params.id);
  if (!ok) throw new AppError(404, 'not_found', 'rule not found');
  res.status(204).end();
});

router.post('/:id/restore', (req, res) => {
  const rule = repo.restoreScheduleRule(requireUserId(req), req.params.id);
  if (!rule) throw new AppError(404, 'not_found', 'rule not found');
  res.json({ rule });
});

export default router;
