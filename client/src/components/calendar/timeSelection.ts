import { HOUR_PX, snap } from '../../calendarUtil';

const DAY_MINUTES = 24 * 60;
const MIN_SELECTION_MINUTES = 15;

export interface BlankTimeSelection {
  startMinutes: number;
  endMinutes: number;
  durationMinutes: number;
}

export function minutesFromTimelineOffset(offsetY: number, hourPx = HOUR_PX): number {
  return Math.max(0, Math.min(DAY_MINUTES - MIN_SELECTION_MINUTES, snap((offsetY / hourPx) * 60)));
}

export function buildBlankTimeSelection(anchorMinutes: number, currentMinutes: number): BlankTimeSelection {
  const start = Math.max(0, Math.min(DAY_MINUTES - MIN_SELECTION_MINUTES, Math.min(anchorMinutes, currentMinutes)));
  const end = Math.min(DAY_MINUTES, Math.max(start + MIN_SELECTION_MINUTES, Math.max(anchorMinutes, currentMinutes)));
  return { startMinutes: start, endMinutes: end, durationMinutes: end - start };
}

export function createDraftFromBlankSelection(anchorMinutes: number, currentMinutes: number, defaultDurationMinutes = 60): BlankTimeSelection {
  const selection = buildBlankTimeSelection(anchorMinutes, currentMinutes);
  if (Math.abs(currentMinutes - anchorMinutes) >= MIN_SELECTION_MINUTES) return selection;
  const duration = Math.max(MIN_SELECTION_MINUTES, Math.min(defaultDurationMinutes, DAY_MINUTES - selection.startMinutes));
  return {
    startMinutes: selection.startMinutes,
    endMinutes: selection.startMinutes + duration,
    durationMinutes: duration,
  };
}
