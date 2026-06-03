import { buildBlankTimeSelection, createDraftFromBlankSelection, minutesFromTimelineOffset } from '../client/src/components/calendar/timeSelection';
import { HOUR_PX } from '../client/src/calendarUtil';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(minutesFromTimelineOffset(9.12 * HOUR_PX) === 9 * 60, 'timeline offsets should snap to the nearest 15 minutes');
assert(minutesFromTimelineOffset(-20) === 0, 'negative timeline offsets should clamp to day start');
assert(minutesFromTimelineOffset(25 * HOUR_PX) === 23 * 60 + 45, 'timeline offsets should clamp before day end');

const downward = buildBlankTimeSelection(9 * 60, 10 * 60 + 30);
assert(downward.startMinutes === 9 * 60, 'downward drag should keep the lower start');
assert(downward.durationMinutes === 90, 'downward drag duration mismatch');

const upward = buildBlankTimeSelection(14 * 60, 13 * 60 + 15);
assert(upward.startMinutes === 13 * 60 + 15, 'upward drag should use the earlier slot as start');
assert(upward.durationMinutes === 45, 'upward drag duration mismatch');

const clickDraft = createDraftFromBlankSelection(11 * 60, 11 * 60);
assert(clickDraft.durationMinutes === 60, 'click fallback should preserve the one-hour default');

const endOfDayDraft = createDraftFromBlankSelection(23 * 60 + 45, 23 * 60 + 45);
assert(endOfDayDraft.durationMinutes === 15 && endOfDayDraft.endMinutes === 24 * 60, 'near-midnight click should stay inside the day');

console.log('calendar blank selection ok');
