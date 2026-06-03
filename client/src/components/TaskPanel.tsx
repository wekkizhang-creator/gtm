import { useEffect, useState, type ReactNode } from 'react';
import type { QuickParseResult, Task, Priority, Selection, Tag, SavedFilter, List } from '../types';
import TaskItem from './TaskItem';
import type { QuickCaptureInput } from '../api/client';
import {
  quickAddDraftSummary,
  quickAddSubmitOptions,
  quickAddTokenLabel,
  type QuickAddPreviewState,
  type QuickAddSubmitOptions,
} from '../quickAddPreview';
import { captureVoiceText } from '../voiceQuickCapture';
import { taskManualOrderUpdates, type TaskManualOrderAction } from '../taskManualOrder';
import { buildTaskListGroups, sortTaskList, type TaskGroupMode, type TaskSortMode } from '../taskListView';
import type { TaskFilterPatch, TaskFilterState } from '../taskFilters';
import { formatDue } from '../util';

interface Props {
  selection: Selection;
  title: string;
  tags: Tag[];
  tagFilter: string;
  savedFilters: SavedFilter[];
  savedFilterId: string;
  taskFilters: TaskFilterState;
  tasks: Task[];
  lists: List[];
  loading: boolean;
  error: string | null;
  syncNotice?: string | null;
  completionUndo?: { title: string; count: number } | null;
  canQuickAdd: boolean;
  firstTaskGuide?: ReactNode;
  overduePosition?: 'top' | 'original' | 'grouped';
  sortMode: TaskSortMode;
  groupMode: TaskGroupMode;
  quickParseEnabled: boolean;
  onQuickAdd: (title: string, options?: QuickAddSubmitOptions) => void;
  onQuickParse: (title: string) => Promise<QuickParseResult>;
  onQuickCapture: (input: QuickCaptureInput) => Promise<void>;
  onSortMode: (mode: TaskSortMode) => void;
  onGroupMode: (mode: TaskGroupMode) => void;
  onTaskFilters: (patch: TaskFilterPatch) => void;
  onClearTaskFilters: () => void;
  onTagFilter: (tagId: string) => void;
  onSavedFilter: (filterId: string) => void;
  onSaveFilter: () => void;
  onToggle: (t: Task) => void;
  onDelete: (t: Task) => void;
  onRestore: (t: Task) => void;
  onPurge: (t: Task) => void;
  onPurgeExpiredTrash: () => void;
  onEmptyTrash: () => void;
  onSetPriority: (t: Task, p: Priority) => void;
  onSetDue: (t: Task, iso: string | null) => void;
  onBatch: (input: {
    taskIds: string[];
    action: 'update' | 'delete' | 'restore' | 'purge';
    patch?: Partial<Pick<Task, 'dueDate' | 'priority' | 'listId' | 'completed'>>;
  }) => void;
  onReorderTasks: (updates: Array<{ id: string; sortOrder: number }>) => void;
  onUndoCompletion: () => void;
  onDismissCompletionUndo: () => void;
  onOpenDetail: (t: Task) => void;
  onChanged: () => void;
}

