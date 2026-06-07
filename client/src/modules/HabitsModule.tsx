import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { ensureNotificationPermission } from '../notificationPermission';
import { useSettings } from '../settings';
import type { SearchNavigationTarget } from '../searchNavigation';
import { startOfDay, addDays, ymd, WEEKDAYS } from '../calendarUtil';
import type { Habit } from '../types';

const EMOJIS = ['🌙', '📖', '🏃', '💧', '🧘', '🍎', '💪', '✍️', '🛌', '🥗'];

interface Props {
  searchTarget?: SearchNavigationTarget | null;
}

export default function HabitsModule({ searchTarget }: Props) {
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [habits, setHabits] = useState<Habit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('🌙');
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [reminderTime, setReminderTime] = useState('');
  const { settings } = useSettings();
  const weekStart = settings.datetime.weekStart;

  const weekDays = useMemo(() => {
    const off = (anchor.getDay() - weekStart + 7) % 7;
    const start = addDays(startOfDay(anchor), -off);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [anchor, weekStart]);

  const fromStr = ymd(weekDays[0]);
  const toStr = ymd(weekDays[6]);
  const todayStr = ymd(new Date());

  const reload = useCallback(async () => {
    try {
      setHabits(await api.listHabits(fromStr, toStr));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [fromStr, toStr]);

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

  function toggleDay(habit: Habit, day: Date) {
    const dateStr = ymd(day);
    if (dateStr > todayStr) return;
    if (!habit.daysOfWeek.includes(day.getDay())) return;
    void mutate(() => api.toggleHabit(habit.id, dateStr));
  }

  function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    const v = name.trim();
    if (!v) return;
    const picked = days.length ? days : [0, 1, 2, 3, 4, 5, 6];
    const time = reminderTime || null;
    void mutate(async () => {
      if (time) await ensureNotificationPermission('habit_reminder');
      await api.createHabit({ name: v, icon, daysOfWeek: picked, reminderTime: time });
    });
    setName('');
    setIcon('🌙');
    setDays([0, 1, 2, 3, 4, 5, 6]);
    setReminderTime('');
    setShowAdd(false);
  }

  function toggleDayPick(d: number) {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));
  }

  return (
    <main className="habits-main">
      <div className="habits-toolbar">
        <h1 className="habits-title">习惯</h1>
        <div className="cal-nav">
          <button onClick={() => setAnchor(addDays(anchor, -7))} title="上一周">‹</button>
          <button onClick={() => setAnchor(new Date())}>今天</button>
          <button onClick={() => setAnchor(addDays(anchor, 7))} title="下一周">›</button>
        </div>
        <button className="habits-add-btn" onClick={() => setShowAdd((v) => !v)}>
          ＋ 新建习惯
        </button>
      </div>

      {error && <div className="banner banner-error">⚠ {error}</div>}

      {showAdd && (
        <form className="habit-add-form" onSubmit={submitAdd}>
          <input
            className="habit-name-input"
            autoFocus
            placeholder="习惯名称（如：早睡 12 点半睡觉）"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="habit-emoji-row">
            {EMOJIS.map((em) => (
              <button type="button" key={em} className={`habit-emoji${icon === em ? ' active' : ''}`} onClick={() => setIcon(em)}>
                {em}
              </button>
            ))}
          </div>
          <div className="habit-days-row">
            <span className="habit-days-label">频率</span>
            {WEEKDAYS.map((w, idx) => (
              <button
                type="button"
                key={idx}
                className={`habit-day-pick${days.includes(idx) ? ' active' : ''}`}
                onClick={() => toggleDayPick(idx)}
              >
                {w.replace('周', '')}
              </button>
            ))}
          </div>
          <label className="habit-reminder-row">
            <span>提醒</span>
            <input type="time" value={reminderTime} onChange={(e) => setReminderTime(e.target.value)} />
          </label>
          <div className="habit-add-actions">
            <button type="submit">创建</button>
            <button type="button" onClick={() => setShowAdd(false)}>
              取消
            </button>
          </div>
        </form>
      )}

      <div className="habit-week-head">
        <div className="habit-head-info" />
        {weekDays.map((d) => (
          <div key={ymd(d)} className={`habit-day-head${ymd(d) === todayStr ? ' today' : ''}`}>
            <span className="hd-dow">{WEEKDAYS[d.getDay()]}</span>
            <span className="hd-dom">{d.getDate()}</span>
          </div>
        ))}
      </div>

      <div className="habit-list">
        {habits.length === 0 && <div className="empty">还没有习惯，点「＋ 新建习惯」开始</div>}
        {habits.map((h) => (
          <div key={h.id} className={`habit-row${searchTarget?.type === 'habits' && searchTarget.id === h.id ? ' search-hit' : ''}`}>
            <div className="habit-info">
              <span className="habit-icon">{h.icon ?? '🔁'}</span>
              <div className="habit-meta">
                <div className="habit-name">{h.name}</div>
                <div className="habit-streaks">
                  <span title="当前连续">⚡{h.currentStreak}天</span>
                  <span title="最佳记录">🔥{h.bestStreak}天</span>
                </div>
              </div>
              <button className="habit-del" title="删除习惯" onClick={() => void mutate(() => api.deleteHabit(h.id))}>
                ✕
              </button>
            </div>
            <div className="habit-cells">
              {weekDays.map((d) => {
                const dateStr = ymd(d);
                const future = dateStr > todayStr;
                const scheduled = h.daysOfWeek.includes(d.getDay());
                const checked = h.checkins.includes(dateStr);
                let cls = 'habit-circle';
                if (!scheduled) cls += ' muted';
                else if (future) cls += ' future';
                else if (checked) cls += ' checked';
                return (
                  <div key={dateStr} className="habit-cell">
                    <button
                      className={cls}
                      style={checked ? { background: h.color ?? '#c96442', borderColor: h.color ?? '#c96442' } : undefined}
                      disabled={future || !scheduled}
                      onClick={() => toggleDay(h, d)}
                    >
                      {checked ? '✓' : ''}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
