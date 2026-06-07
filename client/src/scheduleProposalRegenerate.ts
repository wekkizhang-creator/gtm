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

export function isScheduleProposalStaleError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'proposal_stale';
}

export function describeScheduleProposalConfirmError(err: unknown): string {
  if (isScheduleProposalStaleError(err)) {
    return '排期方案已过期。任务或规则已变更，请点击“重新生成”获取最新方案后再确认。';
  }
  return err instanceof Error ? err.message : String(err);
}

export function isScheduleProposalUndoStaleError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'proposal_undo_stale';
}

export function describeScheduleProposalUndoError(err: unknown): string {
  if (isScheduleProposalUndoStaleError(err)) {
    return '无法撤销这次排期：相关任务在确认后已被修改。请先核对当前任务时间。';
  }
  return err instanceof Error ? err.message : String(err);
}
