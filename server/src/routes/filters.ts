import { Router } from 'express';
import { requireUserId } from '../authMiddleware';
import * as repo from '../repo';
import { AppError } from '../types';

const router = Router();

router.get('/', (req, res) => {
  res.json({ filters: repo.listSavedFilters(requireUserId(req)) });
});

router.post('/', (req, res) => {
  const b = req.body ?? {};
  if (typeof b.name !== 'string' || !b.name.trim()) throw new AppError(400, 'invalid', 'name is required');
  const filter = repo.createSavedFilter(requireUserId(req), { name: b.name, query: b.query ?? {}, sortOrder: b.sortOrder });
  res.status(201).json({ filter });
});

router.patch('/:id', (req, res) => {
  const filter = repo.updateSavedFilter(requireUserId(req), req.params.id, req.body ?? {});
  if (!filter) throw new AppError(404, 'not_found', 'filter not found');
  res.json({ filter });
});

router.delete('/:id', (req, res) => {
  if (!repo.deleteSavedFilter(requireUserId(req), req.params.id)) throw new AppError(404, 'not_found', 'filter not found');
  res.status(204).end();
});

export default router;
