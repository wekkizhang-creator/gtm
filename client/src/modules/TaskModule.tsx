import { useCallback, useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import TaskPanel from '../components/TaskPanel';
import { api, type CreateTaskInput } from '../api/client';
import { startOfTodayISO } from '../util';
import { useSettings } from '../settings';
import type { List, Task, SmartCounts, Selection, SmartKey, Priority } from '../types';

const SMART_LABELS: Record<SmartKey, string> = {
  today: '今天',
  next7days: '最近7天',
  inbox: '收集箱',
  completed: '已完成',
  trash: '垃圾桶',
};

const EMPTY_COUNTS: SmartCounts = { today: 0, next7days: 0, inbox: 0, completed: 0, trash: 0 };

export default function TaskModule() {
  const { settings } = useSettings();
  const [lists, setLists] = useState<List[]>([]);
  const [counts, setCounts] = useState<SmartCounts>(EMPTY_COUNTS);
  const [selection, setSelection] = useState<Selection>({ kind: 'smart', key: 'today' });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queryFor = (sel: Selection) => (sel.kind === 'smart' ? `view=${sel.key}` : `listId=${sel.id}`);

  const refreshSidebar = useCallback(async () => {
    try {
      const [ls, cs] = await Promise.all([api.listLists(), api.smartCounts()]);
      setLists(ls);
      setCounts(cs);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const loadTasks = useCallback(async (sel: Selection) => {
    setLoading(true);
    setError(null);
    try {
      setTasks(await api.getTasks(queryFor(sel)));
    } catch (e) {
      setError((e as Error).message);
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSidebar();
  }, [refreshSidebar]);

  useEffect(() => {
    void loadTasks(selection);
  }, [selection, loadTasks]);

  const reload = useCallback(async () => {
    await Promise.all([loadTasks(selection), refreshSidebar()]);
  }, [selection, loadTasks, refreshSidebar]);

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

  function buildCreateInput(title: string): CreateTaskInput {
    const input: CreateTaskInput = { title, priority: settings.taskDefaults.priority };
    if (selection.kind === 'smart') {
      if (selection.key === 'today' || selection.key === 'next7days') {
        input.dueDate = startOfTodayISO();
        input.isAllDay = true;
      }
    } else {
      input.listId = selection.id;
    }
    if (!input.listId && settings.taskDefaults.listId) input.listId = settings.taskDefaults.listId;
    return input;
  }

  const title =
    selection.kind === 'smart' ? SMART_LABELS[selection.key] : lists.find((l) => l.id === selection.id)?.name ?? '清单';
  const canQuickAdd = !(selection.kind === 'smart' && (selection.key === 'completed' || selection.key === 'trash'));

  return (
    <>
      <Sidebar
        lists={lists}
        counts={counts}
        selection={selection}
        onSelect={setSelection}
        onAddList={(name) =>
          void mutate(async () => {
            const l = await api.createList(name);
            setSelection({ kind: 'list', id: l.id });
          })
        }
        onDeleteList={(id) =>
          void mutate(async () => {
            await api.deleteList(id);
            if (selection.kind === 'list' && selection.id === id) {
              setSelection({ kind: 'smart', key: 'today' });
            }
          })
        }
      />

      <TaskPanel
        selection={selection}
        title={title}
        tasks={tasks}
        loading={loading}
        error={error}
        canQuickAdd={canQuickAdd}
        onQuickAdd={(t) => void mutate(() => api.createTask(buildCreateInput(t)))}
        onToggle={(t) => void mutate(() => api.updateTask(t.id, { completed: !t.completed }))}
        onDelete={(t) => void mutate(() => api.deleteTask(t.id))}
        onRestore={(t) => void mutate(() => api.restoreTask(t.id))}
        onPurge={(t) => void mutate(() => api.purgeTask(t.id))}
        onSetPriority={(t, p: Priority) => void mutate(() => api.updateTask(t.id, { priority: p }))}
        onSetDue={(t, iso) => void mutate(() => api.updateTask(t.id, { dueDate: iso }))}
      />
    </>
  );
}
