// Single-user settings store (KV table). Returns defaults deep-merged with stored values.
// The AI API key is stored obfuscated and never returned in full (only last-4 mask).
import { db, nowISO } from './db';
import type { Settings } from './types';

const DEFAULTS: Settings = {
  appearance: { themeMode: 'system', accent: '#c96442', fontSize: 'normal', density: 'standard', animations: true },
  datetime: { weekStart: 1, timeFormat: 'system' },
  modules: { hidden: [], defaultLaunch: 'tasks' },
  smartLists: { hidden: [] },
  taskDefaults: { priority: 0, listId: null },
  ai: { enabled: false, provider: '', baseUrl: '', model: '', hasApiKey: false, apiKeyMasked: '' },
};

const GROUPS = ['appearance', 'datetime', 'modules', 'smartLists', 'taskDefaults'] as const;
const AI_KEY_ROW = 'ai.apiKey';

function readRow(key: string): string | null {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? r.value : null;
}
function writeRow(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, nowISO());
}
function readGroup(key: string): Record<string, unknown> {
  const raw = readRow(key);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// light obfuscation so the key is not stored as cleartext (NOT production-grade crypto)
function ob(s: string): string {
  return 'b64:' + Buffer.from(s, 'utf8').toString('base64');
}
function deob(s: string): string {
  return s.startsWith('b64:') ? Buffer.from(s.slice(4), 'base64').toString('utf8') : s;
}
function mask(key: string): string {
  if (!key) return '';
  return key.length <= 4 ? '••••' : '••••' + key.slice(-4);
}

export function getSettings(): Settings {
  const out: Settings = JSON.parse(JSON.stringify(DEFAULTS));
  for (const g of GROUPS) Object.assign(out[g], readGroup(g));
  Object.assign(out.ai, readGroup('ai')); // non-secret ai config
  const keyRaw = readRow(AI_KEY_ROW);
  if (keyRaw) {
    const real = deob(keyRaw);
    out.ai.hasApiKey = !!real;
    out.ai.apiKeyMasked = mask(real);
  }
  // never leak the raw key
  delete (out.ai as Record<string, unknown>).apiKey;
  return out;
}

export function patchSettings(patch: Record<string, any>): Settings {
  for (const g of GROUPS) {
    if (patch[g] && typeof patch[g] === 'object') {
      writeRow(g, JSON.stringify({ ...readGroup(g), ...patch[g] }));
    }
  }
  if (patch.ai && typeof patch.ai === 'object') {
    const { apiKey, ...rest } = patch.ai;
    if (Object.keys(rest).length) writeRow('ai', JSON.stringify({ ...readGroup('ai'), ...rest }));
    if (typeof apiKey === 'string') {
      if (apiKey === '') db.prepare('DELETE FROM settings WHERE key = ?').run(AI_KEY_ROW);
      else writeRow(AI_KEY_ROW, ob(apiKey));
    }
  }
  return getSettings();
}

/** internal use (AI test endpoint) — returns the real key */
export function getRawApiKey(): string | null {
  const raw = readRow(AI_KEY_ROW);
  return raw ? deob(raw) : null;
}

export function resetGroup(group: string): Settings {
  if (group === 'ai') {
    db.prepare('DELETE FROM settings WHERE key = ?').run('ai');
    db.prepare('DELETE FROM settings WHERE key = ?').run(AI_KEY_ROW);
  } else {
    db.prepare('DELETE FROM settings WHERE key = ?').run(group);
  }
  return getSettings();
}

/** Full data export (all tables) for the "导出数据" feature. */
export function exportAll(): Record<string, unknown> {
  const all = (sql: string) => db.prepare(sql).all();
  return {
    exportedAt: nowISO(),
    version: 1,
    lists: all('SELECT * FROM lists'),
    tasks: all('SELECT * FROM tasks'),
    focusSessions: all('SELECT * FROM focus_sessions'),
    habits: all('SELECT * FROM habits'),
    habitCheckins: all('SELECT * FROM habit_checkins'),
    countdowns: all('SELECT * FROM countdowns'),
    settings: getSettings(),
  };
}
