import type { Task } from './types';

export type TaskManualOrderAction = 'up' | 'down' | 'top';

export interface TaskOrderUpdate {
  id: string;
  sortOrder: number;
}

export function taskManualOrderUpdates(
  tasks: Array<Pick<Task, 'id' | 'sortOrder'>>,
  taskId: string,
  action: TaskManualOrderAction,
): TaskOrderUpdate[] {
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return [];
  const current = tasks[index];
  if (action === 'up') {
    const prev = tasks[index - 1];
    return prev ? [{ id: current.id, sortOrder: prev.sortOrder }, { id: prev.id, sortOrder: current.sortOrder }] : [];
  }
  if (action === 'down') {
    const next = tasks[index + 1];
    return next ? [{ id: current.id, sortOrder: next.sortOrder }, { id: next.id, sortOrder: current.sortOrder }] : [];
  }
  const first = tasks[0];
  return first && first.id !== current.id ? [{ id: current.id, sortOrder: first.sortOrder - 1 }] : [];
}
