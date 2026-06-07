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
