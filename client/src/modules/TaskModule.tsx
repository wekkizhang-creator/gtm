import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Sidebar from '../components/Sidebar';
import TaskPanel from '../components/TaskPanel';
import TaskDetailModal from '../components/TaskDetailModal';
import { api, isNetworkError, type CreateTaskInput, type QuickCaptureInput } from '../api/client';
import { trackEvent } from '../analytics';
import { authOfflineEnterProperties, consumeQueuedAuthOfflineEnter, queueAuthOfflineEnter } from '../authOfflineAnalytics';
import { startOfTodayISO } from '../util';
import { useSettings } from '../settings';
import { useAuth } from '../auth';
import type { QuickAddSubmitOptions } from '../quickAddPreview';
import { enqueueTaskCreate, flushSyncQueue, pendingSyncCount } from '../syncQueue';
import { playTaskCompletionSound } from '../taskCompletionSound';
import type { SearchNavigationTarget } from '../searchNavigation';
import {
  controlsFromSavedFilterQuery,
  emptyTaskFilterState,
  savedFilterQueryFromSelection,
  taskFilterQuery,
  type TaskFilterPatch,
  type TaskFilterState,
} from '../taskFilters';
import type { TaskGroupMode, TaskSortMode } from '../taskListView';
import type { AccountOnboarding, List, ListFolder, Task, SmartCounts, Selection, SmartKey, Priority, Tag, SavedFilter } from '../types';

const SMART_LABELS: Record<SmartKey, string> = {
  active: '全部任务',
  today: '今天',
  next7days: '最近7天',
  inbox: '收集箱',
  completed: '已完成',
  trash: '垃圾桶',
};

const EMPTY_COUNTS: SmartCounts = { today: 0, next7days: 0, inbox: 0, completed: 0, trash: 0 };

interface CompletionUndoState {
  taskIds: string[];
  title: string;
  count: number;
}

interface Props {
  searchTarget?: SearchNavigationTarget | null;
}

