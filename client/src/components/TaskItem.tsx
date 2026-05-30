import type { Task, Priority } from '../types';
import { PRIORITY_COLORS, PRIORITY_LABELS, formatDue, isoToDateInput, dateInputToISO } from '../util';

interface Props {
  task: Task;
  inTrash: boolean;
  onToggle: (t: Task) => void;
  onDelete: (t: Task) => void;
  onRestore: (t: Task) => void;
  onPurge: (t: Task) => void;
  onSetPriority: (t: Task, p: Priority) => void;
  onSetDue: (t: Task, iso: string | null) => void;
}

export default function TaskItem({
  task,
  inTrash,
  onToggle,
  onDelete,
  onRestore,
  onPurge,
  onSetPriority,
  onSetDue,
}: Props) {
  const due = formatDue(task.dueDate);
  const ringColor = PRIORITY_COLORS[task.priority];

  return (
    <li className={`task-item${task.completed ? ' is-completed' : ''}`} data-task-id={task.id}>
      <button
        className="task-check"
        style={{ borderColor: ringColor, color: ringColor }}
        aria-label={task.completed ? '标记为未完成' : '标记为完成'}
        disabled={inTrash}
        onClick={() => onToggle(task)}
      >
        {task.completed ? '✓' : ''}
      </button>

      <div className="task-main">
        <div className="task-title">{task.title}</div>
        {due && (
          <div className={`task-due${due.overdue ? ' overdue' : ''}`}>{due.text}</div>
        )}
      </div>

      <div className="task-actions">
        {!inTrash && (
          <>
            <input
              className="task-date"
              type="date"
              title="设置截止日期"
              value={isoToDateInput(task.dueDate)}
              onChange={(e) => onSetDue(task, dateInputToISO(e.target.value))}
            />
            <select
              className="task-priority"
              title="优先级"
              value={task.priority}
              style={{ color: ringColor }}
              onChange={(e) => onSetPriority(task, Number(e.target.value) as Priority)}
            >
              {([3, 2, 1, 0] as Priority[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
            <button className="task-del" title="删除" onClick={() => onDelete(task)}>
              ✕
            </button>
          </>
        )}
        {inTrash && (
          <>
            <button className="task-restore" title="恢复" onClick={() => onRestore(task)}>
              恢复
            </button>
            <button className="task-del" title="彻底删除" onClick={() => onPurge(task)}>
              彻底删除
            </button>
          </>
        )}
      </div>
    </li>
  );
}
