import { createSearchNavigationTarget, moduleForSearchResult } from '../client/src/searchNavigation';
import type { SearchResult } from '../client/src/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const base: SearchResult = {
  type: 'tasks',
  id: 'task-1',
  title: 'Task result',
  subtitle: null,
  matchedFields: ['title'],
  updatedAt: '2026-06-07T00:00:00.000Z',
};

assert(moduleForSearchResult('tasks') === 'tasks', 'task search result should open tasks module');
assert(moduleForSearchResult('lists') === 'tasks', 'list search result should open tasks module');
assert(moduleForSearchResult('tags') === 'tasks', 'tag search result should open tasks module');
assert(moduleForSearchResult('goals') === 'goals', 'goal search result should open goals module');
assert(moduleForSearchResult('habits') === 'habits', 'habit search result should open habits module');
assert(moduleForSearchResult('countdowns') === 'countdown', 'countdown search result should open countdown module');

const target = createSearchNavigationTarget(base, 42);
assert(target.type === 'tasks' && target.id === 'task-1' && target.title === 'Task result', 'navigation target should preserve the clicked result');
assert(target.nonce === 42, 'navigation target should preserve nonce for repeated clicks');
