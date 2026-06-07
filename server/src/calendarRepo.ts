import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { db, nowISO } from './db';
import {
  AppError,
  type CalendarReplanCandidateDTO,
  type CalendarSubscriptionDTO,
  type CalendarSyncResultDTO,
  type ExternalCalendarEventDTO,
  type SystemCalendarPermissionDTO,
  type SystemCalendarPermissionReason,
  type SystemCalendarPermissionStatus,
} from './types';

const SYSTEM_CALENDAR_PERMISSION = 'system-calendar-readonly';
const SYSTEM_CALENDAR_STATUSES = new Set<SystemCalendarPermissionStatus>(['unknown', 'granted', 'denied', 'unsupported']);
const SYSTEM_CALENDAR_REASONS = new Set<SystemCalendarPermissionReason>(['system_calendar_subscription']);
const SUBSCRIPTION_TYPES = new Set(['ics', 'holiday', 'system']);

interface ParsedIcsEvent {
  uid: string;
  title: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  rawJson: string;
}

function mapSub(r: any): CalendarSubscriptionDTO {
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    url: r.url ?? null,
    color: r.color ?? null,
    enabled: !!r.enabled,
    lastSyncedAt: r.last_synced_at ?? null,
    createdAt: r.created_at,
  };
}

function mapEvent(r: any): ExternalCalendarEventDTO {
  return {
    id: r.id,
    subscriptionId: r.subscription_id,
    externalUid: r.external_uid,
    title: r.title,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    isAllDay: !!r.is_all_day,
    rawJson: r.raw_json ?? null,
  };
}

