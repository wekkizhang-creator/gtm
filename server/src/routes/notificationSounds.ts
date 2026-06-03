import { Router } from 'express';
import { requireUserId } from '../authMiddleware';
import * as repo from '../repo';
import { AppError } from '../types';

const router = Router();

router.get('/', (req, res) => {
  const purpose = typeof req.query.purpose === 'string' ? req.query.purpose : null;
  res.json({ sounds: repo.listNotificationSounds(requireUserId(req), purpose) });
});

router.post('/', (req, res) => {
  const body = req.body ?? {};
  const sound = repo.createNotificationSound(requireUserId(req), {
    name: body.name,
    purpose: body.purpose ?? 'both',
    mimeType: body.mimeType ?? null,
    contentBase64: body.contentBase64,
  });
  res.status(201).json({ sound });
});

router.get('/:id/download', (req, res) => {
  const sound = repo.getNotificationSoundFile(requireUserId(req), req.params.id);
  if (!sound) throw new AppError(404, 'not_found', 'notification sound not found');
  res.setHeader('Content-Type', sound.mimeType);
  res.download(sound.storagePath, sound.name);
});

export default router;
