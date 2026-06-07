import { buildGoalTaskDependencyState } from '../client/src/goalTaskDependencies';
import type { Task } from '../client/src/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function task(input: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    id: input.id,
    title: input.title,
    note: null,
    listId: null,
    priority: 1,
    dueDate: null,
    startDate: null,
    isAllDay: true,
    isImportant: null,
    isUrgent: null,
    parentId: null,
    parentTitle: null,
    hierarchyPath: [input.title],
    goalId: 'goal-1',
    rootTaskId: null,
    level: 1,
    plannedStartAt: null,
    plannedEndAt: null,
    actualStartAt: null,
    actualEndAt: null,
    dependencyTaskIds: [],
    autoScheduleEnabled: true,
    isLockedSchedule: false,
    estimatedMinutes: null,
    scheduleEnergyType: null,
    scheduleTaskType: null,
    isSplittable: false,
    minScheduleMinutes: null,
    subtaskConfig: { progressMode: 'auto', autoCompleteParent: false, collapsed: false },
    recurrenceRule: null,
    source: 'manual',
    manualProgress: null,
    pinned: false,
    status: 'todo',
    tags: [],
    reminders: [],
    attachments: [],
    checklistTotal: 0,
    checklistDone: 0,
    subtaskTotal: 0,
    subtaskDone: 0,
    rollupProgress: 0,
    completed: false,
    completedAt: null,
    deletedAt: null,
    sortOrder: 0,
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z',
    ...input,
  };
}

const prerequisite = task({ id: 'copy', title: 'Write copy' });
const completedPrerequisite = task({ id: 'done', title: 'Approve outline', completed: true, status: 'done' });
const skippedPrerequisite = task({ id: 'skipped', title: 'Optional research', status: 'skipped' });
const dependent = task({
  id: 'design',
  title: 'Design cover',
  dependencyTaskIds: ['copy', 'done', 'skipped', 'missing'],
});

const state = buildGoalTaskDependencyState(dependent, [dependent, prerequisite, completedPrerequisite, skippedPrerequisite]);

assert(state.dependencies.length === 4, 'dependency state should preserve all dependency ids');
assert(state.blockers.length === 2, `expected unfinished and missing blockers, got ${state.blockers.length}`);
assert(state.isBlocked, 'unfinished dependency should block the dependent task');
assert(state.blockers.some((dependency) => dependency.id === 'copy' && dependency.title === 'Write copy'), 'unfinished dependency should be a blocker');
assert(state.blockers.some((dependency) => dependency.id === 'missing' && dependency.title === '缺失的前置任务'), 'missing dependency should be a blocker');
assert(state.dependencies.find((dependency) => dependency.id === 'done')?.satisfied === true, 'done dependency should be satisfied');
assert(state.dependencies.find((dependency) => dependency.id === 'skipped')?.satisfied === true, 'skipped dependency should be satisfied');

console.log('goal-task-dependencies-client: all assertions passed');

