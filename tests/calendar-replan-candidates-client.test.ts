import { buildCalendarReplanProposalInput, calendarReplanCandidateSummary } from '../client/src/calendarReplanCandidates';
import type { CalendarReplanCandidate } from '../client/src/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const candidate: CalendarReplanCandidate = {
  goalId: 'goal-1',
  goalTitle: 'Launch plan',
  affectedTaskCount: 2,
  trigger: 'calendar_sync:sub-1',
  affectedTasks: [
    {
      taskId: 'task-1',
      title: 'Prepare launch deck',
      plannedStartAt: '2030-01-02T09:00:00.000Z',
      plannedEndAt: '2030-01-02T10:00:00.000Z',
      blockingEventTitle: 'External Planning',
      blockingEventStart: '2030-01-02T09:30:00.000Z',
      blockingEventEnd: '2030-01-02T10:30:00.000Z',
    },
    {
      taskId: 'task-2',
      title: 'Draft launch mail',
      plannedStartAt: '2030-01-02T11:00:00.000Z',
      plannedEndAt: '2030-01-02T12:00:00.000Z',
      blockingEventTitle: 'Client Review',
      blockingEventStart: '2030-01-02T11:30:00.000Z',
      blockingEventEnd: '2030-01-02T12:30:00.000Z',
    },
  ],
};

const input = buildCalendarReplanProposalInput(candidate);
assert(input.mode === 'reschedule', 'calendar replan should create a reschedule proposal');
assert(input.trigger === 'calendar_sync:sub-1', 'calendar replan should preserve the sync trigger');
assert(input.taskIds?.join('|') === 'task-1|task-2', 'calendar replan should scope to affected tasks');
assert(input.from === '2030-01-02T09:00:00.000Z', `calendar replan from mismatch: ${input.from}`);
assert(input.to === '2030-01-09T12:30:00.000Z', `calendar replan to should extend the affected range, got ${input.to}`);

const summary = calendarReplanCandidateSummary(candidate);
assert(summary.includes('Launch plan'), 'summary should include goal title');
assert(summary.includes('2 个任务受影响'), 'summary should include affected count');
assert(summary.includes('External Planning') && summary.includes('Client Review'), 'summary should include blocking event names');

console.log('calendar-replan-candidates-client: all assertions passed');
