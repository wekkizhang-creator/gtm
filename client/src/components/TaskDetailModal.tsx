import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { aiConfigurationIssue } from '../aiGuide';
import { ensureNotificationPermission } from '../notificationPermission';
import { useSettings } from '../settings';
import { playTaskCompletionSound } from '../taskCompletionSound';
import { PRIORITY_COLORS, PRIORITY_LABELS, isoToDateInput, dateInputToISO } from '../util';
import type { AIBreakdownSuggestion, AIQuadrantSuggestionResult, Task, TaskActivity, TaskChecklistItem, Priority, Tag } from '../types';

function isoToDateTimeLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dateTimeLocalToISO(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.onload = () => resolve(String(reader.result ?? '').split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}

export default function TaskDetailModal({
  task: initial,
  onClose,
  onChanged,
}: {
  task: Task;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { settings } = useSettings();
  const [task, setTask] = useState<Task>(initial);
  const [subs, setSubs] = useState<Task[]>([]);
  const [checklist, setChecklist] = useState<TaskChecklistItem[]>([]);
  const [activity, setActivity] = useState<TaskActivity[]>([]);
  const [title, setTitle] = useState(initial.title);
  const [note, setNote] = useState(initial.note ?? '');
  const [estimate, setEstimate] = useState(initial.estimatedMinutes ? String(initial.estimatedMinutes) : '');
  const [manualProgress, setManualProgress] = useState(initial.manualProgress == null ? '' : String(initial.manualProgress));
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagId, setTagId] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [reminderDraft, setReminderDraft] = useState('');
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [checklistDraft, setChecklistDraft] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState<AIBreakdownSuggestion[]>([]);
  const [quadrantBusy, setQuadrantBusy] = useState(false);
  const [quadrantSuggestion, setQuadrantSuggestion] = useState<AIQuadrantSuggestionResult | null>(null);
  const [noteMessage, setNoteMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [t, s, items, activityItems, allTags] = await Promise.all([
        api.getTask(initial.id),
        api.getSubtasks(initial.id),
        api.listTaskChecklist(initial.id),
        api.listTaskActivity(initial.id),
        api.listTags(),
      ]);
      setTask(t);
      setSubs(s);
      setChecklist(items);
      setActivity(activityItems);
      setTags(allTags);
      setManualProgress(t.manualProgress == null ? '' : String(t.manualProgress));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    onChanged();
  }, [initial.id, onChanged]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const patch = async (p: Parameters<typeof api.updateTask>[1]) => {
    try {
      const updated = await api.updateTask(task.id, p);
      await playTaskCompletionSound(settings, task.completed, updated.completed);
      await reload();
      return updated;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };

  async function toggleParent() {
    if (!task.completed && task.subtaskTotal > task.subtaskDone) {
      if (window.confirm('该任务还有未完成的子任务，是否同时完成所有子任务？')) {
        for (const s of subs) if (!s.completed) await api.updateTask(s.id, { completed: true });
      }
    }
    await patch({ completed: !task.completed });
  }

  async function deferCurrentOccurrence() {
    try {
      await api.deferRecurringTask(task.id);
      setNoteMessage('已顺延到下一周期');
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function skipCurrentOccurrence() {
    if (!window.confirm('确认跳过本次重复任务？系统会保留当前实例并创建下一次。')) return;
    try {
      const result = await api.skipRecurringTask(task.id);
      setNoteMessage(result.nextTask ? `已创建下一次：${result.nextTask.title}` : '本次已跳过');
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function addSubtasks(text: string) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    try {
      for (const l of lines) await api.createTask({ title: l, parentId: task.id });
      setDraft('');
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function addChecklistItems(text: string) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    try {
      for (const l of lines) await api.createTaskChecklistItem(task.id, { title: l });
      setChecklistDraft('');
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toggleChecklistItem(item: TaskChecklistItem) {
    try {
      const updated = await api.updateTaskChecklistItem(task.id, item.id, { completed: !item.completed });
      await playTaskCompletionSound(settings, item.completed, updated.completed);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function renameChecklistItem(item: TaskChecklistItem, title: string) {
    const next = title.trim();
    if (!next || next === item.title) return;
    try {
      await api.updateTaskChecklistItem(task.id, item.id, { title: next });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteChecklistItem(item: TaskChecklistItem) {
    try {
      await api.deleteTaskChecklistItem(task.id, item.id);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function convertChecklistItem(item: TaskChecklistItem) {
    try {
      await api.convertChecklistItemToSubtask(task.id, item.id);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function generateAISubtasks() {
    const issue = aiConfigurationIssue(settings.ai, 'AI 拆解');
    if (issue) {
      setError(issue);
      return;
    }
    setAiBusy(true);
    try {
      const result = await api.aiBreakdownTask({ taskId: task.id, maxItems: 6 });
      setAiSuggestions(result.suggestions);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAiBusy(false);
    }
  }

  async function applyAISuggestions(items = aiSuggestions) {
    if (!items.length) return;
    try {
      for (const item of items) {
        await api.createTask({
          title: item.title,
          note: item.note,
          parentId: task.id,
          estimatedMinutes: item.estimatedMinutes,
          priority: item.priority,
          source: 'ai',
        });
      }
      setAiSuggestions([]);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function generateQuadrantSuggestion() {
    const issue = aiConfigurationIssue(settings.ai, 'AI 四象限建议');
    if (issue) {
      setError(issue);
      return;
    }
    setQuadrantBusy(true);
    try {
      const result = await api.aiSuggestQuadrant({ taskId: task.id });
      setQuadrantSuggestion(result);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setQuadrantBusy(false);
    }
  }

  async function applyQuadrantSuggestion() {
    if (!quadrantSuggestion) return;
    await patch({
      isImportant: quadrantSuggestion.suggestion.isImportant,
      isUrgent: quadrantSuggestion.suggestion.isUrgent,
    });
    setQuadrantSuggestion(null);
  }

  async function attachTag(id: string) {
    if (!id) return;
    try {
      await api.addTaskTag(task.id, id);
      setTagId('');
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function createAndAttachTag() {
    const name = tagDraft.trim();
    if (!name) return;
    try {
      const tag = await api.createTag({ name });
      await api.addTaskTag(task.id, tag.id);
      setTagDraft('');
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removeTag(id: string) {
    try {
      await api.removeTaskTag(task.id, id);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function addReminder() {
    const remindAt = dateTimeLocalToISO(reminderDraft);
    if (!remindAt) return;
    try {
      await ensureNotificationPermission('task_reminder');
      await api.createTaskReminder(task.id, { remindAt, channel: 'email' });
      setReminderDraft('');
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteReminder(id: string) {
    try {
      await api.deleteTaskReminder(task.id, id);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function uploadAttachment(file: File | null) {
    if (!file) return;
    setAttachmentBusy(true);
    try {
      const contentBase64 = await readFileAsBase64(file);
      await api.createTaskAttachment(task.id, { fileName: file.name, mimeType: file.type || null, contentBase64 });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAttachmentBusy(false);
    }
  }

  async function openAsStickyNote() {
    try {
      const note = await api.createNoteFromTask(task.id);
      setNoteMessage(`已生成便签：${note.title}`);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toggleSub(s: Task) {
    try {
      const updated = await api.updateTask(s.id, { completed: !s.completed });
      await playTaskCompletionSound(settings, s.completed, updated.completed);
      const fresh = await api.getSubtasks(task.id);
      const t = await api.getTask(task.id);
      setSubs(fresh);
      setTask(t);
      onChanged();
      if (!s.completed && !task.subtaskConfig.autoCompleteParent && !t.completed && fresh.length > 0 && fresh.every((x) => x.completed)) {
        if (window.confirm('全部子任务已完成，是否将该任务标记为完成？')) await patch({ completed: true });
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const pct = Math.round(task.rollupProgress * 100);
  const availableTags = tags.filter((tag) => !task.tags.some((item) => item.id === tag.id));

  return (
    <>
      <div className="td-backdrop" onClick={onClose} />
      <div className="td-modal" onClick={(e) => e.stopPropagation()}>
        <button className="td-close" onClick={onClose} title="关闭">
          ✕
        </button>

        <div className="td-head">
          <button
            className={`task-check${task.completed ? ' done' : ''}`}
            style={{ borderColor: PRIORITY_COLORS[task.priority], color: PRIORITY_COLORS[task.priority] }}
            onClick={() => void toggleParent()}
          >
            {task.completed ? '✓' : ''}
          </button>
          <input
            className={`td-title${task.completed ? ' done' : ''}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== task.title && void patch({ title: title.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </div>

        <div className="td-meta">
          <label>
            截止
            <input type="date" value={isoToDateInput(task.dueDate)} onChange={(e) => void patch({ dueDate: dateInputToISO(e.target.value) })} />
          </label>
          <label>
            优先级
            <select value={task.priority} onChange={(e) => void patch({ priority: Number(e.target.value) as Priority })}>
              {([0, 1, 2, 3] as Priority[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
          <label>
            预计(分)
            <input
              type="number"
              min="0"
              className="td-est"
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
              onBlur={() => void patch({ estimatedMinutes: estimate ? Number(estimate) : null })}
            />
          </label>
        </div>

        <div className="td-meta td-meta-wide">
          <label>
            状态
            <select value={task.status} onChange={(e) => void patch({ status: e.target.value as Task['status'] })}>
              <option value="todo">待办</option>
              <option value="doing">进行中</option>
              <option value="waiting">等待</option>
              <option value="done">完成</option>
              <option value="skipped">已跳过</option>
            </select>
          </label>
          <label>
            重复
            <select value={task.recurrenceRule ?? ''} onChange={(e) => void patch({ recurrenceRule: e.target.value || null })}>
              <option value="">不重复</option>
              <option value="FREQ=DAILY">每天</option>
              <option value="FREQ=WEEKLY">每周</option>
              <option value="FREQ=MONTHLY">每月</option>
              <option value="FREQ=YEARLY">每年</option>
            </select>
          </label>
          <label>
            手动进度
            <input
              type="number"
              min="0"
              max="100"
              className="td-est"
              value={manualProgress}
              onChange={(e) => setManualProgress(e.target.value)}
              onBlur={() => void patch({ manualProgress: manualProgress === '' ? null : Number(manualProgress) })}
            />
          </label>
          <label className="td-auto">
            <input type="checkbox" checked={task.pinned} onChange={(e) => void patch({ pinned: e.target.checked })} />
            置顶
          </label>
        </div>

        {task.recurrenceRule && task.status !== 'skipped' && (
          <div className="td-inline-form">
            <button type="button" onClick={() => void deferCurrentOccurrence()}>
              顺延本次
            </button>
            <button type="button" onClick={() => void skipCurrentOccurrence()}>
              跳过本次
            </button>
          </div>
        )}

        <div className="td-section">
          <div className="td-section-title">四象限</div>
          <div className="td-inline-form">
            <label className="td-auto">
              <input type="checkbox" checked={task.isImportant === true} onChange={(e) => void patch({ isImportant: e.target.checked })} />
              重要
            </label>
            <label className="td-auto">
              <input type="checkbox" checked={task.isUrgent === true} onChange={(e) => void patch({ isUrgent: e.target.checked })} />
              紧急
            </label>
            <button type="button" onClick={() => void generateQuadrantSuggestion()} disabled={quadrantBusy}>
              {quadrantBusy ? '判断中...' : 'AI 建议'}
            </button>
          </div>
          {quadrantSuggestion && (
            <div className="td-ai-suggestions compact">
              <div className="td-ai-head">
                <span>
                  建议：{quadrantSuggestion.suggestion.isImportant ? '重要' : '不重要'} / {quadrantSuggestion.suggestion.isUrgent ? '紧急' : '不紧急'}
                </span>
                <button type="button" onClick={() => void applyQuadrantSuggestion()}>
                  采纳
                </button>
              </div>
              {quadrantSuggestion.suggestion.reason && <p>{quadrantSuggestion.suggestion.reason}</p>}
              <span className="td-muted">置信度 {Math.round(quadrantSuggestion.suggestion.confidence * 100)}%</span>
            </div>
          )}
        </div>

        <div className="td-section">
          <div className="td-section-title">标签</div>
          <div className="td-chip-row">
            {task.tags.map((tag) => (
              <button key={tag.id} className="td-chip" style={{ borderColor: tag.color ?? undefined }} onClick={() => void removeTag(tag.id)}>
                {tag.name} ×
              </button>
            ))}
            {task.tags.length === 0 && <span className="td-muted">暂无标签</span>}
          </div>
          <div className="td-inline-form">
            <select value={tagId} onChange={(e) => setTagId(e.target.value)}>
              <option value="">选择已有标签</option>
              {availableTags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void attachTag(tagId)} disabled={!tagId}>
              添加
            </button>
          </div>
          <form
            className="td-inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void createAndAttachTag();
            }}
          >
            <input placeholder="新标签名称" value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} />
            <button type="submit" disabled={!tagDraft.trim()}>
              新建并添加
            </button>
          </form>
        </div>

        <div className="td-section">
          <div className="td-section-title">邮箱提醒</div>
          <ul className="td-reminder-list">
            {task.reminders.map((reminder) => (
              <li key={reminder.id}>
                <span>{isoToDateTimeLocal(reminder.remindAt).replace('T', ' ')}</span>
                <button type="button" onClick={() => void deleteReminder(reminder.id)}>
                  删除
                </button>
              </li>
            ))}
            {task.reminders.length === 0 && <li className="td-muted">暂无提醒</li>}
          </ul>
          <form
            className="td-inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void addReminder();
            }}
          >
            <input type="datetime-local" value={reminderDraft} onChange={(e) => setReminderDraft(e.target.value)} />
            <button type="submit" disabled={!reminderDraft}>
              添加提醒
            </button>
          </form>
        </div>

        <div className="td-section">
          <div className="td-section-title">附件</div>
          <ul className="td-reminder-list">
            {task.attachments.map((attachment) => (
              <li key={attachment.id}>
                <a href={`/api/attachments/${attachment.id}/download`} target="_blank" rel="noreferrer">
                  {attachment.fileName}
                </a>
                <span className="td-muted">{Math.ceil(attachment.sizeBytes / 1024)} KB</span>
              </li>
            ))}
            {task.attachments.length === 0 && <li className="td-muted">暂无附件</li>}
          </ul>
          <label className="td-file-upload">
            <input
              type="file"
              disabled={attachmentBusy}
              onChange={(e) => {
                void uploadAttachment(e.target.files?.[0] ?? null);
                e.currentTarget.value = '';
              }}
            />
            {attachmentBusy ? '上传中...' : '上传附件'}
          </label>
        </div>

        <textarea
          className="td-note"
          placeholder="备注…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => note !== (task.note ?? '') && void patch({ note: note || null })}
        />
        <div className="td-note-actions">
          <button type="button" onClick={() => void openAsStickyNote()}>
            打开为便签
          </button>
          {noteMessage && <span className="td-muted">{noteMessage}</span>}
        </div>

        {error && <div className="banner banner-error">⚠ {error}</div>}

        <div className="td-sub-head">
          <span>子任务 {task.subtaskTotal > 0 ? `${task.subtaskDone}/${task.subtaskTotal}` : ''}</span>
          <div className="td-sub-config">
            <button type="button" onClick={() => void generateAISubtasks()} disabled={aiBusy}>
              {aiBusy ? 'AI 拆解中...' : 'AI 拆解'}
            </button>
            <select
              title="进度计算方式"
              value={task.subtaskConfig.progressMode}
              onChange={(e) => void patch({ subtaskConfig: { progressMode: e.target.value as 'auto' | 'count' | 'estimate' } })}
            >
              <option value="auto">自动</option>
              <option value="count">按完成数</option>
              <option value="estimate">按预计耗时</option>
            </select>
            <label className="td-auto">
              <input
                type="checkbox"
                checked={task.subtaskConfig.autoCompleteParent}
                onChange={(e) => void patch({ subtaskConfig: { autoCompleteParent: e.target.checked } })}
              />
              全完成时自动完成父任务
            </label>
          </div>
        </div>

        {aiSuggestions.length > 0 && (
          <div className="td-ai-suggestions">
            <div className="td-ai-head">
              <span>AI 子任务建议</span>
              <button type="button" onClick={() => void applyAISuggestions()}>
                全部采用
              </button>
            </div>
            <ul>
              {aiSuggestions.map((item, index) => (
                <li key={`${item.title}-${index}`}>
                  <div>
                    <strong>{item.title}</strong>
                    <span className="td-muted">
                      {item.estimatedMinutes ? ` · ${item.estimatedMinutes} 分钟` : ''}{item.priority ? ` · P${item.priority}` : ''}
                    </span>
                    {item.note && <p>{item.note}</p>}
                  </div>
                  <button type="button" onClick={() => void applyAISuggestions([item])}>
                    采用
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {task.subtaskTotal > 0 && (
          <div className="td-progress">
            <div className="td-progress-bar" style={{ width: `${pct}%` }} />
            <span className="td-progress-pct">{pct}%</span>
          </div>
        )}

        <div className="td-section">
          <div className="td-section-title">检查项</div>
          {checklist.length > 0 && (
            <ul className="td-sub-list td-checklist-list">
              {checklist.map((item) => (
                <li key={item.id} className={`td-sub-item${item.completed ? ' is-completed' : ''}`}>
                  <button className="subtask-check" onClick={() => void toggleChecklistItem(item)}>
                    {item.completed ? '✓' : ''}
                  </button>
                  <input
                    className="td-sub-title"
                    defaultValue={item.title}
                    onBlur={(e) => void renameChecklistItem(item, e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  />
                  <button className="td-sub-promote" title="转为子任务" onClick={() => void convertChecklistItem(item)}>
                    ↗
                  </button>
                  <button className="td-sub-del" title="删除" onClick={() => void deleteChecklistItem(item)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="td-add"
            onSubmit={(e) => {
              e.preventDefault();
              void addChecklistItems(checklistDraft);
            }}
          >
            <input
              className="td-add-input"
              placeholder="+ 添加检查项，回车创建（支持多行粘贴）"
              value={checklistDraft}
              onChange={(e) => setChecklistDraft(e.target.value)}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text');
                if (text.includes('\n')) {
                  e.preventDefault();
                  void addChecklistItems(text);
                }
              }}
            />
          </form>
        </div>

        <ul className="td-sub-list">
          {subs.map((s) => (
            <li key={s.id} className={`td-sub-item${s.completed ? ' is-completed' : ''}`}>
              <button
                className="subtask-check"
                style={{ borderColor: PRIORITY_COLORS[s.priority], color: PRIORITY_COLORS[s.priority] }}
                onClick={() => void toggleSub(s)}
              >
                {s.completed ? '✓' : ''}
              </button>
              <input
                className="td-sub-title"
                defaultValue={s.title}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== s.title) void api.updateTask(s.id, { title: v }).then(reload);
                }}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
              <button className="td-sub-promote" title="升级为独立任务" onClick={() => void api.updateTask(s.id, { parentId: null }).then(reload)}>
                ↗
              </button>
              <button className="td-sub-del" title="删除" onClick={() => void api.deleteTask(s.id).then(reload)}>
                ✕
              </button>
            </li>
          ))}
        </ul>

        <form
          className="td-add"
          onSubmit={(e) => {
            e.preventDefault();
            void addSubtasks(draft);
          }}
        >
          <input
            className="td-add-input"
            placeholder="+ 添加子任务，回车创建（支持多行粘贴）"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text');
              if (text.includes('\n')) {
                e.preventDefault();
                void addSubtasks(text);
              }
            }}
          />
        </form>

        <div className="td-section">
          <div className="td-section-title">Activity</div>
          <ul className="td-activity-list">
            {activity.map((item) => (
              <li key={item.id} className="td-activity-item">
                <span>{item.summary}</span>
                <time>{new Date(item.createdAt).toLocaleString()}</time>
              </li>
            ))}
            {!activity.length && <li className="td-muted">No activity yet</li>}
          </ul>
        </div>
      </div>
    </>
  );
}
