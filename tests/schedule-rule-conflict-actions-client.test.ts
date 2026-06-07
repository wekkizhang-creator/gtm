import { buildScheduleRuleConflictActions } from '../client/src/scheduleRuleConflictActions';
import type { ScheduleRuleConflictItem } from '../client/src/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const conflict: ScheduleRuleConflictItem = {
  id: 'proposal-1:0',
  proposalId: 'proposal-1',
  proposalStatus: 'draft',
  goalId: 'goal-1',
  createdAt: '2030-01-08T01:00:00.000Z',
  type: 'schedule_overflow',
  severity: 'blocking',
  taskId: 'task-1',
  taskTitle: 'Write launch brief',
  ruleIds: ['rule-1'],
  rules: [{ id: 'rule-1', name: 'No work after 21:30', priority: 'hard', status: 'enabled' }],
  message: 'Task cannot fit before the range end under current rules.',
  suggestions: ['Extend the goal deadline.', 'Disable or loosen blocking rules.'],
};

const actions = buildScheduleRuleConflictActions(conflict);
assert(actions.length === 3, `expected three actions, got ${actions.length}`);
const reschedule = actions.find((action) => action.type === 'reschedule');
assert(reschedule?.label === '重排受影响任务', 'task conflict should expose a task-specific reschedule action');
assert(reschedule?.goalId === 'goal-1', 'reschedule action should target the conflict goal');
assert(reschedule?.proposalInput.mode === 'reschedule', 'reschedule action should create a reschedule proposal');
assert(reschedule?.proposalInput.taskIds?.[0] === 'task-1', 'reschedule action should scope to the affected task');
assert(reschedule?.proposalInput.trigger === 'rule_conflict:proposal-1:0', 'reschedule trigger should retain the conflict id');
assert(actions.some((action) => action.type === 'disable_rule' && action.ruleId === 'rule-1'), 'enabled rule should expose a disable action');
assert(actions.some((action) => action.type === 'view_rule' && action.ruleId === 'rule-1'), 'conflict should expose a rule detail action');
assert(!actions.some((action) => action.type === 'temporary_override'), 'hard rules should not expose a temporary override action');

const normalConflict = {
  ...conflict,
  ruleIds: ['rule-2'],
  rules: [{ id: 'rule-2', name: 'Prefer mornings', priority: 'normal' as const, status: 'enabled' as const }],
};
const normalActions = buildScheduleRuleConflictActions(normalConflict);
const override = normalActions.find((action) => action.type === 'temporary_override');
assert(override?.label === '临时突破「Prefer mornings」一次', 'normal rules should expose one-time override action');
assert(override.goalId === 'goal-1' && override.ruleId === 'rule-2', 'override action should target the conflict goal and rule');
assert(override.proposalInput.ignoredRuleIds?.join('|') === 'rule-2', 'override proposal should ignore the selected rule once');
assert(override.proposalInput.taskIds?.[0] === 'task-1', 'override proposal should stay scoped to the affected task');
assert(override.proposalInput.trigger === 'rule_override:proposal-1:0:rule-2', 'override trigger should retain conflict and rule ids');

const disabledConflict = { ...conflict, taskId: null, rules: [{ ...conflict.rules[0], status: 'disabled' as const }] };
const disabledActions = buildScheduleRuleConflictActions(disabledConflict);
assert(disabledActions.some((action) => action.type === 'reschedule' && action.label === '生成重排方案'), 'goal conflict should expose a goal replan action');
assert(!disabledActions.some((action) => action.type === 'disable_rule'), 'disabled rules should not expose another disable action');

console.log('schedule-rule-conflict-actions-client: all assertions passed');
