import {
  buildScheduleProposalManualDragPatch,
  buildScheduleProposalManualShift,
  getScheduleProposalDragMaxOffsetMinutes,
  getScheduleProposalStartOffsetMinutes,
  listManualAdjustmentConflicts,
} from '../client/src/scheduleProposalManualAdjust';
import type { ScheduleProposal, ScheduleProposalChange } from '../client/src/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const change: ScheduleProposalChange = {
  changeKey: 'task-1:schedule',
  taskId: 'task-1',
  title: 'Draft investor update',
  operation: 'schedule_task',
  segmentIndex: null,
  segmentTotal: null,
  createdTaskId: null,
  oldStartDate: null,
  oldDueDate: null,
  oldPlannedStartAt: null,
  oldPlannedEndAt: null,
  oldIsAllDay: true,
  plannedStartAt: '2030-01-11T12:00:00.000Z',
  plannedEndAt: '2030-01-11T13:00:00.000Z',
  durationMinutes: 60,
  ruleIds: [],
  avoidedBlocks: [],
  reason: 'Fits this block.',
  conflict: false,
  confirmed: false,
};

const proposal: ScheduleProposal = {
  id: 'proposal-1',
  goalId: 'goal-1',
  status: 'draft',
  range: { from: '2030-01-11T12:00:00.000Z', to: '2030-01-11T16:00:00.000Z' },
  changes: [change],
  explanations: [],
  conflicts: [
    {
      type: 'manual_adjustment_conflict',
      severity: 'warning',
      taskId: 'task-1',
      ruleIds: [],
      message: 'Manual adjustment overlaps Review launch checklist.',
      suggestions: ['Choose a free time slot before confirming this proposal change.'],
    },
    {
      type: 'manual_adjustment_conflict',
      severity: 'warning',
      taskId: 'other-task',
      ruleIds: [],
      message: 'Other task conflict.',
      suggestions: [],
    },
  ],
  riskScore: 1,
  createdAt: '2030-01-11T10:00:00.000Z',
  confirmedAt: null,
};

const shifted = buildScheduleProposalManualShift(change, 30);
assert(shifted.plannedStartAt === '2030-01-11T12:30:00.000Z', 'shift should move start by delta minutes');
assert(shifted.plannedEndAt === '2030-01-11T13:30:00.000Z', 'shift should preserve duration');

assert(getScheduleProposalDragMaxOffsetMinutes(proposal.range, change) === 180, 'drag max should preserve one-hour task inside four-hour range');
assert(getScheduleProposalStartOffsetMinutes(proposal.range, '2030-01-11T13:30:00.000Z') === 90, 'drag offset should be minutes from proposal range start');

const dragged = buildScheduleProposalManualDragPatch(proposal.range, change, 120);
assert(dragged.plannedStartAt === '2030-01-11T14:00:00.000Z', 'drag patch should start at range start plus offset');
assert(dragged.plannedEndAt === '2030-01-11T15:00:00.000Z', 'drag patch should preserve task duration');

const conflicts = listManualAdjustmentConflicts(proposal, 'task-1');
assert(conflicts.length === 1, 'manual adjustment conflicts should be filtered by task');
assert(conflicts[0].message.includes('Review launch checklist'), 'manual adjustment conflict should preserve server message');

console.log('schedule-proposal-manual-adjust-client: all assertions passed');

