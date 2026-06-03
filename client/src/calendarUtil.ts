export const HOUR_PX = 44; // pixel height of one hour on the time axis
export type CalView = 'day' | '3day' | 'week' | 'month';

export const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Local date as "YYYY-MM-DD". */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Visible days + the UTC ISO [from,to] window for the range query. */
export function rangeFor(
  view: CalView,
  anchor: Date,
  weekStart: 0 | 1 = 0,
): { days: Date[]; fromISO: string; toISO: string } {
  let start = startOfDay(anchor);
  let count = 3;
  if (view === 'day') count = 1;
  else if (view === 'month') {
    const first = startOfDay(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    const off = (first.getDay() - weekStart + 7) % 7;
    start = addDays(first, -off);
    count = 42;
  } else if (view === 'week') {
    const off = (anchor.getDay() - weekStart + 7) % 7;
    start = addDays(startOfDay(anchor), -off);
    count = 7;
  }
  const days = Array.from({ length: count }, (_, i) => addDays(start, i));
  const last = new Date(days[count - 1]);
  last.setHours(23, 59, 59, 999);
  return { days, fromISO: days[0].toISOString(), toISO: last.toISOString() };
}

/** Local minutes-since-midnight for an ISO timestamp (used to position blocks). */
export function minutesOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

export function sameLocalDay(iso: string, day: Date): boolean {
  const d = new Date(iso);
  return d.getFullYear() === day.getFullYear() && d.getMonth() === day.getMonth() && d.getDate() === day.getDate();
}

/** A Date at `minutes` past local midnight of `day`. */
export function dayAtMinutes(day: Date, minutes: number): Date {
  const d = startOfDay(day);
  d.setMinutes(minutes);
  return d;
}

export function snap(min: number, step = 15): number {
  return Math.round(min / step) * step;
}

export function durationMin(startIso: string, dueIso: string): number {
  return Math.max(15, (new Date(dueIso).getTime() - new Date(startIso).getTime()) / 60000);
}

// time-format preference, set by the settings provider
let _timeFormat: 'system' | '12' | '24' = '24';
let _locale = 'zh-CN';
let _timeZoneMode: 'system' | 'manual' = 'system';
let _timeZone: string | null = null;
export function setTimeFormat(f: 'system' | '12' | '24'): void {
  _timeFormat = f;
}
export function setLocale(locale: string): void {
  _locale = locale;
}
export function setTimeZone(mode: 'system' | 'manual', timeZone: string | null): void {
  _timeZoneMode = mode;
  _timeZone = timeZone;
}
function activeTimeZone(): string | undefined {
  return _timeZoneMode === 'manual' && _timeZone ? _timeZone : undefined;
}
function use12h(): boolean {
  if (_timeFormat === '12') return true;
  if (_timeFormat === '24') return false;
  try {
    return !!new Intl.DateTimeFormat(_locale, { hour: 'numeric', timeZone: activeTimeZone() }).resolvedOptions().hour12;
  } catch {
    return false;
  }
}

export function localDateLabel(iso: string | Date, options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return new Intl.DateTimeFormat(_locale, { ...options, timeZone: activeTimeZone() }).format(d);
}

/** local time string, respecting the time-format setting. */
export function hm(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(_locale, {
    hour: use12h() ? 'numeric' : '2-digit',
    minute: '2-digit',
    hour12: use12h(),
    timeZone: activeTimeZone(),
  }).format(d);
}
