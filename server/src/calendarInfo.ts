import { AppError, type CalendarDayInfoDTO } from './types';

type HolidayMark = {
  name: string;
  type: CalendarDayInfoDTO['holidayType'];
};

const HOLIDAY_SOURCE = '国务院办公厅关于2026年部分节假日安排的通知（国办发明电〔2025〕7号）';

const HOLIDAY_RANGES: Array<{ name: string; from: string; to: string }> = [
  { name: '元旦', from: '2026-01-01', to: '2026-01-03' },
  { name: '春节', from: '2026-02-15', to: '2026-02-23' },
  { name: '清明节', from: '2026-04-04', to: '2026-04-06' },
  { name: '劳动节', from: '2026-05-01', to: '2026-05-05' },
  { name: '端午节', from: '2026-06-19', to: '2026-06-21' },
  { name: '中秋节', from: '2026-09-25', to: '2026-09-27' },
  { name: '国庆节', from: '2026-10-01', to: '2026-10-07' },
];

const ADJUSTED_WORKDAYS: Array<{ name: string; dates: string[] }> = [
  { name: '元旦调休上班', dates: ['2026-01-04'] },
  { name: '春节调休上班', dates: ['2026-02-14', '2026-02-28'] },
  { name: '劳动节调休上班', dates: ['2026-05-09'] },
  { name: '国庆节调休上班', dates: ['2026-09-20', '2026-10-10'] },
];

const DAY_LABELS = [
  '',
  '初一',
  '初二',
  '初三',
  '初四',
  '初五',
  '初六',
  '初七',
  '初八',
  '初九',
  '初十',
  '十一',
  '十二',
  '十三',
  '十四',
  '十五',
  '十六',
  '十七',
  '十八',
  '十九',
  '二十',
  '廿一',
  '廿二',
  '廿三',
  '廿四',
  '廿五',
  '廿六',
  '廿七',
  '廿八',
  '廿九',
  '三十',
];

const lunarFormatter = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' });

function dateFromYmd(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(date: Date, n: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + n);
  return next;
}

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function buildHolidayMap(): Map<string, HolidayMark> {
  const map = new Map<string, HolidayMark>();
  for (const range of HOLIDAY_RANGES) {
    for (let d = dateFromYmd(range.from); ymd(d) <= range.to; d = addDays(d, 1)) {
      map.set(ymd(d), { name: range.name, type: 'public_holiday' });
    }
  }
  for (const row of ADJUSTED_WORKDAYS) {
    for (const date of row.dates) map.set(date, { name: row.name, type: 'adjusted_workday' });
  }
  return map;
}

const holidayMap = buildHolidayMap();

function lunarLabel(date: Date): string {
  try {
    const parts = lunarFormatter.formatToParts(date);
    const month = parts.find((part) => part.type === 'month')?.value ?? '';
    const day = Number(parts.find((part) => part.type === 'day')?.value ?? 0);
    if (!day) return lunarFormatter.format(date);
    return day === 1 ? month : (DAY_LABELS[day] ?? `${day}日`);
  } catch {
    return '';
  }
}

export function getCalendarDayInfo(input: { from: string; to: string }): CalendarDayInfoDTO[] {
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs > toMs) {
    throw new AppError(400, 'invalid', 'from/to must be valid ISO date strings');
  }

  const start = startOfDay(new Date(fromMs));
  const end = startOfDay(new Date(toMs));
  const days: CalendarDayInfoDTO[] = [];
  for (let d = start, i = 0; d <= end; d = addDays(d, 1), i++) {
    if (i > 370) throw new AppError(400, 'range_too_large', 'calendar day-info range cannot exceed 371 days');
    const date = ymd(d);
    const holiday = holidayMap.get(date) ?? null;
    const isAdjustedWorkday = holiday?.type === 'adjusted_workday';
    const isPublicHoliday = holiday?.type === 'public_holiday';
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    days.push({
      date,
      lunarLabel: lunarLabel(d),
      holidayName: holiday?.name ?? null,
      holidayType: holiday?.type ?? null,
      isOffDay: isPublicHoliday || (!isAdjustedWorkday && weekend),
      isAdjustedWorkday,
      source: holiday ? HOLIDAY_SOURCE : null,
    });
  }
  return days;
}
