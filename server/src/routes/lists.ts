import { Router } from 'express';
import * as repo from '../repo';
import { AppError } from '../types';
import { requireUserId } from '../authMiddleware';

const router = Router();

// GET /api/lists -> custom lists (inbox excluded; it is a smart list in the UI)
router.get('/', (_req, res) => {
  const req = _req;
  res.json({ lists: repo.listLists(requireUserId(req)) });
});

router.get('/folders', (req, res) => {
  res.json({ folders: repo.listFolders(requireUserId(req)) });
});

router.post('/folders', (req, res) => {
  const b = req.body ?? {};
  if (typeof b.name !== 'string' || !b.name.trim()) throw new AppError(400, 'invalid', 'folder name is required');
  res.status(201).json({ folder: repo.createFolder(requireUserId(req), { name: b.name, collapsed: !!b.collapsed, sortOrder: b.sortOrder }) });
});

router.patch('/folders/:id', (req, res) => {
  const folder = repo.updateFolder(requireUserId(req), req.params.id, req.body ?? {});
  if (!folder) throw new AppError(404, 'not_found', 'folder not found');
  res.json({ folder });
});

router.delete('/folders/:id', (req, res) => {
  if (!repo.deleteFolder(requireUserId(req), req.params.id)) throw new AppError(404, 'not_found', 'folder not found');
  res.status(204).end();
});

// POST /api/lists
router.post('/', (req, res) => {
  const { name, color, icon, folderId } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    throw new AppError(400, 'invalid', 'name is required');
  }
  res.status(201).json({ list: repo.createList(requireUserId(req), name.trim(), color ?? null, icon ?? null, folderId ?? null) });
});

// PATCH /api/lists/:id
router.patch('/:id', (req, res) => {
  const list = repo.updateList(requireUserId(req), req.params.id, req.body ?? {});
  if (!list) throw new AppError(404, 'not_found', 'list not found');
  res.json({ list });
});

// DELETE /api/lists/:id  (moves its tasks back to inbox)
router.delete('/:id', (req, res) => {
  repo.deleteList(requireUserId(req), req.params.id);
  res.status(204).end();
});

export default router;
