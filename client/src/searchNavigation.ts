import type { ModuleKey } from './components/ModuleRail';
import type { SearchResult } from './types';

export interface SearchNavigationTarget {
  type: SearchResult['type'];
  id: string;
  title: string;
  nonce: number;
}

export function moduleForSearchResult(type: SearchResult['type']): ModuleKey {
  if (type === 'goals') return 'goals';
  if (type === 'habits') return 'habits';
  if (type === 'countdowns') return 'countdown';
  return 'tasks';
}

export function createSearchNavigationTarget(item: SearchResult, nonce: number): SearchNavigationTarget {
  return {
    type: item.type,
    id: item.id,
    title: item.title,
    nonce,
  };
}
