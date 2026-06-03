import { useRef, useState } from 'react';
import type { CalendarDayInfo, Task } from '../../types';
import { HOUR_PX, minutesOfDay, sameLocalDay, snap, dayAtMinutes, durationMin, WEEKDAYS, hm, ymd } from '../../calendarUtil';
import { PRIORITY_COLORS } from '../../util';
import { taskSegmentsForDay, type CalendarBlockSegment } from './eventLayout';
import { calendarTaskParentHint, calendarTaskPathLabel } from './taskHierarchy';
import { buildBlankTimeSelection, createDraftFromBlankSelection, minutesFromTimelineOffset } from './timeSelection';

interface Props {
  days: Date[];
  tasks: Task[];
  dayInfos: CalendarDayInfo[];
  showLunar: boolean;
  showHolidayAdjustments: boolean;
  onCreateAt: (day: Date, minutes: number, durationMinutes?: number) => void;
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

type BlankSelection = {
  dayKey: string;
  startMin: number;
  currentMin: number;
} | null;

const hours = Array.from({ length: 24 }, (_, h) => h);

export default function CalendarGrid({
  days,
  tasks,
  dayInfos,
  showLunar,
  showHolidayAdjustments,
  onCreateAt,
  onDropSchedule,
  onMove,
  onResize,
  onOpenBlock,
}: Props) {
  const [drag, setDrag] = useState<Drag>(null);
  const [blankSelection, setBlankSelection] = useState<BlankSelection>(null);

  const timed = tasks.filter((t) => !t.isAllDay && t.startDate && t.dueDate);
  const allday = tasks.filter((t) => t.isAllDay && t.dueDate);
  const infoByDate = new Map(dayInfos.map((info) => [info.date, info]));

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

  function onBlankPointerDown(day: Date, minutes: number) {
    setBlankSelection({ dayKey: ymd(day), startMin: minutes, currentMin: minutes });
  }

  function onBlankPointerMove(day: Date, minutes: number) {
    setBlankSelection((selection) => {
      if (!selection || selection.dayKey !== ymd(day)) return selection;
      return { ...selection, currentMin: minutes };
    });
  }

  function onBlankPointerUp(day: Date, minutes: number) {
    setBlankSelection((selection) => {
      if (!selection || selection.dayKey !== ymd(day)) return null;
      const draft = createDraftFromBlankSelection(selection.startMin, minutes);
      onCreateAt(day, draft.startMinutes, draft.durationMinutes);
      return null;
    });
  }

  return (
    <div className="cal-grid">
      <div className="cal-head">
        <div className="cal-gutter-head" />
        {days.map((d) => {
          const isToday = sameLocalDay(new Date().toISOString(), d);
          const info = infoByDate.get(ymd(d));
          return (
            <div
              key={d.toISOString()}
              className={`cal-day-head${isToday ? ' today' : ''}${showHolidayAdjustments && info?.isOffDay ? ' offday' : ''}${showHolidayAdjustments && info?.isAdjustedWorkday ? ' adjusted-workday' : ''}`}
            >
              <span className="cal-dow">{WEEKDAYS[d.getDay()]}</span>
              <span className="cal-dom">{d.getDate()}</span>
              {showLunar && info?.lunarLabel && <span className="cal-lunar">{info.lunarLabel}</span>}
              {showHolidayAdjustments && info?.holidayName && <span className="cal-holiday">{info.holidayName}</span>}
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
            segments={taskSegmentsForDay(timed, d)}
            drag={drag}
            blankSelection={blankSelection?.dayKey === ymd(d) ? blankSelection : null}
            onBlankPointerDown={onBlankPointerDown}
            onBlankPointerMove={onBlankPointerMove}
            onBlankPointerUp={onBlankPointerUp}
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
  segments,
  drag,
  blankSelection,
  onBlankPointerDown,
  onBlankPointerMove,
  onBlankPointerUp,
  onDropSchedule,
  onOpenBlock,
  onBlockPointerDown,
  onBlockPointerMove,
  onBlockPointerUp,
}: {
  day: Date;
  segments: CalendarBlockSegment[];
  drag: Drag;
  blankSelection: Exclude<BlankSelection, null> | null;
  onBlankPointerDown: (day: Date, minutes: number) => void;
  onBlankPointerMove: (day: Date, minutes: number) => void;
  onBlankPointerUp: (day: Date, minutes: number) => void;
  onDropSchedule: (taskId: string, day: Date, minutes: number) => void;
  onOpenBlock: (task: Task, x: number, y: number) => void;
  onBlockPointerDown: (e: React.PointerEvent, task: Task, day: Date, mode: 'move' | 'resize') => void;
  onBlockPointerMove: (e: React.PointerEvent) => void;
  onBlockPointerUp: (e: React.PointerEvent, task: Task) => void;
}) {
  const colRef = useRef<HTMLDivElement>(null);

  function minutesAt(clientY: number): number {
    const rect = colRef.current!.getBoundingClientRect();
    return minutesFromTimelineOffset(clientY - rect.top, HOUR_PX);
  }

  const selectionRange = blankSelection ? buildBlankTimeSelection(blankSelection.startMin, blankSelection.currentMin) : null;

  return (
    <div
      className="cal-col"
      ref={colRef}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        onBlankPointerDown(day, minutesAt(e.clientY));
      }}
      onPointerMove={(e) => onBlankPointerMove(day, minutesAt(e.clientY))}
      onPointerUp={(e) => onBlankPointerUp(day, minutesAt(e.clientY))}
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

      {selectionRange && (
        <div
          className="cal-selection"
          style={{
            top: (selectionRange.startMinutes / 60) * HOUR_PX,
            height: (selectionRange.durationMinutes / 60) * HOUR_PX,
          }}
        >
          {hm(dayAtMinutes(day, selectionRange.startMinutes).toISOString())} - {hm(dayAtMinutes(day, selectionRange.endMinutes).toISOString())}
        </div>
      )}

      {segments.map((segment) => {
        const t = segment.task;
        let topMin = segment.startMinutes;
        let durMin = segment.durationMinutes;
        if (drag && drag.id === t.id && sameLocalDay(t.startDate!, day)) {
          if (drag.mode === 'move') topMin = Math.max(0, Math.min(24 * 60 - durMin, drag.origStartMin + drag.deltaMin));
          else durMin = Math.max(15, drag.origDurMin + drag.deltaMin);
        }
        const color = PRIORITY_COLORS[t.priority];
        const parentHint = calendarTaskParentHint(t);
        const pathLabel = calendarTaskPathLabel(t);
        const laneGap = 4;
        const laneWidth = `calc(${100 / segment.laneCount}% - ${((segment.laneCount - 1) * laneGap) / segment.laneCount}px)`;
        const laneLeft = `calc(3px + ${(segment.lane * 100) / segment.laneCount}% + ${(segment.lane * laneGap) / segment.laneCount}px)`;
        return (
          <div
            key={segment.key}
            className={`cal-block${segment.startsBeforeDay ? ' continues-before' : ''}${segment.endsAfterDay ? ' continues-after' : ''}`}
            style={{
              top: (topMin / 60) * HOUR_PX,
              height: (durMin / 60) * HOUR_PX,
              left: laneLeft,
              right: 'auto',
              width: laneWidth,
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
            title={segment.startsBeforeDay || segment.endsAfterDay ? `${pathLabel} · 跨天任务` : pathLabel}
          >
            {parentHint && <div className="cal-block-parent">{parentHint}</div>}
            <div className="cal-block-title">{t.title}</div>
            <div className="cal-block-time">{segment.startsBeforeDay ? '前日 ' : ''}{hm(t.startDate!)}-{hm(t.dueDate!)}{segment.endsAfterDay ? ' 次日' : ''}</div>
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
