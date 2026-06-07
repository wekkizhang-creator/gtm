import type { CreateScheduleProposalInput } from './api/client';
import type { CalendarReplanCandidate } from './types';

const REPLAN_RANGE_DAYS = 7;

function validTime(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function buildCalendarReplanProposalInput(candidate: CalendarReplanCandidate): CreateScheduleProposalInput {
  const starts = candidate.affectedTasks
    .flatMap((task) => [task.plannedStartAt, task.blockingEventStart])
    .map(validTime)
    .filter((value): value is number => value != null);
  const ends = candidate.affectedTasks
    .flatMap((task) => [task.plannedEndAt, task.blockingEventEnd])
    .map(validTime)
    .filter((value): value is number => value != null);
  const from = starts.length ? new Date(Math.min(...starts)).toISOString() : null;
  const to = ends.length ? new Date(Math.max(...ends) + REPLAN_RANGE_DAYS * 86_400_000).toISOString() : null;
  return {
    mode: 'reschedule',
    trigger: candidate.trigger,
    taskIds: candidate.affectedTasks.map((task) => task.taskId),
    from,
    to,
  };
}

export function calendarReplanCandidateSummary(candidate: CalendarReplanCandidate): string {
  const taskCount = candidate.affectedTaskCount || candidate.affectedTasks.length;
  const eventNames = Array.from(new Set(candidate.affectedTasks.map((task) => task.blockingEventTitle))).slice(0, 3);
  return `${candidate.goalTitle} · ${taskCount} 个任务受影响${eventNames.length ? ` · ${eventNames.join('、')}` : ''}`;
}
