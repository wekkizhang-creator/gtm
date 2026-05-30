import { useCallback, useEffect, useMemo, useState } from 'react';
import CalendarGrid from '../components/calendar/CalendarGrid';
import SchedulePanel from '../components/calendar/SchedulePanel';
import { api } from '../api/client';
import { useSettings } from '../settings';
import { rangeFor, addDays, dayAtMinutes, hm, type CalView } from '../calendarUtil';
import type { Task } from '../types';

const DEFAULT_DURATION_MS = 60 * 60000;

export default function CalendarModule() {
  const [view, setView] = useState<CalView>('3day');
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [undated, setUndated] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [popover, setPopover] = useState<{ task: Task; x: number; y: number } | null>(null);
  const { settings } = useSettings();
  const weekStart = settings.datetime.weekStart;

  const { days, fromISO, toISO } = useMemo(() => rangeFor(view, anchor, weekStart), [view, anchor, weekStart]);

  const reload = useCallback(async () => {
    try {
      const [rng, und] = await Promise.all([api.getTasksRange(fromISO, toISO), api.getUndated()]);
      setTasks(rng);
      setUndated(und);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [fromISO, toISO]);

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

  const schedule = (taskId: string, start: Date, due: Date) =>
    void mutate(() => api.updateTask(taskId, { startDate: start.toISOString(), dueDate: due.toISOString(), isAllDay: false }));

  const onCreateAt = (day: Date, minutes: number) => {
    const start = dayAtMinutes(day, minutes);
    const due = new Date(start.getTime() + DEFAULT_DURATION_MS);
    void mutate(() =>
      api.createTask({ title: '新任务', startDate: start.toISOString(), dueDate: due.toISOString(), isAllDay: false }),
    );
  };

  const onDropSchedule = (taskId: string, day: Date, minutes: number) => {
    const start = dayAtMinutes(day, minutes);
    schedule(taskId, start, new Date(start.getTime() + DEFAULT_DURATION_MS));
  };

  const title = `${anchor.getFullYear()}年${String(anchor.getMonth() + 1).padStart(2, '0')}月`;
  const step = view === 'day' ? 1 : view === '3day' ? 3 : 7;

  return (
    <>
      <main className="cal-main">
        <div className="cal-toolbar">
          <h1 className="cal-title">{title}</h1>
          <div className="cal-views">
            {(['day', '3day', 'week'] as CalView[]).map((v) => (
              <button key={v} className={`cal-view-btn${view === v ? ' active' : ''}`} onClick={() => setView(v)}>
                {v === 'day' ? '日' : v === '3day' ? '3天' : '周'}
              </button>
            ))}
          </div>
          <div className="cal-nav">
            <button onClick={() => setAnchor(addDays(anchor, -step))} title="上一段">‹</button>
            <button onClick={() => setAnchor(new Date())}>今天</button>
            <button onClick={() => setAnchor(addDays(anchor, step))} title="下一段">›</button>
          </div>
        </div>

        {error && <div className="banner banner-error">⚠ {error}</div>}

        <CalendarGrid
          days={days}
          tasks={tasks}
          onCreateAt={onCreateAt}
          onDropSchedule={onDropSchedule}
          onMove={(t, start, due) => schedule(t.id, start, due)}
          onResize={(t, due) => void mutate(() => api.updateTask(t.id, { dueDate: due.toISOString() }))}
          onOpenBlock={(task, x, y) => setPopover({ task, x, y })}
        />
      </main>

      <SchedulePanel
        tasks={undated}
        onScheduleFirstDay={(t) => {
          const start = dayAtMinutes(days[0], 9 * 60);
          schedule(t.id, start, new Date(start.getTime() + DEFAULT_DURATION_MS));
        }}
      />

      {popover && (
        <BlockPopover
          key={popover.task.id}
          popover={popover}
          onClose={() => setPopover(null)}
          onRename={(t) => void mutate(() => api.updateTask(popover.task.id, { title: t }))}
          onUnschedule={() => {
            void mutate(() => api.updateTask(popover.task.id, { startDate: null, dueDate: null, isAllDay: true }));
            setPopover(null);
          }}
          onDelete={() => {
            void mutate(() => api.deleteTask(popover.task.id));
            setPopover(null);
          }}
        />
      )}
    </>
  );
}

function BlockPopover({
  popover,
  onClose,
  onRename,
  onUnschedule,
  onDelete,
}: {
  popover: { task: Task; x: number; y: number };
  onClose: () => void;
  onRename: (title: string) => void;
  onUnschedule: () => void;
  onDelete: () => void;
}) {
  const t = popover.task;
  const [title, setTitle] = useState(t.title);
  const time = t.startDate && t.dueDate ? `${hm(t.startDate)} – ${hm(t.dueDate)}` : t.dueDate ? '全天' : '';
  const left = Math.min(popover.x, window.innerWidth - 260);
  const top = Math.min(popover.y, window.innerHeight - 160);

  return (
    <>
      <div className="popover-backdrop" onClick={onClose} />
      <div className="block-popover" style={{ left, top }}>
        <input
          className="popover-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title.trim() !== t.title && onRename(title.trim())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        <div className="popover-time">{time}</div>
        <div className="popover-actions">
          <button onClick={onUnschedule}>取消排期</button>
          <button className="danger" onClick={onDelete}>删除</button>
        </div>
      </div>
    </>
  );
}
