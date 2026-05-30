import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Countdown } from '../types';

const EMOJIS = ['🎯', '🎂', '🚀', '💍', '🎓', '✈️', '🎉', '📅', '❤️', '🏆'];

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
    setRepeat(false);
    setIcon('🎯');
    setShowForm(true);
  }
  function openEdit(c: Countdown) {
    setEditingId(c.id);
    setTitle(c.title);
    setDate(c.targetDate);
    setRepeat(c.repeatYearly);
    setIcon(c.icon ?? '🎯');
    setShowForm(true);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    const payload = { title: t, targetDate: date, repeatYearly: repeat, icon };
    void mutate(async () => {
      if (editingId) await api.updateCountdown(editingId, payload);
      else await api.createCountdown(payload);
    });
    setShowForm(false);
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
          <div className="cd-emoji-row">
            {EMOJIS.map((em) => (
              <button type="button" key={em} className={`cd-emoji${icon === em ? ' active' : ''}`} onClick={() => setIcon(em)}>
                {em}
              </button>
            ))}
          </div>
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
        {items.map((c) => {
          const d = c.daysRemaining;
          const past = d < 0;
          const label = d > 0 ? '还有' : d < 0 ? '已过' : '';
          const big = d === 0 ? '今天' : String(Math.abs(d));
          return (
            <div key={c.id} className={`cd-card${c.pinned ? ' pinned' : ''}`} onClick={() => openEdit(c)}>
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
                {c.effectiveDate}
                {c.repeatYearly ? ' · 🔁 每年' : ''}
              </div>
              <div className="cd-card-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="cd-pin"
                  title={c.pinned ? '取消置顶' : '置顶'}
                  onClick={() => void mutate(() => api.updateCountdown(c.id, { pinned: !c.pinned }))}
                >
                  {c.pinned ? '★' : '☆'}
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
