import type { Task } from '../../types';

export function calendarTaskParentHint(task: Task): string | null {
  return task.parentTitle ?? (task.hierarchyPath.length > 1 ? task.hierarchyPath[task.hierarchyPath.length - 2] : null);
}

export function calendarTaskPathLabel(task: Task): string {
  return task.hierarchyPath.length > 1 ? task.hierarchyPath.join(' / ') : task.title;
}
