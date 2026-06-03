import type { Settings } from './types';

type CompletionSound = Settings['notifications']['completionSound'];

interface NotificationSoundRuntime {
  AudioContext?: new () => AudioContext;
  webkitAudioContext?: new () => AudioContext;
  Audio?: new (src?: string) => HTMLAudioElement;
}

export interface NotificationSoundResult {
  played: boolean;
  reason?: 'disabled' | 'unsupported' | 'failed';
}

export function normalizeReminderVolume(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric))) / 100;
}

export function shouldPlayNotificationSound(completionSound: CompletionSound | undefined, reminderVolume: unknown): boolean {
  return completionSound !== 'none' && normalizeReminderVolume(reminderVolume) > 0;
}

export function customNotificationSoundUrl(
  settings: Pick<Settings['notifications'], 'completionSound' | 'completionSoundId' | 'reminderSound' | 'reminderSoundId'>,
): string | null {
  const customId = settings.completionSound === 'custom' ? settings.completionSoundId : settings.reminderSound === 'custom' ? settings.reminderSoundId : null;
  return customId ? `/api/notification-sounds/${encodeURIComponent(customId)}/download` : null;
}

export async function playNotificationSound(
  settings: Pick<
    Settings['notifications'],
    'completionSound' | 'completionSoundId' | 'reminderSound' | 'reminderSoundId' | 'reminderVolume'
  >,
  runtime: NotificationSoundRuntime | undefined = typeof window === 'undefined' ? undefined : (window as Window & NotificationSoundRuntime),
): Promise<NotificationSoundResult> {
  if (!shouldPlayNotificationSound(settings.completionSound, settings.reminderVolume)) {
    return { played: false, reason: 'disabled' };
  }
  const customUrl = customNotificationSoundUrl(settings);
  if (customUrl) {
    const AudioElement = runtime?.Audio;
    if (!AudioElement) return { played: false, reason: 'unsupported' };
    try {
      const audio = new AudioElement(customUrl);
      audio.volume = normalizeReminderVolume(settings.reminderVolume);
      await audio.play();
      return { played: true };
    } catch {
      return { played: false, reason: 'failed' };
    }
  }
  const AudioCtor = runtime?.AudioContext ?? runtime?.webkitAudioContext;
  if (!AudioCtor) return { played: false, reason: 'unsupported' };

  try {
    const context = new AudioCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    gain.gain.value = normalizeReminderVolume(settings.reminderVolume);
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => {
      void context.close().catch(() => {});
    };
    if (context.state === 'suspended') await context.resume();
    oscillator.start();
    oscillator.stop(context.currentTime + 0.18);
    return { played: true };
  } catch {
    return { played: false, reason: 'failed' };
  }
}
