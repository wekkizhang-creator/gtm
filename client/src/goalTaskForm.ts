import type { Priority, ScheduleEnergyType } from './types';
import { dateInputToISO } from './util';

export interface GoalTaskFormState {
  title: string;
  parentId: string;
  estimatedMinutesText: string;
  scheduleEnergyType: '' | ScheduleEnergyType;
  scheduleTaskType: string;
  isSplittable: boolean;
  minScheduleMinutesText: string;
}

export interface GoalTaskCreateInput {
  title: string;
  parentId: string | null;
  estimatedMinutes: number | null;
  scheduleEnergyType: ScheduleEnergyType | null;
  scheduleTaskType: string | null;
  isSplittable: boolean;
  minScheduleMinutes: number | null;
}

export interface GoalTaskEditFormState {
  title: string;
  priority: Priority;
  dueDateText: string;
  estimatedMinutesText: string;
  scheduleEnergyType: '' | ScheduleEnergyType;
  scheduleTaskType: string;
  isSplittable: boolean;
  minScheduleMinutesText: string;
}

export interface GoalTaskEditPatch {
  title: string;
  priority: Priority;
  dueDate: string | null;
  isAllDay: boolean;
  estimatedMinutes: number | null;
  scheduleEnergyType: ScheduleEnergyType | null;
  scheduleTaskType: string | null;
  isSplittable: boolean;
  minScheduleMinutes: number | null;
}

function optionalNumber(value: string): number | null {
  return value.trim() ? Number(value) : null;
}

export function buildGoalTaskCreateInput(form: GoalTaskFormState): GoalTaskCreateInput {
  return {
    title: form.title.trim(),
    parentId: form.parentId || null,
    estimatedMinutes: optionalNumber(form.estimatedMinutesText),
    scheduleEnergyType: form.scheduleEnergyType || null,
    scheduleTaskType: form.scheduleTaskType.trim() || null,
    isSplittable: form.isSplittable,
    minScheduleMinutes: form.isSplittable ? optionalNumber(form.minScheduleMinutesText) : null,
  };
}

export function buildGoalTaskEditPatch(form: GoalTaskEditFormState): GoalTaskEditPatch {
  return {
    title: form.title.trim(),
    priority: form.priority,
    dueDate: dateInputToISO(form.dueDateText),
    isAllDay: true,
    estimatedMinutes: optionalNumber(form.estimatedMinutesText),
    scheduleEnergyType: form.scheduleEnergyType || null,
    scheduleTaskType: form.scheduleTaskType.trim() || null,
    isSplittable: form.isSplittable,
    minScheduleMinutes: form.isSplittable ? optionalNumber(form.minScheduleMinutesText) : null,
  };
}
