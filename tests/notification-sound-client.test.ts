import { customNotificationSoundUrl, normalizeReminderVolume, shouldPlayNotificationSound } from '../client/src/notificationSound';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main() {
  assert(normalizeReminderVolume(70) === 0.7, '70 should normalize to 0.7 gain');
  assert(normalizeReminderVolume(101) === 1, 'volume above 100 should clamp to 1 gain');
  assert(normalizeReminderVolume(-1) === 0, 'negative volume should clamp to muted');
  assert(normalizeReminderVolume('bad') === 0, 'non-numeric volume should be muted');

  assert(shouldPlayNotificationSound('ding', 70) === true, 'ding at non-zero volume should play');
  assert(shouldPlayNotificationSound('custom', 70) === true, 'custom sound at non-zero volume should play');
  assert(shouldPlayNotificationSound('ding', 0) === false, 'zero volume should not play');
  assert(shouldPlayNotificationSound('none', 70) === false, 'disabled completion sound should not play');
  assert(
    customNotificationSoundUrl({ completionSound: 'custom', completionSoundId: 'done-1', reminderSound: 'default', reminderSoundId: null }) ===
      '/api/notification-sounds/done-1/download',
    'custom completion sound should use its download URL',
  );
  assert(
    customNotificationSoundUrl({ completionSound: 'ding', completionSoundId: null, reminderSound: 'custom', reminderSoundId: 'reminder-1' }) ===
      '/api/notification-sounds/reminder-1/download',
    'custom reminder sound should use its download URL',
  );
  assert(
    customNotificationSoundUrl({ completionSound: 'ding', completionSoundId: null, reminderSound: 'default', reminderSoundId: null }) === null,
    'default sounds should not produce a custom URL',
  );
}

main();
