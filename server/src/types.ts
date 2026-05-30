// Shared DTO types (API response shapes) and error type.

export type Priority = 0 | 1 | 2 | 3; // 0 none, 1 low, 2 medium, 3 high

export interface ListDTO {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  isInbox: boolean;
  taskCount: number; // active (incomplete, not deleted) tasks in this list
}

export interface TaskDTO {
  id: string;
  title: string;
  note: string | null;
  listId: string | null;
  priority: Priority;
  dueDate: string | null; // ISO8601 (UTC) — for a timed block this is the END
  startDate: string | null; // ISO8601 (UTC) — block START; null for all-day/undated
  isAllDay: boolean;
  isImportant: boolean | null; // four-quadrant dimension; null = unclassified
  isUrgent: boolean | null; // four-quadrant dimension; null = unclassified
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

export interface FocusSessionDTO {
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

export interface HabitDTO {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  daysOfWeek: number[]; // 0=Sun .. 6=Sat
  note: string | null;
  sortOrder: number;
  archived: boolean;
  checkins: string[]; // checked dates (YYYY-MM-DD) within the queried range
  currentStreak: number;
  bestStreak: number;
  createdAt: string;
  updatedAt: string;
}

export interface CountdownDTO {
  id: string;
  title: string;
  targetDate: string; // 'YYYY-MM-DD'
  icon: string | null;
  color: string | null;
  repeatYearly: boolean;
  pinned: boolean;
  note: string | null;
  sortOrder: number;
  effectiveDate: string; // next occurrence (== targetDate when not repeating)
  daysRemaining: number; // signed: >0 future, 0 today, <0 past
  createdAt: string;
  updatedAt: string;
}

/** Error that maps to a specific HTTP status + machine code. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
