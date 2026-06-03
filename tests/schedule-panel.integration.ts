import { groupScheduleTasks } from '../client/src/components/calendar/scheduleGrouping';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const tasks: any[] = [
  { id: 'a', title: 'Write launch brief', note: 'investor', listId: 'work', priority: 3, tags: [{ id: 't1', name: 'Launch' }] },
  { id: 'b', title: 'Buy snacks', note: null, listId: null, priority: 1, tags: [] },
  { id: 'c', title: 'Review copy', note: null, listId: 'work', priority: 2, tags: [{ id: 't2', name: 'Review' }] },
];
const lists: any[] = [{ id: 'work', name: 'Work' }];
const tags: any[] = [
  { id: 't1', name: 'Launch' },
  { id: 't2', name: 'Review' },
];

const byList = groupScheduleTasks(tasks, lists, tags, 'list', '');
assert(byList.find((g) => g.label === 'Work')?.tasks.length === 2, 'list grouping should include two Work tasks');
assert(byList.find((g) => g.label === '收集箱')?.tasks.length === 1, 'list grouping should include inbox fallback');

const byTag = groupScheduleTasks(tasks, lists, tags, 'tag', '');
assert(byTag.find((g) => g.label === 'Launch')?.tasks[0].id === 'a', 'tag grouping should use task tags');
assert(byTag.find((g) => g.label === '未打标签')?.tasks[0].id === 'b', 'tag grouping should include untagged tasks');

const byPriority = groupScheduleTasks(tasks, lists, tags, 'priority', '');
assert(byPriority[0].id === '3' && byPriority[0].tasks[0].id === 'a', 'priority grouping should sort high priority first');

const filtered = groupScheduleTasks(tasks, lists, tags, 'list', 'investor');
assert(filtered.length === 1 && filtered[0].tasks[0].id === 'a', 'schedule filter should search notes');

console.log('schedule panel grouping ok');
