import { useCallback, useEffect, useMemo, useState } from 'react';
import CalendarGrid from '../components/calendar/CalendarGrid';
import MonthGrid from '../components/calendar/MonthGrid';
import SchedulePanel from '../components/calendar/SchedulePanel';
import TaskDetailModal from '../components/TaskDetailModal';
import { api } from '../api/client';
import { ensureSystemCalendarPermission } from '../systemCalendarPermission';
import { useSettings } from '../settings';
import { rangeFor, addDays, dayAtMinutes, hm, type CalView } from '../calendarUtil';
import type { CalendarDayInfo, CalendarSubscription, ExternalCalendarEvent, List, SystemCalendarPermission, Tag, Task } from '../types';

const DEFAULT_DURATION_MS = 60 * 60000;

export default function CalendarModule() {
  const [view, setView] = useState<CalView>('3day');
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [undated, setUndated] = useState<Task[]>([]);
  const [dayInfos, setDayInfos] = useState<CalendarDayInfo[]>([]);
  const [externalEvents, setExternalEvents] = useState<ExternalCalendarEvent[]>([]);
  const [subscriptions, setSubscriptions] = useState<CalendarSubscription[]>([]);
  const [systemCalendarPermission, setSystemCalendarPermission] = useState<SystemCalendarPermission | null>(null);
  const [lists, setLists] = useState<List[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [subName, setSubName] = useState('');
  const [icsText, setIcsText] = useState('');
  const [systemCalendarMessage, setSystemCalendarMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [popover, setPopover] = useState<{ task: Task; x: number; y: number } | null>(null);
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const { settings, update } = useSettings();
  const weekStart = settings.datetime.weekStart;

  const { days, fromISO, toISO } = useMemo(() => rangeFor(view, anchor, weekStart), [view, anchor, weekStart]);

  const reload = useCallback(async () => {
    try {
      const [rng, und, info, ext, subs, systemPermission, listRows, tagRows] = await Promise.all([
        api.getTasksRange(fromISO, toISO),
        api.getUndated(),
        api.listCalendarDayInfo(fromISO, toISO),
        api.listCalendarEvents(fromISO, toISO),
        api.listCalendarSubscriptions(),
        api.getSystemCalendarPermission(),
        api.listLists(),
        api.listTags(),
      ]);
      setTasks(rng);
      setUndated(und);
      setDayInfos(info);
      setExternalEvents(ext);
      setSubscriptions(subs);
      setSystemCalendarPermission(systemPermission);
      setLists(listRows);
      setTags(tagRows);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [fromISO, toISO]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    setView(settings.calendar.view);
  }, [settings.calendar.view]);

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

  const onCreateAt = (day: Date, minutes: number, durationMinutes = 60) => {
    const start = dayAtMinutes(day, minutes);
    const due = new Date(start.getTime() + durationMinutes * 60000);
    void mutate(() =>
      api.createTask({ title: '新任务', startDate: start.toISOString(), dueDate: due.toISOString(), isAllDay: false }),
    );
  };

  const onDropSchedule = (taskId: string, day: Date, minutes: number) => {
    const start = dayAtMinutes(day, minutes);
    schedule(taskId, start, new Date(start.getTime() + DEFAULT_DURATION_MS));
  };

  const onCreateDay = (day: Date) => {
    const due = new Date(day);
    due.setHours(23, 59, 59, 999);
    void mutate(() => api.createTask({ title: '新任务', dueDate: due.toISOString(), isAllDay: true }));
  };

  const changeView = (next: CalView) => {
    setView(next);
    void update({ calendar: { view: next } });
  };

  const shiftAnchor = (direction: -1 | 1) => {
    if (view === 'month') {
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1));
    } else {
      const step = view === 'day' ? 1 : view === '3day' ? 3 : 7;
      setAnchor(addDays(anchor, direction * step));
    }
  };

  async function addSubscription(e: React.FormEvent) {
    e.preventDefault();
    const name = subName.trim();
    if (!name || !icsText.trim()) return;
    await mutate(async () => {
      const sub = await api.createCalendarSubscription({ name, type: 'ics' });
      await api.syncCalendarSubscription(sub.id, icsText);
      setSubName('');
      setIcsText('');
    });
  }

  async function enableSystemCalendar() {
    setSystemCalendarMessage(null);
    try {
      const permission = await ensureSystemCalendarPermission();
      setSystemCalendarPermission(permission);
      if (permission.status === 'unsupported') {
        setSystemCalendarMessage('当前运行环境没有系统日历读取桥接，请使用 ICS 只读订阅。');
        return;
      }
      if (permission.status !== 'granted') {
        setSystemCalendarMessage('系统日历权限未允许，暂不能开启系统日历订阅。');
        return;
      }
      await mutate(() => api.createSystemCalendarSubscription({ name: '系统日历' }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const title = `${anchor.getFullYear()}年${String(anchor.getMonth() + 1).padStart(2, '0')}月`;

  return (
    <>
      <main className="cal-main">
        <div className="cal-toolbar">
          <h1 className="cal-title">{title}</h1>
          <div className="cal-views">
            {(['day', '3day', 'week', 'month'] as CalView[]).map((v) => (
              <button key={v} className={`cal-view-btn${view === v ? ' active' : ''}`} onClick={() => changeView(v)}>
                {v === 'day' ? '日' : v === '3day' ? '3天' : v === 'week' ? '周' : '月'}
              </button>
            ))}
          </div>
          <div className="cal-nav">
            <button onClick={() => shiftAnchor(-1)} title="上一段">‹</button>
            <button onClick={() => setAnchor(new Date())}>今天</button>
            <button onClick={() => shiftAnchor(1)} title="下一段">›</button>
          </div>
        </div>

        {error && <div className="banner banner-error">⚠ {error}</div>}

        {view === 'month' ? (
          <MonthGrid
            anchor={anchor}
            days={days}
            tasks={tasks}
            externalEvents={externalEvents}
            dayInfos={dayInfos}
            showLunar={settings.datetime.showLunar}
            showHolidayAdjustments={settings.datetime.showHolidayAdjustments}
            onCreateDay={onCreateDay}
            onOpenTask={(task, x, y) => (task.parentId ? setDetailTask(task) : setPopover({ task, x, y }))}
          />
        ) : (
          <CalendarGrid
            days={days}
            tasks={tasks}
            dayInfos={dayInfos}
            showLunar={settings.datetime.showLunar}
            showHolidayAdjustments={settings.datetime.showHolidayAdjustments}
            onCreateAt={onCreateAt}
            onDropSchedule={onDropSchedule}
            onMove={(t, start, due) => schedule(t.id, start, due)}
            onResize={(t, due) => void mutate(() => api.updateTask(t.id, { dueDate: due.toISOString() }))}
            onOpenBlock={(task, x, y) => (task.parentId ? setDetailTask(task) : setPopover({ task, x, y }))}
          />
        )}

        <section className="external-calendar">
          <div className="external-calendar-head">
            <strong>外部日历</strong>
            <span>{externalEvents.length} 个事件</span>
          </div>
          <div className="external-calendar-system">
            <button type="button" onClick={() => void enableSystemCalendar()}>
              订阅系统日历
            </button>
            <span>{systemCalendarPermission ? `权限：${systemCalendarPermission.guidance}` : '权限：未同步'}</span>
          </div>
          {systemCalendarMessage && <div className="external-calendar-message">{systemCalendarMessage}</div>}
          <form className="external-calendar-form" onSubmit={(e) => void addSubscription(e)}>
            <input placeholder="订阅名称" value={subName} onChange={(e) => setSubName(e.target.value)} />
            <textarea placeholder="粘贴 ICS 内容后同步" value={icsText} onChange={(e) => setIcsText(e.target.value)} />
            <button type="submit" disabled={!subName.trim() || !icsText.trim()}>
              同步
            </button>
          </form>
          <div className="external-calendar-subscriptions">
            {subscriptions.map((sub) => (
              <span key={sub.id}>{sub.name}</span>
            ))}
          </div>
          <ul className="external-event-list">
            {externalEvents.map((event) => (
              <li key={event.id}>
                <span>{event.title}</span>
                <small>
                  {new Date(event.startsAt).toLocaleString()} - {new Date(event.endsAt).toLocaleTimeString()}
                </small>
              </li>
            ))}
            {externalEvents.length === 0 && <li className="external-empty">当前范围没有外部事件</li>}
          </ul>
        </section>
      </main>

      <SchedulePanel
        tasks={undated}
        lists={lists}
        tags={tags}
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
      {detailTask && <TaskDetailModal task={detailTask} onClose={() => setDetailTask(null)} onChanged={() => void reload()} />}
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
