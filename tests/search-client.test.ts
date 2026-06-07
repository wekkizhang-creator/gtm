import { searchHistoryLabel, searchTypesParam, toggleSearchType } from '../client/src/searchControls';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const selected = toggleSearchType([], 'goals');
assert(searchTypesParam(selected) === 'goals', 'single selected search type should serialize to goals');

const withTasks = toggleSearchType(selected, 'tasks');
assert(searchTypesParam(withTasks) === 'tasks,goals', 'search types should serialize in stable UI order');

const withoutGoals = toggleSearchType(withTasks, 'goals');
assert(searchTypesParam(withoutGoals) === 'tasks', 'toggle should remove an already selected type');

assert(searchHistoryLabel({ query: 'Neptune', types: [] }) === 'Neptune', 'broad search history should label by query only');
assert(searchHistoryLabel({ query: 'Neptune', types: ['goals'] }) === 'Neptune · 目标', 'typed search history should include type labels');
