import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { aiConfigurationIssue } from '../aiGuide';
import { useSettings } from '../settings';
import { dateInputToISO, isoToDateInput } from '../util';
import type { AIScheduleResult, AIScheduleSuggestion, Goal, Task } from '../types';

export default function GoalModule() {
  const { settings } = useSettings();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState('');
  const [deadline, setDeadline] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskEstimate, setTaskEstimate] = useState('60');
  const [parentId, setParentId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [aiSchedule, setAiSchedule] = useState<AIScheduleResult | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  const selected = goals.find((g) => g.id === selectedId) ?? null;

  const loadGoals = useCallback(async () => {
    const list = await api.listGoals();
    setGoals(list);
    setSelectedId((cur) => cur || list[0]?.id || '');
  }, []);

  const loadTree = useCallback(async () => {
    if (!selectedId) {
      setTasks([]);
      return;
    }
    const tree = await api.getGoalTree(selectedId);
    setTasks(tree.tasks);
  }, [selectedId]);

  const reload = useCallback(async () => {
    try {
      await loadGoals();
      await loadTree();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [loadGoals, loadTree]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    setAiSchedule(null);
  }, [selectedId]);

  async function mutate(fn: () => Promise<unknown>) {
    try {
      await fn();
      await reload();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function createGoal(e: React.FormEvent) {
    e.preventDefault();
    const name = title.trim();
    if (!name) return;
    await mutate(async () => {
      const goal = await api.createGoal({
        title: name,
        deadlineAt: dateInputToISO(deadline),
        availableTimeRule: JSON.stringify({ startHour: 9, endHour: 18 }),
      });
      setSelectedId(goal.id);
      setTitle('');
      setDeadline('');
    });
  }

  async function createTask(e: React.FormEvent) {
    e.preventDefault();
    const name = taskTitle.trim();
    if (!selectedId || !name) return;
    await mutate(async () => {
      await api.createGoalTask(selectedId, {
        title: name,
        parentId: parentId || null,
        estimatedMinutes: taskEstimate ? Number(taskEstimate) : null,
      });
      setTaskTitle('');
      setParentId('');
    });
  }

  async function suggestAiSchedule() {
    if (!selected) return;
    const issue = aiConfigurationIssue(settings.ai, 'AI 排期');
    if (issue) {
      setError(issue);
      return;
    }
    setAiBusy(true);
    try {
      const result = await api.aiScheduleSuggestion({
        goalId: selected.id,
        from: selected.startAt,
        to: selected.deadlineAt,
      });
      setAiSchedule(result);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAiBusy(false);
    }
  }

  function schedulePatch(item: AIScheduleSuggestion) {
    return {
      plannedStartAt: item.plannedStartAt,
      plannedEndAt: item.plannedEndAt,
      startDate: item.plannedStartAt,
      dueDate: item.plannedEndAt,
      isAllDay: false,
    };
  }

  async function applyScheduleItem(item: AIScheduleSuggestion) {
    await mutate(async () => {
      await api.updateTask(item.taskId, schedulePatch(item));
      setAiSchedule((cur) =>
        cur ? { ...cur, suggestions: cur.suggestions.filter((suggestion) => suggestion.taskId !== item.taskId) } : cur,
      );
    });
  }

  async function applyAllSchedule() {
    if (!aiSchedule) return;
    await mutate(async () => {
      for (const item of aiSchedule.suggestions) {
        await api.updateTask(item.taskId, schedulePatch(item));
      }
      setAiSchedule(null);
    });
  }

  return (
    <main className="goal-main">
      <aside className="goal-list">
        <div className="goal-list-head">目标</div>
        <form className="goal-create" onSubmit={(e) => void createGoal(e)}>
          <input placeholder="新目标" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          <button type="submit" disabled={!title.trim()}>
            创建
          </button>
        </form>
        <div className="goal-items">
          {goals.map((goal) => (
            <button key={goal.id} className={`goal-item${goal.id === selectedId ? ' active' : ''}`} onClick={() => setSelectedId(goal.id)}>
              <span>{goal.title}</span>
              <small>{goal.deadlineAt ? isoToDateInput(goal.deadlineAt) : '无截止'}</small>
            </button>
          ))}
          {goals.length === 0 && <div className="goal-empty">还没有目标</div>}
        </div>
      </aside>

      <section className="goal-detail">
        <header className="goal-head">
          <div>
            <h1>{selected?.title ?? '选择或创建目标'}</h1>
            {selected?.deadlineAt && <p>截止 {isoToDateInput(selected.deadlineAt)}</p>}
          </div>
          {selected && (
            <div className="goal-actions">
              <button className="goal-primary" onClick={() => void mutate(() => api.autoScheduleGoal(selected.id))}>
                自动排期
              </button>
              <button className="goal-secondary" onClick={() => void suggestAiSchedule()} disabled={aiBusy}>
                {aiBusy ? '生成中' : 'AI 排期建议'}
              </button>
            </div>
          )}
        </header>

        {error && <div className="banner banner-error">⚠ {error}</div>}

        {selected && (
          <>
            <form className="goal-task-form" onSubmit={(e) => void createTask(e)}>
              <input placeholder="拆一个可执行任务" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
              <input type="number" min="15" step="15" value={taskEstimate} onChange={(e) => setTaskEstimate(e.target.value)} />
              <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">作为顶层任务</option>
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {'—'.repeat(Math.max(0, task.level - 1))} {task.title}
                  </option>
                ))}
              </select>
              <button type="submit" disabled={!taskTitle.trim()}>
                添加
              </button>
            </form>

            {aiSchedule && (
              <section className="goal-ai-schedule">
                <div className="goal-ai-head">
                  <div>
                    <strong>AI 排期建议</strong>
                    <span>
                      {new Date(aiSchedule.range.from).toLocaleDateString()} - {new Date(aiSchedule.range.to).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="goal-ai-actions">
                    <button onClick={() => void applyAllSchedule()} disabled={aiSchedule.suggestions.length === 0}>
                      全部采纳
                    </button>
                    <button onClick={() => setAiSchedule(null)}>关闭</button>
                  </div>
                </div>
                <ul>
                  {aiSchedule.suggestions.map((item) => {
                    const label = tasks.find((task) => task.id === item.taskId)?.title ?? item.title;
                    return (
                      <li key={item.taskId}>
                        <div>
                          <span>{label}</span>
                          <small>
                            {new Date(item.plannedStartAt).toLocaleString()} - {new Date(item.plannedEndAt).toLocaleTimeString()}
                          </small>
                          {item.reason && <p>{item.reason}</p>}
                        </div>
                        <button onClick={() => void applyScheduleItem(item)}>采纳</button>
                      </li>
                    );
                  })}
                  {aiSchedule.suggestions.length === 0 && <li className="goal-empty">建议已全部采纳</li>}
                </ul>
              </section>
            )}

            <ul className="goal-task-list">
              {tasks.map((task) => (
                <li key={task.id} className="goal-task" style={{ paddingLeft: 12 + (task.level - 1) * 20 }}>
                  <span>{task.title}</span>
                  <small>
                    {task.plannedStartAt && task.plannedEndAt
                      ? `${new Date(task.plannedStartAt).toLocaleString()} - ${new Date(task.plannedEndAt).toLocaleTimeString()}`
                      : `${task.estimatedMinutes ?? 60} 分钟`}
                  </small>
                </li>
              ))}
              {tasks.length === 0 && <li className="goal-empty">把目标拆成任务后，可以一键排进日历。</li>}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
