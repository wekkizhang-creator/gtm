import type { Selection, SmartKey, TaskStatus } from './types';

export type TaskDateFilter = '' | 'today' | 'next7days' | 'undated';
export type TaskPriorityFilter = '' | '0' | '1' | '2' | '3';
export type TaskStatusFilter = '' | TaskStatus;

export interface TaskFilterState {
  q: string;
  dateFilter: TaskDateFilter;
  priority: TaskPriorityFilter;
  status: TaskStatusFilter;
}

export type TaskFilterPatch = Partial<TaskFilterState>;

const SMART_KEYS: SmartKey[] = ['today', 'next7days', 'inbox', 'completed', 'trash'];
const DATE_FILTERS: TaskDateFilter[] = ['', 'today', 'next7days', 'undated'];
const PRIORITY_FILTERS: TaskPriorityFilter[] = ['', '0', '1', '2', '3'];
const STATUS_FILTERS: TaskStatusFilter[] = ['', 'todo', 'doing', 'waiting', 'done'];

export function emptyTaskFilterState(): TaskFilterState {
  return { q: '', dateFilter: '', priority: '', status: '' };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

export function taskFilterQuery(filters: TaskFilterState, tagId: string): Record<string, string> {
  const query: Record<string, string> = {};
  const q = filters.q.trim();
  if (q) query.q = q;
  if (tagId) query.tagId = tagId;
  if (filters.dateFilter) query.dateFilter = filters.dateFilter;
  if (filters.priority !== '') query.priority = filters.priority;
  if (filters.status) query.status = filters.status;
  return query;
}

export function savedFilterQueryFromSelection(selection: Selection, filters: TaskFilterState, tagId: string): Record<string, string> {
  const query = taskFilterQuery(filters, tagId);
  if (selection.kind === 'smart') query.view = selection.key;
  else query.listId = selection.id;
  return query;
}

export function controlsFromSavedFilterQuery(query: Record<string, unknown>): {
  filters: TaskFilterState;
  tagId: string;
  selection: Selection | null;
} {
  const filters = emptyTaskFilterState();
  const q = stringValue(query.q).trim();
  if (q) filters.q = q;

  const dateFilter = stringValue(query.dateFilter) as TaskDateFilter;
  if (DATE_FILTERS.includes(dateFilter)) filters.dateFilter = dateFilter;

  const priority = stringValue(query.priority) as TaskPriorityFilter;
  if (PRIORITY_FILTERS.includes(priority)) filters.priority = priority;

  const status = stringValue(query.status) as TaskStatusFilter;
  if (STATUS_FILTERS.includes(status)) filters.status = status;

  const view = stringValue(query.view) as SmartKey;
  const listId = stringValue(query.listId);
  const selection = SMART_KEYS.includes(view) ? { kind: 'smart' as const, key: view } : listId ? { kind: 'list' as const, id: listId } : null;

  return { filters, tagId: stringValue(query.tagId), selection };
}
