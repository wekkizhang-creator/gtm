import {
  playTaskCompletionSound,
  shouldPlayTaskCompletionSound,
  type TaskCompletionSoundSettings,
} from '../client/src/taskCompletionSound';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function notificationSettings(patch: Partial<TaskCompletionSoundSettings> = {}): { notifications: TaskCompletionSoundSettings } {
  return {
    notifications: {
      completionSound: 'ding',
      completionSoundId: null,
      reminderSound: 'default',
      reminderSoundId: null,
      reminderVolume: 70,
      ...patch,
    },
  };
}

async function main() {
  assert(shouldPlayTaskCompletionSound(false, true, notificationSettings({ completionSound: 'ding' }).notifications) === true, 'ding completion transition should play');
  assert(
    shouldPlayTaskCompletionSound(false, true, notificationSettings({ completionSound: 'custom', completionSoundId: 'sound-1' }).notifications) === true,
    'custom completion transition should play',
  );
  assert(shouldPlayTaskCompletionSound(false, true, notificationSettings({ completionSound: 'none' }).notifications) === false, 'disabled completion sound should not play');
  assert(shouldPlayTaskCompletionSound(false, true, notificationSettings({ reminderVolume: 0 }).notifications) === false, 'muted completion sound should not play');
  assert(shouldPlayTaskCompletionSound(true, false, notificationSettings().notifications) === false, 'reopening a task should not play');
  assert(shouldPlayTaskCompletionSound(true, true, notificationSettings().notifications) === false, 'already completed tasks should not play again');

  const calls: TaskCompletionSoundSettings[] = [];
  const played = await playTaskCompletionSound(
    notificationSettings({ completionSound: 'custom', completionSoundId: 'done-1' }),
    false,
    true,
    async (settings) => {
      calls.push(settings);
      return { played: true };
    },
  );
  assert(played.played === true, 'injected player should report playback');
  assert(calls.length === 1, 'completion transition should call player once');
  assert(calls[0]?.completionSound === 'custom' && calls[0]?.completionSoundId === 'done-1', 'custom completion settings should reach player');

  const disabled = await playTaskCompletionSound(notificationSettings({ completionSound: 'none' }), false, true, async (settings) => {
    calls.push(settings);
    return { played: true };
  });
  assert(disabled.played === false && disabled.reason === 'disabled', 'disabled completion sound should return disabled result');
  assert(calls.length === 1, 'disabled completion sound should not call player');
}

main();
