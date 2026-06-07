import type { CreateScheduleProposalInput } from './api/client';
import type { ScheduleRuleConflictItem } from './types';

export type ScheduleRuleConflictAction =
  | {
      type: 'reschedule';
      label: string;
      goalId: string;
      proposalInput: CreateScheduleProposalInput;
    }
  | {
      type: 'disable_rule';
      label: string;
      ruleId: string;
    }
  | {
      type: 'temporary_override';
      label: string;
      goalId: string;
      ruleId: string;
      proposalInput: CreateScheduleProposalInput;
    }
  | {
      type: 'view_rule';
      label: string;
      ruleId: string;
    };

export function buildScheduleRuleConflictActions(conflict: ScheduleRuleConflictItem): ScheduleRuleConflictAction[] {
  const actions: ScheduleRuleConflictAction[] = [];
  if (conflict.goalId) {
    actions.push({
      type: 'reschedule',
      label: conflict.taskId ? '重排受影响任务' : '生成重排方案',
      goalId: conflict.goalId,
      proposalInput: {
        mode: 'reschedule',
        trigger: `rule_conflict:${conflict.id}`,
        taskIds: conflict.taskId ? [conflict.taskId] : undefined,
      },
    });
  }
  const enabledRule = conflict.rules.find((rule) => rule.status === 'enabled');
  const overridableRule = conflict.rules.find((rule) => rule.status === 'enabled' && rule.priority !== 'hard');
  if (conflict.goalId && overridableRule) {
    actions.push({
      type: 'temporary_override',
      label: `临时突破「${overridableRule.name}」一次`,
      goalId: conflict.goalId,
      ruleId: overridableRule.id,
      proposalInput: {
        mode: 'reschedule',
        trigger: `rule_override:${conflict.id}:${overridableRule.id}`,
        taskIds: conflict.taskId ? [conflict.taskId] : undefined,
        ignoredRuleIds: [overridableRule.id],
      },
    });
  }
  if (enabledRule) {
    actions.push({
      type: 'disable_rule',
      label: `停用「${enabledRule.name}」`,
      ruleId: enabledRule.id,
    });
  }
  const firstRule = conflict.rules[0];
  if (firstRule) {
    actions.push({
      type: 'view_rule',
      label: '查看规则详情',
      ruleId: firstRule.id,
    });
  }
  return actions;
}
