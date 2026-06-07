import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Countdown } from '../types';

const EMOJIS = ['🎯', '🎂', '🚀', '💍', '🎓', '✈️', '🎉', '📅', '❤️', '🏆'];
const DEFAULT_COUNTDOWN_COLOR = '#c96442';

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function CountdownModule() {
  const [items, setItems] = useState<Countdown[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(todayInput());
  const [mode, setMode] = useState<'countdown' | 'countup'>('countdown');
  const [color, setColor] = useState(DEFAULT_COUNTDOWN_COLOR);
  const [note, setNote] = useState('');
  const [repeat, setRepeat] = useState(false);
  const [icon, setIcon] = useState('🎯');

  const reload = useCallback(async () => {
    try {
      setItems(await api.listCountdowns());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const mutate = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        await reload();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [reload],
  );

  function openAdd() {
    setEditingId(null);
    setTitle('');
    setDate(todayInput());
    setMode('countdown');
    setColor(DEFAULT_COUNTDOWN_COLOR);
    setNote('');
    setRepeat(false);
    setIcon('🎯');
    setShowForm(true);
  }
  function openEdit(c: Countdown) {
    setEditingId(c.id);
    setTitle(c.title);
    setDate(c.targetDate);
    setMode(c.mode);
    setColor(c.color ?? DEFAULT_COUNTDOWN_COLOR);
    setNote(c.note ?? '');
    setRepeat(c.repeatYearly);
    setIcon(c.icon ?? '🎯');
    setShowForm(true);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    const payload = { title: t, targetDate: date, mode, color, note: note.trim() || null, repeatYearly: repeat, icon };
    void mutate(async () => {
      if (editingId) await api.updateCountdown(editingId, payload);
      else await api.createCountdown(payload);
    });
    setShowForm(false);
  }

  function moveCountdown(id: string, direction: -1 | 1) {
    const index = items.findIndex((item) => item.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= items.length) return;
    if (items[index].pinned !== items[target].pinned) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    void mutate(async () => {
      const reordered = await api.reorderCountdowns(next.map((item) => item.id));
      setItems(reordered);
    });
  }

  return (
    <main className="cd-main">
      <div className="cd-toolbar">
        <h1 className="cd-title">倒数日</h1>
        <button className="cd-add-btn" onClick={openAdd}>
          ＋ 新建倒数日
        </button>
      </div>

      {error && <div className="banner banner-error">⚠ {error}</div>}

      {showForm && (
        <form className="cd-form" onSubmit={submit}>
          <input
            className="cd-title-input"
            autoFocus
            placeholder="名称（如：产品发布 / 生日）"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="cd-form-row">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <label className="cd-repeat">
              <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> 每年重复
            </label>
          </div>
          <div className="cd-mode-row" role="group" aria-label="倒数日类型">
            <button type="button" className={mode === 'countdown' ? 'active' : ''} onClick={() => setMode('countdown')}>
              倒数
            </button>
            <button type="button" className={mode === 'countup' ? 'active' : ''} onClick={() => setMode('countup')}>
              正数
            </button>
          </div>
          <label className="cd-color-field">
            <span>颜色</span>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
          <div className="cd-emoji-row">
            {EMOJIS.map((em) => (
              <button type="button" key={em} className={`cd-emoji${icon === em ? ' active' : ''}`} onClick={() => setIcon(em)}>
                {em}
              </button>
            ))}
          </div>
          <textarea className="cd-note-input" placeholder="备注（可选）" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          <div className="cd-form-actions">
            <button type="submit">{editingId ? '保存' : '创建'}</button>
            <button type="button" onClick={() => setShowForm(false)}>
              取消
            </button>
          </div>
        </form>
      )}

      <div className="cd-grid">
        {items.length === 0 && !showForm && <div className="empty">还没有倒数日，点「＋ 新建倒数日」开始</div>}
        {items.map((c, index) => {
          const d = c.daysRemaining;
          const past = d < 0;
          const label = d > 0 ? '还有' : d < 0 ? '已过' : '';
          const big = d === 0 ? '今天' : String(Math.abs(d));
          const canMoveUp = index > 0 && items[index - 1].pinned === c.pinned;
          const canMoveDown = index < items.length - 1 && items[index + 1].pinned === c.pinned;
          return (
            <div key={c.id} className={`cd-card${c.pinned ? ' pinned' : ''}`} onClick={() => openEdit(c)}>
              {c.color && <span className="cd-color-strip" style={{ background: c.color }} />}
              <div className="cd-card-top">
                <span className="cd-icon">{c.icon ?? '📅'}</span>
                <span className="cd-card-title">{c.title}</span>
              </div>
              <div className={`cd-big${past ? ' past' : ''}`}>
                {d !== 0 && <span className="cd-label">{label}</span>}
                <span className="cd-num">{big}</span>
                {d !== 0 && <span className="cd-unit">天</span>}
              </div>
              <div className="cd-meta">
                <span className="cd-mode-badge">{c.mode === 'countup' ? '正数' : '倒数'}</span>
                {c.effectiveDate}
                {c.repeatYearly ? ' · 🔁 每年' : ''}
              </div>
              {c.note && <p className="cd-note-preview">{c.note}</p>}
              <div className="cd-card-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="cd-pin"
                  title={c.pinned ? '取消置顶' : '置顶'}
                  onClick={() => void mutate(() => api.updateCountdown(c.id, { pinned: !c.pinned }))}
                >
                  {c.pinned ? '★' : '☆'}
                </button>
                <button className="cd-move" title="上移" disabled={!canMoveUp} onClick={() => moveCountdown(c.id, -1)}>
                  ▲
                </button>
                <button className="cd-move" title="下移" disabled={!canMoveDown} onClick={() => moveCountdown(c.id, 1)}>
                  ▼
                </button>
                <button className="cd-del" title="删除" onClick={() => void mutate(() => api.deleteCountdown(c.id))}>
                  ✕
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
