import {
  controlsFromSavedFilterQuery,
  emptyTaskFilterState,
  savedFilterQueryFromSelection,
  taskFilterQuery,
  type TaskFilterState,
} from '../client/src/taskFilters';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main() {
  const filters: TaskFilterState = { q: ' launch ', dateFilter: 'today', priority: '3', status: 'doing' };
  const query = taskFilterQuery(filters, 'tag-1');
  assert(query.q === 'launch', 'query should trim keyword');
  assert(query.tagId === 'tag-1', 'query should include tag');
  assert(query.dateFilter === 'today', 'query should include date filter');
  assert(query.priority === '3', 'query should include priority');
  assert(query.status === 'doing', 'query should include status');

  const saved = savedFilterQueryFromSelection({ kind: 'list', id: 'list-1' }, filters, 'tag-1');
  assert(saved.listId === 'list-1' && !saved.view, 'saved list filter should persist list scope');
  assert(saved.q === 'launch' && saved.priority === '3' && saved.status === 'doing', 'saved filter should persist conditions');

  const restored = controlsFromSavedFilterQuery({ view: 'inbox', tagId: 'tag-2', q: ' brief ', dateFilter: 'undated', priority: 0, status: 'waiting' });
  assert(restored.selection?.kind === 'smart' && restored.selection.key === 'inbox', 'saved smart filter should restore selection');
  assert(restored.tagId === 'tag-2', 'saved filter should restore tag');
  assert(restored.filters.q === 'brief', 'saved filter should trim restored keyword');
  assert(restored.filters.dateFilter === 'undated', 'saved filter should restore date filter');
  assert(restored.filters.priority === '0', 'saved filter should restore numeric priority as string');
  assert(restored.filters.status === 'waiting', 'saved filter should restore status');

  const ignored = controlsFromSavedFilterQuery({ view: 'bad', dateFilter: 'future', priority: 9, status: 'blocked' });
  assert(ignored.selection === null, 'invalid selection should be ignored');
  assert(JSON.stringify(ignored.filters) === JSON.stringify(emptyTaskFilterState()), 'invalid saved filter values should reset to empty controls');
}

main();
