// Real HTTP client. Every call hits a real backend route. On failure it throws —
// the UI surfaces the error instead of showing fabricated data.
import type { List, Task, SmartCounts, Priority, FocusSession, FocusStats, Habit, Countdown } from '../types';

const BASE = '/api';

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface CreateTaskInput {
  title: string;
  listId?: string | null;
  priority?: Priority;
  dueDate?: string | null;
  startDate?: string | null;
  isAllDay?: boolean;
  isImportant?: boolean | null;
  isUrgent?: boolean | null;
  note?: string | null;
}

export type UpdateTaskInput = Partial<{
  title: string;
  note: string | null;
  listId: string | null;
  priority: Priority;
  dueDate: string | null;
  startDate: string | null;
  isAllDay: boolean;
  isImportant: boolean | null;
  isUrgent: boolean | null;
  completed: boolean;
  sortOrder: number;
}>;

export interface CreateFocusInput {
  taskId?: string | null;
  mode: 'pomodoro' | 'countup';
  startedAt: string;
  endedAt: string;
  durationSec: number;
  isPomodoro: boolean;
  note?: string | null;
}

export const api = {
  // lists
  listLists: () => req<{ lists: List[] }>('/lists').then((r) => r.lists),
  createList: (name: string) =>
    req<{ list: List }>('/lists', { method: 'POST', body: JSON.stringify({ name }) }).then((r) => r.list),
  updateList: (id: string, patch: Partial<Pick<List, 'name' | 'color' | 'icon' | 'sortOrder'>>) =>
    req<{ list: List }>(`/lists/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.list),
  deleteList: (id: string) => req<void>(`/lists/${id}`, { method: 'DELETE' }),

  // smart counts
  smartCounts: () => req<{ counts: SmartCounts }>('/smart-lists').then((r) => r.counts),

  // tasks
  getTasks: (query: string) => req<{ tasks: Task[] }>(`/tasks?${query}`).then((r) => r.tasks),
  getTasksRange: (fromISO: string, toISO: string) =>
    req<{ tasks: Task[] }>(
      `/tasks?from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}`,
    ).then((r) => r.tasks),
  getUndated: () => req<{ tasks: Task[] }>('/tasks?view=undated').then((r) => r.tasks),
  getMatrixTasks: () => req<{ tasks: Task[] }>('/tasks?view=matrix').then((r) => r.tasks),
  getUnclassifiedTasks: () => req<{ tasks: Task[] }>('/tasks?view=unclassified').then((r) => r.tasks),
  createTask: (input: CreateTaskInput) =>
    req<{ task: Task }>('/tasks', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.task),
  updateTask: (id: string, patch: UpdateTaskInput) =>
    req<{ task: Task }>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.task),
  deleteTask: (id: string) => req<void>(`/tasks/${id}`, { method: 'DELETE' }),
  restoreTask: (id: string) => req<{ task: Task }>(`/tasks/${id}/restore`, { method: 'POST' }).then((r) => r.task),
  purgeTask: (id: string) => req<void>(`/tasks/${id}?permanent=1`, { method: 'DELETE' }),

  // focus (pomodoro)
  getActiveTasks: () => req<{ tasks: Task[] }>('/tasks?view=active').then((r) => r.tasks),
  listFocusSessions: (limit = 100) =>
    req<{ sessions: FocusSession[] }>(`/focus/sessions?limit=${limit}`).then((r) => r.sessions),
  createFocusSession: (input: CreateFocusInput) =>
    req<{ session: FocusSession }>('/focus/sessions', { method: 'POST', body: JSON.stringify(input) }).then(
      (r) => r.session,
    ),
  deleteFocusSession: (id: string) => req<void>(`/focus/sessions/${id}`, { method: 'DELETE' }),
  focusStats: () => req<{ stats: FocusStats }>('/focus/stats').then((r) => r.stats),

  // habits
  listHabits: (from: string, to: string) =>
    req<{ habits: Habit[] }>(`/habits?from=${from}&to=${to}`).then((r) => r.habits),
  createHabit: (input: { name: string; icon?: string | null; color?: string | null; daysOfWeek?: number[]; note?: string | null }) =>
    req<{ habit: Habit }>('/habits', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.habit),
  deleteHabit: (id: string) => req<void>(`/habits/${id}`, { method: 'DELETE' }),
  toggleHabit: (id: string, date: string) =>
    req<{ checked: boolean; currentStreak: number; bestStreak: number }>(`/habits/${id}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ date }),
    }),

  // countdowns
  listCountdowns: () => req<{ countdowns: Countdown[] }>('/countdowns').then((r) => r.countdowns),
  createCountdown: (input: {
    title: string;
    targetDate: string;
    icon?: string | null;
    color?: string | null;
    repeatYearly?: boolean;
    pinned?: boolean;
    note?: string | null;
  }) => req<{ countdown: Countdown }>('/countdowns', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.countdown),
  updateCountdown: (
    id: string,
    patch: Partial<{ title: string; targetDate: string; icon: string | null; repeatYearly: boolean; pinned: boolean; note: string | null; sortOrder: number }>,
  ) => req<{ countdown: Countdown }>(`/countdowns/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.countdown),
  deleteCountdown: (id: string) => req<void>(`/countdowns/${id}`, { method: 'DELETE' }),
};
