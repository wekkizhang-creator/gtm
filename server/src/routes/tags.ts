import { Router } from 'express';
import { requireUserId } from '../authMiddleware';
import * as repo from '../repo';
import { AppError } from '../types';

const router = Router();

router.get('/', (req, res) => {
  res.json({ tags: repo.listTags(requireUserId(req)) });
});

router.post('/', (req, res) => {
  const b = req.body ?? {};
  if (typeof b.name !== 'string' || !b.name.trim()) {
    throw new AppError(400, 'invalid', 'name is required');
  }
  const tag = repo.createTag(requireUserId(req), { name: b.name, color: b.color ?? null, parentId: b.parentId ?? null });
  res.status(201).json({ tag });
});

router.post('/:id/merge', (req, res) => {
  const targetId = req.body?.targetId;
  if (typeof targetId !== 'string' || !targetId.trim()) {
    throw new AppError(400, 'invalid', 'targetId is required');
  }
  res.json({ merge: repo.mergeTag(requireUserId(req), req.params.id, targetId) });
});

router.patch('/:id', (req, res) => {
  const tag = repo.updateTag(requireUserId(req), req.params.id, req.body ?? {});
  if (!tag) throw new AppError(404, 'not_found', 'tag not found');
  res.json({ tag });
});

router.delete('/:id', (req, res) => {
  const ok = repo.deleteTag(requireUserId(req), req.params.id);
  if (!ok) throw new AppError(404, 'not_found', 'tag not found');
  res.status(204).end();
});

export default router;
