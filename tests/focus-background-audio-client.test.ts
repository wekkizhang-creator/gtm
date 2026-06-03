import {
  focusAudioFadeDuration,
  focusAudioFadeStepVolume,
  FOCUS_AUDIO_FADE_OUT_MS,
  normalizeFocusAudioVolume,
  playableFocusSoundUrl,
  shouldPlayFocusBackgroundAudio,
} from '../client/src/focusBackgroundAudio';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function near(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < 0.000001;
}

function main() {
  const sound = { assetUrl: '/sounds/rain.wav', localPath: null };
  const cachedSound = { assetUrl: '/sounds/rain.wav', localPath: 'cache://rain' };
  const localSound = { assetUrl: '/sounds/rain.wav', localPath: '/local/rain.wav' };
  const settings = {
    backgroundAudioAllowed: true,
    pauseSoundOnPause: true,
    playSoundDuringRest: false,
    fadeOutStop: true,
  };

  assert(normalizeFocusAudioVolume(50) === 0.5, '50 should normalize to half volume');
  assert(normalizeFocusAudioVolume(150) === 1, 'volume above 100 should clamp to 1');
  assert(normalizeFocusAudioVolume(-10) === 0, 'negative volume should clamp to 0');
  assert(playableFocusSoundUrl(sound) === '/sounds/rain.wav', 'asset URL should be playable');
  assert(playableFocusSoundUrl(cachedSound) === '/sounds/rain.wav', 'cache placeholders should fall back to the asset URL');
  assert(playableFocusSoundUrl(localSound) === '/local/rain.wav', 'real local/browser paths should be preferred');

  assert(shouldPlayFocusBackgroundAudio('running', settings, sound) === true, 'running focus should play background audio');
  assert(shouldPlayFocusBackgroundAudio('paused', settings, sound) === false, 'paused focus should stop when pause sync is enabled');
  assert(shouldPlayFocusBackgroundAudio('paused', { ...settings, pauseSoundOnPause: false }, sound) === true, 'paused focus can keep playing when configured');
  assert(shouldPlayFocusBackgroundAudio('resting', settings, sound) === false, 'rest should stop when rest playback is disabled');
  assert(shouldPlayFocusBackgroundAudio('resting', { ...settings, playSoundDuringRest: true }, sound) === true, 'rest should play when configured');
  assert(shouldPlayFocusBackgroundAudio('running', { ...settings, backgroundAudioAllowed: false }, sound) === false, 'background audio permission should disable playback');

  assert(focusAudioFadeDuration(true) === FOCUS_AUDIO_FADE_OUT_MS, 'fade enabled should use configured duration');
  assert(focusAudioFadeDuration(false) === 0, 'fade disabled should stop immediately');
  assert(near(focusAudioFadeStepVolume(0.8, 1, 4), 0.6), 'fade step should reduce volume linearly');
  assert(focusAudioFadeStepVolume(0.8, 4, 4) === 0, 'last fade step should reach silence');
}

main();
