import { buildScheduleProposalImpact } from '../client/src/scheduleProposalImpact';
import type { ScheduleProposal, ScheduleProposalChange } from '../client/src/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function change(input: Partial<ScheduleProposalChange> & Pick<ScheduleProposalChange, 'changeKey' | 'taskId' | 'title'>): ScheduleProposalChange {
  return {
    changeKey: input.changeKey,
    taskId: input.taskId,
    title: input.title,
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
    reason: 'Fits the available focus block',
    conflict: false,
    confirmed: false,
    ...input,
  };
}

const proposal: ScheduleProposal = {
  id: 'proposal-1',
  goalId: 'goal-1',
  status: 'draft',
  range: {
    from: '2030-01-11T12:00:00.000Z',
    to: '2030-01-11T16:00:00.000Z',
  },
  changes: [
    change({
      changeKey: 'new-task',
      taskId: 'task-new',
      title: 'Write launch notes',
    }),
    change({
      changeKey: 'moved-task',
      taskId: 'task-moved',
      title: 'Draft investor update',
      oldPlannedStartAt: '2030-01-11T11:00:00.000Z',
      oldPlannedEndAt: '2030-01-11T12:00:00.000Z',
      plannedStartAt: '2030-01-11T14:00:00.000Z',
      plannedEndAt: '2030-01-11T15:00:00.000Z',
    }),
  ],
  explanations: [],
  conflicts: [
    {
      type: 'reschedule_impact',
      severity: 'info',
      taskId: 'task-moved',
      ruleIds: [],
      message: 'Investor Call overlaps the original block.',
      suggestions: ['Move after Investor Call'],
    },
    {
      type: 'schedule_overflow',
      severity: 'blocking',
      taskId: 'task-blocked',
      ruleIds: ['rule-night'],
      message: 'No valid slot before deadline.',
      suggestions: ['Relax the night rule'],
    },
    {
      type: 'rule_conflict',
      severity: 'warning',
      taskId: 'task-risk',
      ruleIds: ['rule-focus'],
      message: 'Preferred focus block is unavailable.',
      suggestions: ['Use a lower energy block'],
    },
  ],
  riskScore: 3,
  createdAt: '2030-01-11T10:00:00.000Z',
  confirmedAt: null,
};

const impact = buildScheduleProposalImpact(proposal);

assert(impact.counts.totalChanges === 2, 'total change count should come from proposal changes');
assert(impact.counts.added === 1, 'new task without old planned time should count as added');
assert(impact.addedChanges[0].changeKey === 'new-task', 'added changes should preserve proposal change data');
assert(impact.counts.moved === 1, 'change with different old planned time should count as moved');
assert(impact.movedChanges[0].changeKey === 'moved-task', 'moved changes should preserve proposal change data');
assert(impact.counts.affected === 1, 'reschedule_impact should count as affected task');
assert(impact.affectedConflicts[0].taskId === 'task-moved', 'affected conflict should preserve task id');
assert(impact.counts.blocked === 1, 'blocking conflict should count as unavailable scheduling');
assert(impact.blockedConflicts[0].type === 'schedule_overflow', 'blocked conflict should preserve conflict type');
assert(impact.counts.risks === 2, 'warning and blocking conflicts should count as risks');

console.log('schedule-proposal-impact-client: all assertions passed');

