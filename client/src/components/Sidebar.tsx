import { useEffect, useMemo, useState } from 'react';
import { useSettings } from '../settings';
import { api } from '../api/client';
import { rangeFor, ymd, WEEKDAYS } from '../calendarUtil';
import type { CalendarDayInfo, List, ListFolder, SmartCounts, Selection, SmartKey } from '../types';

interface Props {
  lists: List[];
  folders: ListFolder[];
  counts: SmartCounts;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onAddList: (name: string, folderId?: string | null, type?: List['type']) => void;
  onDeleteList: (id: string) => void;
  onUpdateList: (id: string, patch: Partial<Pick<List, 'folderId' | 'sortOrder' | 'type'>>) => void;
  onReorderLists: (updates: Array<{ id: string; sortOrder: number }>) => void;
  onAddFolder: (name: string) => void;
  onUpdateFolder: (id: string, patch: Partial<Pick<ListFolder, 'collapsed' | 'name' | 'sortOrder'>>) => void;
  onReorderFolders: (updates: Array<{ id: string; sortOrder: number }>) => void;
  onDeleteFolder: (id: string) => void;
}

const SMART_ITEMS: { key: SmartKey; label: string; icon: string }[] = [
  { key: 'today', label: '今天', icon: '📅' },
  { key: 'next7days', label: '最近7天', icon: '🗓️' },
  { key: 'inbox', label: '收集箱', icon: '📥' },
];

function isActiveSmart(sel: Selection, key: SmartKey) {
  return sel.kind === 'smart' && sel.key === key;
}

function sameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

function weekNumber(date: Date): number {
  const first = new Date(date.getFullYear(), 0, 1);
  const dayOffset = Math.floor((date.getTime() - first.getTime()) / 86_400_000);
  return Math.floor((dayOffset + first.getDay()) / 7) + 1;
}

