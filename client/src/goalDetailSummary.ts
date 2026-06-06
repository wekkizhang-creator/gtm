import type { Goal, Task } from './types';

export interface GoalDetailSummary {
  totalTaskCount: number;
  openTaskCount: number;
  completedTaskCount: number;
  scheduledTaskCount: number;
  unscheduledTaskCount: number;
  overdueTaskCount: number;
  completionPercent: number;
  estimatedMinutes: {
    total: number;
    completed: number;
    open: number;
  };
  riskMessages: string[];
}

function isSchedulableLeaf(task: Task): boolean {
  return task.subtaskTotal === 0 && task.status !== 'skipped' && !task.deletedAt;
}

function hasSchedule(task: Task): boolean {
  return !!((task.startDate && task.dueDate && !task.isAllDay) || (task.plannedStartAt && task.plannedEndAt));
}

function isOverdue(task: Task, now: Date): boolean {
  if (task.completed || task.status === 'skipped') return false;
  const due = task.dueDate ? new Date(task.dueDate) : null;
  return !!due && !Number.isNaN(due.getTime()) && due < now;
}

export function buildGoalDetailSummary(goal: Goal, tasks: Task[], now: Date = new Date()): GoalDetailSummary {
  const leafTasks = tasks.filter(isSchedulableLeaf);
  const completedTasks = leafTasks.filter((task) => task.completed);
  const openTasks = leafTasks.filter((task) => !task.completed);
  const scheduledTasks = openTasks.filter(hasSchedule);
  const unscheduledTasks = openTasks.filter((task) => task.autoScheduleEnabled && !task.isLockedSchedule && !hasSchedule(task));
  const overdueTasks = openTasks.filter((task) => isOverdue(task, now));
  const totalEstimated = leafTasks.reduce((sum, task) => sum + (task.estimatedMinutes ?? 0), 0);
  const completedEstimated = completedTasks.reduce((sum, task) => sum + (task.estimatedMinutes ?? 0), 0);
  const openEstimated = openTasks.reduce((sum, task) => sum + (task.estimatedMinutes ?? 0), 0);
  const completionPercent = leafTasks.length ? Math.round((completedTasks.length / leafTasks.length) * 100) : 0;
  const riskMessages: string[] = [];

  if (overdueTasks.length) {
    riskMessages.push(`${overdueTasks.length} 个任务已超过截止时间`);
  }
  if (goal.deadlineAt && openTasks.length) {
    const deadline = new Date(goal.deadlineAt);
    if (!Number.isNaN(deadline.getTime()) && deadline < now) {
      riskMessages.push(`计划已过截止日期，仍有 ${openTasks.length} 个任务未完成`);
    }
  }
  if (unscheduledTasks.length && goal.status !== 'completed' && goal.status !== 'archived') {
    riskMessages.push(`${unscheduledTasks.length} 个可排期任务还没有进入日历`);
  }

  return {
    totalTaskCount: leafTasks.length,
    openTaskCount: openTasks.length,
    completedTaskCount: completedTasks.length,
    scheduledTaskCount: scheduledTasks.length,
    unscheduledTaskCount: unscheduledTasks.length,
    overdueTaskCount: overdueTasks.length,
    completionPercent,
    estimatedMinutes: {
      total: totalEstimated,
      completed: completedEstimated,
      open: openEstimated,
    },
    riskMessages,
  };
}
