import { useRef, useState } from 'react';
import type { Task } from '../../types';
import { HOUR_PX, minutesOfDay, sameLocalDay, snap, dayAtMinutes, durationMin, WEEKDAYS, hm } from '../../calendarUtil';
import { PRIORITY_COLORS } from '../../util';

interface Props {
  days: Date[];
  tasks: Task[];
  onCreateAt: (day: Date, minutes: number) => void;
  onDropSchedule: (taskId: string, day: Date, minutes: number) => void;
  onMove: (task: Task, start: Date, due: Date) => void;
  onResize: (task: Task, due: Date) => void;
  onOpenBlock: (task: Task, x: number, y: number) => void;
}

type Drag = {
  id: string;
  mode: 'move' | 'resize';
  startClientY: number;
  origStartMin: number;
  origDurMin: number;
  deltaMin: number;
  day: Date;
} | null;

const hours = Array.from({ length: 24 }, (_, h) => h);

export default function CalendarGrid({ days, tasks, onCreateAt, onDropSchedule, onMove, onResize, onOpenBlock }: Props) {
  const [drag, setDrag] = useState<Drag>(null);

  const timed = tasks.filter((t) => !t.isAllDay && t.startDate && t.dueDate);
  const allday = tasks.filter((t) => t.isAllDay && t.dueDate);

  function onBlockPointerDown(e: React.PointerEvent, task: Task, day: Date, mode: 'move' | 'resize') {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({
      id: task.id,
      mode,
      startClientY: e.clientY,
      origStartMin: minutesOfDay(task.startDate!),
      origDurMin: durationMin(task.startDate!, task.dueDate!),
      deltaMin: 0,
      day,
    });
  }
  function onBlockPointerMove(e: React.PointerEvent) {
    setDrag((d) => {
      if (!d) return d;
      const raw = e.clientY - d.startClientY;
      return { ...d, deltaMin: snap((raw / HOUR_PX) * 60) };
    });
  }
  function onBlockPointerUp(_e: React.PointerEvent, task: Task) {
    setDrag((d) => {
      if (!d || d.id !== task.id) return null;
      if (d.deltaMin !== 0) {
        if (d.mode === 'move') {
          const newStartMin = Math.max(0, Math.min(24 * 60 - d.origDurMin, d.origStartMin + d.deltaMin));
          const start = dayAtMinutes(d.day, newStartMin);
          onMove(task, start, new Date(start.getTime() + d.origDurMin * 60000));
        } else {
          const newDur = Math.max(15, d.origDurMin + d.deltaMin);
          const start = dayAtMinutes(d.day, d.origStartMin);
          onResize(task, new Date(start.getTime() + newDur * 60000));
        }
      }
      return null;
    });
  }

  return (
    <div className="cal-grid">
      <div className="cal-head">
        <div className="cal-gutter-head" />
        {days.map((d) => {
          const isToday = sameLocalDay(new Date().toISOString(), d);
          return (
            <div key={d.toISOString()} className={`cal-day-head${isToday ? ' today' : ''}`}>
              <span className="cal-dow">{WEEKDAYS[d.getDay()]}</span>
              <span className="cal-dom">{d.getDate()}</span>
            </div>
          );
        })}
      </div>

      <div className="cal-allday">
        <div className="cal-gutter-allday">全天</div>
        {days.map((d) => (
          <div key={d.toISOString()} className="cal-allday-col">
            {allday
              .filter((t) => sameLocalDay(t.dueDate!, d))
              .map((t) => (
                <div
                  key={t.id}
                  className="allday-chip"
                  style={{ background: PRIORITY_COLORS[t.priority] }}
                  onClick={(e) => onOpenBlock(t, e.clientX, e.clientY)}
                >
                  {t.title}
                </div>
              ))}
          </div>
        ))}
      </div>

      <div className="cal-body">
        <div className="cal-gutter">
          {hours.map((h) => (
            <div key={h} className="cal-hour-label" style={{ height: HOUR_PX }}>
              {String(h).padStart(2, '0')}:00
            </div>
          ))}
        </div>
        {days.map((d) => (
          <DayColumn
            key={d.toISOString()}
            day={d}
            blocks={timed.filter((t) => sameLocalDay(t.startDate!, d))}
            drag={drag}
            onCreateAt={onCreateAt}
            onDropSchedule={onDropSchedule}
            onOpenBlock={onOpenBlock}
            onBlockPointerDown={onBlockPointerDown}
            onBlockPointerMove={onBlockPointerMove}
            onBlockPointerUp={onBlockPointerUp}
          />
        ))}
      </div>
    </div>
  );
}

function DayColumn({
  day,
  blocks,
  drag,
  onCreateAt,
  onDropSchedule,
  onOpenBlock,
  onBlockPointerDown,
  onBlockPointerMove,
  onBlockPointerUp,
}: {
  day: Date;
  blocks: Task[];
  drag: Drag;
  onCreateAt: (day: Date, minutes: number) => void;
  onDropSchedule: (taskId: string, day: Date, minutes: number) => void;
  onOpenBlock: (task: Task, x: number, y: number) => void;
  onBlockPointerDown: (e: React.PointerEvent, task: Task, day: Date, mode: 'move' | 'resize') => void;
  onBlockPointerMove: (e: React.PointerEvent) => void;
  onBlockPointerUp: (e: React.PointerEvent, task: Task) => void;
}) {
  const colRef = useRef<HTMLDivElement>(null);

  function minutesAt(clientY: number): number {
    const rect = colRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(24 * 60 - 15, snap(((clientY - rect.top) / HOUR_PX) * 60)));
  }

  return (
    <div
      className="cal-col"
      ref={colRef}
      onClick={(e) => onCreateAt(day, minutesAt(e.clientY))}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData('text/plain');
        if (id) onDropSchedule(id, day, minutesAt(e.clientY));
      }}
    >
      {hours.map((h) => (
        <div key={h} className="cal-cell" style={{ height: HOUR_PX }} />
      ))}

      {blocks.map((t) => {
        let topMin = minutesOfDay(t.startDate!);
        let durMin = durationMin(t.startDate!, t.dueDate!);
        if (drag && drag.id === t.id) {
          if (drag.mode === 'move') topMin = Math.max(0, Math.min(24 * 60 - durMin, drag.origStartMin + drag.deltaMin));
          else durMin = Math.max(15, drag.origDurMin + drag.deltaMin);
        }
        const color = PRIORITY_COLORS[t.priority];
        return (
          <div
            key={t.id}
            className="cal-block"
            style={{
              top: (topMin / 60) * HOUR_PX,
              height: (durMin / 60) * HOUR_PX,
              borderLeftColor: color,
              background: color + '22',
            }}
            onClick={(e) => {
              e.stopPropagation();
              onOpenBlock(t, e.clientX, e.clientY);
            }}
            onPointerDown={(e) => onBlockPointerDown(e, t, day, 'move')}
            onPointerMove={onBlockPointerMove}
            onPointerUp={(e) => onBlockPointerUp(e, t)}
          >
            <div className="cal-block-title">{t.title}</div>
            <div className="cal-block-time">
              {hm(t.startDate!)}–{hm(t.dueDate!)}
            </div>
            <div
              className="cal-block-resize"
              onPointerDown={(e) => onBlockPointerDown(e, t, day, 'resize')}
              onPointerMove={onBlockPointerMove}
              onPointerUp={(e) => onBlockPointerUp(e, t)}
            />
          </div>
        );
      })}
    </div>
  );
}
