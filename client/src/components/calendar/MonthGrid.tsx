import type { CalendarDayInfo, ExternalCalendarEvent, Task } from '../../types';
import { sameLocalDay, startOfDay, ymd } from '../../calendarUtil';
import { PRIORITY_COLORS } from '../../util';
import { calendarTaskPathLabel } from './taskHierarchy';

interface Props {
  anchor: Date;
  days: Date[];
  tasks: Task[];
  externalEvents: ExternalCalendarEvent[];
  dayInfos: CalendarDayInfo[];
  showLunar: boolean;
  showHolidayAdjustments: boolean;
  onCreateDay: (day: Date) => void;
  onOpenTask: (task: Task, x: number, y: number) => void;
}

const MAX_TASKS = 3;

function eventOverlapsDay(event: ExternalCalendarEvent, day: Date): boolean {
  const start = startOfDay(day).getTime();
  const end = start + 24 * 60 * 60 * 1000 - 1;
  return Date.parse(event.startsAt) <= end && Date.parse(event.endsAt) >= start;
}

export default function MonthGrid({
  anchor,
  days,
  tasks,
  externalEvents,
  dayInfos,
  showLunar,
  showHolidayAdjustments,
  onCreateDay,
  onOpenTask,
}: Props) {
  const infoByDate = new Map(dayInfos.map((info) => [info.date, info]));
  return (
    <div className="month-grid">
      {days.map((day) => {
        const date = ymd(day);
        const info = infoByDate.get(date);
        const inMonth = day.getMonth() === anchor.getMonth();
        const dayTasks = tasks.filter((task) => {
          const iso = task.startDate ?? task.dueDate;
          return iso ? sameLocalDay(iso, day) : false;
        });
        const dayEvents = externalEvents.filter((event) => eventOverlapsDay(event, day));
        return (
          <section
            key={date}
            className={`month-cell${inMonth ? '' : ' muted'}${showHolidayAdjustments && info?.isOffDay ? ' offday' : ''}${showHolidayAdjustments && info?.isAdjustedWorkday ? ' adjusted-workday' : ''}`}
          >
            <header className="month-cell-head">
              <div>
                <span className="month-dom">{day.getDate()}</span>
                {showLunar && info?.lunarLabel && <span className="month-lunar">{info.lunarLabel}</span>}
              </div>
              <button className="month-add" onClick={() => onCreateDay(day)} title="新建全天任务">
                +
              </button>
            </header>
            {showHolidayAdjustments && info?.holidayName && <div className="month-holiday">{info.holidayName}</div>}
            <div className="month-items">
              {dayEvents.map((event) => (
                <div key={event.id} className="month-event">
                  {event.title}
                </div>
              ))}
              {dayTasks.slice(0, MAX_TASKS).map((task) => (
                <button
                  key={task.id}
                  className="month-task"
                  style={{ borderLeftColor: PRIORITY_COLORS[task.priority] }}
                  onClick={(e) => onOpenTask(task, e.clientX, e.clientY)}
                  title={calendarTaskPathLabel(task)}
                >
                  {task.title}
                </button>
              ))}
              {dayTasks.length > MAX_TASKS && <span className="month-more">+{dayTasks.length - MAX_TASKS}</span>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
