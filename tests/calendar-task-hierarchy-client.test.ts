import type { Task } from '../client/src/types';
import { calendarTaskParentHint, calendarTaskPathLabel } from '../client/src/components/calendar/taskHierarchy';

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
    isAllDay: false,
    isImportant: null,
    isUrgent: null,
    parentId: null,
    parentTitle: null,
    hierarchyPath: [input.title],
    goalId: null,
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

const standalone = task({ id: 'root', title: 'Standalone' });
assert(calendarTaskParentHint(standalone) === null, 'top-level tasks should not show a parent hint');
assert(calendarTaskPathLabel(standalone) === 'Standalone', 'top-level path should be the task title');

const subtask = task({
  id: 'child',
  title: '阅读第 1 章',
  parentId: 'parent',
  parentTitle: '学习 AI Agent',
  hierarchyPath: ['年度学习', '学习 AI Agent', '阅读第 1 章'],
});
assert(calendarTaskParentHint(subtask) === '学习 AI Agent', 'subtask should show direct parent hint');
assert(calendarTaskPathLabel(subtask) === '年度学习 / 学习 AI Agent / 阅读第 1 章', 'subtask path should include the full hierarchy');

console.log('calendar task hierarchy ok');
