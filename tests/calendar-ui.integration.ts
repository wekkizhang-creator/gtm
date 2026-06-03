import { rangeFor, ymd } from '../client/src/calendarUtil';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const may2026 = rangeFor('month', new Date(2026, 4, 31, 12), 1);
assert(may2026.days.length === 42, `month view should return 42 grid days, got ${may2026.days.length}`);
assert(ymd(may2026.days[0]) === '2026-04-27', `month grid should start on Monday 2026-04-27, got ${ymd(may2026.days[0])}`);
assert(ymd(may2026.days[41]) === '2026-06-07', `month grid should end on 2026-06-07, got ${ymd(may2026.days[41])}`);
assert(may2026.fromISO <= new Date(2026, 3, 27).toISOString(), 'month range should include the leading week');
assert(may2026.toISO >= new Date(2026, 5, 7, 23, 59, 59, 999).toISOString(), 'month range should include the trailing week');

const sundayStart = rangeFor('month', new Date(2026, 1, 17, 12), 0);
assert(ymd(sundayStart.days[0]) === '2026-02-01', `Sunday-start February should begin on 2026-02-01, got ${ymd(sundayStart.days[0])}`);

console.log('calendar month view range ok');
