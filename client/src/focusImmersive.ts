export type FocusPhase = 'idle' | 'running' | 'paused' | 'resting';
export type FocusMode = 'pomodoro' | 'countup';

export function shouldConfirmImmersiveExit(status: FocusPhase): boolean {
  return status !== 'idle';
}

export function confirmImmersiveExit(status: FocusPhase, confirmFn: (message: string) => boolean): boolean {
  if (!shouldConfirmImmersiveExit(status)) return true;
  return confirmFn('退出沉浸模式？当前专注或休息仍会继续。');
}

export function confirmFocusStop(
  input: { mode: FocusMode; status: FocusPhase; immersive: boolean },
  confirmFn: (message: string) => boolean,
): boolean {
  if (input.status === 'idle') return true;
  if (input.status === 'resting') return confirmFn('结束休息并停止循环？');
  if (input.mode === 'pomodoro') return confirmFn('放弃这个番茄？本次专注不会被记录。');
  if (input.immersive) return confirmFn('结束并保存本次正计时专注？');
  return true;
}

export async function enterImmersiveFocus(target: HTMLElement): Promise<void> {
  if (typeof target.requestFullscreen !== 'function') {
    throw new Error('fullscreen_not_supported');
  }
  await target.requestFullscreen();
}

export async function exitImmersiveFocus(doc: Document): Promise<void> {
  if (!doc.fullscreenElement) return;
  if (typeof doc.exitFullscreen !== 'function') {
    throw new Error('fullscreen_not_supported');
  }
  await doc.exitFullscreen();
}
