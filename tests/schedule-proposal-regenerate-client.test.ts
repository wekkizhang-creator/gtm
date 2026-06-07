import {
  buildScheduleProposalRegenerateInput,
  describeScheduleProposalConfirmError,
  isScheduleProposalStaleError,
} from '../client/src/scheduleProposalRegenerate';
import type { ScheduleProposal } from '../client/src/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function proposal(input: Partial<ScheduleProposal>): ScheduleProposal {
  return {
    id: input.id ?? 'proposal-1',
    goalId: input.goalId ?? 'goal-1',
    status: input.status ?? 'draft',
    range: input.range ?? { from: '2030-01-01T00:00:00.000Z', to: '2030-01-08T00:00:00.000Z' },
    changes: input.changes ?? [],
    explanations: input.explanations ?? [],
    conflicts: input.conflicts ?? [],
    riskScore: input.riskScore ?? 0,
    createdAt: input.createdAt ?? '2030-01-01T00:00:00.000Z',
    confirmedAt: input.confirmedAt ?? null,
  };
}

const initialInput = buildScheduleProposalRegenerateInput(
  proposal({
    changes: [
      {
        changeKey: 'change-1',
        taskId: 'task-1',
        title: 'Write copy',
        operation: 'schedule_task',
        segmentIndex: null,
        segmentTotal: null,
        createdTaskId: null,
        oldStartDate: null,
        oldDueDate: null,
        oldPlannedStartAt: null,
        oldPlannedEndAt: null,
        oldIsAllDay: true,
        plannedStartAt: '2030-01-02T09:00:00.000Z',
        plannedEndAt: '2030-01-02T10:00:00.000Z',
        durationMinutes: 60,
        ruleIds: [],
        avoidedBlocks: [],
        reason: 'First open slot.',
        conflict: false,
        confirmed: false,
      },
    ],
  }),
);

assert(initialInput.mode === 'initial_schedule', 'initial proposal regeneration should stay initial_schedule');
assert(initialInput.from === '2030-01-01T00:00:00.000Z' && initialInput.to === '2030-01-08T00:00:00.000Z', 'regeneration should preserve range');
assert(initialInput.trigger === 'regenerate:proposal-1', 'regeneration trigger should keep the source proposal id');
assert(initialInput.taskIds === undefined, 'initial regeneration should not scope to only scheduled changes');

const replanInput = buildScheduleProposalRegenerateInput(
  proposal({
    id: 'proposal-2',
    changes: [
      {
        changeKey: 'change-2',
        taskId: 'task-2',
        title: 'Move deck',
        operation: 'schedule_task',
        segmentIndex: null,
        segmentTotal: null,
        createdTaskId: null,
        oldStartDate: '2030-01-02T09:00:00.000Z',
        oldDueDate: '2030-01-02T10:00:00.000Z',
        oldPlannedStartAt: '2030-01-02T09:00:00.000Z',
        oldPlannedEndAt: '2030-01-02T10:00:00.000Z',
        oldIsAllDay: false,
        plannedStartAt: '2030-01-02T11:00:00.000Z',
        plannedEndAt: '2030-01-02T12:00:00.000Z',
        durationMinutes: 60,
        ruleIds: [],
        avoidedBlocks: [],
        reason: 'Moved away from external event.',
        conflict: false,
        confirmed: false,
      },
    ],
    conflicts: [
      {
        type: 'reschedule_impact',
        severity: 'info',
        taskId: 'task-2',
        ruleIds: [],
        message: 'Task overlaps external event.',
        suggestions: [],
      },
    ],
  }),
);

assert(replanInput.mode === 'reschedule', 'replan regeneration should keep reschedule mode');
assert(replanInput.taskIds?.join('|') === 'task-2', 'replan regeneration should scope to affected tasks');
assert(replanInput.trigger === 'regenerate:proposal-2', 'replan trigger should keep the source proposal id');

const staleError = new Error('server english stale message') as Error & { code?: string };
staleError.code = 'proposal_stale';
assert(isScheduleProposalStaleError(staleError), 'proposal_stale API errors should be recognized by the client');
assert(
  describeScheduleProposalConfirmError(staleError).includes('重新生成'),
  'stale confirmation errors should guide the user to regenerate the proposal',
);
const normalError = new Error('ordinary confirm failure');
assert(describeScheduleProposalConfirmError(normalError) === 'ordinary confirm failure', 'non-stale confirmation errors should keep their original message');

console.log('schedule-proposal-regenerate-client: all assertions passed');
