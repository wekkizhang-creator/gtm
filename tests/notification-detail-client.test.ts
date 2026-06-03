import { canShowNotificationDetail, notificationDisplayContent } from '../client/src/notificationPrivacy';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main() {
  const item = { title: 'Pay rent', body: 'Due today' };

  assert(canShowNotificationDetail('when_unlocked', false) === true, 'unlocked default should show details');
  assert(canShowNotificationDetail('when_unlocked', true) === false, 'locked default should hide details');
  assert(canShowNotificationDetail('always', true) === true, 'always should show details even when locked');
  assert(canShowNotificationDetail('hidden', false) === false, 'hidden should hide details even when unlocked');

  const unlocked = notificationDisplayContent(item, 'when_unlocked', false);
  assert(unlocked.title === 'Pay rent' && unlocked.body === 'Due today', 'unlocked notification should keep original content');
  assert(unlocked.detailsHidden === false, 'unlocked notification should not be marked private');

  const locked = notificationDisplayContent(item, 'when_unlocked', true);
  assert(locked.title !== item.title, 'locked notification should hide title');
  assert(locked.body?.includes('解锁'), `locked notification should guide unlock, got ${locked.body}`);
  assert(locked.detailsHidden === true, 'locked notification should be marked private');

  const hidden = notificationDisplayContent(item, 'hidden', false);
  assert(hidden.title !== item.title, 'hidden preference should hide title');
  assert(hidden.body === '通知详情已隐藏', `hidden preference body mismatch: ${hidden.body}`);
  assert(hidden.detailsHidden === true, 'hidden preference should be marked private');

  const always = notificationDisplayContent(item, 'always', true);
  assert(always.title === item.title && always.body === item.body, 'always preference should reveal original content');
}

main();
