import { Router } from 'express';
import { optionalAuth } from '../authMiddleware';
import * as analytics from '../analyticsRepo';

const router = Router();

router.post('/events', optionalAuth, (req, res) => {
  res.status(202).json(analytics.recordEvents(req.auth ?? null, req.body ?? {}, req));
});

export default router;
