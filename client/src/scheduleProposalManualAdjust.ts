import type { ScheduleProposal, ScheduleProposalChange, ScheduleProposalConflict } from './types';

export interface ScheduleProposalManualPatch {
  plannedStartAt: string;
  plannedEndAt: string;
}

function parseDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid ${field}`);
  }
  return date;
}

function durationMs(change: Pick<ScheduleProposalChange, 'plannedStartAt' | 'plannedEndAt'>): number {
  const start = parseDate(change.plannedStartAt, 'plannedStartAt');
  const end = parseDate(change.plannedEndAt, 'plannedEndAt');
  const value = end.getTime() - start.getTime();
  if (value <= 0) throw new Error('invalid duration');
  return value;
}

export function buildScheduleProposalManualShift(change: ScheduleProposalChange, deltaMinutes: number): ScheduleProposalManualPatch {
  const start = parseDate(change.plannedStartAt, 'plannedStartAt');
  const deltaMs = deltaMinutes * 60_000;
  const nextStart = new Date(start.getTime() + deltaMs);
  const nextEnd = new Date(nextStart.getTime() + durationMs(change));
  return { plannedStartAt: nextStart.toISOString(), plannedEndAt: nextEnd.toISOString() };
}

export function getScheduleProposalDragMaxOffsetMinutes(range: ScheduleProposal['range'], change: ScheduleProposalChange): number {
  const rangeStart = parseDate(range.from, 'range.from');
  const rangeEnd = parseDate(range.to, 'range.to');
  const availableMs = rangeEnd.getTime() - rangeStart.getTime() - durationMs(change);
  return Math.max(0, Math.floor(availableMs / 60_000));
}

export function getScheduleProposalStartOffsetMinutes(range: ScheduleProposal['range'], plannedStartAt: string): number {
  const rangeStart = parseDate(range.from, 'range.from');
  const start = parseDate(plannedStartAt, 'plannedStartAt');
  return Math.max(0, Math.round((start.getTime() - rangeStart.getTime()) / 60_000));
}

export function buildScheduleProposalManualDragPatch(
  range: ScheduleProposal['range'],
  change: ScheduleProposalChange,
  offsetMinutes: number,
): ScheduleProposalManualPatch {
  const rangeStart = parseDate(range.from, 'range.from');
  const nextStart = new Date(rangeStart.getTime() + Math.max(0, offsetMinutes) * 60_000);
  const nextEnd = new Date(nextStart.getTime() + durationMs(change));
  return { plannedStartAt: nextStart.toISOString(), plannedEndAt: nextEnd.toISOString() };
}

export function listManualAdjustmentConflicts(proposal: ScheduleProposal, taskId: string): ScheduleProposalConflict[] {
  return proposal.conflicts.filter((conflict) => conflict.type === 'manual_adjustment_conflict' && conflict.taskId === taskId);
}

