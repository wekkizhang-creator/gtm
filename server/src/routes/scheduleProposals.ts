import { Router } from 'express';
import { requireUserId } from '../authMiddleware';
import * as repo from '../scheduleRulesRepo';
import { AppError } from '../types';

const router = Router();

router.get('/:id', (req, res) => {
  const proposal = repo.getScheduleProposal(requireUserId(req), req.params.id);
  if (!proposal) throw new AppError(404, 'not_found', 'proposal not found');
  res.json({ proposal });
});

router.patch('/:id/changes/:changeKey', (req, res) => {
  const proposal = repo.updateScheduleProposalChange(requireUserId(req), req.params.id, req.params.changeKey, req.body ?? {});
  res.json({ proposal });
});

router.post('/:id/confirm', (req, res) => {
  res.json(repo.confirmScheduleProposal(requireUserId(req), req.params.id, req.body ?? {}));
});

router.post('/:id/undo', (req, res) => {
  res.json(repo.undoScheduleProposal(requireUserId(req), req.params.id));
});

router.post('/:id/discard', (req, res) => {
  const proposal = repo.discardScheduleProposal(requireUserId(req), req.params.id);
  res.json({ proposal });
});

export default router;