export default function TaskModule({ searchTarget }: Props) {
  const { settings } = useSettings();
  const { user } = useAuth();
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [lists, setLists] = useState<List[]>([]);
  const [folders, setFolders] = useState<ListFolder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [counts, setCounts] = useState<SmartCounts>(EMPTY_COUNTS);
  const [selection, setSelection] = useState<Selection>({ kind: 'smart', key: 'today' });
  const [tagFilter, setTagFilter] = useState('');
  const [savedFilterId, setSavedFilterId] = useState('');
  const [taskFilters, setTaskFilters] = useState<TaskFilterState>(() => emptyTaskFilterState());
  const [taskSortMode, setTaskSortMode] = useState<TaskSortMode>('custom');
  const [taskGroupMode, setTaskGroupMode] = useState<TaskGroupMode>('none');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [pendingSync, setPendingSync] = useState(() => pendingSyncCount(user.id));
  const [completionUndo, setCompletionUndo] = useState<CompletionUndoState | null>(null);
  const [onboarding, setOnboarding] = useState<AccountOnboarding | null>(null);
  const [firstTaskTitle, setFirstTaskTitle] = useState('');
  const [firstTaskBusy, setFirstTaskBusy] = useState(false);
  const [firstTaskError, setFirstTaskError] = useState<string | null>(null);

  const queryFor = (sel: Selection, activeTag: string, filters: TaskFilterState) => {
    const params = new URLSearchParams();
    if (sel.kind === 'smart') params.set('view', sel.key);
    else params.set('listId', sel.id);
    for (const [key, value] of Object.entries(taskFilterQuery(filters, activeTag))) {
      params.set(key, value);
    }
    return params.toString();
  };

  const refreshSidebar = useCallback(async () => {
    try {
      const [ls, folderList, cs, tagList, filterList] = await Promise.all([
        api.listLists(),
        api.listFolders(),
        api.smartCounts(),
        api.listTags(),
        api.listSavedFilters(),
      ]);
      setLists(ls);
      setFolders(folderList);
      setCounts(cs);
      setTags(tagList);
      setSavedFilters(filterList);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const loadTasks = useCallback(async (sel: Selection) => {
    setLoading(true);
    setError(null);
    try {
      setTasks(await api.getTasks(queryFor(sel, tagFilter, taskFilters)));
    } catch (e) {
      setError((e as Error).message);
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, [tagFilter, taskFilters]);

  const refreshOnboarding = useCallback(async () => {
    try {
      setOnboarding(await api.getAccountOnboarding());
    } catch (e) {
      setFirstTaskError((e as Error).message);
      setOnboarding(null);
    }
  }, []);

  useEffect(() => {
    void refreshSidebar();
  }, [refreshSidebar]);

  useEffect(() => {
    setOnboarding(null);
    setFirstTaskTitle('');
    setFirstTaskError(null);
    void refreshOnboarding();
  }, [user.id, refreshOnboarding]);

  useEffect(() => {
    void loadTasks(selection);
  }, [selection, loadTasks]);

  useEffect(() => {
    if (!searchTarget) return;
    if (searchTarget.type === 'tasks') {
      void api
        .getTask(searchTarget.id)
        .then((task) => {
          if (task.listId) setSelection({ kind: 'list', id: task.listId });
          setDetailTask(task);
          setError(null);
        })
        .catch((err) => setError((err as Error).message));
    } else if (searchTarget.type === 'lists') {
      setSelection({ kind: 'list', id: searchTarget.id });
      setTagFilter('');
      setSavedFilterId('');
      setTaskFilters(emptyTaskFilterState());
    } else if (searchTarget.type === 'tags') {
      setSelection({ kind: 'smart', key: 'active' });
      setTagFilter(searchTarget.id);
      setSavedFilterId('');
      setTaskFilters(emptyTaskFilterState());
    }
  }, [searchTarget?.nonce]);

  const reload = useCallback(async () => {
    await Promise.all([loadTasks(selection), refreshSidebar(), refreshOnboarding()]);
  }, [selection, loadTasks, refreshSidebar, refreshOnboarding]);

  const flushPendingSync = useCallback(async () => {
    try {
      const result = await flushSyncQueue(user.id);
      setPendingSync(result.pending);
      if (result.results.some((item) => item.status === 'applied' || item.status === 'duplicate')) {
        setSyncNotice(result.pending ? `已同步部分离线操作，仍有 ${result.pending} 条待处理` : '离线操作已同步');
        await reload();
      } else if (result.pending) {
        setSyncNotice(`仍有 ${result.pending} 条离线操作待同步`);
      } else {
        setSyncNotice(null);
      }
    } catch (e) {
      if (!isNetworkError(e)) setSyncNotice((e as Error).message);
    }
  }, [user.id, reload]);

  useEffect(() => {
    setPendingSync(pendingSyncCount(user.id));
  }, [user.id]);

  useEffect(() => {
    const queueOfflineEnter = () => {
      const pending = pendingSyncCount(user.id);
      setPendingSync(pending);
      queueAuthOfflineEnter(user.id, authOfflineEnterProperties(user.id, pending));
    };
    const onOnline = () => {
      const queued = consumeQueuedAuthOfflineEnter(user.id);
      if (queued) trackEvent('auth_offline_enter', queued);
      void flushPendingSync();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', queueOfflineEnter);
    if (navigator.onLine) onOnline();
    else queueOfflineEnter();
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', queueOfflineEnter);
    };
  }, [flushPendingSync]);

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

  async function quickAdd(text: string, options: QuickAddSubmitOptions = {}): Promise<void> {
    const input = buildCreateInput(text);
    const tagNames: string[] = [];
    if (options.parsed) {
      const parsed = options.parsed;
      input.title = parsed.draft.title;
      if (parsed.draft.dueDate || 'dueDate' in input) input.dueDate = parsed.draft.dueDate ?? input.dueDate ?? null;
      if (parsed.draft.startDate || 'startDate' in input) input.startDate = parsed.draft.startDate ?? input.startDate ?? null;
      if (parsed.draft.dueDate || parsed.draft.startDate || 'isAllDay' in input) {
        input.isAllDay = parsed.draft.dueDate || parsed.draft.startDate ? parsed.draft.isAllDay : input.isAllDay;
      }
      input.priority = parsed.draft.priority || input.priority;
      if (parsed.draft.estimatedMinutes != null) input.estimatedMinutes = parsed.draft.estimatedMinutes;
      if (parsed.draft.recurrenceRule) input.recurrenceRule = parsed.draft.recurrenceRule;
      if (parsed.draft.note) input.note = parsed.draft.note;
      tagNames.push(...parsed.draft.tags);
    } else if (settings.quickAdd.parseEnabled && !options.skipParse) {
      try {
        const parsed = await api.quickParseTask(text);
        input.title = parsed.draft.title;
        if (parsed.draft.dueDate || 'dueDate' in input) input.dueDate = parsed.draft.dueDate ?? input.dueDate ?? null;
        if (parsed.draft.startDate || 'startDate' in input) input.startDate = parsed.draft.startDate ?? input.startDate ?? null;
        if (parsed.draft.dueDate || parsed.draft.startDate || 'isAllDay' in input) {
          input.isAllDay = parsed.draft.dueDate || parsed.draft.startDate ? parsed.draft.isAllDay : input.isAllDay;
        }
        input.priority = parsed.draft.priority || input.priority;
        if (parsed.draft.estimatedMinutes != null) input.estimatedMinutes = parsed.draft.estimatedMinutes;
        if (parsed.draft.recurrenceRule) input.recurrenceRule = parsed.draft.recurrenceRule;
        if (parsed.draft.note) input.note = parsed.draft.note;
        tagNames.push(...parsed.draft.tags);
      } catch (e) {
        if (!isNetworkError(e)) throw e;
      }
    }
    let task: Task;
    try {
      task = await api.createTask(input);
    } catch (e) {
      if (isNetworkError(e)) {
        const pending = enqueueTaskCreate(user.id, input);
        setPendingSync(pending);
        setSyncNotice(`当前离线：任务已加入同步队列，共 ${pending} 条待同步`);
        throw new Error('当前离线：任务已加入同步队列，联网后会自动同步');
      }
      throw e;
    }
    const attachIds = new Set<string>();
    if (tagFilter) attachIds.add(tagFilter);
    for (const name of tagNames) {
      const existing = tags.find((tag) => tag.name === name);
      const tag = existing ?? (await api.createTag({ name }));
      attachIds.add(tag.id);
    }
    for (const id of attachIds) await api.addTaskTag(task.id, id);
  }

  async function quickCapture(input: QuickCaptureInput): Promise<void> {
    const captureText = input.text?.trim() || input.title?.trim() || input.url?.trim() || '';
    if (!captureText) throw new Error('quick_capture_text_required');
    const contextual = buildCreateInput(captureText);
    const request: QuickCaptureInput = { ...input };
    if (request.listId == null && contextual.listId) request.listId = contextual.listId;
    if (request.priority == null && contextual.priority != null) request.priority = contextual.priority;
    if (request.dueDate == null && Object.prototype.hasOwnProperty.call(contextual, 'dueDate')) request.dueDate = contextual.dueDate ?? null;
    if (request.startDate == null && Object.prototype.hasOwnProperty.call(contextual, 'startDate')) request.startDate = contextual.startDate ?? null;
    if (request.isAllDay == null && Object.prototype.hasOwnProperty.call(contextual, 'isAllDay')) request.isAllDay = contextual.isAllDay;
    try {
      await api.quickCaptureTask(request);
    } catch (e) {
      if (isNetworkError(e)) {
        const pending = enqueueTaskCreate(user.id, { ...contextual, source: input.source });
        setPendingSync(pending);
        setSyncNotice(`Offline: quick capture queued, ${pending} pending`);
        throw new Error('Offline: quick capture queued and will sync automatically');
      }
      throw e;
    }
  }

  async function submitFirstTask(e: FormEvent) {
    e.preventDefault();
    const title = firstTaskTitle.trim();
    if (!title || firstTaskBusy) return;
    setFirstTaskBusy(true);
    setFirstTaskError(null);
    try {
      await quickAdd(title);
      setFirstTaskTitle('');
      await reload();
    } catch (err) {
      setFirstTaskError((err as Error).message);
    } finally {
      setFirstTaskBusy(false);
    }
  }

  function updateTaskFilters(patch: TaskFilterPatch): void {
    setSavedFilterId('');
    setTaskFilters((prev) => ({ ...prev, ...patch }));
  }

  function updateTagFilter(tagId: string): void {
    setSavedFilterId('');
    setTagFilter(tagId);
  }

  function clearTaskFilters(): void {
    setSavedFilterId('');
    setTagFilter('');
    setTaskFilters(emptyTaskFilterState());
  }

  function applySavedFilter(filterId: string): void {
    setSavedFilterId(filterId);
    if (!filterId) return;
    const filter = savedFilters.find((item) => item.id === filterId);
    if (!filter) return;
    const next = controlsFromSavedFilterQuery(filter.query);
    setTagFilter(next.tagId);
    setTaskFilters(next.filters);
    if (next.selection) setSelection(next.selection);
  }

  async function saveCurrentFilter(): Promise<void> {
    const name = window.prompt('过滤器名称');
    if (!name?.trim()) return;
    const filter = await api.createSavedFilter({ name: name.trim(), query: savedFilterQueryFromSelection(selection, taskFilters, tagFilter) });
    setSavedFilterId(filter.id);
  }

  async function undoLastCompletion(): Promise<void> {
    const pending = completionUndo;
    if (!pending) return;
    await mutate(async () => {
      const result = await api.batchTasks({
        taskIds: pending.taskIds,
        action: 'update',
        patch: { completed: false },
      });
      setCompletionUndo(null);
      setSyncNotice(pending.count === 1 ? `已撤销完成：${pending.title}` : `已撤销完成 ${result.affected} 项任务`);
    });
  }

  const title =
    selection.kind === 'smart' ? SMART_LABELS[selection.key] : lists.find((l) => l.id === selection.id)?.name ?? '清单';
  const canQuickAdd = !(selection.kind === 'smart' && (selection.key === 'completed' || selection.key === 'trash'));
  const firstTaskGuide =
    onboarding?.showFirstTaskGuide && canQuickAdd ? (
      <section className="first-task-guide" aria-label="创建首个任务引导">
        <div className="first-task-guide-copy">
          <strong>创建你的第一个任务</strong>
          <span>写下现在最想推进的一件事，任务会直接保存到当前账号。</span>
        </div>
        <form className="first-task-guide-form" onSubmit={submitFirstTask}>
          <input
            value={firstTaskTitle}
            onChange={(e) => setFirstTaskTitle(e.target.value)}
            placeholder="例如：整理今天的三件重点"
            disabled={firstTaskBusy}
          />
          <button type="submit" disabled={firstTaskBusy || !firstTaskTitle.trim()}>
            {firstTaskBusy ? '创建中...' : '创建'}
          </button>
        </form>
        {firstTaskError && <div className="first-task-guide-error">{firstTaskError}</div>}
      </section>
    ) : null;

  return (
    <>
      <Sidebar
        lists={lists}
        folders={folders}
        counts={counts}
        selection={selection}
        onSelect={setSelection}
        onAddList={(name, folderId, type) =>
          void mutate(async () => {
            const l = await api.createList(name, folderId, type);
            setSelection({ kind: 'list', id: l.id });
          })
        }
        onUpdateList={(id, patch) => void mutate(() => api.updateList(id, patch))}
        onReorderLists={(updates) =>
          void mutate(async () => {
            for (const update of updates) await api.updateList(update.id, { sortOrder: update.sortOrder });
          })
        }
        onAddFolder={(name) => void mutate(() => api.createFolder({ name }))}
        onUpdateFolder={(id, patch) => void mutate(() => api.updateFolder(id, patch))}
        onReorderFolders={(updates) =>
          void mutate(async () => {
            for (const update of updates) await api.updateFolder(update.id, { sortOrder: update.sortOrder });
          })
        }
        onDeleteFolder={(id) => void mutate(() => api.deleteFolder(id))}
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
        tags={tags}
        tagFilter={tagFilter}
        savedFilters={savedFilters}
        savedFilterId={savedFilterId}
        taskFilters={taskFilters}
        tasks={tasks}
        lists={lists}
        loading={loading}
        error={error}
        syncNotice={syncNotice ?? (pendingSync ? `有 ${pendingSync} 条离线操作待同步` : null)}
        completionUndo={completionUndo ? { title: completionUndo.title, count: completionUndo.count } : null}
        canQuickAdd={canQuickAdd}
        firstTaskGuide={firstTaskGuide}
        overduePosition={
          selection.kind === 'list' || (selection.kind === 'smart' && selection.key === 'inbox')
            ? settings.taskDefaults.overduePosition
            : 'original'
        }
        sortMode={taskSortMode}
        groupMode={taskGroupMode}
        onSortMode={setTaskSortMode}
        onGroupMode={setTaskGroupMode}
        onTaskFilters={updateTaskFilters}
        onClearTaskFilters={clearTaskFilters}
        onTagFilter={updateTagFilter}
        onSavedFilter={applySavedFilter}
        onSaveFilter={() => void mutate(saveCurrentFilter)}
        quickParseEnabled={settings.quickAdd.parseEnabled}
        onQuickParse={(text) => api.quickParseTask(text)}
        onQuickAdd={(t, options) => void mutate(() => quickAdd(t, options))}
        onQuickCapture={(input) => mutate(() => quickCapture(input))}
        onToggle={(t) =>
          void mutate(async () => {
            const updated = await api.updateTask(t.id, { completed: !t.completed });
            await playTaskCompletionSound(settings, t.completed, updated.completed);
            setCompletionUndo(!t.completed && updated.completed ? { taskIds: [updated.id], title: updated.title, count: 1 } : null);
          })
        }
        onDelete={(t) => void mutate(() => api.deleteTask(t.id))}
        onRestore={(t) => void mutate(() => api.restoreTask(t.id))}
        onPurge={(t) => void mutate(() => api.purgeTask(t.id))}
        onPurgeExpiredTrash={() =>
          void mutate(async () => {
            const result = await api.purgeExpiredTrash(30);
            setSyncNotice(`已清理 ${result.purgedCount} 条超过 30 天的垃圾桶任务`);
          })
        }
        onEmptyTrash={() =>
          void mutate(async () => {
            if (!window.confirm('确认彻底清空垃圾桶？此操作不可撤销。')) return;
            const result = await api.emptyTrash();
            setSyncNotice(`已彻底删除 ${result.purgedCount} 条垃圾桶任务`);
          })
        }
        onSetPriority={(t, p: Priority) => void mutate(() => api.updateTask(t.id, { priority: p }))}
        onSetDue={(t, iso) => void mutate(() => api.updateTask(t.id, { dueDate: iso }))}
        onBatch={(input) =>
          void mutate(async () => {
            const previouslyIncompleteIds = new Set(
              input.taskIds.filter((id) => tasks.some((task) => task.id === id && !task.completed)),
            );
            const shouldPlayBatchCompletion =
              input.action === 'update' &&
              input.patch?.completed === true &&
              previouslyIncompleteIds.size > 0;
            const result = await api.batchTasks(input);
            if (shouldPlayBatchCompletion && result.affected > 0) {
              await playTaskCompletionSound(settings, false, true);
            }
            const completedTasks = shouldPlayBatchCompletion
              ? result.tasks.filter((task) => previouslyIncompleteIds.has(task.id) && task.completed)
              : [];
            setCompletionUndo(
              completedTasks.length > 0
                ? { taskIds: completedTasks.map((task) => task.id), title: completedTasks[0].title, count: completedTasks.length }
                : null,
            );
          })
        }
        onReorderTasks={(updates) =>
          void mutate(async () => {
            for (const update of updates) await api.updateTask(update.id, { sortOrder: update.sortOrder });
          })
        }
        onUndoCompletion={() => void undoLastCompletion()}
        onDismissCompletionUndo={() => setCompletionUndo(null)}
        onOpenDetail={(t) => setDetailTask(t)}
        onChanged={() => void reload()}
      />
      {detailTask && (
        <TaskDetailModal task={detailTask} onClose={() => setDetailTask(null)} onChanged={() => void reload()} />
      )}
    </>
  );
}
