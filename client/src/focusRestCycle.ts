export interface FocusRestSettings {
  restMinutes: number;
  longRestMinutes: number;
  longRestInterval: number;
}

export interface FocusRestPlan {
  minutes: number;
  isLongRest: boolean;
  completedPomodoros: number;
}

function positiveInt(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function nextFocusRestPlan(settings: FocusRestSettings, completedPomodorosBefore: number): FocusRestPlan {
  const completedPomodoros = Math.max(0, Math.trunc(completedPomodorosBefore)) + 1;
  const longRestInterval = positiveInt(settings.longRestInterval, 4);
  const isLongRest = completedPomodoros % longRestInterval === 0;
  return {
    completedPomodoros,
    isLongRest,
    minutes: isLongRest ? positiveInt(settings.longRestMinutes, 15) : positiveInt(settings.restMinutes, 5),
  };
}
