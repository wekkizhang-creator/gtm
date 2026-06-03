import { useMemo, useState } from 'react';
import type { List, Tag, Task } from '../../types';
import { PRIORITY_COLORS } from '../../util';
import { groupScheduleTasks, type ScheduleGroupMode } from './scheduleGrouping';

interface Props {
  tasks: Task[];
  lists: List[];
  tags: Tag[];
  onScheduleFirstDay: (t: Task) => void;
}

const MODES: Array<{ value: ScheduleGroupMode; label: string }> = [
  { value: 'list', label: '清单' },
  { value: 'tag', label: '标签' },
  { value: 'priority', label: '优先级' },
];

export default function SchedulePanel({ tasks, lists, tags, onScheduleFirstDay }: Props) {
  const [mode, setMode] = useState<ScheduleGroupMode>('list');
  const [query, setQuery] = useState('');
  const groups = useMemo(() => groupScheduleTasks(tasks, lists, tags, mode, query), [tasks, lists, tags, mode, query]);

  return (
    <aside className="schedule-panel">
      <div className="schedule-head">安排任务</div>
      <div className="schedule-tabs">
        {MODES.map((item) => (
          <button key={item.value} className={mode === item.value ? 'active' : ''} onClick={() => setMode(item.value)}>
            {item.label}
          </button>
        ))}
      </div>
      <input className="schedule-filter" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="筛选任务" />
      <div className="schedule-hint">拖到日历排期，或点「排期」放到首日 9:00</div>
      <div className="schedule-groups">
        {groups.map((group) => (
          <section className="schedule-group" key={group.id}>
            <div className="schedule-group-head">
              <span>{group.label}</span>
              <small>{group.tasks.length}</small>
            </div>
            <ul className="schedule-list">
              {group.tasks.map((t) => (
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
            </ul>
          </section>
        ))}
        {groups.length === 0 && <div className="schedule-empty">当前没有无日期任务需要安排</div>}
      </div>
    </aside>
  );
}
