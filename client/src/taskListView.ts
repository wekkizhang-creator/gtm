import type { List, Priority, Tag, Task } from './types';

export type TaskSortMode = 'custom' | 'time' | 'priority' | 'title' | 'list';
export type TaskGroupMode = 'none' | 'list' | 'date' | 'priority' | 'tag';

export interface TaskListGroup {
  id: string;
  label: string;
  tasks: Task[];
}

const ALL_LABEL = '\u5168\u90e8';
const INBOX_LABEL = '\u6536\u96c6\u7bb1';
const NO_DATE_LABEL = '\u65e0\u65e5\u671f';
const UNTAGGED_LABEL = '\u672a\u6253\u6807\u7b7e';

const PRIORITY_LABELS: Record<Priority, string> = {
  0: '\u65e0\u4f18\u5148\u7ea7',
  1: '\u4f4e\u4f18\u5148\u7ea7',
  2: '\u4e2d\u4f18\u5148\u7ea7',
  3: '\u9ad8\u4f18\u5148\u7ea7',
};

function taskTime(task: Task): number | null {
  const value = task.startDate ?? task.dueDate;
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function dayKey(task: Task): string | null {
  const value = task.startDate ?? task.dueDate;
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function listMeta(lists: List[]): Map<string, { label: string; order: number }> {
  const map = new Map<string, { label: string; order: number }>();
  for (const list of lists) {
    map.set(list.id, { label: list.name, order: list.isInbox ? -1 : list.sortOrder });
  }
  return map;
}

function listOrder(task: Task, lists: List[]): number {
  if (!task.listId) return -1;
  return listMeta(lists).get(task.listId)?.order ?? -1;
}

function fallbackCompare(a: Task, b: Task): number {
  return a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export function sortTaskList(tasks: Task[], mode: TaskSortMode, lists: List[]): Task[] {
  if (mode === 'custom') return [...tasks];
  return [...tasks].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (mode === 'time') {
      const left = taskTime(a);
      const right = taskTime(b);
      if (left != null && right != null && left !== right) return left - right;
      if (left != null && right == null) return -1;
      if (left == null && right != null) return 1;
      return fallbackCompare(a, b);
    }
    if (mode === 'priority') {
      return b.priority - a.priority || (taskTime(a) ?? Number.MAX_SAFE_INTEGER) - (taskTime(b) ?? Number.MAX_SAFE_INTEGER) || fallbackCompare(a, b);
    }
    if (mode === 'title') {
      return a.title.localeCompare(b.title, 'zh-CN') || fallbackCompare(a, b);
    }
    return listOrder(a, lists) - listOrder(b, lists) || fallbackCompare(a, b);
  });
}

function push(map: Map<string, TaskListGroup>, id: string, label: string, task: Task): void {
  const group = map.get(id) ?? { id, label, tasks: [] };
  group.tasks.push(task);
  map.set(id, group);
}

export function buildTaskListGroups(tasks: Task[], mode: TaskGroupMode, sortMode: TaskSortMode, lists: List[], tags: Tag[]): TaskListGroup[] {
  const sorted = sortTaskList(tasks, sortMode, lists);
  if (mode === 'none') return [{ id: 'all', label: ALL_LABEL, tasks: sorted }];

  const groups = new Map<string, TaskListGroup>();
  const listsById = listMeta(lists);
  const tagsById = new Map(tags.map((tag) => [tag.id, tag]));

  for (const task of sorted) {
    if (mode === 'list') {
      const list = task.listId ? listsById.get(task.listId) : null;
      push(groups, list && task.listId ? task.listId : 'inbox', list?.label ?? INBOX_LABEL, task);
    } else if (mode === 'date') {
      const key = dayKey(task);
      push(groups, key ? `date:${key}` : 'date:none', key ?? NO_DATE_LABEL, task);
    } else if (mode === 'priority') {
      const priority = task.priority as Priority;
      push(groups, String(priority), PRIORITY_LABELS[priority], task);
    } else if (task.tags.length) {
      for (const tag of task.tags) push(groups, tag.id, tagsById.get(tag.id)?.name ?? tag.name, task);
    } else {
      push(groups, 'tag:none', UNTAGGED_LABEL, task);
    }
  }

  return [...groups.values()].sort((a, b) => {
    if (mode === 'list') {
      const left = a.id === 'inbox' ? -1 : listsById.get(a.id)?.order ?? Number.MAX_SAFE_INTEGER;
      const right = b.id === 'inbox' ? -1 : listsById.get(b.id)?.order ?? Number.MAX_SAFE_INTEGER;
      return left - right || a.label.localeCompare(b.label, 'zh-CN');
    }
    if (mode === 'date') {
      if (a.id === 'date:none') return 1;
      if (b.id === 'date:none') return -1;
      return a.id.localeCompare(b.id);
    }
    if (mode === 'priority') return Number(b.id) - Number(a.id);
    if (a.id === 'tag:none') return 1;
    if (b.id === 'tag:none') return -1;
    const left = tagsById.get(a.id)?.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const right = tagsById.get(b.id)?.sortOrder ?? Number.MAX_SAFE_INTEGER;
    return left - right || a.label.localeCompare(b.label, 'zh-CN');
  });
}
