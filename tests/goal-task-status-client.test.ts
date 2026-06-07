import { goalTaskDisplayStatus, goalTaskHasSchedule, goalTaskStatusActions, GOAL_TASK_STATUS_LABELS } from '../client/src/goalTaskStatus';
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

const now = new Date('2030-01-10T10:00:00.000Z');

assert(GOAL_TASK_STATUS_LABELS.unscheduled === '未排期', 'unscheduled label should match PRD wording');
assert(goalTaskDisplayStatus(task({ id: 'unscheduled', title: 'Unscheduled' }), now) === 'unscheduled', 'todo task without schedule should be unscheduled');
assert(
  goalTaskDisplayStatus(
    task({
      id: 'scheduled',
      title: 'Scheduled',
      isAllDay: false,
      startDate: '2030-01-10T12:00:00.000Z',
      dueDate: '2030-01-10T13:00:00.000Z',
    }),
    now,
  ) === 'scheduled',
  'task with real calendar dates should be scheduled',
);
assert(goalTaskHasSchedule(task({ id: 'planned', title: 'Planned', plannedStartAt: '2030-01-10T12:00:00.000Z', plannedEndAt: '2030-01-10T13:00:00.000Z' })), 'planned schedule fields should count as schedule evidence');
assert(goalTaskDisplayStatus(task({ id: 'doing', title: 'Doing', status: 'doing' }), now) === 'doing', 'doing status should be shown as in progress');
assert(goalTaskDisplayStatus(task({ id: 'done', title: 'Done', completed: true, status: 'done' }), now) === 'completed', 'done task should be completed');
assert(goalTaskDisplayStatus(task({ id: 'skipped', title: 'Skipped', status: 'skipped' }), now) === 'skipped', 'skipped task should be skipped');
assert(goalTaskDisplayStatus(task({ id: 'overdue', title: 'Overdue', dueDate: '2030-01-09T09:00:00.000Z' }), now) === 'overdue', 'past due open task should be overdue');

const startAction = goalTaskStatusActions(task({ id: 'start', title: 'Start' }), now).find((action) => action.key === 'start');
assert(startAction?.patch.status === 'doing' && startAction.patch.actualStartAt === now.toISOString(), 'start action should set doing and actualStartAt');

const completeAction = goalTaskStatusActions(task({ id: 'complete', title: 'Complete' }), now).find((action) => action.key === 'complete');
assert(completeAction?.patch.completed === true && completeAction.patch.status === 'done', 'complete action should set completed and done');

const reopenAction = goalTaskStatusActions(task({ id: 'reopen', title: 'Reopen', completed: true, status: 'done' }), now)[0];
assert(reopenAction.key === 'reopen' && reopenAction.patch.completed === false && reopenAction.patch.status === 'todo', 'completed task should reopen to todo');

console.log('goal-task-status-client: all assertions passed');