export default function TaskPanel(props: Props) {
  const { selection, title, tags, tagFilter, savedFilters, savedFilterId, tasks, lists, loading, error, syncNotice, canQuickAdd } = props;
  const [draft, setDraft] = useState('');
  const [quickPreview, setQuickPreview] = useState<QuickAddPreviewState>({ status: 'idle' });
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchDue, setBatchDue] = useState('');
  const [batchPriority, setBatchPriority] = useState('');
  const [batchListId, setBatchListId] = useState('');
  const inTrash = selection.kind === 'smart' && selection.key === 'trash';
  const selectedIds = [...selected].filter((id) => tasks.some((task) => task.id === id));
  const showOverdueGroups = !inTrash && props.groupMode === 'none' && props.overduePosition === 'grouped';
  const showFirstTaskGuide = Boolean(props.firstTaskGuide);
  const sortedTasks = sortTaskList(tasks, props.sortMode, lists);
  const listTypeById = new Map(lists.map((list) => [list.id, list.type]));
  const isNoteListTask = (task: Task) => (task.listId ? listTypeById.get(task.listId) === 'note' : false);
  const overdueTasks = showOverdueGroups ? sortedTasks.filter((task) => formatDue(task.dueDate)?.overdue) : [];
  const currentTasks = showOverdueGroups ? sortedTasks.filter((task) => !formatDue(task.dueDate)?.overdue) : sortedTasks;
  const groupedTasks = props.groupMode === 'none' ? [] : buildTaskListGroups(tasks, props.groupMode, props.sortMode, lists, tags);
  const canManualOrder =
    !inTrash &&
    props.groupMode === 'none' &&
    props.sortMode === 'custom' &&
    !showOverdueGroups &&
    (selection.kind === 'list' || (selection.kind === 'smart' && selection.key === 'inbox'));

  useEffect(() => {
    setSelected((prev) => new Set([...prev].filter((id) => tasks.some((task) => task.id === id))));
  }, [tasks]);

  useEffect(() => {
    const text = draft.trim();
    setQuickPreview((prev) => (prev.status !== 'idle' && prev.text !== text ? { status: 'idle' } : prev));
  }, [draft]);

  async function previewQuickAdd(text: string) {
    if (!props.quickParseEnabled) return;
    setQuickPreview({ status: 'loading', text });
    try {
      const result = await props.onQuickParse(text);
      setQuickPreview({ status: 'ready', text, result });
    } catch (e) {
      setQuickPreview({ status: 'error', text, message: (e as Error).message });
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = draft.trim();
    if (!v) return;
    const options = quickAddSubmitOptions(v, quickPreview);
    if (props.quickParseEnabled && options && !options.parsed && !options.skipParse) {
      void previewQuickAdd(v);
      return;
    }
    props.onQuickAdd(v, options ?? undefined);
    setDraft('');
    setQuickPreview({ status: 'idle' });
  }

  async function startVoiceCapture() {
    if (voiceBusy) return;
    setVoiceBusy(true);
    setQuickPreview({ status: 'idle' });
    try {
      const text = await captureVoiceText();
      await props.onQuickCapture({ source: 'voice', text, parse: props.quickParseEnabled });
      setDraft('');
      setQuickPreview({ status: 'idle' });
    } catch (e) {
      setQuickPreview({ status: 'error', text: draft.trim(), message: (e as Error).message });
    } finally {
      setVoiceBusy(false);
    }
  }

  function toggleSelected(id: string, value: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function batch(action: Parameters<Props['onBatch']>[0]['action'], patch?: Parameters<Props['onBatch']>[0]['patch']) {
    if (!selectedIds.length) return;
    props.onBatch({ taskIds: selectedIds, action, patch });
    setSelected(new Set());
  }

  function moveTask(taskId: string, action: TaskManualOrderAction) {
    const updates = taskManualOrderUpdates(currentTasks, taskId, action);
    if (updates.length) props.onReorderTasks(updates);
  }

  return (
    <main className="panel">
      <header className="panel-header">
        <h1>{title}</h1>
        <div className="panel-header-tools">
          <select className="panel-filter" value={tagFilter} onChange={(e) => props.onTagFilter(e.target.value)}>
            <option value="">全部标签</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
          <select className="panel-filter" value={savedFilterId} onChange={(e) => props.onSavedFilter(e.target.value)}>
            <option value="">全部过滤器</option>
            {savedFilters.map((filter) => (
              <option key={filter.id} value={filter.id}>
                {filter.name}
              </option>
            ))}
          </select>
          <button className="panel-filter-save" onClick={props.onSaveFilter} title="保存当前过滤器">
            保存
          </button>
          <select className="panel-filter" title="排序" value={props.sortMode} onChange={(e) => props.onSortMode(e.target.value as TaskSortMode)}>
            <option value="custom">自定义排序</option>
            <option value="time">按时间</option>
            <option value="priority">按优先级</option>
            <option value="title">按标题</option>
            <option value="list">按清单</option>
          </select>
          <select className="panel-filter" title="分组" value={props.groupMode} onChange={(e) => props.onGroupMode(e.target.value as TaskGroupMode)}>
            <option value="none">不分组</option>
            <option value="list">按清单</option>
            <option value="date">按日期</option>
            <option value="priority">按优先级</option>
            <option value="tag">按标签</option>
          </select>
          <span className="panel-count">{tasks.length}</span>
        </div>
      </header>

      <div className="task-filter-row">
        <input
          className="panel-filter panel-filter-search"
          value={props.taskFilters.q}
          onChange={(e) => props.onTaskFilters({ q: e.target.value })}
          placeholder="搜索标题/备注"
        />
        <select className="panel-filter" title="时间筛选" value={props.taskFilters.dateFilter} onChange={(e) => props.onTaskFilters({ dateFilter: e.target.value as TaskFilterState['dateFilter'] })}>
          <option value="">全部时间</option>
          <option value="today">今天</option>
          <option value="next7days">最近 7 天</option>
          <option value="undated">无日期</option>
        </select>
        <select className="panel-filter" title="优先级筛选" value={props.taskFilters.priority} onChange={(e) => props.onTaskFilters({ priority: e.target.value as TaskFilterState['priority'] })}>
          <option value="">全部优先级</option>
          <option value="3">高优先级</option>
          <option value="2">中优先级</option>
          <option value="1">低优先级</option>
          <option value="0">无优先级</option>
        </select>
        <select className="panel-filter" title="状态筛选" value={props.taskFilters.status} onChange={(e) => props.onTaskFilters({ status: e.target.value as TaskFilterState['status'] })}>
          <option value="">全部状态</option>
          <option value="todo">待办</option>
          <option value="doing">进行中</option>
          <option value="waiting">等待中</option>
          <option value="done">已完成状态</option>
        </select>
        <button type="button" className="panel-filter-save" onClick={props.onClearTaskFilters}>
          清除筛选
        </button>
      </div>

      {props.firstTaskGuide}

      {canQuickAdd && !showFirstTaskGuide && (
        <form className="quick-add" onSubmit={submit}>
          <div className="quick-add-row">
            <input
              className="quick-add-input"
              placeholder={props.quickParseEnabled ? '+ 添加任务，回车先解析，再回车创建' : '+ 添加任务，回车即可创建'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="button" className="quick-add-voice" disabled={voiceBusy} onClick={() => void startVoiceCapture()}>
              {voiceBusy ? 'Listening' : 'Voice'}
            </button>
            {props.quickParseEnabled && (
              <button type="button" className="quick-add-parse" disabled={!draft.trim() || quickPreview.status === 'loading'} onClick={() => void previewQuickAdd(draft.trim())}>
                {quickPreview.status === 'loading' ? '解析中' : '解析'}
              </button>
            )}
          </div>
          {quickPreview.status === 'ready' && (
            <div className="quick-add-preview">
              <div className="quick-add-token-row">
                {quickPreview.result.tokens.map((token, index) => (
                  <span key={`${token.type}-${token.raw}-${index}`} className={`quick-add-token quick-add-token-${token.type}`}>
                    {quickAddTokenLabel(token)}
                  </span>
                ))}
              </div>
              <div className="quick-add-summary">
                {quickAddDraftSummary(quickPreview.result).map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
              <div className="quick-add-preview-actions">
                <button type="submit">按解析结果创建</button>
                <button type="button" onClick={() => setQuickPreview({ status: 'dismissed', text: draft.trim() })}>
                  撤销解析
                </button>
              </div>
            </div>
          )}
          {quickPreview.status === 'dismissed' && (
            <div className="quick-add-preview quick-add-preview-muted">
              <span>已撤销解析，将按原文创建。</span>
              <button type="submit">创建原文任务</button>
            </div>
          )}
          {quickPreview.status === 'error' && <div className="quick-add-preview quick-add-preview-error">解析失败：{quickPreview.message}</div>}
        </form>
      )}

      {inTrash && tasks.length > 0 && (
        <div className="trash-actions">
          <span>垃圾桶保留期 30 天</span>
          <button onClick={props.onPurgeExpiredTrash}>清理 30 天前</button>
          <button className="danger" onClick={props.onEmptyTrash}>清空垃圾桶</button>
        </div>
      )}

      {selectedIds.length > 0 && (
        <div className="batch-bar">
          <span>已选择 {selectedIds.length} 项</span>
          {!inTrash && (
            <>
              <button onClick={() => batch('update', { completed: true })}>完成</button>
              <input type="date" value={batchDue} onChange={(e) => setBatchDue(e.target.value)} />
              <button onClick={() => batch('update', { dueDate: batchDue ? new Date(`${batchDue}T00:00:00`).toISOString() : null })}>
                设日期
              </button>
              <select value={batchPriority} onChange={(e) => setBatchPriority(e.target.value)}>
                <option value="">优先级</option>
                {([3, 2, 1, 0] as Priority[]).map((p) => (
                  <option key={p} value={p}>
                    {p === 0 ? '无' : p === 1 ? '低' : p === 2 ? '中' : '高'}
                  </option>
                ))}
              </select>
              <button disabled={batchPriority === ''} onClick={() => batch('update', { priority: Number(batchPriority) as Priority })}>
                设置
              </button>
              <select value={batchListId} onChange={(e) => setBatchListId(e.target.value)}>
                <option value="">移动到清单</option>
                {lists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </select>
              <button disabled={!batchListId} onClick={() => batch('update', { listId: batchListId })}>
                移动
              </button>
              <button className="danger" onClick={() => batch('delete')}>
                删除
              </button>
            </>
          )}
          {inTrash && (
            <>
              <button onClick={() => batch('restore')}>恢复</button>
              <button className="danger" onClick={() => batch('purge')}>彻底删除</button>
            </>
          )}
          <button onClick={() => setSelected(new Set())}>取消</button>
        </div>
      )}

      {syncNotice && <div className="banner">{syncNotice}</div>}
      {props.completionUndo && (
        <div className="completion-undo-bar" role="status" aria-live="polite">
          <span>{props.completionUndo.count === 1 ? `已完成「${props.completionUndo.title}」` : `已完成 ${props.completionUndo.count} 项任务`}</span>
          <button type="button" onClick={props.onUndoCompletion}>
            撤销
          </button>
          <button type="button" className="completion-undo-close" title="关闭" onClick={props.onDismissCompletionUndo}>
            ×
          </button>
        </div>
      )}
      {error && <div className="banner banner-error">⚠ {error}</div>}
      {loading && <div className="banner">加载中…</div>}

      {!loading && !error && !showFirstTaskGuide && tasks.length === 0 && (
        <div className="empty">这里还没有任务</div>
      )}

      {props.groupMode !== 'none' && groupedTasks.map((group) => (
        <section key={group.id} className="task-view-group">
          <div className="task-group-title">{group.label}<span>{group.tasks.length}</span></div>
          <ul className="task-list">
            {group.tasks.map((t) => (
              <TaskItem
                key={`${group.id}-${t.id}`}
                task={t}
                inTrash={inTrash}
                batchSelected={selected.has(t.id)}
                isNoteList={isNoteListTask(t)}
                onBatchSelect={(checked) => toggleSelected(t.id, checked)}
                onToggle={props.onToggle}
                onDelete={props.onDelete}
                onRestore={props.onRestore}
                onPurge={props.onPurge}
                onSetPriority={props.onSetPriority}
                onSetDue={props.onSetDue}
                onOpenDetail={props.onOpenDetail}
                onChanged={props.onChanged}
              />
            ))}
          </ul>
        </section>
      ))}
      {props.groupMode === 'none' && showOverdueGroups && overdueTasks.length > 0 && <div className="task-group-title">已过期</div>}
      {props.groupMode === 'none' && (
        <ul className="task-list">
          {(showOverdueGroups ? overdueTasks : currentTasks).map((t, index) => (
          <TaskItem
            key={t.id}
            task={t}
            inTrash={inTrash}
            batchSelected={selected.has(t.id)}
            isNoteList={isNoteListTask(t)}
            onBatchSelect={(checked) => toggleSelected(t.id, checked)}
            orderControls={canManualOrder ? { canMoveUp: index > 0, canMoveDown: index < currentTasks.length - 1, canPinTop: index > 0 } : undefined}
            onMoveTask={(action) => moveTask(t.id, action)}
            onToggle={props.onToggle}
            onDelete={props.onDelete}
            onRestore={props.onRestore}
            onPurge={props.onPurge}
            onSetPriority={props.onSetPriority}
            onSetDue={props.onSetDue}
            onOpenDetail={props.onOpenDetail}
            onChanged={props.onChanged}
          />
          ))}
        </ul>
      )}
      {props.groupMode === 'none' && showOverdueGroups && currentTasks.length > 0 && (
        <>
          <div className="task-group-title">未过期<span>{currentTasks.length}</span></div>
          <ul className="task-list">
            {currentTasks.map((t) => (
              <TaskItem
                key={t.id}
                task={t}
                inTrash={inTrash}
                batchSelected={selected.has(t.id)}
                isNoteList={isNoteListTask(t)}
                onBatchSelect={(checked) => toggleSelected(t.id, checked)}
                onToggle={props.onToggle}
                onDelete={props.onDelete}
                onRestore={props.onRestore}
                onPurge={props.onPurge}
                onSetPriority={props.onSetPriority}
                onSetDue={props.onSetDue}
                onOpenDetail={props.onOpenDetail}
                onChanged={props.onChanged}
              />
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
