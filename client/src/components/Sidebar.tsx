import { useState } from 'react';
import type { List, SmartCounts, Selection, SmartKey } from '../types';

interface Props {
  lists: List[];
  counts: SmartCounts;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onAddList: (name: string) => void;
  onDeleteList: (id: string) => void;
}

const SMART_ITEMS: { key: SmartKey; label: string; icon: string }[] = [
  { key: 'today', label: '今天', icon: '📅' },
  { key: 'next7days', label: '最近7天', icon: '🗓️' },
  { key: 'inbox', label: '收集箱', icon: '📥' },
];

function isActiveSmart(sel: Selection, key: SmartKey) {
  return sel.kind === 'smart' && sel.key === key;
}

export default function Sidebar({ lists, counts, selection, onSelect, onAddList, onDeleteList }: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  function submitList(e: React.FormEvent) {
    e.preventDefault();
    const v = name.trim();
    if (!v) return;
    onAddList(v);
    setName('');
    setAdding(false);
  }

  return (
    <aside className="sidebar">
      <div className="brand">效率清单</div>

      <nav className="nav-group">
        {SMART_ITEMS.map((it) => (
          <button
            key={it.key}
            className={`nav-item${isActiveSmart(selection, it.key) ? ' active' : ''}`}
            onClick={() => onSelect({ kind: 'smart', key: it.key })}
          >
            <span className="nav-icon">{it.icon}</span>
            <span className="nav-label">{it.label}</span>
            <span className="nav-badge">{counts[it.key] || ''}</span>
          </button>
        ))}
      </nav>

      <div className="nav-section-title">
        <span>清单</span>
        <button className="add-list-btn" title="新建清单" onClick={() => setAdding((v) => !v)}>
          ＋
        </button>
      </div>

      {adding && (
        <form className="add-list-form" onSubmit={submitList}>
          <input
            autoFocus
            placeholder="清单名称，回车创建"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => !name.trim() && setAdding(false)}
          />
        </form>
      )}

      <nav className="nav-group">
        {lists.map((l) => (
          <button
            key={l.id}
            className={`nav-item${selection.kind === 'list' && selection.id === l.id ? ' active' : ''}`}
            onClick={() => onSelect({ kind: 'list', id: l.id })}
          >
            <span className="nav-icon" style={{ color: l.color ?? '#c96442' }}>
              ▤
            </span>
            <span className="nav-label">{l.name}</span>
            <span className="nav-badge">{l.taskCount || ''}</span>
            <span
              className="nav-del"
              title="删除清单"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteList(l.id);
              }}
            >
              ✕
            </span>
          </button>
        ))}
        {lists.length === 0 && <div className="nav-empty">还没有自定义清单</div>}
      </nav>

      <div className="nav-group nav-bottom">
        <button
          className={`nav-item${isActiveSmart(selection, 'completed') ? ' active' : ''}`}
          onClick={() => onSelect({ kind: 'smart', key: 'completed' })}
        >
          <span className="nav-icon">✓</span>
          <span className="nav-label">已完成</span>
          <span className="nav-badge">{counts.completed || ''}</span>
        </button>
        <button
          className={`nav-item${isActiveSmart(selection, 'trash') ? ' active' : ''}`}
          onClick={() => onSelect({ kind: 'smart', key: 'trash' })}
        >
          <span className="nav-icon">🗑️</span>
          <span className="nav-label">垃圾桶</span>
          <span className="nav-badge">{counts.trash || ''}</span>
        </button>
      </div>
    </aside>
  );
}
