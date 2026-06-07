import type { SearchHistory, SearchResult } from './types';

export const SEARCH_TYPE_OPTIONS: Array<{ type: SearchResult['type']; label: string }> = [
  { type: 'tasks', label: '任务' },
  { type: 'lists', label: '清单' },
  { type: 'tags', label: '标签' },
  { type: 'habits', label: '习惯' },
  { type: 'countdowns', label: '倒数日' },
  { type: 'goals', label: '目标' },
];

export function normalizeSearchTypes(types: SearchResult['type'][]): SearchResult['type'][] {
  const selected = new Set(types);
  return SEARCH_TYPE_OPTIONS.map((item) => item.type).filter((type) => selected.has(type));
}

export function toggleSearchType(selected: SearchResult['type'][], type: SearchResult['type']): SearchResult['type'][] {
  const next = selected.includes(type) ? selected.filter((item) => item !== type) : [...selected, type];
  return normalizeSearchTypes(next);
}

export function searchTypesParam(types: SearchResult['type'][]): string | undefined {
  const normalized = normalizeSearchTypes(types);
  return normalized.length ? normalized.join(',') : undefined;
}

export function searchHistoryLabel(item: Pick<SearchHistory, 'query' | 'types'>): string {
  if (!item.types.length) return item.query;
  const labels = item.types
    .map((type) => SEARCH_TYPE_OPTIONS.find((option) => option.type === type)?.label ?? type)
    .join('、');
  return `${item.query} · ${labels}`;
}
