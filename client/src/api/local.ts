// Browser-storage implementation of the API (for the static GitHub Pages build).
// Real persistence via localStorage — NOT mock data. Mirrors the server's logic.
import type { List, Task, SmartCounts, FocusSession, FocusStats, Habit, Countdown, Settings } from '../types';
import type { CreateTaskInput, UpdateTaskInput, CreateFocusInput } from './client';

const P = 'el.';
function load<T>(key: string, def: T): T {
  try {
    const r = localStorage.getItem(P + key);
    return r ? (JSON.parse(r) as T) : def;
  } catch {
    return def;
  }
}
function save(key: string, val: unknown): void {
  localStorage.setItem(P + key, JSON.stringify(val));
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now());
const now = () => new Date().toISOString();
const ok = <T>(v: T) => Promise.resolve(v);

// ---------- date helpers (match server) ----------
function startOfTodayISO() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); }
function endOfTodayISO() { const d = new Date(); d.setHours(23, 59, 59, 999); return d.toISOString(); }
function endOfDayOffsetISO(n: number) { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(23, 59, 59, 999); return d.toISOString(); }
function pad(n: number) { return String(n).padStart(2, '0'); }
function dStr(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayStr() { return dStr(new Date()); }
function parseDate(s: string) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDaysStr(s: string, n: number) { const d = parseDate(s); d.setDate(d.getDate() + n); return dStr(d); }
function dow(s: string) { return parseDate(s).getDay(); }

// ---------- tables ----------
type LRec = Omit<List, 'taskCount'>;
const getLists = () => load<LRec[]>('lists', []);
const getTasks = () => load<Task[]>('tasks', []);
const getFocus = () => load<FocusSession[]>('focus', []);
type HRec = Omit<Habit, 'checkins' | 'currentStreak' | 'bestStreak'>;
const getHabits = () => load<HRec[]>('habits', []);
type Ck = { id: string; habitId: string; date: string };
const getCheckins = () => load<Ck[]>('checkins', []);
type CdRec = Omit<Countdown, 'effectiveDate' | 'daysRemaining'>;
const getCds = () => load<CdRec[]>('countdowns', []);

function inbox(): LRec {
  const ls = getLists();
  let ib = ls.find((l) => l.isInbox);
  if (!ib) {
    ib = { id: uid(), name: '收集箱', color: null, icon: 'inbox', sortOrder: -1, isInbox: true };
    save('lists', [ib, ...ls]);
  }
  return ib;
}
const taskCount = (listId: string) => getTasks().filter((t) => t.listId === listId && !t.completed && !t.deletedAt).length;

// ---------- comparators ----------
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byPrioCreated = (a: Task, b: Task) => b.priority - a.priority || -cmpStr(a.createdAt, b.createdAt);
const byDue = (a: Task, b: Task) => cmpStr(a.dueDate ?? '', b.dueDate ?? '') || b.priority - a.priority;

function queryTasks(opts: { view?: string; listId?: string; from?: string; to?: string }): Task[] {
  const all = getTasks();
  const ib = inbox();
  if (opts.from && opts.to) {
    const f = opts.from, t = opts.to;
    return all
      .filter((x) => !x.deletedAt && ((x.startDate && x.startDate <= t && (x.dueDate ?? '') >= f) || (!x.startDate && x.dueDate && x.dueDate >= f && x.dueDate <= t)))
      .sort((a, b) => cmpStr(a.startDate ?? a.dueDate ?? '', b.startDate ?? b.dueDate ?? ''));
  }
  const v = opts.view;
  if (v === 'inbox') return all.filter((x) => x.listId === ib.id && !x.completed && !x.deletedAt).sort(byPrioCreated);
  if (v === 'active') return all.filter((x) => !x.completed && !x.deletedAt).sort(byPrioCreated);
  if (v === 'today') return all.filter((x) => !x.completed && !x.deletedAt && x.dueDate && x.dueDate <= endOfTodayISO()).sort(byDue);
  if (v === 'next7days') return all.filter((x) => !x.completed && !x.deletedAt && x.dueDate && x.dueDate >= startOfTodayISO() && x.dueDate <= endOfDayOffsetISO(6)).sort(byDue);
  if (v === 'completed') return all.filter((x) => x.completed && !x.deletedAt).sort((a, b) => -cmpStr(a.completedAt ?? '', b.completedAt ?? ''));
  if (v === 'trash') return all.filter((x) => !!x.deletedAt).sort((a, b) => -cmpStr(a.deletedAt ?? '', b.deletedAt ?? ''));
  if (v === 'undated') return all.filter((x) => !x.dueDate && !x.completed && !x.deletedAt).sort(byPrioCreated);
  if (v === 'matrix') return all.filter((x) => !x.deletedAt && x.isImportant != null && x.isUrgent != null).sort((a, b) => Number(a.completed) - Number(b.completed) || byPrioCreated(a, b));
  if (v === 'unclassified') return all.filter((x) => !x.completed && !x.deletedAt && (x.isImportant == null || x.isUrgent == null)).sort(byPrioCreated);
  if (opts.listId) return all.filter((x) => x.listId === opts.listId && !x.completed && !x.deletedAt).sort(byPrioCreated);
  return [];
}

function countWhere(fn: (t: Task) => boolean) { return getTasks().filter(fn).length; }

// ---------- streaks (match server) ----------
function streaks(checked: Set<string>, days: number[]) {
  const sched = (s: string) => days.includes(dow(s));
  const today = todayStr();
  let cur = 0, d = today;
  if (sched(d) && !checked.has(d)) d = addDaysStr(d, -1);
  for (let g = 0; g < 3000; g++) {
    if (!sched(d)) { d = addDaysStr(d, -1); continue; }
    if (checked.has(d)) { cur++; d = addDaysStr(d, -1); } else break;
  }
  let best = 0;
  if (checked.size) {
    const arr = [...checked].sort();
    let c = arr[0], run = 0;
    for (let g = 0; c <= today && g < 6000; g++) {
      if (sched(c)) { if (checked.has(c)) { run++; if (run > best) best = run; } else run = 0; }
      c = addDaysStr(c, 1);
    }
  }
  return { current: cur, best };
}

// ---------- countdown compute (match server) ----------
function cdCompute(target: string, repeat: boolean) {
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  let eff = parseDate(target);
  if (repeat) {
    const t = parseDate(target);
    eff = new Date(t0.getFullYear(), t.getMonth(), t.getDate());
    if (eff.getTime() < t0.getTime()) eff = new Date(t0.getFullYear() + 1, t.getMonth(), t.getDate());
  }
  return { effectiveDate: dStr(eff), daysRemaining: Math.round((eff.getTime() - t0.getTime()) / 86400000) };
}

// ---------- settings ----------
const DEFAULTS: Settings = {
  appearance: { themeMode: 'system', accent: '#c96442', fontSize: 'normal', density: 'standard', animations: true },
  datetime: { weekStart: 1, timeFormat: 'system' },
  modules: { hidden: [], defaultLaunch: 'tasks' },
  smartLists: { hidden: [] },
  taskDefaults: { priority: 0, listId: null },
  ai: { enabled: false, provider: '', baseUrl: '', model: '', hasApiKey: false, apiKeyMasked: '' },
};
const GROUPS = ['appearance', 'datetime', 'modules', 'smartLists', 'taskDefaults'] as const;
function readSettings(): Settings {
  const stored = load<Record<string, any>>('settings', {});
  const out: Settings = JSON.parse(JSON.stringify(DEFAULTS));
  for (const g of GROUPS) Object.assign((out as any)[g], stored[g] ?? {});
  Object.assign(out.ai, stored.ai ?? {});
  const key = load<string>('aiKey', '');
  if (key) { out.ai.hasApiKey = true; out.ai.apiKeyMasked = key.length <= 4 ? '••••' : '••••' + key.slice(-4); }
  delete (out.ai as any).apiKey;
  return out;
}

// ---------- first-run demo seed (real records, like fresh-app onboarding) ----------
function seedIfEmpty() {
  if (load('seeded', '') === '1') return;
  save('seeded', '1');
  const ib = inbox();
  const ts = now();
  const today = startOfTodayISO();
  const work: LRec = { id: uid(), name: '工作', color: '#c96442', icon: null, sortOrder: 1, isInbox: false };
  save('lists', [...getLists(), work]);
  const mk = (o: Partial<Task>): Task => ({ id: uid(), title: '', note: null, listId: ib.id, priority: 0, dueDate: null, startDate: null, isAllDay: true, isImportant: null, isUrgent: null, completed: false, completedAt: null, deletedAt: null, sortOrder: 0, createdAt: ts, updatedAt: ts, ...o } as Task);
  save('tasks', [
    mk({ title: '体验「效率清单」各个模块', dueDate: today, priority: 3 }),
    mk({ title: '把这条拖到日历上排期', listId: work.id, priority: 2 }),
    mk({ title: '在四象限里给任务分重要/紧急', dueDate: today, isImportant: true, isUrgent: true }),
    mk({ title: '完善 PRD', listId: work.id }),
    mk({ title: '读一篇文章' }),
  ]);
  const h: HRec = { id: uid(), name: '每天阅读 30 分钟', icon: '📖', color: '#c96442', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], note: null, sortOrder: 0, archived: false, createdAt: ts, updatedAt: ts };
  save('habits', [h]);
  save('checkins', [
    { id: uid(), habitId: h.id, date: todayStr() },
    { id: uid(), habitId: h.id, date: addDaysStr(todayStr(), -1) },
  ]);
  const cd = (o: Partial<CdRec>): CdRec => ({ id: uid(), title: '', targetDate: todayStr(), icon: null, color: null, repeatYearly: false, pinned: false, note: null, sortOrder: 0, createdAt: ts, updatedAt: ts, ...o } as CdRec);
  save('countdowns', [
    cd({ title: '新版本发布', targetDate: addDaysStr(todayStr(), 30).slice(0, 10), icon: '🚀' }),
    cd({ title: '我的生日', targetDate: '2000-08-08', repeatYearly: true, icon: '🎂' }),
  ]);
}
if (import.meta.env.VITE_API === 'local') seedIfEmpty();

