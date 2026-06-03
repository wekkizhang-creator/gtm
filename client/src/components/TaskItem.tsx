import { useState } from 'react';
import { api } from '../api/client';
import { useSettings } from '../settings';
import { playTaskCompletionSound } from '../taskCompletionSound';
import type { TaskManualOrderAction } from '../taskManualOrder';
import type { Task, Priority } from '../types';
import { PRIORITY_COLORS, PRIORITY_LABELS, formatDue, isoToDateInput, dateInputToISO } from '../util';

interface Props {
  task: Task;
  inTrash: boolean;
  batchSelected: boolean;
  onBatchSelect: (checked: boolean) => void;
  orderControls?: { canMoveUp: boolean; canMoveDown: boolean; canPinTop: boolean };
  onMoveTask?: (action: TaskManualOrderAction) => void;
  onToggle: (t: Task) => void;
  onDelete: (t: Task) => void;
  onRestore: (t: Task) => void;
  onPurge: (t: Task) => void;
  onSetPriority: (t: Task, p: Priority) => void;
  onSetDue: (t: Task, iso: string | null) => void;
  onOpenDetail: (t: Task) => void;
  onChanged: () => void;
}

export default function TaskItem({
  task,
  inTrash,
  batchSelected,
  onBatchSelect,
  orderControls,
  onMoveTask,
  onToggle,
  onDelete,
  onRestore,
  onPurge,
  onSetPriority,
  onSetDue,
  onOpenDetail,
  onChanged,
}: Props) {
  const { settings } = useSettings();
  const due = formatDue(task.dueDate);
  const ringColor = PRIORITY_COLORS[task.priority];
  const hasSub = task.subtaskTotal > 0;
  const [expanded, setExpanded] = useState(false);
  const [subs, setSubs] = useState<Task[]>([]);

  async function toggleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next) {
      try {
        setSubs(await api.getSubtasks(task.id));
      } catch {
        /* ignore */
      }
    }
  }
  async function toggleSub(s: Task) {
    try {
      const updated = await api.updateTask(s.id, { completed: !s.completed });
      await playTaskCompletionSound(settings, s.completed, updated.completed);
      setSubs(await api.getSubtasks(task.id));
      onChanged();
    } catch {
      /* ignore */
    }
  }

  return (
    <li className={`task-item${task.completed ? ' is-completed' : ''}`} data-task-id={task.id}>
      <div className="task-row">
        <input
          className="task-batch-check"
          type="checkbox"
          checked={batchSelected}
          aria-label={`选择 ${task.title}`}
          onChange={(e) => onBatchSelect(e.target.checked)}
          onClick={(e) => e.stopPropagation()}
        />
        <button
          className="task-check"
          style={{ borderColor: ringColor, color: ringColor }}
          aria-label={task.completed ? '标记为未完成' : '标记为完成'}
          disabled={inTrash}
          onClick={() => onToggle(task)}
        >
          {task.completed ? '✓' : ''}
        </button>

        <div className="task-main" onClick={() => !inTrash && onOpenDetail(task)}>
          <div className="task-title">{task.title}</div>
          <div className="task-sub-meta">
            {due && <span className={`task-due${due.overdue ? ' overdue' : ''}`}>{due.text}</span>}
            {hasSub && (
              <span
                className="task-progress"
                title="展开子任务"
                onClick={(e) => {
                  e.stopPropagation();
                  void toggleExpand();
                }}
              >
                {expanded ? '▾' : '▸'} {task.subtaskDone}/{task.subtaskTotal}
              </span>
            )}
          </div>
        </div>

        <div className="task-actions">
          {!inTrash && (
            <>
              {orderControls && (
                <div className="task-order-controls" aria-label="任务排序">
                  <button type="button" title="上移" disabled={!orderControls.canMoveUp} onClick={() => onMoveTask?.('up')}>
                    ↑
                  </button>
                  <button type="button" title="下移" disabled={!orderControls.canMoveDown} onClick={() => onMoveTask?.('down')}>
                    ↓
                  </button>
                  <button type="button" title="置顶" disabled={!orderControls.canPinTop} onClick={() => onMoveTask?.('top')}>
                    ⇧
                  </button>
                </div>
              )}
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
      </div>

      {hasSub && expanded && (
        <ul className="subtask-inline">
          {subs.map((s) => (
            <li key={s.id} className={`subtask-inline-item${s.completed ? ' is-completed' : ''}`}>
              <button
                className="subtask-check"
                style={{ borderColor: PRIORITY_COLORS[s.priority], color: PRIORITY_COLORS[s.priority] }}
                onClick={() => void toggleSub(s)}
              >
                {s.completed ? '✓' : ''}
              </button>
              <span className="subtask-title" onClick={() => onOpenDetail(s)}>
                {s.title}
              </span>
            </li>
          ))}
          {subs.length === 0 && <li className="subtask-loading">加载中…</li>}
        </ul>
      )}
    </li>
  );
}
