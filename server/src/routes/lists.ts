import { Router } from 'express';
import * as repo from '../repo';
import { AppError } from '../types';

const router = Router();

// GET /api/lists -> custom lists (inbox excluded; it is a smart list in the UI)
router.get('/', (_req, res) => {
  res.json({ lists: repo.listLists() });
});

// POST /api/lists
router.post('/', (req, res) => {
  const { name, color, icon } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    throw new AppError(400, 'invalid', 'name is required');
  }
  res.status(201).json({ list: repo.createList(name.trim(), color ?? null, icon ?? null) });
});

// PATCH /api/lists/:id
router.patch('/:id', (req, res) => {
  const list = repo.updateList(req.params.id, req.body ?? {});
  if (!list) throw new AppError(404, 'not_found', 'list not found');
  res.json({ list });
});

// DELETE /api/lists/:id  (moves its tasks back to inbox)
router.delete('/:id', (req, res) => {
  repo.deleteList(req.params.id);
  res.status(204).end();
});

export default router;
