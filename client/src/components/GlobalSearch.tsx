import { useState } from 'react';
import { api } from '../api/client';
import type { SearchResult } from '../types';

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
  const [results, setResults] = useState<SearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    try {
      setResults(await api.search(q.trim()));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setResults([]);
    }
  }

  return (
    <div className="global-search">
      <button className="global-search-toggle" onClick={() => setOpen((v) => !v)} title="搜索">
        🔎
      </button>
      {open && (
        <div className="global-search-panel">
          <form onSubmit={(e) => void submit(e)}>
            <input autoFocus placeholder="搜索任务、目标、习惯..." value={q} onChange={(e) => setQ(e.target.value)} />
            <button type="submit">搜索</button>
          </form>
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
