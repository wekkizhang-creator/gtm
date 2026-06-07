import type { UpdateTaskInput } from './api/client';
import type { Task } from './types';

export type GoalTaskDisplayStatus = 'unscheduled' | 'scheduled' | 'doing' | 'completed' | 'overdue' | 'skipped';

export const GOAL_TASK_STATUS_LABELS: Record<GoalTaskDisplayStatus, string> = {
  unscheduled: '未排期',
  scheduled: '已排期',
  doing: '进行中',
  completed: '已完成',
  overdue: '延期',
  skipped: '跳过',
};

export interface GoalTaskStatusAction {
  key: 'start' | 'complete' | 'reopen' | 'skip';
  label: string;
  patch: UpdateTaskInput;
}

function dateValue(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function goalTaskHasSchedule(task: Task): boolean {
  return !!((task.startDate && task.dueDate && !task.isAllDay) || (task.plannedStartAt && task.plannedEndAt));
}

export function goalTaskDisplayStatus(task: Task, now: Date = new Date()): GoalTaskDisplayStatus {
  if (task.status === 'skipped') return 'skipped';
  if (task.completed || task.status === 'done') return 'completed';
  if (task.status === 'doing' || (task.actualStartAt && !task.actualEndAt)) return 'doing';

  const due = dateValue(task.dueDate ?? task.plannedEndAt);
  if (due && due < now) return 'overdue';

  return goalTaskHasSchedule(task) ? 'scheduled' : 'unscheduled';
}

export function goalTaskStatusActions(task: Task, now: Date = new Date()): GoalTaskStatusAction[] {
  const displayStatus = goalTaskDisplayStatus(task, now);

  if (displayStatus === 'completed' || displayStatus === 'skipped') {
    return [
      {
        key: 'reopen',
        label: '重新打开',
        patch: { completed: false, status: 'todo', actualEndAt: null },
      },
    ];
  }

  const actions: GoalTaskStatusAction[] = [];

  if (displayStatus !== 'doing') {
    actions.push({
      key: 'start',
      label: '开始',
      patch: { status: 'doing', actualStartAt: now.toISOString(), actualEndAt: null },
    });
  }

  actions.push(
    {
      key: 'complete',
      label: '完成',
      patch: { completed: true, status: 'done', actualEndAt: now.toISOString() },
    },
    {
      key: 'skip',
      label: '跳过',
      patch: { status: 'skipped', completed: false, actualEndAt: now.toISOString() },
    },
  );

  return actions;
}
