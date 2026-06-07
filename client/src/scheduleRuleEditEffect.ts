import type { CreateScheduleProposalInput } from './api/client';

export type ScheduleRuleEditApplyMode = 'future_only' | 'recalculate_7d';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function buildScheduleRuleEditProposalInput(
  mode: ScheduleRuleEditApplyMode,
  ruleId: string,
  now = new Date(),
): CreateScheduleProposalInput | null {
  if (mode !== 'recalculate_7d') return null;
  return {
    from: now.toISOString(),
    to: new Date(now.getTime() + SEVEN_DAYS_MS).toISOString(),
    mode: 'reschedule',
    trigger: `rule_update:${ruleId}`,
  };
}