// ---------- the API (mirrors api/client.ts shape) ----------
export const localApi = {
  // lists
  listLists: () => ok(getLists().filter((l) => !l.isInbox).sort((a, b) => a.sortOrder - b.sortOrder).map((l) => ({ ...l, taskCount: taskCount(l.id) }) as List)),
  createList: (name: string) => {
    const ls = getLists();
    const max = Math.max(0, ...ls.filter((l) => !l.isInbox).map((l) => l.sortOrder));
    const l: LRec = { id: uid(), name, color: null, icon: null, sortOrder: max + 1, isInbox: false };
    save('lists', [...ls, l]);
    return ok({ ...l, taskCount: 0 } as List);
  },
  updateList: (id: string, patch: Partial<Pick<List, 'name' | 'color' | 'icon' | 'sortOrder'>>) => {
    const ls = getLists().map((l) => (l.id === id && !l.isInbox ? { ...l, ...patch } : l));
    save('lists', ls);
    const l = ls.find((x) => x.id === id)!;
    return ok({ ...l, taskCount: taskCount(id) } as List);
  },
  deleteList: (id: string) => {
    const ib = inbox();
    save('tasks', getTasks().map((t) => (t.listId === id ? { ...t, listId: ib.id, updatedAt: now() } : t)));
    save('lists', getLists().filter((l) => l.id !== id));
    return ok(undefined as void);
  },
  smartCounts: (): Promise<SmartCounts> => {
    const ib = inbox();
    return ok({
      inbox: countWhere((t) => t.listId === ib.id && !t.completed && !t.deletedAt),
      today: countWhere((t) => !t.completed && !t.deletedAt && !!t.dueDate && t.dueDate <= endOfTodayISO()),
      next7days: countWhere((t) => !t.completed && !t.deletedAt && !!t.dueDate && t.dueDate >= startOfTodayISO() && t.dueDate <= endOfDayOffsetISO(6)),
      completed: countWhere((t) => t.completed && !t.deletedAt),
      trash: countWhere((t) => !!t.deletedAt),
    });
  },

  // tasks
  getTasks: (query: string) => { const q = new URLSearchParams(query); return ok(queryTasks({ view: q.get('view') ?? undefined, listId: q.get('listId') ?? undefined })); },
  getTasksRange: (from: string, to: string) => ok(queryTasks({ from, to })),
  getUndated: () => ok(queryTasks({ view: 'undated' })),
  getMatrixTasks: () => ok(queryTasks({ view: 'matrix' })),
  getUnclassifiedTasks: () => ok(queryTasks({ view: 'unclassified' })),
  getActiveTasks: () => ok(queryTasks({ view: 'active' })),
  createTask: (input: CreateTaskInput) => {
    const ts = now();
    const t: Task = {
      id: uid(), title: input.title, note: input.note ?? null, listId: input.listId ?? inbox().id,
      priority: (input.priority ?? 0) as Task['priority'], dueDate: input.dueDate ?? null, startDate: input.startDate ?? null,
      isAllDay: input.isAllDay ?? true, isImportant: input.isImportant ?? null, isUrgent: input.isUrgent ?? null,
      completed: false, completedAt: null, deletedAt: null, sortOrder: 0, createdAt: ts, updatedAt: ts,
    };
    save('tasks', [...getTasks(), t]);
    return ok(t);
  },
  updateTask: (id: string, patch: UpdateTaskInput) => {
    const all = getTasks();
    const cur = all.find((t) => t.id === id);
    if (!cur) return Promise.reject(new Error('task not found'));
    const next: Task = { ...cur, ...patch, updatedAt: now() } as Task;
    if ('completed' in patch) next.completedAt = patch.completed ? now() : null;
    if (next.startDate && next.dueDate && next.startDate > next.dueDate) return Promise.reject(new Error('startDate must be on or before dueDate'));
    save('tasks', all.map((t) => (t.id === id ? next : t)));
    return ok(next);
  },
  deleteTask: (id: string) => { save('tasks', getTasks().map((t) => (t.id === id ? { ...t, deletedAt: now(), updatedAt: now() } : t))); return ok(undefined as void); },
  restoreTask: (id: string) => { const all = getTasks().map((t) => (t.id === id ? { ...t, deletedAt: null, updatedAt: now() } : t)); save('tasks', all); return ok(all.find((t) => t.id === id)!); },
  purgeTask: (id: string) => { save('tasks', getTasks().filter((t) => t.id !== id)); return ok(undefined as void); },

  // focus
  listFocusSessions: (limit = 100) => {
    const tasks = getTasks();
    return ok(getFocus().sort((a, b) => -cmpStr(a.endedAt, b.endedAt)).slice(0, limit).map((s) => ({ ...s, taskTitle: s.taskId ? tasks.find((t) => t.id === s.taskId)?.title ?? null : null })));
  },
  createFocusSession: (input: CreateFocusInput) => {
    const s: FocusSession = { id: uid(), taskId: input.taskId ?? null, taskTitle: null, mode: input.mode, startedAt: input.startedAt, endedAt: input.endedAt, durationSec: Math.round(input.durationSec), isPomodoro: !!input.isPomodoro, note: input.note ?? null, createdAt: now() };
    save('focus', [...getFocus(), s]);
    return ok(s);
  },
  deleteFocusSession: (id: string) => { save('focus', getFocus().filter((s) => s.id !== id)); return ok(undefined as void); },
  focusStats: (): Promise<FocusStats> => {
    const f = getFocus(); const t0 = startOfTodayISO(), t1 = endOfTodayISO();
    const todayS = f.filter((s) => s.endedAt >= t0 && s.endedAt <= t1);
    return ok({
      todayCount: todayS.filter((s) => s.isPomodoro).length,
      todayDurationSec: todayS.reduce((a, s) => a + s.durationSec, 0),
      totalCount: f.filter((s) => s.isPomodoro).length,
      totalDurationSec: f.reduce((a, s) => a + s.durationSec, 0),
    });
  },

  // habits
  listHabits: (from: string, to: string) => {
    const cks = getCheckins();
    return ok(getHabits().filter((h) => !h.archived).sort((a, b) => a.sortOrder - b.sortOrder).map((h) => {
      const dates = cks.filter((c) => c.habitId === h.id).map((c) => c.date);
      const st = streaks(new Set(dates), h.daysOfWeek);
      return { ...h, checkins: dates.filter((d) => d >= from && d <= to), currentStreak: st.current, bestStreak: st.best } as Habit;
    }));
  },
  createHabit: (input: { name: string; icon?: string | null; color?: string | null; daysOfWeek?: number[]; note?: string | null }) => {
    const ts = now();
    const hs = getHabits();
    const max = Math.max(0, ...hs.map((h) => h.sortOrder));
    const h: HRec = { id: uid(), name: input.name, icon: input.icon ?? null, color: input.color ?? null, daysOfWeek: input.daysOfWeek?.length ? input.daysOfWeek : [0, 1, 2, 3, 4, 5, 6], note: input.note ?? null, sortOrder: max + 1, archived: false, createdAt: ts, updatedAt: ts };
    save('habits', [...hs, h]);
    return ok({ ...h, checkins: [], currentStreak: 0, bestStreak: 0 } as Habit);
  },
  deleteHabit: (id: string) => { save('habits', getHabits().filter((h) => h.id !== id)); save('checkins', getCheckins().filter((c) => c.habitId !== id)); return ok(undefined as void); },
  toggleHabit: (id: string, date: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Promise.reject(new Error('date must be YYYY-MM-DD'));
    if (date > todayStr()) return Promise.reject(new Error('cannot check in for a future date'));
    const h = getHabits().find((x) => x.id === id);
    if (!h) return Promise.reject(new Error('habit not found'));
    let cks = getCheckins();
    const existing = cks.find((c) => c.habitId === id && c.date === date);
    let checked: boolean;
    if (existing) { cks = cks.filter((c) => c !== existing); checked = false; } else { cks = [...cks, { id: uid(), habitId: id, date }]; checked = true; }
    save('checkins', cks);
    const st = streaks(new Set(cks.filter((c) => c.habitId === id).map((c) => c.date)), h.daysOfWeek);
    return ok({ checked, currentStreak: st.current, bestStreak: st.best });
  },

  // countdowns
  listCountdowns: () => {
    const list = getCds().map((c) => ({ ...c, ...cdCompute(c.targetDate, c.repeatYearly) }) as Countdown);
    list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const au = a.daysRemaining >= 0, bu = b.daysRemaining >= 0;
      if (au !== bu) return au ? -1 : 1;
      return au ? a.daysRemaining - b.daysRemaining : b.daysRemaining - a.daysRemaining;
    });
    return ok(list);
  },
  createCountdown: (input: { title: string; targetDate: string; icon?: string | null; color?: string | null; repeatYearly?: boolean; pinned?: boolean; note?: string | null }) => {
    const ts = now();
    const cds = getCds();
    const max = Math.max(0, ...cds.map((c) => c.sortOrder));
    const c: CdRec = { id: uid(), title: input.title, targetDate: input.targetDate, icon: input.icon ?? null, color: input.color ?? null, repeatYearly: !!input.repeatYearly, pinned: !!input.pinned, note: input.note ?? null, sortOrder: max + 1, createdAt: ts, updatedAt: ts };
    save('countdowns', [...cds, c]);
    return ok({ ...c, ...cdCompute(c.targetDate, c.repeatYearly) } as Countdown);
  },
  updateCountdown: (id: string, patch: Record<string, unknown>) => {
    const cds = getCds().map((c) => (c.id === id ? { ...c, ...patch, updatedAt: now() } : c));
    save('countdowns', cds);
    const c = cds.find((x) => x.id === id)!;
    return ok({ ...c, ...cdCompute(c.targetDate, c.repeatYearly) } as Countdown);
  },
  deleteCountdown: (id: string) => { save('countdowns', getCds().filter((c) => c.id !== id)); return ok(undefined as void); },

  // settings
  getSettings: () => ok(readSettings()),
  patchSettings: (patch: Record<string, any>) => {
    const stored = load<Record<string, any>>('settings', {});
    for (const g of GROUPS) if (patch[g]) stored[g] = { ...(stored[g] ?? {}), ...patch[g] };
    if (patch.ai) { const { apiKey, ...rest } = patch.ai; stored.ai = { ...(stored.ai ?? {}), ...rest }; if (typeof apiKey === 'string') { if (apiKey === '') localStorage.removeItem(P + 'aiKey'); else save('aiKey', apiKey); } }
    save('settings', stored);
    return ok(readSettings());
  },
  resetSettings: (group: string) => {
    const stored = load<Record<string, any>>('settings', {});
    delete stored[group];
    if (group === 'ai') localStorage.removeItem(P + 'aiKey');
    save('settings', stored);
    return ok(readSettings());
  },
  aiTest: async () => {
    const s = readSettings().ai; const key = load<string>('aiKey', '');
    if (!s.baseUrl) return { ok: false, message: '未配置 Base URL' };
    if (!key) return { ok: false, message: '未配置 API Key' };
    try {
      const r = await fetch(s.baseUrl.replace(/\/$/, '') + '/models', { headers: { Authorization: `Bearer ${key}` } });
      return { ok: r.ok, message: r.ok ? `连接成功（HTTP ${r.status}）` : `连接失败：HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, message: '连接失败（静态站点常因跨域被拦截）：' + (e instanceof Error ? e.message : String(e)) };
    }
  },
  exportData: () => ok({
    exportedAt: now(), version: 1,
    lists: getLists(), tasks: getTasks(), focusSessions: getFocus(), habits: getHabits(), habitCheckins: getCheckins(), countdowns: getCds(), settings: readSettings(),
  }),
};
