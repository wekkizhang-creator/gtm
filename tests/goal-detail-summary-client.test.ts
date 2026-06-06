import type { Goal, Task } from '../client/src/types';
import { buildGoalDetailSummary } from '../client/src/goalDetailSummary';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const now = new Date('2030-01-10T10:00:00.000Z');

const goal: Goal = {
  id: 'goal-1',
  title: 'Launch plan',
  description: null,
  startAt: '2030-01-01T00:00:00.000Z',
  deadlineAt: '2030-01-09T23:00:00.000Z',
  totalEstimatedMinutes: null,
  availableTimeRule: null,
  progressMode: 'auto',
  status: 'active',
  createdAt: '2030-01-01T00:00:00.000Z',
  updatedAt: '2030-01-01T00:00:00.000Z',
};

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
    goalId: goal.id,
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

const summary = buildGoalDetailSummary(
  goal,
  [
    task({ id: 'parent', title: 'Parent task', subtaskTotal: 2 }),
    task({ id: 'done', title: 'Completed copy', completed: true, status: 'done', estimatedMinutes: 30 }),
    task({
      id: 'scheduled',
      title: 'Scheduled design',
      estimatedMinutes: 60,
      isAllDay: false,
      startDate: '2030-01-10T12:00:00.000Z',
      dueDate: '2030-01-10T13:00:00.000Z',
    }),
    task({ id: 'unscheduled', title: 'Unscheduled QA', estimatedMinutes: 45 }),
    task({ id: 'overdue', title: 'Overdue review', estimatedMinutes: 15, dueDate: '2030-01-09T09:00:00.000Z' }),
    task({ id: 'skipped', title: 'Skipped task', status: 'skipped' }),
  ],
  now,
);

assert(summary.totalTaskCount === 4, `expected four leaf tasks, got ${summary.totalTaskCount}`);
assert(summary.completedTaskCount === 1, 'completed task count should include done leaf tasks');
assert(summary.openTaskCount === 3, 'open task count should exclude completed and skipped tasks');
assert(summary.scheduledTaskCount === 1, 'scheduled count should detect real time blocks');
assert(summary.unscheduledTaskCount === 2, 'unscheduled count should include auto-schedulable open tasks without time blocks');
assert(summary.overdueTaskCount === 1, 'overdue count should include open tasks past due');
assert(summary.completionPercent === 25, `expected 25% completion, got ${summary.completionPercent}`);
assert(summary.estimatedMinutes.total === 150, `expected total estimate 150, got ${summary.estimatedMinutes.total}`);
assert(summary.estimatedMinutes.completed === 30, 'completed estimate should sum completed tasks');
assert(summary.estimatedMinutes.open === 120, 'open estimate should sum open tasks');
assert(summary.riskMessages.some((message) => message.includes('计划已过截止日期')), 'expired goal should produce a deadline risk message');

console.log('goal-detail-summary-client: all assertions passed');
