import { buildTaskListGroups, sortTaskList } from '../client/src/taskListView';
import type { List, Tag, Task } from '../client/src/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const INBOX_LABEL = '\u6536\u96c6\u7bb1';
const NO_DATE_LABEL = '\u65e0\u65e5\u671f';
const HIGH_PRIORITY_LABEL = '\u9ad8\u4f18\u5148\u7ea7';
const MEDIUM_PRIORITY_LABEL = '\u4e2d\u4f18\u5148\u7ea7';
const LOW_PRIORITY_LABEL = '\u4f4e\u4f18\u5148\u7ea7';
const UNTAGGED_LABEL = '\u672a\u6253\u6807\u7b7e';

const lists: List[] = [
  { id: 'work', folderId: null, name: 'Work', color: null, icon: null, type: 'task', sortOrder: 2, isInbox: false, taskCount: 0 },
  { id: 'home', folderId: null, name: 'Home', color: null, icon: null, type: 'task', sortOrder: 1, isInbox: false, taskCount: 0 },
];

const tags: Tag[] = [
  { id: 'launch', name: 'Launch', color: null, sortOrder: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'errand', name: 'Errand', color: null, sortOrder: 2, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
];

function task(input: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    id: input.id,
    title: input.title,
    note: null,
    listId: null,
    priority: 0,
    dueDate: null,
    startDate: null,
    isAllDay: true,
    isImportant: null,
    isUrgent: null,
    parentId: null,
    goalId: null,
    rootTaskId: null,
    level: 0,
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...input,
  };
}

function main() {
  const tasks = [
    task({ id: 'a', title: 'Beta', listId: 'work', priority: 3, dueDate: '2026-02-02T00:00:00.000Z', sortOrder: 2, tags: [tags[0], tags[1]] }),
    task({ id: 'b', title: 'Alpha', listId: 'home', priority: 1, dueDate: '2026-02-01T00:00:00.000Z', sortOrder: 1, tags: [tags[1]] }),
    task({ id: 'c', title: 'Inbox', listId: null, priority: 2, sortOrder: 3, tags: [] }),
  ];

  assert(sortTaskList(tasks, 'custom', lists).map((item) => item.id).join(',') === 'a,b,c', 'custom sort should preserve API order');
  assert(sortTaskList(tasks, 'time', lists).map((item) => item.id).join(',') === 'b,a,c', 'time sort should put dated tasks first');
  assert(sortTaskList(tasks, 'priority', lists).map((item) => item.id).join(',') === 'a,c,b', 'priority sort should be high to low');
  assert(sortTaskList(tasks, 'title', lists).map((item) => item.id).join(',') === 'b,a,c', 'title sort should be locale aware');
  assert(sortTaskList(tasks, 'list', lists).map((item) => item.id).join(',') === 'c,b,a', 'list sort should use inbox then list order');

  const byList = buildTaskListGroups(tasks, 'list', 'priority', lists, tags);
  assert(byList.map((group) => group.label).join(',') === `${INBOX_LABEL},Home,Work`, 'list groups should follow list order');
  const byDate = buildTaskListGroups(tasks, 'date', 'priority', lists, tags);
  assert(byDate.map((group) => group.label).join(',') === `2026-02-01,2026-02-02,${NO_DATE_LABEL}`, 'date groups should sort calendar days');
  const byPriority = buildTaskListGroups(tasks, 'priority', 'custom', lists, tags);
  assert(byPriority.map((group) => group.label).join(',') === `${HIGH_PRIORITY_LABEL},${MEDIUM_PRIORITY_LABEL},${LOW_PRIORITY_LABEL}`, 'priority groups should sort high to low');
  const byTag = buildTaskListGroups(tasks, 'tag', 'priority', lists, tags);
  assert(byTag.map((group) => group.label).join(',') === `Launch,Errand,${UNTAGGED_LABEL}`, 'tag groups should follow tag order and include untagged');
  assert(byTag.find((group) => group.label === 'Errand')?.tasks.map((item) => item.id).join(',') === 'a,b', 'multi-tag tasks should appear in every matching tag group');
}

main();
