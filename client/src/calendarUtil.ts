export const HOUR_PX = 44; // pixel height of one hour on the time axis
export type CalView = 'day' | '3day' | 'week';

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
export function rangeFor(view: CalView, anchor: Date): { days: Date[]; fromISO: string; toISO: string } {
  let start = startOfDay(anchor);
  let count = 3;
  if (view === 'day') count = 1;
  else if (view === 'week') {
    start = addDays(startOfDay(anchor), -anchor.getDay()); // Sunday-start week
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

/** "HH:MM" local. */
export function hm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
