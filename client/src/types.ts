// Mirror of the server DTOs (the API contract).
export type Priority = 0 | 1 | 2 | 3;

export interface List {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  isInbox: boolean;
  taskCount: number;
}

export interface Task {
  id: string;
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
  completedAt: string | null;
  deletedAt: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface SmartCounts {
  today: number;
  next7days: number;
  inbox: number;
  completed: number;
  trash: number;
}

export type SmartKey = 'today' | 'next7days' | 'inbox' | 'completed' | 'trash';

export type Selection = { kind: 'smart'; key: SmartKey } | { kind: 'list'; id: string };

export interface FocusSession {
  id: string;
  taskId: string | null;
  taskTitle: string | null;
  mode: 'pomodoro' | 'countup';
  startedAt: string;
  endedAt: string;
  durationSec: number;
  isPomodoro: boolean;
  note: string | null;
  createdAt: string;
}

export interface FocusStats {
  todayCount: number;
  todayDurationSec: number;
  totalCount: number;
  totalDurationSec: number;
}

export interface Habit {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  daysOfWeek: number[];
  note: string | null;
  sortOrder: number;
  archived: boolean;
  checkins: string[];
  currentStreak: number;
  bestStreak: number;
  createdAt: string;
  updatedAt: string;
}

export interface Countdown {
  id: string;
  title: string;
  targetDate: string;
  icon: string | null;
  color: string | null;
  repeatYearly: boolean;
  pinned: boolean;
  note: string | null;
  sortOrder: number;
  effectiveDate: string;
  daysRemaining: number;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  appearance: {
    themeMode: 'light' | 'dark' | 'system';
    accent: string;
    fontSize: 'small' | 'normal' | 'large' | 'xlarge';
    density: 'compact' | 'standard' | 'loose';
    animations: boolean;
  };
  datetime: { weekStart: 0 | 1; timeFormat: 'system' | '12' | '24' };
  modules: { hidden: string[]; defaultLaunch: string };
  smartLists: { hidden: string[] };
  taskDefaults: { priority: 0 | 1 | 2 | 3; listId: string | null };
  ai: { enabled: boolean; provider: string; baseUrl: string; model: string; hasApiKey: boolean; apiKeyMasked: string };
}

export type SettingsPatch = {
  appearance?: Partial<Settings['appearance']>;
  datetime?: Partial<Settings['datetime']>;
  modules?: Partial<Settings['modules']>;
  smartLists?: Partial<Settings['smartLists']>;
  taskDefaults?: Partial<Settings['taskDefaults']>;
  ai?: Partial<Settings['ai']> & { apiKey?: string };
};
