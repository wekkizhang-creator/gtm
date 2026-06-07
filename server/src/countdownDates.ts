function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function fmt(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dateOnly(input: Date): Date {
  const d = new Date(input);
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseDateParts(s: string): { year: number; month: number; day: number } {
  const [year, month, day] = s.split('-').map(Number);
  return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function exactCalendarDate(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day);
}

export function isValidCountdownDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const { year, month, day } = parseDateParts(value);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function annualCalendarDate(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, Math.min(day, daysInMonth(year, month)));
}

export function resolveCountdownOccurrence(
  targetStr: string,
  repeat: boolean,
  todayInput: Date = new Date(),
): { effectiveDate: string; daysRemaining: number } {
  const today = dateOnly(todayInput);
  const target = parseDateParts(targetStr);
  let effective = exactCalendarDate(target.year, target.month, target.day);

  if (repeat) {
    effective = annualCalendarDate(today.getFullYear(), target.month, target.day);
    if (effective.getTime() < today.getTime()) {
      effective = annualCalendarDate(today.getFullYear() + 1, target.month, target.day);
    }
  }

  const daysRemaining = Math.round((effective.getTime() - today.getTime()) / 86_400_000);
  return { effectiveDate: fmt(effective), daysRemaining };
}
