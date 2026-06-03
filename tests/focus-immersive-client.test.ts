import {
  confirmFocusStop,
  confirmImmersiveExit,
  enterImmersiveFocus,
  exitImmersiveFocus,
  shouldConfirmImmersiveExit,
} from '../client/src/focusImmersive';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  let prompts = 0;
  const deny = () => {
    prompts += 1;
    return false;
  };
  const allow = () => {
    prompts += 1;
    return true;
  };

  assert(shouldConfirmImmersiveExit('idle') === false, 'idle immersive exit should not require confirmation');
  assert(shouldConfirmImmersiveExit('running') === true, 'running immersive exit should require confirmation');
  assert(confirmImmersiveExit('idle', deny) === true, 'idle immersive exit should continue without prompting');
  assert(prompts === 0, `idle immersive exit should not prompt, got ${prompts}`);
  assert(confirmImmersiveExit('running', deny) === false, 'denied running immersive exit should be cancelled');
  assert(prompts === 1, `running immersive exit should prompt once, got ${prompts}`);

  prompts = 0;
  assert(confirmFocusStop({ mode: 'countup', status: 'running', immersive: false }, deny) === true, 'normal countup stop should save without confirmation');
  assert(prompts === 0, 'normal countup stop should not prompt');
  assert(confirmFocusStop({ mode: 'countup', status: 'running', immersive: true }, deny) === false, 'immersive countup stop should honor cancellation');
  assert(confirmFocusStop({ mode: 'pomodoro', status: 'paused', immersive: true }, allow) === true, 'pomodoro abandon should continue after confirmation');
  assert(confirmFocusStop({ mode: 'pomodoro', status: 'resting', immersive: true }, deny) === false, 'rest cycle stop should require confirmation');

  const target = {
    entered: false,
    async requestFullscreen() {
      this.entered = true;
    },
  } as HTMLElement & { entered: boolean };
  await enterImmersiveFocus(target);
  assert(target.entered === true, 'enterImmersiveFocus should call requestFullscreen');

  let unsupportedEnter = false;
  try {
    await enterImmersiveFocus({} as HTMLElement);
  } catch (err) {
    unsupportedEnter = (err as Error).message === 'fullscreen_not_supported';
  }
  assert(unsupportedEnter, 'missing requestFullscreen should fail explicitly');

  const doc = {
    fullscreenElement: target,
    exited: false,
    async exitFullscreen() {
      this.exited = true;
      this.fullscreenElement = null;
    },
  } as unknown as Document & { exited: boolean };
  await exitImmersiveFocus(doc);
  assert(doc.exited === true, 'exitImmersiveFocus should call exitFullscreen');

  const idleDoc = {
    fullscreenElement: null,
    exited: false,
    async exitFullscreen() {
      this.exited = true;
    },
  } as unknown as Document & { exited: boolean };
  await exitImmersiveFocus(idleDoc);
  assert(idleDoc.exited === false, 'exitImmersiveFocus should no-op when not fullscreen');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
