import { Router } from 'express';
import { requireUserId } from '../authMiddleware';
import * as repo from '../repo';
import { AppError } from '../types';

const router = Router();

router.get('/:id/download', (req, res) => {
  const file = repo.getAttachmentFile(requireUserId(req), req.params.id);
  if (!file) throw new AppError(404, 'not_found', 'attachment not found');
  res.setHeader('Content-Type', file.mimeType ?? 'application/octet-stream');
  res.download(file.storagePath, file.fileName);
});

export default router;
