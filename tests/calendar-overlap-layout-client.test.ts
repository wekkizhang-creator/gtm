import type { Task } from '../client/src/types';
import { taskSegmentsForDay } from '../client/src/components/calendar/eventLayout';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function iso(year: number, month: number, day: number, hour: number, minute: number): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

function task(id: string, title: string, startDate: string, dueDate: string): Task {
  return {
    id,
    title,
    note: null,
    listId: null,
    priority: 1,
    dueDate,
    startDate,
    isAllDay: false,
    isImportant: null,
    isUrgent: null,
    parentId: null,
    parentTitle: null,
    hierarchyPath: [title],
    goalId: null,
    rootTaskId: null,
    level: 1,
    plannedStartAt: null,
    plannedEndAt: null,
    actualStartAt: null,
    actualEndAt: null,
    dependencyTaskIds: [],
    autoScheduleEnabled: true,
    isLockedSchedule: false,
    estimatedMinutes: null,
    subtaskConfig: { progressMode: 'auto', autoCompleteParent: false, collapsed: false },
    recurrenceRule: null,
    source: 'manual',
    manualProgress: null,
    pinned: false,
    status: 'todo',
    tags: [],
    reminders: [],
    attachments: [],
    checklistTotal: 0,
    checklistDone: 0,
    subtaskTotal: 0,
    subtaskDone: 0,
    rollupProgress: 0,
    completed: false,
    completedAt: null,
    deletedAt: null,
    sortOrder: 0,
    createdAt: iso(2030, 1, 1, 8, 0),
    updatedAt: iso(2030, 1, 1, 8, 0),
  };
}

const jan1 = new Date(2030, 0, 1);
const jan2 = new Date(2030, 0, 2);
const crossDay = task('cross', 'Cross day', iso(2030, 1, 1, 23, 30), iso(2030, 1, 2, 1, 30));
const firstDay = taskSegmentsForDay([crossDay], jan1)[0];
const secondDay = taskSegmentsForDay([crossDay], jan2)[0];
assert(firstDay.startMinutes === 23 * 60 + 30 && firstDay.endMinutes === 24 * 60, 'cross-day first segment should end at midnight');
assert(firstDay.endsAfterDay === true && firstDay.startsBeforeDay === false, 'cross-day first segment flags mismatch');
assert(secondDay.startMinutes === 0 && secondDay.endMinutes === 90, 'cross-day second segment should start at midnight');
assert(secondDay.startsBeforeDay === true && secondDay.endsAfterDay === false, 'cross-day second segment flags mismatch');

const day = new Date(2030, 0, 3);
const overlapping = taskSegmentsForDay(
  [
    task('a', 'A', iso(2030, 1, 3, 9, 0), iso(2030, 1, 3, 10, 0)),
    task('b', 'B', iso(2030, 1, 3, 9, 30), iso(2030, 1, 3, 10, 30)),
    task('c', 'C', iso(2030, 1, 3, 11, 0), iso(2030, 1, 3, 12, 0)),
  ],
  day,
);
const a = overlapping.find((segment) => segment.task.id === 'a')!;
const b = overlapping.find((segment) => segment.task.id === 'b')!;
const c = overlapping.find((segment) => segment.task.id === 'c')!;
assert(a.laneCount === 2 && b.laneCount === 2, 'overlapping segments should share a two-lane cluster');
assert(a.lane !== b.lane, 'overlapping segments should be placed in different lanes');
assert(c.laneCount === 1 && c.lane === 0, 'non-overlapping segment should use the full lane');

console.log('calendar overlap layout ok');
