import { buildScheduleRuleEditProposalInput } from '../client/src/scheduleRuleEditEffect';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const now = new Date('2030-01-08T01:30:00.000Z');

assert(buildScheduleRuleEditProposalInput('future_only', 'rule-1', now) === null, 'future-only rule edits should not create a proposal input');

const input = buildScheduleRuleEditProposalInput('recalculate_7d', 'rule-1', now);
assert(input, 'recalculate mode should create a proposal input');
assert(input.from === '2030-01-08T01:30:00.000Z', 'proposal should start from the edit time');
assert(input.to === '2030-01-15T01:30:00.000Z', 'proposal should cover exactly the next seven days');
assert(input.mode === 'reschedule', 'proposal should use reschedule mode');
assert(input.trigger === 'rule_update:rule-1', 'proposal trigger should retain the edited rule id');

console.log('schedule-rule-edit-effect-client: all assertions passed');