export function listSubscriptions(userId: string): CalendarSubscriptionDTO[] {
  return (db.prepare('SELECT * FROM calendar_subscriptions WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[]).map(mapSub);
}

function insertSubscription(
  userId: string,
  input: { type: string; name: string; url?: string | null; color?: string | null; enabled?: boolean },
): CalendarSubscriptionDTO {
  const id = randomUUID();
  const ts = nowISO();
  db.prepare(
    `INSERT INTO calendar_subscriptions (id, user_id, type, name, url, color, enabled, last_synced_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(id, userId, input.type, input.name, input.url ?? null, input.color ?? null, input.enabled === false ? 0 : 1, ts);
  return mapSub(db.prepare('SELECT * FROM calendar_subscriptions WHERE user_id = ? AND id = ?').get(userId, id));
}

function normalizeSubscriptionType(type: string | undefined): string {
  const normalized = (type ?? 'ics').trim().toLowerCase();
  if (!SUBSCRIPTION_TYPES.has(normalized)) throw new AppError(400, 'invalid_calendar_subscription', 'subscription type is invalid');
  return normalized;
}

export function createSubscription(
  userId: string,
  input: { type?: string; name: string; url?: string | null; color?: string | null; enabled?: boolean },
): CalendarSubscriptionDTO {
  const name = input.name.trim();
  if (!name) throw new AppError(400, 'invalid', 'name is required');
  const type = normalizeSubscriptionType(input.type);
  if (type === 'system') throw new AppError(501, 'system_calendar_provider_not_configured', 'system calendar read-only provider is not configured');
  return insertSubscription(userId, { type, name, url: input.url ?? null, color: input.color ?? null, enabled: input.enabled });
}

function systemCalendarGuidance(status: SystemCalendarPermissionStatus): SystemCalendarPermissionDTO['guidance'] {
  if (status === 'granted') return 'enabled';
  if (status === 'denied') return 'blocked';
  if (status === 'unsupported') return 'unsupported';
  return 'request_when_needed';
}

function systemCalendarPermissionDto(row?: {
  status: string;
  prompt_reason: string | null;
  last_prompted_at: string | null;
  updated_at: string | null;
}): SystemCalendarPermissionDTO {
  const status = SYSTEM_CALENDAR_STATUSES.has(row?.status as SystemCalendarPermissionStatus)
    ? (row!.status as SystemCalendarPermissionStatus)
    : 'unknown';
  return {
    permission: SYSTEM_CALENDAR_PERMISSION,
    status,
    promptReason: SYSTEM_CALENDAR_REASONS.has(row?.prompt_reason as SystemCalendarPermissionReason)
      ? (row!.prompt_reason as SystemCalendarPermissionReason)
      : null,
    lastPromptedAt: row?.last_prompted_at ?? null,
    updatedAt: row?.updated_at ?? null,
    shouldPrompt: status === 'unknown',
    guidance: systemCalendarGuidance(status),
  };
}

export function getSystemCalendarPermission(userId: string): SystemCalendarPermissionDTO {
  const row = db
    .prepare('SELECT status, prompt_reason, last_prompted_at, updated_at FROM calendar_permissions WHERE user_id = ? AND permission = ?')
    .get(userId, SYSTEM_CALENDAR_PERMISSION) as
    | { status: string; prompt_reason: string | null; last_prompted_at: string | null; updated_at: string | null }
    | undefined;
  return systemCalendarPermissionDto(row);
}

export function updateSystemCalendarPermission(
  userId: string,
  input: { status?: unknown; promptReason?: unknown },
): SystemCalendarPermissionDTO {
  if (typeof input.status !== 'string' || !SYSTEM_CALENDAR_STATUSES.has(input.status as SystemCalendarPermissionStatus)) {
    throw new AppError(400, 'invalid_system_calendar_permission', 'status is invalid');
  }
  let promptReason: SystemCalendarPermissionReason | null = null;
  if (input.promptReason != null) {
    if (typeof input.promptReason !== 'string' || !SYSTEM_CALENDAR_REASONS.has(input.promptReason as SystemCalendarPermissionReason)) {
      throw new AppError(400, 'invalid_system_calendar_permission', 'promptReason is invalid');
    }
    promptReason = input.promptReason as SystemCalendarPermissionReason;
  }
  const ts = nowISO();
  db.prepare(
    `INSERT INTO calendar_permissions (user_id, permission, status, prompt_reason, last_prompted_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, permission) DO UPDATE SET
       status = excluded.status,
       prompt_reason = COALESCE(excluded.prompt_reason, calendar_permissions.prompt_reason),
       last_prompted_at = COALESCE(excluded.last_prompted_at, calendar_permissions.last_prompted_at),
       updated_at = excluded.updated_at`,
  ).run(userId, SYSTEM_CALENDAR_PERMISSION, input.status, promptReason, promptReason ? ts : null, ts);
  return getSystemCalendarPermission(userId);
}

function systemCalendarSource(): { kind: 'url' | 'file'; source: string } | null {
  const url = process.env.SYSTEM_CALENDAR_ICS_URL?.trim();
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('unsupported protocol');
      }
    } catch {
      throw new AppError(502, 'system_calendar_provider_failed', 'system calendar URL is invalid');
    }
    return { kind: 'url', source: url };
  }
  const file = (process.env.SYSTEM_CALENDAR_ICS_FILE ?? process.env.SYSTEM_CALENDAR_ICS_PATH)?.trim();
  return file ? { kind: 'file', source: file } : null;
}

async function loadSystemCalendarIcs(): Promise<string> {
  const source = systemCalendarSource();
  if (!source) {
    throw new AppError(501, 'system_calendar_provider_not_configured', 'system calendar read-only provider is not configured');
  }
  if (source.kind === 'url') {
    const res = await fetch(source.source);
    if (!res.ok) throw new AppError(502, 'system_calendar_provider_failed', `system calendar provider returned HTTP ${res.status}`);
    return res.text();
  }
  try {
    return readFileSync(source.source, 'utf8');
  } catch {
    throw new AppError(502, 'system_calendar_provider_failed', 'system calendar file could not be read');
  }
}

export async function createSystemSubscription(userId: string, input: { name?: unknown; color?: unknown }): Promise<CalendarSyncResultDTO> {
  const permission = getSystemCalendarPermission(userId);
  if (permission.status !== 'granted') {
    throw new AppError(403, 'system_calendar_permission_required', 'system calendar read-only permission is required');
  }
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : '系统日历';
  const color = typeof input.color === 'string' && input.color.trim() ? input.color.trim() : '#2f9e6f';
  const parsed = parseIcs(await loadSystemCalendarIcs());
  const subscription = insertSubscription(userId, { type: 'system', name, url: null, color, enabled: true });
  const events = syncParsedEvents(userId, subscription.id, parsed);
  return {
    subscription: mapSub(db.prepare('SELECT * FROM calendar_subscriptions WHERE user_id = ? AND id = ?').get(userId, subscription.id)),
    events,
    replanCandidates: buildReplanCandidates(userId, subscription.id, events),
  };
}

export function updateSubscription(userId: string, id: string, patch: Record<string, unknown>): CalendarSubscriptionDTO | null {
  const current = db.prepare('SELECT * FROM calendar_subscriptions WHERE user_id = ? AND id = ?').get(userId, id) as any;
  if (!current) return null;
  if (current.type === 'system' && ('type' in patch || 'url' in patch)) {
    throw new AppError(400, 'invalid_calendar_subscription', 'system calendar source is managed by the configured provider');
  }
  const map: Record<string, string> = { type: 'type', name: 'name', url: 'url', color: 'color', enabled: 'enabled' };
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) {
      let v = patch[k];
      if (k === 'name') {
        v = String(v ?? '').trim();
        if (!v) throw new AppError(400, 'invalid', 'name is required');
      }
      if (k === 'type') {
        v = normalizeSubscriptionType(String(v ?? ''));
        if (v === 'system') throw new AppError(501, 'system_calendar_provider_not_configured', 'system calendar read-only provider is not configured');
      }
      if (k === 'enabled') v = v ? 1 : 0;
      cols.push(`${col} = ?`);
      vals.push(v ?? null);
    }
  }
  if (!cols.length) {
    return mapSub(current);
  }
  vals.push(userId, id);
  const info = db.prepare(`UPDATE calendar_subscriptions SET ${cols.join(', ')} WHERE user_id = ? AND id = ?`).run(...(vals as any[]));
  if (info.changes === 0) return null;
  return mapSub(db.prepare('SELECT * FROM calendar_subscriptions WHERE user_id = ? AND id = ?').get(userId, id));
}

export function deleteSubscription(userId: string, id: string): boolean {
  return db.prepare('DELETE FROM calendar_subscriptions WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
}

function prop(lines: string[], name: string): string | null {
  const line = lines.find((l) => l.toUpperCase().startsWith(name));
  if (!line) return null;
  const idx = line.indexOf(':');
  return idx >= 0 ? line.slice(idx + 1).trim() : null;
}

function parseIcsDate(value: string | null): { iso: string; allDay: boolean } | null {
  if (!value) return null;
  if (/^\d{8}$/.test(value)) {
    return { iso: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00.000Z`, allDay: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000${m[7] ? 'Z' : 'Z'}`;
  return { iso, allDay: false };
}

function parseIcs(icsText: string): ParsedIcsEvent[] {
  const lines = icsText
    .replace(/\r\n[ \t]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim());
  const events: string[][] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = [];
    else if (line === 'END:VEVENT' && cur) {
      events.push(cur);
      cur = null;
    } else if (cur) cur.push(line);
  }
  return events.map((ev, index) => {
    const start = parseIcsDate(prop(ev, 'DTSTART'));
    const end = parseIcsDate(prop(ev, 'DTEND'));
    if (!start || !end) throw new AppError(400, 'invalid_ics', 'VEVENT requires DTSTART and DTEND');
    const uid = prop(ev, 'UID') ?? `event-${index}`;
    const title = prop(ev, 'SUMMARY') ?? '(No title)';
    return { uid, title, startsAt: start.iso, endsAt: end.iso, isAllDay: start.allDay, rawJson: JSON.stringify(ev) };
  });
}

export async function syncSubscription(
  userId: string,
  id: string,
  input: { icsText?: string | null },
): Promise<CalendarSyncResultDTO> {
  const sub = db.prepare('SELECT * FROM calendar_subscriptions WHERE user_id = ? AND id = ?').get(userId, id) as any;
  if (!sub) throw new AppError(404, 'not_found', 'subscription not found');
  let icsText = input.icsText ?? null;
  if (sub.type === 'system') {
    icsText = await loadSystemCalendarIcs();
  } else if (!icsText && sub.url) {
    const res = await fetch(sub.url);
    if (!res.ok) throw new AppError(400, 'sync_failed', `calendar fetch failed: ${res.status}`);
    icsText = await res.text();
  }
  if (!icsText) throw new AppError(400, 'invalid', 'icsText or subscription url is required');
  const parsed = parseIcs(icsText);
  const events = syncParsedEvents(userId, id, parsed);
  return {
    subscription: mapSub(db.prepare('SELECT * FROM calendar_subscriptions WHERE user_id = ? AND id = ?').get(userId, id)),
    events,
    replanCandidates: buildReplanCandidates(userId, id, events),
  };
}

function syncParsedEvents(userId: string, subscriptionId: string, parsed: ParsedIcsEvent[]): ExternalCalendarEventDTO[] {
  const synced: ExternalCalendarEventDTO[] = [];
  const ts = nowISO();
  for (const ev of parsed) {
    const eventId = randomUUID();
    db.prepare(
      `INSERT INTO external_calendar_events
        (id, user_id, subscription_id, external_uid, title, starts_at, ends_at, is_all_day, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subscription_id, external_uid)
       DO UPDATE SET title = excluded.title, starts_at = excluded.starts_at, ends_at = excluded.ends_at, is_all_day = excluded.is_all_day, raw_json = excluded.raw_json`,
    ).run(eventId, userId, subscriptionId, ev.uid, ev.title, ev.startsAt, ev.endsAt, ev.isAllDay ? 1 : 0, ev.rawJson);
    const row = db
      .prepare('SELECT * FROM external_calendar_events WHERE user_id = ? AND subscription_id = ? AND external_uid = ?')
      .get(userId, subscriptionId, ev.uid);
    synced.push(mapEvent(row));
  }
  db.prepare('UPDATE calendar_subscriptions SET last_synced_at = ? WHERE user_id = ? AND id = ?').run(ts, userId, subscriptionId);
  return synced;
}

export function listEvents(userId: string, from: string, to: string): ExternalCalendarEventDTO[] {
  return (
    db
      .prepare(
        `SELECT e.*
         FROM external_calendar_events e
         JOIN calendar_subscriptions s ON s.user_id = e.user_id AND s.id = e.subscription_id
         WHERE e.user_id = ? AND s.enabled = 1 AND e.ends_at >= ? AND e.starts_at <= ?
         ORDER BY e.starts_at ASC`,
      )
      .all(userId, from, to) as any[]
  ).map(mapEvent);
}

function buildReplanCandidates(userId: string, subscriptionId: string, events: ExternalCalendarEventDTO[]): CalendarReplanCandidateDTO[] {
  if (!events.length) return [];
  const rows = db
    .prepare(
      `SELECT
         t.id task_id,
         t.title task_title,
         t.start_date,
         t.due_date,
         t.goal_id,
         g.title goal_title,
         e.title event_title,
         e.starts_at event_start,
         e.ends_at event_end
       FROM tasks t
       JOIN goals g ON g.user_id = t.user_id AND g.id = t.goal_id
       JOIN external_calendar_events e ON e.user_id = t.user_id
       WHERE t.user_id = ?
         AND e.subscription_id = ?
         AND t.deleted_at IS NULL
         AND t.completed = 0
         AND t.goal_id IS NOT NULL
         AND t.start_date IS NOT NULL
         AND t.due_date IS NOT NULL
         AND t.is_all_day = 0
         AND t.auto_schedule_enabled = 1
         AND t.is_locked_schedule = 0
         AND g.status IN ('active', 'not_started')
         AND e.ends_at > t.start_date
         AND e.starts_at < t.due_date
       ORDER BY g.created_at ASC, t.start_date ASC, e.starts_at ASC`,
    )
    .all(userId, subscriptionId) as Array<{
    task_id: string;
    task_title: string;
    start_date: string;
    due_date: string;
    goal_id: string;
    goal_title: string;
    event_title: string;
    event_start: string;
    event_end: string;
  }>;
  const eventKeys = new Set(events.map((event) => `${event.title}:${event.startsAt}:${event.endsAt}`));
  const byGoal = new Map<string, CalendarReplanCandidateDTO>();
  const seenTasks = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!eventKeys.has(`${row.event_title}:${row.event_start}:${row.event_end}`)) continue;
    let candidate = byGoal.get(row.goal_id);
    if (!candidate) {
      candidate = {
        goalId: row.goal_id,
        goalTitle: row.goal_title,
        affectedTaskCount: 0,
        affectedTasks: [],
        trigger: `calendar_sync:${subscriptionId}`,
      };
      byGoal.set(row.goal_id, candidate);
      seenTasks.set(row.goal_id, new Set());
    }
    const seen = seenTasks.get(row.goal_id)!;
    if (seen.has(row.task_id)) continue;
    seen.add(row.task_id);
    candidate.affectedTasks.push({
      taskId: row.task_id,
      title: row.task_title,
      plannedStartAt: row.start_date,
      plannedEndAt: row.due_date,
      blockingEventTitle: row.event_title,
      blockingEventStart: row.event_start,
      blockingEventEnd: row.event_end,
    });
    candidate.affectedTaskCount = candidate.affectedTasks.length;
  }
  return Array.from(byGoal.values());
}
