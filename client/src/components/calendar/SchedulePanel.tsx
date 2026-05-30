import type { Task } from '../../types';
import { PRIORITY_COLORS } from '../../util';

interface Props {
  tasks: Task[];
  onScheduleFirstDay: (t: Task) => void;
}

export default function SchedulePanel({ tasks, onScheduleFirstDay }: Props) {
  return (
    <aside className="schedule-panel">
      <div className="schedule-head">安排任务</div>
      <div className="schedule-hint">拖到日历排期，或点「排期」放到首日 9:00</div>
      <ul className="schedule-list">
        {tasks.map((t) => (
          <li
            key={t.id}
            className="schedule-item"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', t.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
          >
            <span className="schedule-dot" style={{ background: PRIORITY_COLORS[t.priority] }} />
            <span className="schedule-title">{t.title}</span>
            <button className="schedule-add" title="排到首日 9:00" onClick={() => onScheduleFirstDay(t)}>
              排期
            </button>
          </li>
        ))}
        {tasks.length === 0 && <li className="schedule-empty">当前没有无日期任务需要安排</li>}
      </ul>
    </aside>
  );
}
