import type { Goal } from './types';

export const GOAL_STATUS_LABELS: Record<Goal['status'], string> = {
  not_started: '未开始',
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  archived: '已归档',
};

export interface GoalStatusAction {
  status: Goal['status'];
  label: string;
}

export function goalStatusActions(status: Goal['status']): GoalStatusAction[] {
  if (status === 'not_started') {
    return [
      { status: 'active', label: '开始' },
      { status: 'paused', label: '暂停' },
      { status: 'completed', label: '完成' },
      { status: 'archived', label: '归档' },
    ];
  }
  if (status === 'active') {
    return [
      { status: 'paused', label: '暂停' },
      { status: 'completed', label: '完成' },
      { status: 'archived', label: '归档' },
    ];
  }
  if (status === 'paused') {
    return [
      { status: 'active', label: '继续' },
      { status: 'archived', label: '归档' },
    ];
  }
  if (status === 'completed') {
    return [
      { status: 'active', label: '重新打开' },
      { status: 'archived', label: '归档' },
    ];
  }
  return [{ status: 'active', label: '恢复' }];
}

export function goalCanAutoSchedule(status: Goal['status']): boolean {
  return status === 'active' || status === 'not_started';
}