export default function Sidebar({
  lists,
  folders,
  counts,
  selection,
  onSelect,
  onAddList,
  onDeleteList,
  onUpdateList,
  onReorderLists,
  onAddFolder,
  onUpdateFolder,
  onReorderFolders,
  onDeleteFolder,
}: Props) {
  const { settings } = useSettings();
  const hidden = settings.smartLists.hidden;
  const [adding, setAdding] = useState(false);
  const [addingFolder, setAddingFolder] = useState(false);
  const [name, setName] = useState('');
  const [folderName, setFolderName] = useState('');
  const [folderId, setFolderId] = useState('');
  const [listType, setListType] = useState<List['type']>('task');
  const [miniAnchor, setMiniAnchor] = useState(() => new Date());
  const [miniDayInfos, setMiniDayInfos] = useState<CalendarDayInfo[]>([]);
  const showMiniLunar = settings.miniCalendar.showLunar === 'on' || (settings.miniCalendar.showLunar === 'follow' && settings.datetime.showLunar);
  const miniRange = useMemo(() => rangeFor('month', miniAnchor, settings.datetime.weekStart), [miniAnchor, settings.datetime.weekStart]);
  const miniInfoByDate = useMemo(() => new Map(miniDayInfos.map((info) => [info.date, info])), [miniDayInfos]);

  useEffect(() => {
    if (!settings.miniCalendar.enabled || !showMiniLunar) {
      setMiniDayInfos([]);
      return;
    }
    let alive = true;
    api.listCalendarDayInfo(miniRange.fromISO, miniRange.toISO).then((days) => {
      if (alive) setMiniDayInfos(days);
    }).catch(() => {
      if (alive) setMiniDayInfos([]);
    });
    return () => {
      alive = false;
    };
  }, [settings.miniCalendar.enabled, showMiniLunar, miniRange.fromISO, miniRange.toISO]);

  function submitList(e: React.FormEvent) {
    e.preventDefault();
    const v = name.trim();
    if (!v) return;
    onAddList(v, folderId || null, listType);
    setName('');
    setListType('task');
    setAdding(false);
  }

  function submitFolder(e: React.FormEvent) {
    e.preventDefault();
    const v = folderName.trim();
    if (!v) return;
    onAddFolder(v);
    setFolderName('');
    setAddingFolder(false);
  }

  function renderList(l: List) {
    const siblings = lists.filter((list) => (list.folderId ?? null) === (l.folderId ?? null));
    const index = siblings.findIndex((list) => list.id === l.id);
    const prev = index > 0 ? siblings[index - 1] : null;
    const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null;
    const currentFirst = siblings[0];
    return (
      <button
        key={l.id}
        className={`nav-item${selection.kind === 'list' && selection.id === l.id ? ' active' : ''}`}
        onClick={() => onSelect({ kind: 'list', id: l.id })}
      >
        <span className="nav-icon" style={{ color: l.color ?? '#c96442' }}>
          ▤
        </span>
        <span className="nav-label">{l.name}</span>
        {l.type === 'note' && <span className="nav-type-badge">Note</span>}
        <span className="nav-badge">{l.taskCount || ''}</span>
        <select
          className="nav-type-select"
          title="清单类型"
          value={l.type}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onUpdateList(l.id, { type: e.target.value as List['type'] })}
        >
          <option value="task">任务</option>
          <option value="note">笔记</option>
        </select>
        <select
          className="nav-folder-select"
          title="移动到文件夹"
          value={l.folderId ?? ''}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onUpdateList(l.id, { folderId: e.target.value || null })}
        >
          <option value="">无文件夹</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
        <span className="nav-order-actions" aria-label={`排序 ${l.name}`}>
          <span
            role="button"
            aria-disabled={!prev}
            title="上移"
            className={!prev ? 'disabled' : ''}
            onClick={(e) => {
              e.stopPropagation();
              if (prev) onReorderLists([{ id: l.id, sortOrder: prev.sortOrder }, { id: prev.id, sortOrder: l.sortOrder }]);
            }}
          >
            ↑
          </span>
          <span
            role="button"
            aria-disabled={!next}
            title="下移"
            className={!next ? 'disabled' : ''}
            onClick={(e) => {
              e.stopPropagation();
              if (next) onReorderLists([{ id: l.id, sortOrder: next.sortOrder }, { id: next.id, sortOrder: l.sortOrder }]);
            }}
          >
            ↓
          </span>
          <span
            role="button"
            aria-disabled={currentFirst?.id === l.id}
            title="置顶"
            className={currentFirst?.id === l.id ? 'disabled' : ''}
            onClick={(e) => {
              e.stopPropagation();
              if (currentFirst && currentFirst.id !== l.id) onReorderLists([{ id: l.id, sortOrder: currentFirst.sortOrder - 1 }]);
            }}
          >
            ⇧
          </span>
        </span>
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
    );
  }

  const ungrouped = lists.filter((list) => !list.folderId);

  return (
    <aside className="sidebar">
      <div className="brand">效率清单</div>

      {settings.miniCalendar.enabled && (
        <section className="mini-calendar">
          <div className="mini-calendar-head">
            <button type="button" onClick={() => setMiniAnchor((date) => new Date(date.getFullYear(), date.getMonth() - 1, 1))}>‹</button>
            <span>{miniAnchor.getFullYear()}年{miniAnchor.getMonth() + 1}月</span>
            <button type="button" onClick={() => setMiniAnchor((date) => new Date(date.getFullYear(), date.getMonth() + 1, 1))}>›</button>
          </div>
          <div className={`mini-calendar-weekdays${settings.miniCalendar.showWeekNumbers ? ' with-weeks' : ''}`}>
            {settings.miniCalendar.showWeekNumbers && <span>周</span>}
            {Array.from({ length: 7 }, (_, i) => WEEKDAYS[(settings.datetime.weekStart + i) % 7].replace('周', '')).map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className={`mini-calendar-grid${settings.miniCalendar.showWeekNumbers ? ' with-weeks' : ''}`}>
            {miniRange.days.flatMap((day, index) => {
              const key = ymd(day);
              const info = miniInfoByDate.get(key);
              const muted = day.getMonth() !== miniAnchor.getMonth();
              const today = sameDay(day, new Date());
              const nodes = [];
              if (settings.miniCalendar.showWeekNumbers && index % 7 === 0) {
                nodes.push(
                  <span key={`${key}-week`} className="mini-week-num">
                    {weekNumber(day)}
                  </span>,
                );
              }
              nodes.push(
                <button
                  key={key}
                  type="button"
                  className={`mini-day${muted ? ' muted' : ''}${today ? ' today' : ''}${info?.isOffDay ? ' off' : ''}`}
                  title={info?.holidayName ?? key}
                  onClick={() => onSelect({ kind: 'smart', key: 'today' })}
                >
                  <span>{day.getDate()}</span>
                  {showMiniLunar && info?.lunarLabel && <small>{info.lunarLabel}</small>}
                </button>,
              );
              return nodes;
            })}
          </div>
        </section>
      )}

      <nav className="nav-group">
        {SMART_ITEMS.filter((it) => !hidden.includes(it.key)).map((it) => (
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
        <div className="nav-title-actions">
          <button className="add-list-btn" title="新建文件夹" onClick={() => setAddingFolder((v) => !v)}>
            文件夹
          </button>
          <button className="add-list-btn" title="新建清单" onClick={() => setAdding((v) => !v)}>
            ＋
          </button>
        </div>
      </div>

      {addingFolder && (
        <form className="add-list-form" onSubmit={submitFolder}>
          <input
            autoFocus
            placeholder="文件夹名称，回车创建"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            onBlur={() => !folderName.trim() && setAddingFolder(false)}
          />
        </form>
      )}

      {adding && (
        <form className="add-list-form" onSubmit={submitList}>
          <input
            autoFocus
            placeholder="清单名称，回车创建"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => !name.trim() && setAdding(false)}
          />
          <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">无文件夹</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
          <select value={listType} onChange={(e) => setListType(e.target.value as List['type'])}>
            <option value="task">任务清单</option>
            <option value="note">笔记清单</option>
          </select>
        </form>
      )}

      <nav className="nav-group">
        {folders.map((folder, folderIndex) => {
          const children = lists.filter((list) => list.folderId === folder.id);
          const prev = folderIndex > 0 ? folders[folderIndex - 1] : null;
          const next = folderIndex < folders.length - 1 ? folders[folderIndex + 1] : null;
          const first = folders[0];
          return (
            <div className="nav-folder" key={folder.id}>
              <div className="nav-folder-head">
                <button
                  className="nav-folder-toggle"
                  title={folder.collapsed ? '展开文件夹' : '折叠文件夹'}
                  onClick={() => onUpdateFolder(folder.id, { collapsed: !folder.collapsed })}
                >
                  {folder.collapsed ? '▸' : '▾'}
                </button>
                <span className="nav-folder-name">{folder.name}</span>
                <span className="nav-badge">{children.reduce((sum, list) => sum + list.taskCount, 0) || ''}</span>
                <span className="nav-order-actions nav-folder-order" aria-label={`排序文件夹 ${folder.name}`}>
                  <button
                    type="button"
                    title="上移"
                    disabled={!prev}
                    onClick={() => prev && onReorderFolders([{ id: folder.id, sortOrder: prev.sortOrder }, { id: prev.id, sortOrder: folder.sortOrder }])}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    title="下移"
                    disabled={!next}
                    onClick={() => next && onReorderFolders([{ id: folder.id, sortOrder: next.sortOrder }, { id: next.id, sortOrder: folder.sortOrder }])}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    title="置顶"
                    disabled={first?.id === folder.id}
                    onClick={() => first && first.id !== folder.id && onReorderFolders([{ id: folder.id, sortOrder: first.sortOrder - 1 }])}
                  >
                    ⇧
                  </button>
                </span>
                <button className="nav-folder-delete" title="删除文件夹" onClick={() => onDeleteFolder(folder.id)}>
                  ✕
                </button>
              </div>
              {!folder.collapsed && children.map(renderList)}
            </div>
          );
        })}
        {ungrouped.map(renderList)}
        {lists.length === 0 && <div className="nav-empty">还没有自定义清单</div>}
      </nav>

      <div className="nav-group nav-bottom">
        {!hidden.includes('completed') && (
          <button
            className={`nav-item${isActiveSmart(selection, 'completed') ? ' active' : ''}`}
            onClick={() => onSelect({ kind: 'smart', key: 'completed' })}
          >
            <span className="nav-icon">✓</span>
            <span className="nav-label">已完成</span>
            <span className="nav-badge">{counts.completed || ''}</span>
          </button>
        )}
        {!hidden.includes('trash') && (
          <button
            className={`nav-item${isActiveSmart(selection, 'trash') ? ' active' : ''}`}
            onClick={() => onSelect({ kind: 'smart', key: 'trash' })}
          >
            <span className="nav-icon">🗑️</span>
            <span className="nav-label">垃圾桶</span>
            <span className="nav-badge">{counts.trash || ''}</span>
          </button>
        )}
      </div>
    </aside>
  );
}
