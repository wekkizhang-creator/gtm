import type { Task } from './types';

export interface GoalTaskDependencyRef {
  id: string;
  title: string;
  task: Task | null;
  satisfied: boolean;
}

export interface GoalTaskDependencyState {
  dependencies: GoalTaskDependencyRef[];
  blockers: GoalTaskDependencyRef[];
  isBlocked: boolean;
}

function dependencySatisfied(task: Task | null): boolean {
  if (!task) return false;
  return task.completed || task.status === 'done' || task.status === 'skipped';
}

export function buildGoalTaskDependencyState(task: Task, allTasks: Task[]): GoalTaskDependencyState {
  const byId = new Map(allTasks.map((item) => [item.id, item]));
  const dependencies = task.dependencyTaskIds.map((dependencyId) => {
    const dependency = byId.get(dependencyId) ?? null;
    return {
      id: dependencyId,
      title: dependency?.title ?? '缺失的前置任务',
      task: dependency,
      satisfied: dependencySatisfied(dependency),
    };
  });
  const blockers = dependencies.filter((dependency) => !dependency.satisfied);
  return {
    dependencies,
    blockers,
    isBlocked: blockers.length > 0,
  };
}

