// Real SQLite persistence using Node 24's built-in node:sqlite (no native build step).
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? resolve(here, '../data/app.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS lists (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    color      TEXT,
    icon       TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_inbox   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    note         TEXT,
    list_id      TEXT REFERENCES lists(id) ON DELETE SET NULL,
    priority     INTEGER NOT NULL DEFAULT 0,
    due_date     TEXT,
    start_date   TEXT,
    is_all_day   INTEGER NOT NULL DEFAULT 1,
    completed    INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    deleted_at   TEXT,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_list  ON tasks(list_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_due   ON tasks(due_date);
  CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(completed, deleted_at);

  CREATE TABLE IF NOT EXISTS focus_sessions (
    id           TEXT PRIMARY KEY,
    task_id      TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    mode         TEXT NOT NULL,            -- 'pomodoro' | 'countup'
    started_at   TEXT NOT NULL,
    ended_at     TEXT NOT NULL,
    duration_sec INTEGER NOT NULL,
    is_pomodoro  INTEGER NOT NULL DEFAULT 0,
    note         TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_focus_ended ON focus_sessions(ended_at);

  CREATE TABLE IF NOT EXISTS habits (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    icon         TEXT,
    color        TEXT,
    days_of_week TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',
    note         TEXT,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    archived     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS habit_checkins (
    id         TEXT PRIMARY KEY,
    habit_id   TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(habit_id, date)
  );
  CREATE INDEX IF NOT EXISTS idx_checkins_habit ON habit_checkins(habit_id, date);

  CREATE TABLE IF NOT EXISTS countdowns (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    target_date   TEXT NOT NULL,            -- 'YYYY-MM-DD'
    icon          TEXT,
    color         TEXT,
    repeat_yearly INTEGER NOT NULL DEFAULT 0,
    pinned        INTEGER NOT NULL DEFAULT 0,
    note          TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// migration: add columns introduced after the first release (existing DBs)
{
  const cols = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('start_date')) db.exec('ALTER TABLE tasks ADD COLUMN start_date TEXT');
  if (!names.has('is_important')) db.exec('ALTER TABLE tasks ADD COLUMN is_important INTEGER');
  if (!names.has('is_urgent')) db.exec('ALTER TABLE tasks ADD COLUMN is_urgent INTEGER');
}

export function nowISO(): string {
  return new Date().toISOString();
}

/** The single, always-present "收集箱" (Inbox) list. Created once on first run. */
export const INBOX_ID: string = (() => {
  const existing = db.prepare('SELECT id FROM lists WHERE is_inbox = 1 LIMIT 1').get() as
    | { id: string }
    | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  const ts = nowISO();
  db.prepare(
    `INSERT INTO lists (id, name, color, icon, sort_order, is_inbox, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, '收集箱', null, 'inbox', -1, ts, ts);
  return id;
})();

console.log(`[db] SQLite ready at ${DB_PATH} (inbox=${INBOX_ID})`);
