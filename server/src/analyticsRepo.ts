import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { db, nowISO } from './db';
import { AppError, type AuthContext } from './types';

const MAX_EVENTS = 20;
const MAX_DEPTH = 4;
const MAX_KEYS = 40;
const MAX_STRING = 300;
const SENSITIVE_KEY = /(email|phone|identifier|code|token|api[_-]?key|access[_-]?token|refresh[_-]?token|openid|open_id|subject|password|secret|credential)/i;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_VALUE = /^\+?\d[\d\s().-]{7,}$/;
const TOKEN_VALUE = /^[A-Za-z0-9._~+/=-]{24,}$/;
const SAFE_SENSITIVE_NAMED_KEYS = new Set(['is_new_identifier', 'identity_type', 'remaining_identity_count']);

export interface AnalyticsEventInput {
  name?: unknown;
  properties?: unknown;
  occurredAt?: unknown;
  anonymousId?: unknown;
  deviceId?: unknown;
  source?: unknown;
}

function stringOrNull(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function eventName(value: unknown): string {
  const name = stringOrNull(value, 96);
  if (!name || !/^[a-z][a-z0-9_:.]{1,95}$/.test(name)) {
    throw new AppError(400, 'invalid_analytics_event', 'event name is invalid');
  }
  return name;
}

function validOccurredAt(value: unknown): string {
  if (typeof value !== 'string') return nowISO();
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return nowISO();
  return new Date(t).toISOString();
}

function scrub(value: unknown, depth = 0): unknown {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const v = value.trim();
    if (!v) return '';
    if (EMAIL_VALUE.test(v) || PHONE_VALUE.test(v) || TOKEN_VALUE.test(v)) return '[redacted]';
    return v.slice(0, MAX_STRING);
  }
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => scrub(item, depth + 1));
  if (typeof value !== 'object') return null;
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_KEYS) break;
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(key)) continue;
    if (SENSITIVE_KEY.test(key) && !SAFE_SENSITIVE_NAMED_KEYS.has(key)) continue;
    const cleaned = scrub(raw, depth + 1);
    if (cleaned !== undefined) {
      out[key] = cleaned;
      count += 1;
    }
  }
  return out;
}

function normalizeEvents(body: unknown): AnalyticsEventInput[] {
  if (Array.isArray((body as any)?.events)) return (body as any).events;
  if (body && typeof body === 'object') return [body as AnalyticsEventInput];
  throw new AppError(400, 'invalid_analytics_event', 'event payload is required');
}

export function recordEvents(auth: AuthContext | null, body: unknown, req: Request): { accepted: number } {
  const events = normalizeEvents(body);
  if (events.length === 0 || events.length > MAX_EVENTS) {
    throw new AppError(400, 'invalid_analytics_event', `events must contain 1-${MAX_EVENTS} items`);
  }
  const receivedAt = nowISO();
  const insert = db.prepare(
    `INSERT INTO analytics_events
       (id, user_id, session_id, anonymous_id, device_id, event_name, properties_json, source, occurred_at, received_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  try {
    for (const input of events) {
      if (!input || typeof input !== 'object') throw new AppError(400, 'invalid_analytics_event', 'event must be an object');
      insert.run(
        randomUUID(),
        auth?.userId ?? null,
        auth?.sessionId ?? null,
        stringOrNull((input as AnalyticsEventInput).anonymousId, 80),
        stringOrNull((input as AnalyticsEventInput).deviceId, 120),
        eventName((input as AnalyticsEventInput).name),
        JSON.stringify(scrub((input as AnalyticsEventInput).properties ?? {})),
        stringOrNull((input as AnalyticsEventInput).source, 40) ?? 'web',
        validOccurredAt((input as AnalyticsEventInput).occurredAt),
        receivedAt,
        req.ip ?? null,
        typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { accepted: events.length };
}

export function recordServerEvent(
  auth: AuthContext | null,
  req: Request,
  name: string,
  properties: Record<string, unknown> = {},
): void {
  recordEvents(
    auth,
    {
      name,
      source: 'server',
      properties,
      occurredAt: nowISO(),
    },
    req,
  );
}
