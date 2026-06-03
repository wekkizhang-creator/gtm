import type { Task } from '../../types';
import { startOfDay, ymd } from '../../calendarUtil';

const DAY_MINUTES = 24 * 60;
const MIN_BLOCK_MINUTES = 15;

export interface CalendarBlockSegment {
  key: string;
  task: Task;
  startMinutes: number;
  endMinutes: number;
  durationMinutes: number;
  startsBeforeDay: boolean;
  endsAfterDay: boolean;
  lane: number;
  laneCount: number;
}

function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60000;
}

export function taskSegmentsForDay(tasks: Task[], day: Date): CalendarBlockSegment[] {
  const dayStart = startOfDay(day);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const segments: CalendarBlockSegment[] = [];
  for (const task of tasks) {
    if (task.isAllDay || !task.startDate || !task.dueDate) continue;
    const taskStart = new Date(task.startDate);
    const taskEnd = new Date(task.dueDate);
    if (Number.isNaN(taskStart.getTime()) || Number.isNaN(taskEnd.getTime())) continue;
    if (taskEnd <= dayStart || taskStart >= dayEnd) continue;
    const startsBeforeDay = taskStart < dayStart;
    const endsAfterDay = taskEnd > dayEnd;
    const startMinutes = Math.max(0, Math.min(DAY_MINUTES - MIN_BLOCK_MINUTES, minutesBetween(dayStart, startsBeforeDay ? dayStart : taskStart)));
    const rawEndMinutes = Math.min(DAY_MINUTES, Math.max(startMinutes + MIN_BLOCK_MINUTES, minutesBetween(dayStart, endsAfterDay ? dayEnd : taskEnd)));
    segments.push({
      key: `${task.id}:${ymd(day)}`,
      task,
      startMinutes,
      endMinutes: rawEndMinutes,
      durationMinutes: rawEndMinutes - startMinutes,
      startsBeforeDay,
      endsAfterDay,
      lane: 0,
      laneCount: 1,
    });
  }
  return layoutOverlappingSegments(segments);
}

export function layoutOverlappingSegments(segments: CalendarBlockSegment[]): CalendarBlockSegment[] {
  const sorted = [...segments].sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes || a.task.title.localeCompare(b.task.title));
  const laidOut: CalendarBlockSegment[] = [];
  let cluster: CalendarBlockSegment[] = [];
  let clusterEnd = -1;
  const flushCluster = () => {
    if (!cluster.length) return;
    const active: Array<{ lane: number; endMinutes: number }> = [];
    let maxLanes = 1;
    for (const segment of cluster) {
      for (let i = active.length - 1; i >= 0; i--) {
        if (active[i].endMinutes <= segment.startMinutes) active.splice(i, 1);
      }
      const used = new Set(active.map((item) => item.lane));
      let lane = 0;
      while (used.has(lane)) lane++;
      segment.lane = lane;
      active.push({ lane, endMinutes: segment.endMinutes });
      maxLanes = Math.max(maxLanes, lane + 1, active.length);
    }
    for (const segment of cluster) {
      segment.laneCount = maxLanes;
      laidOut.push(segment);
    }
    cluster = [];
    clusterEnd = -1;
  };

  for (const segment of sorted) {
    if (cluster.length && segment.startMinutes >= clusterEnd) flushCluster();
    cluster.push(segment);
    clusterEnd = Math.max(clusterEnd, segment.endMinutes);
  }
  flushCluster();
  return laidOut;
}
