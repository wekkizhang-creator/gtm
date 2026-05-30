import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import './db'; // initialize schema + inbox on boot
import listsRouter from './routes/lists';
import tasksRouter from './routes/tasks';
import focusRouter from './routes/focus';
import habitsRouter from './routes/habits';
import countdownsRouter from './routes/countdowns';
import * as repo from './repo';
import { AppError } from './types';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/smart-lists', (_req, res) => {
  res.json({ counts: repo.smartCounts() });
});

app.use('/api/lists', listsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/focus', focusRouter);
app.use('/api/habits', habitsRouter);
app.use('/api/countdowns', countdownsRouter);

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

const PORT = Number(process.env.PORT ?? 4000);
app.listen(PORT, () => {
  console.log(`[server] API listening on http://localhost:${PORT}`);
});
