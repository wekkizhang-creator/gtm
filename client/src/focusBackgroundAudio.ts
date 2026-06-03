import type { BackgroundSound, Settings } from './types';

type FocusStatus = 'idle' | 'running' | 'paused' | 'resting';
type FocusAudioSettings = Pick<Settings['focus'], 'backgroundAudioAllowed' | 'pauseSoundOnPause' | 'playSoundDuringRest' | 'fadeOutStop'>;
type AudioConstructor = new (src?: string) => HTMLAudioElement;

interface FocusAudioRuntime {
  Audio?: AudioConstructor;
  setInterval?: (handler: () => void, timeout: number) => number;
  clearInterval?: (id: number) => void;
}

export const FOCUS_AUDIO_FADE_OUT_MS = 900;
const FADE_STEP_MS = 75;

function defaultRuntime(): FocusAudioRuntime | undefined {
  if (typeof window === 'undefined') return undefined;
  return {
    Audio: window.Audio,
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
  };
}

export function normalizeFocusAudioVolume(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric))) / 100;
}

export function playableFocusSoundUrl(sound: Pick<BackgroundSound, 'assetUrl' | 'localPath'> | null | undefined): string | null {
  if (!sound) return null;
  const localPath = sound.localPath?.trim();
  if (localPath && !localPath.startsWith('cache://')) return localPath;
  return sound.assetUrl?.trim() || null;
}

export function shouldPlayFocusBackgroundAudio(
  status: FocusStatus,
  settings: FocusAudioSettings,
  sound: Pick<BackgroundSound, 'assetUrl' | 'localPath'> | null | undefined,
): boolean {
  if (!settings.backgroundAudioAllowed || !playableFocusSoundUrl(sound)) return false;
  if (status === 'running') return true;
  if (status === 'paused') return !settings.pauseSoundOnPause;
  if (status === 'resting') return settings.playSoundDuringRest;
  return false;
}

export function focusAudioFadeDuration(fadeOutStop: boolean): number {
  return fadeOutStop ? FOCUS_AUDIO_FADE_OUT_MS : 0;
}

export function focusAudioFadeStepVolume(startVolume: number, step: number, totalSteps: number): number {
  if (totalSteps <= 0) return 0;
  const remainingRatio = Math.max(0, totalSteps - step) / totalSteps;
  return Math.max(0, Math.min(1, startVolume * remainingRatio));
}

export class FocusBackgroundAudioController {
  private audio: HTMLAudioElement | null = null;
  private source: string | null = null;
  private fadeTimer: number | null = null;
  private readonly runtime: FocusAudioRuntime | undefined;

  constructor(runtime: FocusAudioRuntime | undefined = defaultRuntime()) {
    this.runtime = runtime;
  }

  async play(sound: Pick<BackgroundSound, 'assetUrl' | 'localPath'>, volume: number): Promise<{ played: boolean; reason?: 'unsupported' | 'missing_source' | 'play_failed' }> {
    const source = playableFocusSoundUrl(sound);
    if (!source) return { played: false, reason: 'missing_source' };
    const AudioCtor = this.runtime?.Audio;
    if (!AudioCtor) return { played: false, reason: 'unsupported' };

    this.cancelFade();
    if (!this.audio || this.source !== source) {
      this.stop({ fadeOut: false });
      this.audio = new AudioCtor(source);
      this.audio.loop = true;
      this.audio.preload = 'auto';
      this.source = source;
    }

    this.audio.volume = normalizeFocusAudioVolume(volume);
    try {
      await this.audio.play();
      return { played: true };
    } catch {
      return { played: false, reason: 'play_failed' };
    }
  }

  setVolume(volume: number): void {
    if (this.audio) this.audio.volume = normalizeFocusAudioVolume(volume);
  }

  pause(options: { fadeOut: boolean }): void {
    const audio = this.audio;
    if (!audio || audio.paused) return;
    this.fadeOrRun(audio, options.fadeOut, () => {
      audio.pause();
    });
  }

  stop(options: { fadeOut: boolean }): void {
    const audio = this.audio;
    if (!audio) return;
    this.fadeOrRun(audio, options.fadeOut, () => {
      audio.pause();
      audio.currentTime = 0;
      if (this.audio === audio) {
        this.audio = null;
        this.source = null;
      }
    });
  }

  dispose(): void {
    this.cancelFade();
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
    }
    this.audio = null;
    this.source = null;
  }

  private fadeOrRun(audio: HTMLAudioElement, fadeOut: boolean, after: () => void): void {
    this.cancelFade();
    const durationMs = focusAudioFadeDuration(fadeOut);
    const setInterval = this.runtime?.setInterval;
    const clearInterval = this.runtime?.clearInterval;
    if (!durationMs || !setInterval || !clearInterval || audio.volume <= 0) {
      after();
      return;
    }
    const startVolume = audio.volume;
    const totalSteps = Math.max(1, Math.round(durationMs / FADE_STEP_MS));
    let step = 0;
    this.fadeTimer = setInterval(() => {
      step += 1;
      audio.volume = focusAudioFadeStepVolume(startVolume, step, totalSteps);
      if (step >= totalSteps) {
        this.cancelFade();
        after();
      }
    }, FADE_STEP_MS);
  }

  private cancelFade(): void {
    if (this.fadeTimer != null) {
      this.runtime?.clearInterval?.(this.fadeTimer);
      this.fadeTimer = null;
    }
  }
}
