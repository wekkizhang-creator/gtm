import type { Priority } from './types';

export const PRIORITY_COLORS: Record<Priority, string> = {
  0: '#c5c9d1',
  1: '#4a8cf0',
  2: '#f0a020',
  3: '#e5533c',
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  0: '无优先级',
  1: '低优先级',
  2: '中优先级',
  3: '高优先级',
};

/** Local midnight today, as a UTC ISO string (matches how the server stores dates). */
export function startOfTodayISO(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** ISO -> "yyyy-mm-dd" for <input type="date"> using local time. */
export function isoToDateInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** "yyyy-mm-dd" -> local-midnight UTC ISO, or null when cleared. */
export function dateInputToISO(s: string): string | null {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

/** Human due-date label + whether it is overdue (relative to today). */
export function formatDue(iso: string | null): { text: string; overdue: boolean } | null {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((dDay.getTime() - today.getTime()) / 86_400_000);
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  if (diffDays === 0) return { text: '今天', overdue: false };
  if (diffDays === 1) return { text: '明天', overdue: false };
  if (diffDays === -1) return { text: '昨天', overdue: true };
  return { text: md, overdue: diffDays < 0 };
}
