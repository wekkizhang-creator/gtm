import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import './db'; // initialize schema + inbox on boot
import listsRouter from './routes/lists';
import tasksRouter from './routes/tasks';
import tagsRouter from './routes/tags';
import attachmentsRouter from './routes/attachments';
import goalsRouter from './routes/goals';
import notificationsRouter from './routes/notifications';
import notificationSoundsRouter from './routes/notificationSounds';
import searchRouter from './routes/search';
import calendarRouter from './routes/calendar';
import importRouter from './routes/importData';
import filtersRouter from './routes/filters';
import desktopRouter from './routes/desktop';
import aiRouter from './routes/ai';
import notesRouter from './routes/notes';
import focusRouter from './routes/focus';
import habitsRouter from './routes/habits';
import countdownsRouter from './routes/countdowns';
import settingsRouter from './routes/settings';
import authRouter from './routes/auth';
import accountRouter from './routes/account';
import aboutRouter from './routes/about';
import analyticsRouter from './routes/analytics';
import syncRouter from './routes/sync';
import * as repo from './repo';
import { AppError } from './types';
import { requireAuth, requireNormalAccount } from './authMiddleware';

const app = express();
app.use(cors());
app.use(express.json({ limit: '3mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/auth', authRouter);
app.use('/api/account', accountRouter);
app.use('/api/about', aboutRouter);
app.use('/api/analytics', analyticsRouter);

app.use('/api', requireAuth, requireNormalAccount);

app.get('/api/smart-lists', (req, res) => {
  res.json({ counts: repo.smartCounts(req.auth!.userId) });
});

app.use('/api/lists', listsRouter);
app.use('/api/tags', tagsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/attachments', attachmentsRouter);
app.use('/api/goals', goalsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/notification-sounds', notificationSoundsRouter);
app.use('/api/search', searchRouter);
app.use('/api/calendar', calendarRouter);
app.use('/api/import', importRouter);
app.use('/api/filters', filtersRouter);
app.use('/api/desktop', desktopRouter);
app.use('/api/ai', aiRouter);
app.use('/api/notes', notesRouter);
app.use('/api/focus', focusRouter);
app.use('/api/habits', habitsRouter);
app.use('/api/countdowns', countdownsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/sync', syncRouter);

app.post('/api/reminder-runner/tick', (req, res) => {
  res.json(repo.runReminderTick(req.auth!.userId));
});

// unknown API route
app.use('/api', (_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint' } });
});

// central error handler -> JSON
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  console.error('[server] unhandled error:', err);
  res.status(500).json({ error: { code: 'internal', message: err instanceof Error ? err.message : String(err) } });
});

export { app };

if (process.env.EFFICIENCY_LIST_NO_LISTEN !== '1') {
  const PORT = Number(process.env.PORT ?? 4000);
  app.listen(PORT, () => {
    console.log(`[server] API listening on http://localhost:${PORT}`);
  });
}
