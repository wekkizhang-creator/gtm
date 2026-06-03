import { nextFocusRestPlan } from '../client/src/focusRestCycle';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main() {
  const settings = { restMinutes: 5, longRestMinutes: 20, longRestInterval: 4 };
  const first = nextFocusRestPlan(settings, 0);
  assert(first.completedPomodoros === 1, 'first plan should count the next completed pomodoro');
  assert(first.minutes === 5 && first.isLongRest === false, 'first pomodoro should use short rest');

  const fourth = nextFocusRestPlan(settings, 3);
  assert(fourth.completedPomodoros === 4, 'fourth plan should count the fourth completed pomodoro');
  assert(fourth.minutes === 20 && fourth.isLongRest === true, 'fourth pomodoro should use long rest');

  const eighth = nextFocusRestPlan(settings, 7);
  assert(eighth.minutes === 20 && eighth.isLongRest === true, 'every interval boundary should use long rest');

  const fallback = nextFocusRestPlan({ restMinutes: 0, longRestMinutes: 0, longRestInterval: 0 }, 3);
  assert(fallback.minutes === 15 && fallback.isLongRest === true, 'invalid settings should fall back to safe long-rest defaults');
}

main();
