import { useState } from 'react';
import type { Task, Priority, Selection } from '../types';
import TaskItem from './TaskItem';

interface Props {
  selection: Selection;
  title: string;
  tasks: Task[];
  loading: boolean;
  error: string | null;
  canQuickAdd: boolean;
  onQuickAdd: (title: string) => void;
  onToggle: (t: Task) => void;
  onDelete: (t: Task) => void;
  onRestore: (t: Task) => void;
  onPurge: (t: Task) => void;
  onSetPriority: (t: Task, p: Priority) => void;
  onSetDue: (t: Task, iso: string | null) => void;
}

export default function TaskPanel(props: Props) {
  const { selection, title, tasks, loading, error, canQuickAdd } = props;
  const [draft, setDraft] = useState('');
  const inTrash = selection.kind === 'smart' && selection.key === 'trash';

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = draft.trim();
    if (!v) return;
    props.onQuickAdd(v);
    setDraft('');
  }

  return (
    <main className="panel">
      <header className="panel-header">
        <h1>{title}</h1>
        <span className="panel-count">{tasks.length}</span>
      </header>

      {canQuickAdd && (
        <form className="quick-add" onSubmit={submit}>
          <input
            className="quick-add-input"
            placeholder="+ 添加任务，回车即可创建"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </form>
      )}

      {error && <div className="banner banner-error">⚠ {error}</div>}
      {loading && <div className="banner">加载中…</div>}

      {!loading && !error && tasks.length === 0 && (
        <div className="empty">这里还没有任务</div>
      )}

      <ul className="task-list">
        {tasks.map((t) => (
          <TaskItem
            key={t.id}
            task={t}
            inTrash={inTrash}
            onToggle={props.onToggle}
            onDelete={props.onDelete}
            onRestore={props.onRestore}
            onPurge={props.onPurge}
            onSetPriority={props.onSetPriority}
            onSetDue={props.onSetDue}
          />
        ))}
      </ul>
    </main>
  );
}
