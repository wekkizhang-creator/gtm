import type { ScheduleProposal, ScheduleProposalChange, ScheduleProposalConflict } from './types';

export interface ScheduleProposalImpact {
  addedChanges: ScheduleProposalChange[];
  movedChanges: ScheduleProposalChange[];
  affectedConflicts: ScheduleProposalConflict[];
  blockedConflicts: ScheduleProposalConflict[];
  riskConflicts: ScheduleProposalConflict[];
  counts: {
    totalChanges: number;
    added: number;
    moved: number;
    affected: number;
    blocked: number;
    risks: number;
  };
}

function oldStart(change: ScheduleProposalChange): string | null {
  return change.oldPlannedStartAt ?? change.oldStartDate ?? null;
}

function oldEnd(change: ScheduleProposalChange): string | null {
  return change.oldPlannedEndAt ?? change.oldDueDate ?? null;
}

function isMovedChange(change: ScheduleProposalChange): boolean {
  const start = oldStart(change);
  const end = oldEnd(change);
  if (!start && !end) return false;
  return start !== change.plannedStartAt || end !== change.plannedEndAt;
}

export function buildScheduleProposalImpact(proposal: ScheduleProposal): ScheduleProposalImpact {
  const movedChanges = proposal.changes.filter(isMovedChange);
  const movedKeys = new Set(movedChanges.map((change) => change.changeKey));
  const addedChanges = proposal.changes.filter((change) => !movedKeys.has(change.changeKey));
  const affectedConflicts = proposal.conflicts.filter((conflict) => conflict.type === 'reschedule_impact');
  const blockedConflicts = proposal.conflicts.filter((conflict) => conflict.severity === 'blocking');
  const riskConflicts = proposal.conflicts.filter((conflict) => conflict.severity !== 'info');

  return {
    addedChanges,
    movedChanges,
    affectedConflicts,
    blockedConflicts,
    riskConflicts,
    counts: {
      totalChanges: proposal.changes.length,
      added: addedChanges.length,
      moved: movedChanges.length,
      affected: affectedConflicts.length,
      blocked: blockedConflicts.length,
      risks: riskConflicts.length,
    },
  };
}

