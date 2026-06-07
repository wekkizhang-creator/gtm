import { buildGoalTaskStructureSummary } from '../client/src/goalTaskStructureSummary';
import type { AITaskStructureResult, Task } from '../client/src/types';

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

const result: AITaskStructureResult = {
  logId: 'log-1',
  goalId: 'goal-1',
  updates: [
    {
      taskId: 'task-1',
      title: 'Draft launch memo',
      estimatedMinutes: 90,
      scheduleEnergyType: 'high',
      scheduleTaskType: 'deep_work',
      isSplittable: true,
      minScheduleMinutes: 30,
      suggestedDueDate: '2030-01-05T18:00:00.000Z',
      reason: '需要连续专注时间。',
    },
    {
      taskId: 'task-2',
      title: 'Inbox cleanup',
      estimatedMinutes: null,
      scheduleEnergyType: null,
      scheduleTaskType: null,
      isSplittable: false,
      minScheduleMinutes: null,
      suggestedDueDate: null,
      reason: null,
    },
  ],
  tasks: [
    task({ id: 'task-1', title: 'Launch memo' }),
    task({ id: 'task-2', title: 'Inbox cleanup' }),
  ],
};

const summary = buildGoalTaskStructureSummary(result);

assert(summary.length === 2, `expected two summary items, got ${summary.length}`);
assert(summary[0].title === 'Launch memo', 'summary should use the persisted task title when available');
assert(summary[0].reason === '需要连续专注时间。', 'summary should keep the AI reason');
assert(summary[0].changes.some((change) => change.label === '预计耗时' && change.value === '90 分钟'), 'estimated minutes should be formatted');
assert(summary[0].changes.some((change) => change.label === '精力类型' && change.value === '高精力'), 'energy type should be localized');
assert(summary[0].changes.some((change) => change.label === '任务类型' && change.value === 'deep_work'), 'task type should be visible');
assert(summary[0].changes.some((change) => change.label === '可拆分' && change.value === '允许拆分'), 'split state should be visible');
assert(summary[0].changes.some((change) => change.label === '最小时间块' && change.value === '30 分钟'), 'minimum schedule block should be formatted');
assert(summary[0].changes.some((change) => change.label === '建议截止' && change.value === '2030-01-05 18:00'), 'suggested due date should be visible');
assert(summary[1].changes.some((change) => change.label === '预计耗时' && change.value === '未设置'), 'null values should be explicit');
assert(summary[1].changes.some((change) => change.label === '可拆分' && change.value === '不拆分'), 'false split state should be explicit');
assert(summary[1].changes.some((change) => change.label === '建议截止' && change.value === '未设置'), 'missing suggested due date should be explicit');

console.log('goal-task-structure-summary-client: all assertions passed');
