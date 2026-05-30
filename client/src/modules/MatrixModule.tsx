import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { PRIORITY_COLORS } from '../util';
import type { Task } from '../types';

interface QuadDef {
  important: boolean;
  urgent: boolean;
  label: string;
  roman: string;
  color: string;
}

const QUADRANTS: QuadDef[] = [
  { important: true, urgent: true, label: '重要且紧急', roman: 'I', color: '#e5533c' },
  { important: true, urgent: false, label: '重要不紧急', roman: 'II', color: '#f0a020' },
  { important: false, urgent: true, label: '不重要但紧急', roman: 'III', color: '#4a8cf0' },
  { important: false, urgent: false, label: '不重要不紧急', roman: 'IV', color: '#34b37a' },
];

export default function MatrixModule() {
  const [matrix, setMatrix] = useState<Task[]>([]);
  const [unclassified, setUnclassified] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [m, u] = await Promise.all([api.getMatrixTasks(), api.getUnclassifiedTasks()]);
      setMatrix(m);
      setUnclassified(u);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

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

  const classify = (id: string, important: boolean, urgent: boolean) =>
    void mutate(() => api.updateTask(id, { isImportant: important, isUrgent: urgent }));
  const unclassify = (id: string) =>
    void mutate(() => api.updateTask(id, { isImportant: null, isUrgent: null }));
  const toggle = (t: Task) => void mutate(() => api.updateTask(t.id, { completed: !t.completed }));
  const quickAdd = (q: QuadDef, title: string) =>
    void mutate(() => api.createTask({ title, isImportant: q.important, isUrgent: q.urgent }));

  return (
    <>
      <main className="matrix-main">
        {error && <div className="banner banner-error">⚠ {error}</div>}
        <div className="matrix-grid">
          {QUADRANTS.map((q) => (
            <Quadrant
              key={q.roman}
              q={q}
              tasks={matrix.filter((t) => t.isImportant === q.important && t.isUrgent === q.urgent)}
              onDropTask={(id) => classify(id, q.important, q.urgent)}
              onQuickAdd={(title) => quickAdd(q, title)}
              onToggle={toggle}
              onMoveOut={unclassify}
            />
          ))}
        </div>
      </main>

      <aside
        className="schedule-panel"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const id = e.dataTransfer.getData('text/plain');
          if (id) unclassify(id);
        }}
      >
        <div className="schedule-head">未归类</div>
        <div className="schedule-hint">拖到象限完成归类；从象限拖回此处可移出</div>
        <ul className="schedule-list">
          {unclassified.map((t) => (
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
            </li>
          ))}
          {unclassified.length === 0 && <li className="schedule-empty">没有未归类的任务</li>}
        </ul>
      </aside>
    </>
  );
}

function Quadrant({
  q,
  tasks,
  onDropTask,
  onQuickAdd,
  onToggle,
  onMoveOut,
}: {
  q: QuadDef;
  tasks: Task[];
  onDropTask: (id: string) => void;
  onQuickAdd: (title: string) => void;
  onToggle: (t: Task) => void;
  onMoveOut: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = draft.trim();
    if (!v) return;
    onQuickAdd(v);
    setDraft('');
  }

  return (
    <div
      className="quadrant"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData('text/plain');
        if (id) onDropTask(id);
      }}
    >
      <div className="quad-header">
        <span className="quad-badge" style={{ background: q.color }}>
          {q.roman}
        </span>
        <span className="quad-title" style={{ color: q.color }}>
          {q.label}
        </span>
        <span className="quad-count">{tasks.length}</span>
        <button className="quad-add" title="在此象限新建" onClick={() => setAdding((v) => !v)}>
          ＋
        </button>
      </div>

      {adding && (
        <form className="quad-add-form" onSubmit={submit}>
          <input
            autoFocus
            placeholder="输入任务，回车创建"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => !draft.trim() && setAdding(false)}
          />
        </form>
      )}

      <div className="quad-list">
        {tasks.map((t) => (
          <div
            key={t.id}
            className={`quad-task${t.completed ? ' done' : ''}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', t.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
          >
            <button
              className="quad-check"
              style={{ borderColor: PRIORITY_COLORS[t.priority], color: PRIORITY_COLORS[t.priority] }}
              onClick={() => onToggle(t)}
            >
              {t.completed ? '✓' : ''}
            </button>
            <span className="quad-task-title">{t.title}</span>
            <button className="quad-move-out" title="移出（取消归类）" onClick={() => onMoveOut(t.id)}>
              ✕
            </button>
          </div>
        ))}
        {tasks.length === 0 && !adding && <div className="quad-empty">拖任务到这里</div>}
      </div>
    </div>
  );
}
