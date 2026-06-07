import type { CreateScheduleProposalInput } from './api/client';
import type { ScheduleProposal } from './types';

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0)));
}

export function buildScheduleProposalRegenerateInput(proposal: ScheduleProposal): CreateScheduleProposalInput {
  const rescheduleTaskIds = unique([
    ...proposal.conflicts.filter((conflict) => conflict.type === 'reschedule_impact').map((conflict) => conflict.taskId),
    ...proposal.changes.filter((change) => change.oldPlannedStartAt || change.oldStartDate).map((change) => change.taskId),
  ]);
  const isReschedule = rescheduleTaskIds.length > 0;
  return {
    from: proposal.range.from,
    to: proposal.range.to,
    mode: isReschedule ? 'reschedule' : 'initial_schedule',
    trigger: `regenerate:${proposal.id}`,
    taskIds: isReschedule ? rescheduleTaskIds : undefined,
  };
}
