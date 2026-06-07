import { Router } from 'express';
import { requireUserId } from '../authMiddleware';
import * as repo from '../repo';
import { AppError } from '../types';

const router = Router();

function parseTypes(value: unknown): string[] | undefined {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
}

router.get('/history', (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json({ history: repo.listSearchHistory(requireUserId(req), limit) });
});

router.delete('/history/:id', (req, res) => {
  if (!repo.deleteSearchHistory(requireUserId(req), req.params.id)) throw new AppError(404, 'not_found', 'search history not found');
  res.status(204).end();
});

router.get('/', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  if (!q.trim()) throw new AppError(400, 'invalid', 'q is required');
  const types =
    typeof req.query.types === 'string'
      ? parseTypes(req.query.types)
      : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json({ results: repo.searchAll(requireUserId(req), { q, types, limit }) });
});

export default router;
