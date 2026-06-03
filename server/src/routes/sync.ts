import { Router } from 'express';
import { requireUserId } from '../authMiddleware';
import * as sync from '../syncRepo';

const router = Router();

router.post('/operations', (req, res) => {
  res.json(sync.applyOperations(requireUserId(req), req.body ?? {}));
});

export default router;
