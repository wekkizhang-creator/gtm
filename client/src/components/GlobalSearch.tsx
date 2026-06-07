import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { SEARCH_TYPE_OPTIONS, searchHistoryLabel, searchTypesParam, toggleSearchType } from '../searchControls';
import type { SearchHistory, SearchResult } from '../types';

const TYPE_LABELS: Record<SearchResult['type'], string> = {
  tasks: '任务',
  lists: '清单',
  tags: '标签',
  habits: '习惯',
  countdowns: '倒数日',
  goals: '目标',
};

export default function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [selectedTypes, setSelectedTypes] = useState<SearchResult['type'][]>([]);
  const [history, setHistory] = useState<SearchHistory[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void loadHistory();
  }, [open]);

  async function loadHistory() {
    try {
      setHistory(await api.listSearchHistory());
    } catch {
      setHistory([]);
    }
  }

  async function runSearch(query: string, types = selectedTypes) {
    const trimmed = query.trim();
    if (!trimmed) return;
    try {
      setResults(await api.search(trimmed, searchTypesParam(types)));
      setError(null);
      await loadHistory();
    } catch (err) {
      setError((err as Error).message);
      setResults([]);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await runSearch(q);
  }

  async function pickHistory(item: SearchHistory) {
    setQ(item.query);
    setSelectedTypes(item.types);
    await runSearch(item.query, item.types);
  }

  async function removeHistory(id: string) {
    try {
      await api.deleteSearchHistory(id);
      await loadHistory();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="global-search">
      <button className="global-search-toggle" onClick={() => setOpen((v) => !v)} title="搜索">
        🔍
      </button>
      {open && (
        <div className="global-search-panel">
          <form onSubmit={(e) => void submit(e)}>
            <input autoFocus placeholder="搜索任务、目标、习惯..." value={q} onChange={(e) => setQ(e.target.value)} />
            <button type="submit">搜索</button>
          </form>
          <div className="global-search-types">
            <button type="button" className={selectedTypes.length === 0 ? 'active' : ''} onClick={() => setSelectedTypes([])}>
              全部
            </button>
            {SEARCH_TYPE_OPTIONS.map((item) => (
              <button
                key={item.type}
                type="button"
                className={selectedTypes.includes(item.type) ? 'active' : ''}
                onClick={() => setSelectedTypes((current) => toggleSearchType(current, item.type))}
              >
                {item.label}
              </button>
            ))}
          </div>
          {history.length > 0 && (
            <div className="global-search-history">
              {history.map((item) => (
                <span key={item.id}>
                  <button type="button" onClick={() => void pickHistory(item)} title={`${item.resultCount} 个结果`}>
                    {searchHistoryLabel(item)}
                  </button>
                  <button type="button" aria-label="删除搜索历史" onClick={() => void removeHistory(item.id)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {error && <div className="notif-error">{error}</div>}
          <ul>
            {results.map((item) => (
              <li key={`${item.type}:${item.id}`}>
                <span>{TYPE_LABELS[item.type]}</span>
                <strong>{item.title}</strong>
                {item.subtitle && <small>{item.subtitle}</small>}
              </li>
            ))}
            {q && results.length === 0 && !error && <li className="notif-empty">没有结果</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
