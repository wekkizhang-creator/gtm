import { Router } from 'express';
import { requireUserId } from '../authMiddleware';
import * as repo from '../repo';
import { AppError } from '../types';

const router = Router();

router.get('/', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  if (!q.trim()) throw new AppError(400, 'invalid', 'q is required');
  const types =
    typeof req.query.types === 'string'
      ? req.query.types
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json({ results: repo.searchAll(requireUserId(req), { q, types, limit }) });
});

export default router;
