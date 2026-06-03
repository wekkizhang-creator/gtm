import { Router } from 'express';
import { requireUserId } from '../authMiddleware';
import * as notes from '../notesRepo';
import { AppError } from '../types';

const router = Router();

router.get('/', (req, res) => {
  res.json({ notes: notes.listNotes(requireUserId(req), req.query.includeDeleted === '1') });
});

router.post('/', (req, res) => {
  res.status(201).json({ note: notes.createNote(requireUserId(req), req.body ?? {}) });
});

router.post('/from-task', (req, res) => {
  const taskId = req.body?.taskId;
  if (typeof taskId !== 'string' || !taskId) throw new AppError(400, 'invalid_note', 'taskId is required');
  res.status(201).json({ note: notes.createNoteFromTask(requireUserId(req), taskId) });
});

router.patch('/:id', (req, res) => {
  const note = notes.updateNote(requireUserId(req), req.params.id, req.body ?? {});
  if (!note) throw new AppError(404, 'not_found', 'note not found');
  res.json({ note });
});

router.post('/:id/convert-to-task', (req, res) => {
  const result = notes.convertNoteToTask(requireUserId(req), req.params.id);
  if (!result) throw new AppError(404, 'not_found', 'note not found');
  res.status(201).json(result);
});

router.post('/:id/restore', (req, res) => {
  const note = notes.restoreNote(requireUserId(req), req.params.id);
  if (!note) throw new AppError(404, 'not_found', 'note not found');
  res.json({ note });
});

router.delete('/:id', (req, res) => {
  if (!notes.deleteNote(requireUserId(req), req.params.id)) throw new AppError(404, 'not_found', 'note not found');
  res.status(204).end();
});

export default router;
