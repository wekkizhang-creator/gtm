import type { List, Priority, Tag, Task } from '../../types';
import { PRIORITY_LABELS } from '../../util';

export type ScheduleGroupMode = 'list' | 'tag' | 'priority';

export interface ScheduleGroup {
  id: string;
  label: string;
  tasks: Task[];
}

function matches(task: Task, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    task.title.toLowerCase().includes(q) ||
    (task.note ?? '').toLowerCase().includes(q) ||
    task.tags.some((tag) => tag.name.toLowerCase().includes(q))
  );
}

function push(map: Map<string, ScheduleGroup>, id: string, label: string, task: Task): void {
  const group = map.get(id) ?? { id, label, tasks: [] };
  group.tasks.push(task);
  map.set(id, group);
}

export function groupScheduleTasks(
  tasks: Task[],
  lists: List[],
  tags: Tag[],
  mode: ScheduleGroupMode,
  query: string,
): ScheduleGroup[] {
  const listName = new Map(lists.map((list) => [list.id, list.name]));
  const tagName = new Map(tags.map((tag) => [tag.id, tag.name]));
  const filtered = tasks.filter((task) => matches(task, query.trim()));
  const groups = new Map<string, ScheduleGroup>();

  for (const task of filtered) {
    if (mode === 'list') {
      const id = task.listId ?? 'inbox';
      push(groups, id, listName.get(id) ?? '收集箱', task);
    } else if (mode === 'priority') {
      const priority = task.priority as Priority;
      push(groups, String(priority), PRIORITY_LABELS[priority], task);
    } else if (task.tags.length) {
      for (const tag of task.tags) push(groups, tag.id, tagName.get(tag.id) ?? tag.name, task);
    } else {
      push(groups, 'untagged', '未打标签', task);
    }
  }

  return [...groups.values()].sort((a, b) => {
    if (mode === 'priority') return Number(b.id) - Number(a.id);
    return a.label.localeCompare(b.label, 'zh-CN');
  });
}
