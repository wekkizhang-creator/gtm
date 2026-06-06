import { GOAL_STATUS_LABELS, goalCanAutoSchedule, goalStatusActions } from '../client/src/goalStatus';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(GOAL_STATUS_LABELS.paused === '已暂停', 'paused status should have a user-facing label');
assert(goalCanAutoSchedule('active'), 'active goals should be schedulable');
assert(goalCanAutoSchedule('not_started'), 'not-started goals should be schedulable');
assert(!goalCanAutoSchedule('paused'), 'paused goals should not be schedulable');
assert(!goalCanAutoSchedule('completed'), 'completed goals should not be schedulable');
assert(!goalCanAutoSchedule('archived'), 'archived goals should not be schedulable');
assert(goalStatusActions('active').some((action) => action.status === 'paused'), 'active goals should expose pause action');
assert(goalStatusActions('paused').some((action) => action.status === 'active' && action.label === '继续'), 'paused goals should expose resume action');
assert(goalStatusActions('archived').some((action) => action.status === 'active' && action.label === '恢复'), 'archived goals should expose restore action');

console.log('goal-status-client: all assertions passed');
