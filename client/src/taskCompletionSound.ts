import { playNotificationSound, shouldPlayNotificationSound, type NotificationSoundResult } from './notificationSound';
import type { Settings } from './types';

export type TaskCompletionSoundSettings = Pick<
  Settings['notifications'],
  'completionSound' | 'completionSoundId' | 'reminderSound' | 'reminderSoundId' | 'reminderVolume'
>;

export function shouldPlayTaskCompletionSound(
  beforeCompleted: boolean,
  afterCompleted: boolean,
  settings: Pick<TaskCompletionSoundSettings, 'completionSound' | 'reminderVolume'>,
): boolean {
  return !beforeCompleted && afterCompleted && shouldPlayNotificationSound(settings.completionSound, settings.reminderVolume);
}

export async function playTaskCompletionSound(
  settings: { notifications: TaskCompletionSoundSettings },
  beforeCompleted: boolean,
  afterCompleted: boolean,
  play: (settings: TaskCompletionSoundSettings) => Promise<NotificationSoundResult> = playNotificationSound,
): Promise<NotificationSoundResult> {
  if (!shouldPlayTaskCompletionSound(beforeCompleted, afterCompleted, settings.notifications)) {
    return { played: false, reason: 'disabled' };
  }
  return play(settings.notifications);
}
