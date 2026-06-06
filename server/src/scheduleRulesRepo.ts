import { randomUUID } from 'node:crypto';
import { db, nowISO } from './db';
import { createGoalTask, getGoal, getTask } from './repo';
import {
  AppError,
  type GoalDTO,
  type PersonalScheduleRuleDTO,
  type ScheduleEnergyType,
  type ScheduleProposalAvoidedBlockDTO,
  type ScheduleProposalChangeDTO,
  type ScheduleProposalConflictDTO,
  type ScheduleProposalDTO,
  type ScheduleProposalExplanationDTO,
  type ScheduleRuleConflictListDTO,
  type ScheduleRuleDetailsDTO,
  type ScheduleRulePreviewDTO,
  type ScheduleRulePriority,
  type ScheduleRuleStatus,
  type ScheduleRuleTemplateDTO,
  type ScheduleRuleType,
} from './types';

const RULE_TYPES: ScheduleRuleType[] = [
  'time_boundary',
  'energy_preference',
  'fixed_habit',
  'buffer',
  'task_category',
  'reminder',
  'plan_priority',
];
const RULE_STATUSES: ScheduleRuleStatus[] = ['enabled', 'disabled'];
const RULE_PRIORITIES: ScheduleRulePriority[] = ['hard', 'normal', 'preference'];
const ENERGY_TYPES: ScheduleEnergyType[] = ['high', 'medium', 'low'];
const STEP_MS = 15 * 60_000;

type RuleRow = {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  type: ScheduleRuleType;
  status: ScheduleRuleStatus;
  priority: ScheduleRulePriority;
  condition_json: string;
  action_json: string;
  scope_json: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type RuleTemplateRow = {
  id: string;
  name: string;
  description: string | null;
  type: ScheduleRuleType;
  priority: ScheduleRulePriority;
  condition_json: string;
  action_json: string;
  scope_json: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type ProposalRow = {
  id: string;
  user_id: string;
  goal_id: string;
  status: ScheduleProposalDTO['status'];
  range_start: string;
  range_end: string;
  changes_json: string;
  explanations_json: string;
  conflicts_json: string;
  risk_score: number;
  created_at: string;
  confirmed_at: string | null;
};

type TaskRow = Record<string, any>;

type BusySlot = {
  start: Date;
  end: Date;
  source: 'task' | 'external' | 'rule' | 'scheduled';
  ruleId?: string;
  label: string;
};

type ProposalMode = 'initial_schedule' | 'reschedule';

function parseJsonObject(raw: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (raw == null || raw === '') return { ...fallback };
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ...(raw as Record<string, unknown>) };
  if (typeof raw !== 'string') return { ...fallback };
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, 'invalid_schedule_rule', `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseJsonArray<T>(raw: unknown, fallback: T[] = []): T[] {
  if (!raw) return [...fallback];
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(value) ? (value as T[]) : [...fallback];
  } catch {
    return [...fallback];
  }
}

function mapRule(row: RuleRow): PersonalScheduleRuleDTO {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    type: row.type,
    status: row.status,
    priority: row.priority,
    condition: parseJsonObject(row.condition_json),
    action: parseJsonObject(row.action_json),
    scope: parseJsonObject(row.scope_json),
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRuleTemplate(row: RuleTemplateRow): ScheduleRuleTemplateDTO {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    type: row.type,
    status: 'enabled',
    priority: row.priority,
    condition: parseJsonObject(row.condition_json),
    action: parseJsonObject(row.action_json),
    scope: parseJsonObject(row.scope_json),
    sortOrder: row.sort_order,
  };
}

function scheduleChangeKey(change: Pick<ScheduleProposalChangeDTO, 'taskId' | 'operation' | 'segmentIndex' | 'plannedStartAt'>): string {
  return `${change.taskId}:${change.operation}:${change.segmentIndex ?? 0}:${change.plannedStartAt}`;
}

function mapProposal(row: ProposalRow): ScheduleProposalDTO {
  const changes = parseJsonArray<ScheduleProposalChangeDTO>(row.changes_json).map((change): ScheduleProposalChangeDTO => ({
    ...change,
    changeKey: typeof (change as any).changeKey === 'string' ? (change as any).changeKey : scheduleChangeKey(change),
    operation: (change as any).operation === 'create_split_segment' ? 'create_split_segment' : 'schedule_task',
    segmentIndex: Number.isInteger((change as any).segmentIndex) ? (change as any).segmentIndex : null,
    segmentTotal: Number.isInteger((change as any).segmentTotal) ? (change as any).segmentTotal : null,
    createdTaskId: typeof (change as any).createdTaskId === 'string' ? (change as any).createdTaskId : null,
    oldPlannedStartAt: (change as any).oldPlannedStartAt ?? null,
    oldPlannedEndAt: (change as any).oldPlannedEndAt ?? null,
    oldIsAllDay: !!(change as any).oldIsAllDay,
    avoidedBlocks: Array.isArray((change as any).avoidedBlocks) ? (change as any).avoidedBlocks : [],
    confirmed:
      typeof (change as any).confirmed === 'boolean'
        ? (change as any).confirmed
        : row.status === 'confirmed' || row.status === 'undone',
  }));
  return {
    id: row.id,
    goalId: row.goal_id,
    status: row.status,
    range: { from: row.range_start, to: row.range_end },
    changes,
    explanations: parseJsonArray<ScheduleProposalExplanationDTO>(row.explanations_json),
    conflicts: parseJsonArray<ScheduleProposalConflictDTO>(row.conflicts_json),
    riskScore: row.risk_score,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at ?? null,
  };
}

function assertRuleType(value: unknown): asserts value is ScheduleRuleType {
  if (typeof value !== 'string' || !RULE_TYPES.includes(value as ScheduleRuleType)) {
    throw new AppError(400, 'invalid_schedule_rule', `type must be one of ${RULE_TYPES.join(', ')}`);
  }
}

function assertRuleStatus(value: unknown): asserts value is ScheduleRuleStatus {
  if (typeof value !== 'string' || !RULE_STATUSES.includes(value as ScheduleRuleStatus)) {
    throw new AppError(400, 'invalid_schedule_rule', `status must be one of ${RULE_STATUSES.join(', ')}`);
  }
}

function assertRulePriority(value: unknown): asserts value is ScheduleRulePriority {
  if (typeof value !== 'string' || !RULE_PRIORITIES.includes(value as ScheduleRulePriority)) {
    throw new AppError(400, 'invalid_schedule_rule', `priority must be one of ${RULE_PRIORITIES.join(', ')}`);
  }
}

function assertTime(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) {
    throw new AppError(400, 'invalid_schedule_rule', `${field} must be HH:mm`);
  }
  const [h, m] = value.split(':').map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    throw new AppError(400, 'invalid_schedule_rule', `${field} must be HH:mm`);
  }
}

function parseTime(value: unknown): { hour: number; minute: number } | null {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function validateRuleShape(type: ScheduleRuleType, condition: Record<string, unknown>, action: Record<string, unknown>): void {
  if (type === 'time_boundary' || type === 'fixed_habit') {
    assertTime(condition.startTime, 'condition.startTime');
    assertTime(condition.endTime, 'condition.endTime');
    if (condition.daysOfWeek != null) {
      if (
        !Array.isArray(condition.daysOfWeek) ||
        condition.daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
      ) {
        throw new AppError(400, 'invalid_schedule_rule', 'condition.daysOfWeek must contain 0-6');
      }
    }
    if (action.effect != null && action.effect !== 'block') {
      throw new AppError(400, 'invalid_schedule_rule', 'time rules currently support action.effect = block');
    }
  }
  if (type === 'buffer') {
    const minutes = Number(action.minutes ?? condition.minutes);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 240) {
      throw new AppError(400, 'invalid_schedule_rule', 'buffer minutes must be 0-240');
    }
  }
  if (type === 'energy_preference' && condition.energyType != null && !ENERGY_TYPES.includes(condition.energyType as ScheduleEnergyType)) {
    throw new AppError(400, 'invalid_schedule_rule', 'condition.energyType must be high, medium or low');
  }
}

function scopedToGoal(rule: PersonalScheduleRuleDTO, goalId: string): boolean {
  const goalIds = rule.scope.goalIds;
  return !Array.isArray(goalIds) || goalIds.length === 0 || goalIds.includes(goalId);
}

function parseIdList(raw: unknown): string[] {
  if (!raw) return [];
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function orderByDependencies(rows: TaskRow[]): TaskRow[] {
  const remaining = new Map(rows.map((row) => [row.id, row]));
  const ordered: TaskRow[] = [];
  while (remaining.size) {
    const next = [...remaining.values()].find((row) => parseIdList(row.dependency_task_ids).every((dep) => !remaining.has(dep)));
    if (!next) throw new AppError(409, 'dependency_cycle', 'task dependencies contain a cycle');
    ordered.push(next);
    remaining.delete(next.id);
  }
  return ordered;
}

function isDependencySatisfied(row: { completed?: unknown; status?: unknown } | undefined): boolean {
  if (!row) return false;
  return Number(row.completed) === 1 || row.status === 'done' || row.status === 'skipped';
}

function blockRowsWithExternalDependencies(
  userId: string,
  rows: TaskRow[],
  conflicts: ScheduleProposalConflictDTO[],
): TaskRow[] {
  const candidateIds = new Set(rows.map((row) => row.id as string));
  const externalDependencyIds = Array.from(
    new Set(rows.flatMap((row) => parseIdList(row.dependency_task_ids)).filter((id) => !candidateIds.has(id))),
  );
  if (!externalDependencyIds.length) return rows;

  const placeholders = externalDependencyIds.map(() => '?').join(',');
  const dependencyRows = db
    .prepare(`SELECT id, title, status, completed FROM tasks WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`)
    .all(userId, ...externalDependencyIds) as Array<{ id: string; title: string; status: string | null; completed: number }>;
  const dependencies = new Map(dependencyRows.map((row) => [row.id, row]));

  return rows.filter((row) => {
    const blockers = parseIdList(row.dependency_task_ids)
      .filter((id) => !candidateIds.has(id))
      .map((id) => dependencies.get(id) ?? { id, title: 'missing prerequisite task', status: null, completed: 0 })
      .filter((dependency) => !isDependencySatisfied(dependency));
    if (!blockers.length) return true;

    conflicts.push({
      type: 'dependency_blocked',
      severity: 'blocking',
      taskId: row.id,
      ruleIds: [],
      message: `Task "${row.title}" cannot be scheduled because prerequisite task(s) are unfinished: ${blockers
        .map((dependency) => dependency.title)
        .join(', ')}.`,
      suggestions: ['Complete the prerequisite task first.', 'Include prerequisite tasks in the proposal.', 'Remove or adjust the dependency before scheduling.'],
    });
    return false;
  });
}

function parseRange(goal: GoalDTO, input: Record<string, unknown>): { from: string; to: string; fromDate: Date; toDate: Date } {
  const fallbackFrom = goal.startAt ?? nowISO();
  const fallbackEnd = new Date(Date.parse(fallbackFrom) + 7 * 24 * 3600_000);
  fallbackEnd.setHours(23, 59, 59, 999);
  const from = typeof input.from === 'string' && input.from ? input.from : fallbackFrom;
  const to = typeof input.to === 'string' && input.to ? input.to : goal.deadlineAt ?? fallbackEnd.toISOString();
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate >= toDate) {
    throw new AppError(400, 'invalid_schedule_range', 'from and to must be valid ISO dates and from must be before to');
  }
  return { from: fromDate.toISOString(), to: toDate.toISOString(), fromDate, toDate };
}

function parsePreviewRange(input: Record<string, unknown>): { from: string; to: string; fromDate: Date; toDate: Date } {
  const fromValue = typeof input.from === 'string' && input.from ? input.from : nowISO();
  const fromDate = new Date(fromValue);
  if (Number.isNaN(fromDate.getTime())) throw new AppError(400, 'invalid_schedule_range', 'from must be a valid ISO date');
  const fallbackTo = new Date(fromDate.getTime() + 7 * 24 * 3600_000);
  const toValue = typeof input.to === 'string' && input.to ? input.to : fallbackTo.toISOString();
  const toDate = new Date(toValue);
  if (Number.isNaN(toDate.getTime()) || fromDate >= toDate) {
    throw new AppError(400, 'invalid_schedule_range', 'to must be a valid ISO date after from');
  }
  if (toDate.getTime() - fromDate.getTime() > 31 * 24 * 3600_000) {
    throw new AppError(400, 'invalid_schedule_range', 'preview range cannot exceed 31 days');
  }
  return { from: fromDate.toISOString(), to: toDate.toISOString(), fromDate, toDate };
}

function parseGoalWindow(rule: string | null): { startHour: number; endHour: number } {
  if (!rule) return { startHour: 9, endHour: 18 };
  try {
    const value = JSON.parse(rule) as { startHour?: number; endHour?: number };
    const startHour = Number.isFinite(value.startHour) ? Number(value.startHour) : 9;
    const endHour = Number.isFinite(value.endHour) ? Number(value.endHour) : 18;
    if (startHour < 0 || startHour > 23 || endHour <= startHour || endHour > 24) return { startHour: 9, endHour: 18 };
    return { startHour, endHour };
  } catch {
    return { startHour: 9, endHour: 18 };
  }
}

function alignToStep(input: Date): Date {
  const t = input.getTime();
  return new Date(Math.ceil(t / STEP_MS) * STEP_MS);
}

function alignToWorkWindow(input: Date, window: { startHour: number; endHour: number }): Date {
  const d = alignToStep(input);
  const start = new Date(d);
  start.setHours(window.startHour, 0, 0, 0);
  const end = new Date(d);
  end.setHours(window.endHour, 0, 0, 0);
  if (d < start) return start;
  if (d >= end) {
    start.setDate(start.getDate() + 1);
    return start;
  }
  return d;
}

function endOfWorkday(input: Date, window: { startHour: number; endHour: number }): Date {
  const end = new Date(input);
  end.setHours(window.endHour, 0, 0, 0);
  return end;
}

function addMinutes(input: Date, minutes: number): Date {
  return new Date(input.getTime() + minutes * 60_000);
}

function expandRuleBlocks(
  rules: PersonalScheduleRuleDTO[],
  range: { fromDate: Date; toDate: Date },
  conflicts: ScheduleProposalConflictDTO[],
): BusySlot[] {
  const slots: BusySlot[] = [];
  const cursor = new Date(range.fromDate);
  cursor.setHours(0, 0, 0, 0);
  while (cursor < range.toDate) {
    for (const rule of rules) {
      if (rule.status !== 'enabled' || (rule.type !== 'time_boundary' && rule.type !== 'fixed_habit')) continue;
      const startTime = parseTime(rule.condition.startTime);
      const endTime = parseTime(rule.condition.endTime);
      if (!startTime || !endTime) {
        conflicts.push({
          type: 'invalid_rule',
          severity: 'warning',
          ruleIds: [rule.id],
          message: `Rule "${rule.name}" has an invalid time range.`,
          suggestions: ['Edit the rule time to HH:mm.'],
        });
        continue;
      }
      const days = Array.isArray(rule.condition.daysOfWeek) ? (rule.condition.daysOfWeek as number[]) : [0, 1, 2, 3, 4, 5, 6];
      if (!days.includes(cursor.getDay())) continue;
      const start = new Date(cursor);
      start.setHours(startTime.hour, startTime.minute, 0, 0);
      const end = new Date(cursor);
      end.setHours(endTime.hour, endTime.minute, 0, 0);
      if (end <= start) end.setDate(end.getDate() + 1);
      if (end <= range.fromDate || start >= range.toDate) continue;
      slots.push({ start, end, source: 'rule', ruleId: rule.id, label: rule.name });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return slots;
}

function listExistingBusySlots(userId: string, goalId: string, range: { from: string; to: string }): BusySlot[] {
  const taskRows = db
    .prepare(
      `SELECT id, title, start_date, due_date
       FROM tasks
       WHERE user_id = ?
         AND deleted_at IS NULL
         AND is_all_day = 0
         AND start_date IS NOT NULL
         AND due_date IS NOT NULL
         AND (goal_id IS NULL OR goal_id <> ?)
         AND start_date < ?
         AND due_date > ?`,
    )
    .all(userId, goalId, range.to, range.from) as Array<{ id: string; title: string; start_date: string; due_date: string }>;
  const externalRows = db
    .prepare(
      `SELECT id, title, starts_at, ends_at
       FROM external_calendar_events
       WHERE user_id = ?
         AND is_all_day = 0
         AND starts_at < ?
         AND ends_at > ?`,
    )
    .all(userId, range.to, range.from) as Array<{ id: string; title: string; starts_at: string; ends_at: string }>;
  return [
    ...taskRows.map((row) => ({
      start: new Date(row.start_date),
      end: new Date(row.due_date),
      source: 'task' as const,
      label: row.title,
    })),
    ...externalRows.map((row) => ({
      start: new Date(row.starts_at),
      end: new Date(row.ends_at),
      source: 'external' as const,
      label: row.title,
    })),
  ].filter((slot) => !Number.isNaN(slot.start.getTime()) && !Number.isNaN(slot.end.getTime()) && slot.start < slot.end);
}

function currentTaskSlot(row: TaskRow): { start: Date; end: Date } | null {
  const startRaw = row.start_date ?? row.planned_start_at;
  const endRaw = row.due_date ?? row.planned_end_at;
  if (!startRaw || !endRaw) return null;
  const start = new Date(startRaw);
  const end = new Date(endRaw);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) return null;
  return { start, end };
}

function listGoalBusySlots(userId: string, goalId: string, range: { from: string; to: string }, excludeTaskIds: Set<string>): BusySlot[] {
  const rows = db
    .prepare(
      `SELECT id, title, start_date, due_date
       FROM tasks
       WHERE user_id = ?
         AND goal_id = ?
         AND deleted_at IS NULL
         AND is_all_day = 0
         AND start_date IS NOT NULL
         AND due_date IS NOT NULL
         AND start_date < ?
         AND due_date > ?`,
    )
    .all(userId, goalId, range.to, range.from) as Array<{ id: string; title: string; start_date: string; due_date: string }>;
  return rows
    .filter((row) => !excludeTaskIds.has(row.id))
    .map((row) => ({ start: new Date(row.start_date), end: new Date(row.due_date), source: 'task' as const, label: row.title }))
    .filter((slot) => !Number.isNaN(slot.start.getTime()) && !Number.isNaN(slot.end.getTime()) && slot.start < slot.end);
}

function findBlockingSlot(slots: BusySlot[], start: Date, end: Date): BusySlot | null {
  return slots.find((slot) => start < slot.end && end > slot.start) ?? null;
}

function busySlotKey(slot: BusySlot): string {
  return `${slot.source}:${slot.ruleId ?? ''}:${slot.label}:${slot.start.toISOString()}:${slot.end.toISOString()}`;
}

function rememberAvoidedSlot(avoided: BusySlot[], slot: BusySlot): void {
  const key = busySlotKey(slot);
  if (!avoided.some((item) => busySlotKey(item) === key)) avoided.push(slot);
}

function mapAvoidedBlocks(slots: BusySlot[]): ScheduleProposalAvoidedBlockDTO[] {
  return slots.map((slot) => ({
    source: slot.source,
    title: slot.label,
    start: slot.start.toISOString(),
    end: slot.end.toISOString(),
    ruleId: slot.ruleId ?? null,
  }));
}

function avoidedSummary(blocks: ScheduleProposalAvoidedBlockDTO[]): string {
  if (blocks.length === 0) return '';
  const sourceLabel: Record<ScheduleProposalAvoidedBlockDTO['source'], string> = {
    task: 'existing task',
    external: 'external calendar event',
    rule: 'personal rule block',
    scheduled: 'earlier proposal slot',
  };
  return blocks
    .slice(0, 4)
    .map((block) => `${sourceLabel[block.source]} "${block.title}"`)
    .join(', ');
}

function busySourceLabel(source: BusySlot['source']): string {
  if (source === 'external') return 'external calendar event';
  if (source === 'rule') return 'personal rule block';
  if (source === 'scheduled') return 'new proposal slot';
  return 'existing task';
}

function findSlot(
  startFrom: Date,
  durationMinutes: number,
  rangeEnd: Date,
  window: { startHour: number; endHour: number },
  busySlots: BusySlot[],
): { start: Date; end: Date; avoided: BusySlot[] } | null {
  let cursor = alignToWorkWindow(startFrom, window);
  const avoided: BusySlot[] = [];
  let guard = 0;
  while (cursor < rangeEnd && guard < 20000) {
    guard += 1;
    const dayEnd = endOfWorkday(cursor, window);
    const end = addMinutes(cursor, durationMinutes);
    if (end > rangeEnd) return null;
    if (end > dayEnd) {
      const next = new Date(cursor);
      next.setDate(next.getDate() + 1);
      next.setHours(window.startHour, 0, 0, 0);
      cursor = next;
      continue;
    }
    const blocking = findBlockingSlot(busySlots, cursor, end);
    if (blocking) {
      rememberAvoidedSlot(avoided, blocking);
      cursor = alignToWorkWindow(blocking.end, window);
      continue;
    }
    return { start: cursor, end, avoided };
  }
  return null;
}

function totalBufferMinutes(rules: PersonalScheduleRuleDTO[]): number {
  return Math.max(
    0,
    ...rules
      .filter((rule) => rule.status === 'enabled' && rule.type === 'buffer')
      .map((rule) => Number(rule.action.minutes ?? rule.condition.minutes ?? 0))
      .filter((minutes) => Number.isFinite(minutes) && minutes >= 0 && minutes <= 240),
  );
}

function matchingEnergyRuleIds(task: TaskRow, rules: PersonalScheduleRuleDTO[]): string[] {
  const energy = task.schedule_energy_type as ScheduleEnergyType | null;
  if (!energy) return [];
  return rules
    .filter((rule) => rule.status === 'enabled' && rule.type === 'energy_preference')
    .filter((rule) => !rule.condition.energyType || rule.condition.energyType === energy)
    .map((rule) => rule.id);
}

function riskScore(conflicts: ScheduleProposalConflictDTO[]): number {
  return Math.min(
    100,
    conflicts.reduce((sum, conflict) => sum + (conflict.severity === 'blocking' ? 35 : conflict.severity === 'warning' ? 15 : 5), 0),
  );
}

function parseManualScheduleDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !value) {
    throw new AppError(400, 'invalid_schedule_change', `${field} must be a valid ISO date`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, 'invalid_schedule_change', `${field} must be a valid ISO date`);
  }
  return date;
}

function conflictKey(conflict: ScheduleProposalConflictDTO): string {
  return [
    conflict.type,
    conflict.severity,
    conflict.taskId ?? '',
    conflict.ruleIds.join(','),
    conflict.message,
  ].join(':');
}

function mergeConflicts(
  base: ScheduleProposalConflictDTO[],
  additions: ScheduleProposalConflictDTO[],
): ScheduleProposalConflictDTO[] {
  const seen = new Set(base.map(conflictKey));
  const merged = [...base];
  for (const conflict of additions) {
    const key = conflictKey(conflict);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(conflict);
    }
  }
  return merged;
}

function splitDurations(totalMinutes: number, minMinutes: number, enabled: boolean): number[] {
  const total = Math.max(15, totalMinutes);
  const min = Math.max(15, minMinutes);
  if (!enabled || total <= min) return [Math.max(total, min)];
  const parts: number[] = [];
  let remaining = total;
  while (remaining - min >= min) {
    parts.push(min);
    remaining -= min;
  }
  parts.push(remaining);
  return parts;
}

function draftRuleForPreview(input: Record<string, unknown>): PersonalScheduleRuleDTO {
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Rule preview';
  const type = input.type ?? 'time_boundary';
  const status = input.status ?? 'enabled';
  const priority = input.priority ?? 'normal';
  assertRuleType(type);
  assertRuleStatus(status);
  assertRulePriority(priority);
  const condition = requireObject(input.condition, 'condition');
  const action = requireObject(input.action, 'action');
  const scope = requireObject(input.scope, 'scope');
  validateRuleShape(type, condition, action);
  const ts = nowISO();
  return {
    id: typeof input.id === 'string' && input.id ? input.id : 'preview-rule',
    name,
    description: typeof input.description === 'string' && input.description.trim() ? input.description.trim() : null,
    type,
    status,
    priority,
    condition,
    action,
    scope,
    deletedAt: null,
    createdAt: ts,
    updatedAt: ts,
  };
}

export function listScheduleRules(userId: string, opts: { includeDeleted?: boolean } = {}): PersonalScheduleRuleDTO[] {
  const where = opts.includeDeleted ? 'user_id = ?' : 'user_id = ? AND deleted_at IS NULL';
  return (
    db.prepare(`SELECT * FROM personal_schedule_rules WHERE ${where} ORDER BY status ASC, priority ASC, created_at DESC`).all(userId) as RuleRow[]
  ).map(mapRule);
}

export function listScheduleRuleTemplates(): ScheduleRuleTemplateDTO[] {
  return (
    db.prepare('SELECT * FROM schedule_rule_templates ORDER BY sort_order ASC, id ASC').all() as RuleTemplateRow[]
  ).map(mapRuleTemplate);
}

export function getScheduleRule(userId: string, id: string): PersonalScheduleRuleDTO | null {
  const row = db.prepare('SELECT * FROM personal_schedule_rules WHERE user_id = ? AND id = ?').get(userId, id) as RuleRow | undefined;
  return row ? mapRule(row) : null;
}

export function getScheduleRuleDetails(userId: string, id: string): ScheduleRuleDetailsDTO | null {
  const rule = getScheduleRule(userId, id);
  if (!rule) return null;
  const proposals = (
    db.prepare('SELECT * FROM schedule_proposals WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').all(userId) as ProposalRow[]
  ).map(mapProposal);
  let hitCount = 0;
  let conflictCount = 0;
  const recentImpacts: ScheduleRuleDetailsDTO['recentImpacts'] = [];
  const recentConflicts: ScheduleRuleDetailsDTO['recentConflicts'] = [];
  for (const proposal of proposals) {
    for (const change of proposal.changes) {
      if (!change.ruleIds.includes(id)) continue;
      hitCount += 1;
      if (recentImpacts.length < 10) {
        recentImpacts.push({
          proposalId: proposal.id,
          proposalStatus: proposal.status,
          taskId: change.taskId,
          title: change.title,
          operation: change.operation,
          plannedStartAt: change.plannedStartAt,
          plannedEndAt: change.plannedEndAt,
          durationMinutes: change.durationMinutes,
          reason: change.reason,
          createdAt: proposal.createdAt,
        });
      }
    }
    for (const conflict of proposal.conflicts) {
      if (!conflict.ruleIds.includes(id)) continue;
      conflictCount += 1;
      if (recentConflicts.length < 10) {
        recentConflicts.push({
          proposalId: proposal.id,
          proposalStatus: proposal.status,
          type: conflict.type,
          severity: conflict.severity,
          taskId: conflict.taskId ?? null,
          message: conflict.message,
          suggestions: conflict.suggestions,
          createdAt: proposal.createdAt,
        });
      }
    }
  }
  return { rule, hitCount, conflictCount, recentImpacts, recentConflicts };
}

function taskTitleFor(userId: string, taskId: string | null | undefined): string | null {
  if (!taskId) return null;
  const row = db.prepare('SELECT title FROM tasks WHERE user_id = ? AND id = ?').get(userId, taskId) as { title: string } | undefined;
  return row?.title ?? null;
}

export function listScheduleRuleConflicts(userId: string, opts: { limit?: number } = {}): ScheduleRuleConflictListDTO {
  const limit = Math.max(1, Math.min(100, Math.trunc(Number(opts.limit ?? 50)) || 50));
  const rules = new Map(listScheduleRules(userId, { includeDeleted: true }).map((rule) => [rule.id, rule]));
  const proposals = (
    db.prepare('SELECT * FROM schedule_proposals WHERE user_id = ? ORDER BY created_at DESC LIMIT 300').all(userId) as ProposalRow[]
  ).map(mapProposal);
  const conflicts: ScheduleRuleConflictListDTO['conflicts'] = [];
  for (const proposal of proposals) {
    proposal.conflicts.forEach((conflict, index) => {
      const ruleIds = Array.from(new Set(conflict.ruleIds.filter((id) => typeof id === 'string' && id)));
      if (!ruleIds.length || conflicts.length >= limit) return;
      conflicts.push({
        id: `${proposal.id}:${index}`,
        proposalId: proposal.id,
        proposalStatus: proposal.status,
        goalId: proposal.goalId,
        createdAt: proposal.createdAt,
        type: conflict.type,
        severity: conflict.severity,
        taskId: conflict.taskId ?? null,
        taskTitle: taskTitleFor(userId, conflict.taskId),
        ruleIds,
        rules: ruleIds.map((ruleId) => {
          const rule = rules.get(ruleId);
          return {
            id: ruleId,
            name: rule?.name ?? ruleId,
            priority: rule?.priority ?? 'normal',
            status: rule?.status ?? 'disabled',
          };
        }),
        message: conflict.message,
        suggestions: conflict.suggestions,
      });
    });
    if (conflicts.length >= limit) return {
      conflicts,
      summary: {
        total: conflicts.length,
        blocking: conflicts.filter((item) => item.severity === 'blocking').length,
        warning: conflicts.filter((item) => item.severity === 'warning').length,
        info: conflicts.filter((item) => item.severity === 'info').length,
      },
    };
  }
  return {
    conflicts,
    summary: {
      total: conflicts.length,
      blocking: conflicts.filter((item) => item.severity === 'blocking').length,
      warning: conflicts.filter((item) => item.severity === 'warning').length,
      info: conflicts.filter((item) => item.severity === 'info').length,
    },
  };
}

export function createScheduleRule(userId: string, input: Record<string, unknown>): PersonalScheduleRuleDTO {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new AppError(400, 'invalid_schedule_rule', 'name is required');
  const type = input.type ?? 'time_boundary';
  const status = input.status ?? 'enabled';
  const priority = input.priority ?? 'normal';
  assertRuleType(type);
  assertRuleStatus(status);
  assertRulePriority(priority);
  const condition = requireObject(input.condition, 'condition');
  const action = requireObject(input.action, 'action');
  const scope = requireObject(input.scope, 'scope');
  validateRuleShape(type, condition, action);
  const id = randomUUID();
  const ts = nowISO();
  db.prepare(
    `INSERT INTO personal_schedule_rules
       (id, user_id, name, description, type, status, priority, condition_json, action_json, scope_json, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    userId,
    name,
    typeof input.description === 'string' && input.description.trim() ? input.description.trim() : null,
    type,
    status,
    priority,
    JSON.stringify(condition),
    JSON.stringify(action),
    JSON.stringify(scope),
    ts,
    ts,
  );
  return getScheduleRule(userId, id)!;
}

export function updateScheduleRule(userId: string, id: string, patch: Record<string, unknown>): PersonalScheduleRuleDTO | null {
  const current = getScheduleRule(userId, id);
  if (!current) return null;
  const next = {
    name: current.name,
    description: current.description,
    type: current.type,
    status: current.status,
    priority: current.priority,
    condition: current.condition,
    action: current.action,
    scope: current.scope,
  };
  if ('name' in patch) {
    next.name = typeof patch.name === 'string' ? patch.name.trim() : '';
    if (!next.name) throw new AppError(400, 'invalid_schedule_rule', 'name is required');
  }
  if ('description' in patch) next.description = typeof patch.description === 'string' && patch.description.trim() ? patch.description.trim() : null;
  if ('type' in patch) {
    assertRuleType(patch.type);
    next.type = patch.type;
  }
  if ('status' in patch) {
    assertRuleStatus(patch.status);
    next.status = patch.status;
  }
  if ('priority' in patch) {
    assertRulePriority(patch.priority);
    next.priority = patch.priority;
  }
  if ('condition' in patch) next.condition = requireObject(patch.condition, 'condition');
  if ('action' in patch) next.action = requireObject(patch.action, 'action');
  if ('scope' in patch) next.scope = requireObject(patch.scope, 'scope');
  validateRuleShape(next.type, next.condition, next.action);
  const info = db
    .prepare(
      `UPDATE personal_schedule_rules
       SET name = ?, description = ?, type = ?, status = ?, priority = ?, condition_json = ?, action_json = ?, scope_json = ?, updated_at = ?
       WHERE user_id = ? AND id = ?`,
    )
    .run(
      next.name,
      next.description,
      next.type,
      next.status,
      next.priority,
      JSON.stringify(next.condition),
      JSON.stringify(next.action),
      JSON.stringify(next.scope),
      nowISO(),
      userId,
      id,
    );
  if (info.changes === 0) return null;
  return getScheduleRule(userId, id);
}

export function deleteScheduleRule(userId: string, id: string): boolean {
  const ts = nowISO();
  const info = db
    .prepare('UPDATE personal_schedule_rules SET deleted_at = ?, status = ?, updated_at = ? WHERE user_id = ? AND id = ? AND deleted_at IS NULL')
    .run(ts, 'disabled', ts, userId, id);
  return info.changes > 0;
}

export function restoreScheduleRule(userId: string, id: string): PersonalScheduleRuleDTO | null {
  const ts = nowISO();
  const info = db
    .prepare('UPDATE personal_schedule_rules SET deleted_at = NULL, updated_at = ? WHERE user_id = ? AND id = ?')
    .run(ts, userId, id);
  if (info.changes === 0) return null;
  return getScheduleRule(userId, id);
}

export function previewScheduleRule(userId: string, input: Record<string, unknown> = {}): ScheduleRulePreviewDTO {
  const range = parsePreviewRange(input);
  const draftRule = draftRuleForPreview(input);
  const conflicts: ScheduleProposalConflictDTO[] = [];
  const ruleSlots = expandRuleBlocks([draftRule], range, conflicts);
  const goalId = typeof input.goalId === 'string' && input.goalId ? input.goalId : null;
  const taskRows = db
    .prepare(
      `SELECT id, title, start_date, due_date
       FROM tasks
       WHERE user_id = ?
         AND deleted_at IS NULL
         AND is_all_day = 0
         AND start_date IS NOT NULL
         AND due_date IS NOT NULL
         AND (? IS NULL OR goal_id = ?)
         AND start_date < ?
         AND due_date > ?
       ORDER BY start_date ASC`,
    )
    .all(userId, goalId, goalId, range.to, range.from) as Array<{ id: string; title: string; start_date: string; due_date: string }>;
  const affectedTasks = [];
  for (const task of taskRows) {
    const taskStart = new Date(task.start_date);
    const taskEnd = new Date(task.due_date);
    if (Number.isNaN(taskStart.getTime()) || Number.isNaN(taskEnd.getTime()) || taskStart >= taskEnd) continue;
    for (const slot of ruleSlots) {
      if (taskStart < slot.end && taskEnd > slot.start) {
        affectedTasks.push({
          taskId: task.id,
          title: task.title,
          startDate: task.start_date,
          dueDate: task.due_date,
          ruleBlockStart: slot.start.toISOString(),
          ruleBlockEnd: slot.end.toISOString(),
        });
      }
    }
  }
  const blockedSlots = ruleSlots.map((slot) => ({
    start: slot.start.toISOString(),
    end: slot.end.toISOString(),
    ruleId: slot.ruleId ?? null,
    ruleName: slot.label,
  }));
  return {
    range: { from: range.from, to: range.to },
    blockedSlots,
    affectedTasks,
    summary: {
      blockedSlotCount: blockedSlots.length,
      affectedTaskCount: affectedTasks.length,
    },
  };
}

export function createScheduleProposal(userId: string, goalId: string, input: Record<string, unknown> = {}): ScheduleProposalDTO {
  const goal = getGoal(userId, goalId);
  if (!goal) throw new AppError(404, 'not_found', 'goal not found');
  if (goal.status !== 'active' && goal.status !== 'not_started') {
    throw new AppError(409, 'goal_not_schedulable', 'only active or not-started goals can generate schedule proposals');
  }
  const mode: ProposalMode = input.mode === 'reschedule' ? 'reschedule' : 'initial_schedule';
  const range = parseRange(goal, input);
  const ruleList = listScheduleRules(userId).filter((rule) => rule.status === 'enabled' && scopedToGoal(rule, goalId));
  const conflicts: ScheduleProposalConflictDTO[] = [];
  const ruleSlots = expandRuleBlocks(ruleList, range, conflicts);
  const bufferMinutes = totalBufferMinutes(ruleList);
  const window = parseGoalWindow(goal.availableTimeRule);
  const existingBusy = listExistingBusySlots(userId, goalId, range).map((slot) => ({ ...slot, end: addMinutes(slot.end, bufferMinutes) }));
  const busySlots: BusySlot[] = [...existingBusy, ...ruleSlots];
  let rows = db
    .prepare(
      `SELECT t.*
       FROM tasks t
       WHERE t.user_id = ?
         AND t.goal_id = ?
         AND t.deleted_at IS NULL
         AND t.completed = 0
         AND t.auto_schedule_enabled = 1
         AND t.is_locked_schedule = 0
         AND NOT EXISTS (
           SELECT 1 FROM tasks child
           WHERE child.user_id = t.user_id AND child.parent_id = t.id AND child.deleted_at IS NULL
         )
       ORDER BY t.priority DESC, t.created_at ASC`,
    )
    .all(userId, goalId) as TaskRow[];
  const taskIds = Array.isArray(input.taskIds) ? input.taskIds.filter((id) => typeof id === 'string') : [];
  if (taskIds.length) {
    const allowed = new Set(taskIds);
    rows = rows.filter((row) => allowed.has(row.id));
  }
  rows = blockRowsWithExternalDependencies(userId, rows, conflicts);
  if (mode === 'reschedule') {
    const selected = taskIds.length ? new Set(taskIds) : null;
    rows = rows.filter((row) => {
      if (selected?.has(row.id)) return true;
      const slot = currentTaskSlot(row);
      if (!slot) return true;
      const blocking = findBlockingSlot(busySlots, slot.start, slot.end);
      if (!blocking) return false;
      conflicts.push({
        type: 'reschedule_impact',
        severity: 'info',
        taskId: row.id,
        ruleIds: blocking.ruleId ? [blocking.ruleId] : [],
        message: `Task "${row.title}" overlaps ${busySourceLabel(blocking.source)} "${blocking.label}", so it is included in this reschedule proposal.`,
        suggestions: ['Review the proposed new time and confirm the reschedule.'],
      });
      return true;
    });
    const movingIds = new Set(rows.map((row) => row.id as string));
    busySlots.push(...listGoalBusySlots(userId, goalId, range, movingIds).map((slot) => ({ ...slot, end: addMinutes(slot.end, bufferMinutes) })));
  }
  let ordered: TaskRow[] = [];
  try {
    ordered = orderByDependencies(rows);
  } catch {
    conflicts.push({
      type: 'dependency_cycle',
      severity: 'blocking',
      ruleIds: [],
      message: 'Task dependencies contain a cycle, so a proposal cannot be ordered safely.',
      suggestions: ['Remove the cyclic dependency before generating a new proposal.'],
    });
  }

  const changes: ScheduleProposalChangeDTO[] = [];
  const explanations: ScheduleProposalExplanationDTO[] = [];
  let cursor = new Date(range.fromDate);
  const enabledRuleIds = ruleList.map((rule) => rule.id);
  const candidateIds = new Set(ordered.map((row) => row.id as string));
  const scheduledTaskIds = new Set<string>();
  for (const row of ordered) {
    const unfinishedProposalDependencies = parseIdList(row.dependency_task_ids).filter((id) => {
      if (!candidateIds.has(id) || scheduledTaskIds.has(id)) return false;
      const dependencyRow = ordered.find((candidate) => candidate.id === id);
      return !isDependencySatisfied(dependencyRow);
    });
    if (unfinishedProposalDependencies.length) {
      const names = unfinishedProposalDependencies
        .map((id) => ordered.find((candidate) => candidate.id === id)?.title)
        .filter((title): title is string => typeof title === 'string' && title.length > 0);
      conflicts.push({
        type: 'dependency_blocked',
        severity: 'blocking',
        taskId: row.id,
        ruleIds: [],
        message: `Task "${row.title}" cannot be scheduled because prerequisite task(s) were not fully scheduled first: ${names.join(', ')}.`,
        suggestions: ['Confirm or fix the prerequisite task schedule first.', 'Extend the scheduling range.', 'Remove or adjust the dependency before scheduling.'],
      });
      continue;
    }
    const estimatedMinutes = Math.max(15, Number(row.estimated_minutes) || 60);
    const minScheduleMinutes = Math.max(15, Number(row.min_schedule_minutes) || 15);
    const durations = splitDurations(estimatedMinutes, minScheduleMinutes, !!row.is_splittable);
    const isSplit = durations.length > 1;
    const energyRuleIds = matchingEnergyRuleIds(row, ruleList);
    const ruleIds = Array.from(new Set([...enabledRuleIds, ...energyRuleIds]));
    let scheduledSegments = 0;
    for (let index = 0; index < durations.length; index += 1) {
      const duration = durations[index];
      const slot = findSlot(cursor, duration, range.toDate, window, busySlots);
      if (!slot) {
        conflicts.push({
          type: 'schedule_overflow',
          severity: 'blocking',
          taskId: row.id,
          ruleIds: enabledRuleIds,
          message: `Task "${row.title}" cannot fit segment ${index + 1}/${durations.length} before the range end under current rules.`,
          suggestions: ['Extend the goal deadline.', 'Reduce the task estimate.', 'Disable or loosen blocking rules.'],
        });
        break;
      }
      const plannedStartAt = slot.start.toISOString();
      const plannedEndAt = slot.end.toISOString();
      const avoidedBlocks = mapAvoidedBlocks(slot.avoided);
      const avoidedText = avoidedSummary(avoidedBlocks);
      const segmentLabel = isSplit ? ` segment ${index + 1}/${durations.length}` : '';
      const operation = isSplit ? 'create_split_segment' : 'schedule_task';
      const segmentIndex = isSplit ? index + 1 : null;
      const reason = avoidedText
        ? `Scheduled${segmentLabel} for ${duration} minutes inside ${window.startHour}:00-${window.endHour}:00 after avoiding ${avoidedText}.`
        : `Scheduled${segmentLabel} for ${duration} minutes inside ${window.startHour}:00-${window.endHour}:00 with no calendar conflicts.`;
      changes.push({
        changeKey: scheduleChangeKey({ taskId: row.id, operation, segmentIndex, plannedStartAt }),
        taskId: row.id,
        title: isSplit ? `${row.title} (${index + 1}/${durations.length})` : row.title,
        operation,
        segmentIndex,
        segmentTotal: isSplit ? durations.length : null,
        createdTaskId: null,
        oldStartDate: row.start_date ?? null,
        oldDueDate: row.due_date ?? null,
        oldPlannedStartAt: row.planned_start_at ?? null,
        oldPlannedEndAt: row.planned_end_at ?? null,
        oldIsAllDay: !!row.is_all_day,
        plannedStartAt,
        plannedEndAt,
        durationMinutes: duration,
        ruleIds,
        avoidedBlocks,
        reason,
        conflict: false,
        confirmed: false,
      });
      const baseExplanation =
        energyRuleIds.length > 0
          ? `${row.title}${segmentLabel} matched its energy preference and was placed in the first conflict-free slot.`
          : `${row.title}${segmentLabel} was placed in the first conflict-free slot that satisfied the work window and blocking rules.`;
      explanations.push({
        taskId: row.id,
        ruleIds,
        message: avoidedText ? `${baseExplanation} It avoided ${avoidedText}.` : baseExplanation,
      });
      busySlots.push({ start: slot.start, end: addMinutes(slot.end, bufferMinutes), source: 'scheduled', label: isSplit ? `${row.title} (${index + 1}/${durations.length})` : row.title });
      cursor = addMinutes(slot.end, bufferMinutes);
      scheduledSegments += 1;
    }
    if (scheduledSegments === durations.length) scheduledTaskIds.add(row.id);
  }

  if (ordered.length === 0 && conflicts.length === 0) {
    conflicts.push({
      type: 'task_blocked',
      severity: 'info',
      ruleIds: [],
      message:
        mode === 'reschedule'
          ? 'No scheduled tasks are affected by the latest calendar or rule changes.'
          : 'No unlocked leaf tasks are eligible for automatic scheduling.',
      suggestions:
        mode === 'reschedule'
          ? ['Add an unscheduled urgent task or sync a changed calendar event before requesting another reschedule.']
          : ['Add leaf tasks, unlock scheduled tasks, or enable auto scheduling on tasks.'],
    });
  }

  const id = randomUUID();
  const ts = nowISO();
  db.prepare(
    `INSERT INTO schedule_proposals
       (id, user_id, goal_id, status, range_start, range_end, changes_json, explanations_json, conflicts_json, risk_score, created_at, confirmed_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    userId,
    goalId,
    range.from,
    range.to,
    JSON.stringify(changes),
    JSON.stringify(explanations),
    JSON.stringify(conflicts),
    riskScore(conflicts),
    ts,
  );
  return getScheduleProposal(userId, id)!;
}

export function getScheduleProposal(userId: string, id: string): ScheduleProposalDTO | null {
  const row = db.prepare('SELECT * FROM schedule_proposals WHERE user_id = ? AND id = ?').get(userId, id) as ProposalRow | undefined;
  return row ? mapProposal(row) : null;
}

export function updateScheduleProposalChange(
  userId: string,
  id: string,
  changeKey: string,
  input: Record<string, unknown> = {},
): ScheduleProposalDTO {
  const proposal = getScheduleProposal(userId, id);
  if (!proposal) throw new AppError(404, 'not_found', 'proposal not found');
  if (proposal.status !== 'draft') throw new AppError(409, 'proposal_not_draft', 'only draft proposals can be edited');
  const changeIndex = proposal.changes.findIndex((change) => change.changeKey === changeKey);
  if (changeIndex < 0) throw new AppError(404, 'not_found', 'proposal change not found');
  const start = parseManualScheduleDate(input.plannedStartAt, 'plannedStartAt');
  const end = parseManualScheduleDate(input.plannedEndAt, 'plannedEndAt');
  const durationMinutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  if (start >= end || durationMinutes < 15 || durationMinutes > 1440) {
    throw new AppError(400, 'invalid_schedule_change', 'manual schedule duration must be 15-1440 minutes');
  }
  const rangeStart = new Date(proposal.range.from);
  const rangeEnd = new Date(proposal.range.to);
  if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime()) || start < rangeStart || end > rangeEnd) {
    throw new AppError(400, 'invalid_schedule_change', 'manual schedule time must stay inside the proposal range');
  }
  const goal = getGoal(userId, proposal.goalId);
  if (!goal) throw new AppError(404, 'not_found', 'goal not found');
  const changes = proposal.changes.map((change) => ({
    ...change,
    ruleIds: [...change.ruleIds],
    avoidedBlocks: [...change.avoidedBlocks],
  }));
  const target = changes[changeIndex];
  const ruleList = listScheduleRules(userId).filter((rule) => rule.status === 'enabled' && scopedToGoal(rule, proposal.goalId));
  const ruleConflicts: ScheduleProposalConflictDTO[] = [];
  const ruleSlots = expandRuleBlocks(ruleList, { fromDate: rangeStart, toDate: rangeEnd }, ruleConflicts);
  const bufferMinutes = totalBufferMinutes(ruleList);
  const proposalTaskIds = new Set(changes.map((change) => change.taskId));
  const busySlots: BusySlot[] = [
    ...listExistingBusySlots(userId, proposal.goalId, proposal.range).map((slot) => ({ ...slot, end: addMinutes(slot.end, bufferMinutes) })),
    ...listGoalBusySlots(userId, proposal.goalId, proposal.range, proposalTaskIds).map((slot) => ({ ...slot, end: addMinutes(slot.end, bufferMinutes) })),
    ...ruleSlots,
    ...changes
      .filter((change) => change.changeKey !== target.changeKey)
      .map((change) => ({
        start: new Date(change.plannedStartAt),
        end: addMinutes(new Date(change.plannedEndAt), bufferMinutes),
        source: 'scheduled' as const,
        label: change.title,
      })),
  ].filter((slot) => !Number.isNaN(slot.start.getTime()) && !Number.isNaN(slot.end.getTime()) && slot.start < slot.end);
  const blocking = findBlockingSlot(busySlots, start, end);
  const ruleIds = new Set(target.ruleIds);
  if (blocking?.ruleId) ruleIds.add(blocking.ruleId);
  target.plannedStartAt = start.toISOString();
  target.plannedEndAt = end.toISOString();
  target.durationMinutes = durationMinutes;
  target.ruleIds = [...ruleIds];
  target.avoidedBlocks = blocking ? mapAvoidedBlocks([blocking]) : [];
  target.conflict = !!blocking;
  target.reason = blocking
    ? `Manually adjusted to this time, but it overlaps ${busySourceLabel(blocking.source)} "${blocking.label}".`
    : 'Manually adjusted to this time after server-side conflict validation.';
  const manualConflicts: ScheduleProposalConflictDTO[] = blocking
    ? [
        {
          type: 'manual_adjustment_conflict',
          severity: 'warning',
          taskId: target.taskId,
          ruleIds: blocking.ruleId ? [blocking.ruleId] : [],
          message: `Manual adjustment for "${target.title}" overlaps ${busySourceLabel(blocking.source)} "${blocking.label}".`,
          suggestions: ['Choose a free time slot before confirming this proposal change.'],
        },
      ]
    : [];
  const existingConflicts = proposal.conflicts.filter(
    (conflict) => conflict.type !== 'manual_adjustment_conflict' || conflict.taskId !== target.taskId,
  );
  const conflicts = mergeConflicts(mergeConflicts(existingConflicts, ruleConflicts), manualConflicts);
  db.prepare('UPDATE schedule_proposals SET changes_json = ?, conflicts_json = ?, risk_score = ? WHERE user_id = ? AND id = ?').run(
    JSON.stringify(changes),
    JSON.stringify(conflicts),
    riskScore(conflicts),
    userId,
    id,
  );
  return getScheduleProposal(userId, id)!;
}

export function confirmScheduleProposal(
  userId: string,
  id: string,
  input: { changeKeys?: unknown } = {},
): { proposal: ScheduleProposalDTO; tasks: ReturnType<typeof getTask>[] } {
  const proposal = getScheduleProposal(userId, id);
  if (!proposal) throw new AppError(404, 'not_found', 'proposal not found');
  if (proposal.status !== 'draft') throw new AppError(409, 'proposal_not_draft', 'only draft proposals can be confirmed');
  const selectedKeys = Array.isArray(input.changeKeys)
    ? new Set(input.changeKeys.filter((key): key is string => typeof key === 'string' && !!key))
    : null;
  if (selectedKeys && selectedKeys.size === 0) throw new AppError(400, 'no_changes_selected', 'select at least one proposal change to confirm');
  const ts = nowISO();
  const updatedIds = new Set<string>();
  const splitParents = new Set<string>();
  const changes = proposal.changes.map((change) => ({ ...change }));
  const selectedChanges = selectedKeys ? changes.filter((change) => selectedKeys.has(change.changeKey)) : changes;
  if (selectedChanges.length === 0) throw new AppError(400, 'no_changes_selected', 'selected proposal changes were not found');
  for (const change of changes) change.confirmed = selectedChanges.some((selected) => selected.changeKey === change.changeKey);
  db.exec('BEGIN');
  try {
    for (const change of selectedChanges) {
      if (change.operation === 'create_split_segment') {
        const parent = getTask(userId, change.taskId);
        if (!parent || parent.goalId !== proposal.goalId) throw new AppError(404, 'not_found', `task ${change.taskId} not found`);
        if (!splitParents.has(change.taskId)) {
          const clearInfo = db
            .prepare(
              `UPDATE tasks
               SET planned_start_at = NULL, planned_end_at = NULL, start_date = NULL, due_date = NULL, is_all_day = 1, updated_at = ?
               WHERE user_id = ? AND goal_id = ? AND id = ? AND deleted_at IS NULL`,
            )
            .run(ts, userId, proposal.goalId, change.taskId);
          if (clearInfo.changes === 0) throw new AppError(404, 'not_found', `task ${change.taskId} not found`);
          splitParents.add(change.taskId);
          updatedIds.add(change.taskId);
        }
        const child = createGoalTask(userId, proposal.goalId, {
          title: change.title,
          parentId: change.taskId,
          estimatedMinutes: change.durationMinutes,
          scheduleEnergyType: parent.scheduleEnergyType,
          scheduleTaskType: parent.scheduleTaskType,
          isSplittable: false,
          minScheduleMinutes: null,
          startDate: change.plannedStartAt,
          dueDate: change.plannedEndAt,
          isAllDay: false,
          source: 'schedule_split',
        });
        db.prepare('UPDATE tasks SET planned_start_at = ?, planned_end_at = ?, updated_at = ? WHERE user_id = ? AND id = ?').run(
          change.plannedStartAt,
          change.plannedEndAt,
          ts,
          userId,
          child.id,
        );
        change.createdTaskId = child.id;
        const stored = changes.find((item) => item.changeKey === change.changeKey);
        if (stored) stored.createdTaskId = child.id;
        updatedIds.add(child.id);
      } else {
        const info = db
          .prepare(
            `UPDATE tasks
             SET planned_start_at = ?, planned_end_at = ?, start_date = ?, due_date = ?, is_all_day = 0, updated_at = ?
             WHERE user_id = ? AND goal_id = ? AND id = ? AND deleted_at IS NULL`,
          )
          .run(change.plannedStartAt, change.plannedEndAt, change.plannedStartAt, change.plannedEndAt, ts, userId, proposal.goalId, change.taskId);
        if (info.changes === 0) {
          throw new AppError(404, 'not_found', `task ${change.taskId} not found`);
        }
        updatedIds.add(change.taskId);
      }
    }
    db.prepare('UPDATE schedule_proposals SET status = ?, confirmed_at = ?, changes_json = ? WHERE user_id = ? AND id = ?').run(
      'confirmed',
      ts,
      JSON.stringify(changes),
      userId,
      id,
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return {
    proposal: getScheduleProposal(userId, id)!,
    tasks: [...updatedIds].map((taskId) => getTask(userId, taskId)).filter(Boolean),
  };
}

export function undoScheduleProposal(userId: string, id: string): { proposal: ScheduleProposalDTO; tasks: ReturnType<typeof getTask>[] } {
  const proposal = getScheduleProposal(userId, id);
  if (!proposal) throw new AppError(404, 'not_found', 'proposal not found');
  if (proposal.status !== 'confirmed') throw new AppError(409, 'proposal_not_confirmed', 'only confirmed proposals can be undone');
  const ts = nowISO();
  const updatedIds = new Set<string>();
  const restoredSplitParents = new Set<string>();
  db.exec('BEGIN');
  try {
    for (const change of proposal.changes.filter((item) => item.confirmed)) {
      const snapshot = change as ScheduleProposalChangeDTO & {
        oldPlannedStartAt?: string | null;
        oldPlannedEndAt?: string | null;
        oldIsAllDay?: boolean;
      };
      const oldPlannedStartAt = snapshot.oldPlannedStartAt ?? change.oldStartDate ?? null;
      const oldPlannedEndAt = snapshot.oldPlannedEndAt ?? change.oldDueDate ?? null;
      const oldIsAllDay = typeof snapshot.oldIsAllDay === 'boolean' ? snapshot.oldIsAllDay : false;
      if (change.operation === 'create_split_segment') {
        if (!restoredSplitParents.has(change.taskId)) {
          const parentInfo = db
            .prepare(
              `UPDATE tasks
               SET planned_start_at = ?, planned_end_at = ?, start_date = ?, due_date = ?, is_all_day = ?, updated_at = ?
               WHERE user_id = ? AND goal_id = ? AND id = ? AND deleted_at IS NULL`,
            )
            .run(
              oldPlannedStartAt,
              oldPlannedEndAt,
              change.oldStartDate ?? null,
              change.oldDueDate ?? null,
              oldIsAllDay ? 1 : 0,
              ts,
              userId,
              proposal.goalId,
              change.taskId,
            );
          if (parentInfo.changes === 0) throw new AppError(404, 'not_found', `task ${change.taskId} not found`);
          restoredSplitParents.add(change.taskId);
          updatedIds.add(change.taskId);
        }
        if (!change.createdTaskId) throw new AppError(409, 'split_segment_missing', 'confirmed split proposal is missing created task ids');
        const childInfo = db
          .prepare(
            `UPDATE tasks
             SET deleted_at = ?, updated_at = ?
             WHERE user_id = ? AND goal_id = ? AND id = ? AND parent_id = ? AND source = 'schedule_split' AND deleted_at IS NULL`,
          )
          .run(ts, ts, userId, proposal.goalId, change.createdTaskId, change.taskId);
        if (childInfo.changes === 0) throw new AppError(404, 'not_found', `split segment ${change.createdTaskId} not found`);
      } else {
        const info = db
          .prepare(
            `UPDATE tasks
             SET planned_start_at = ?, planned_end_at = ?, start_date = ?, due_date = ?, is_all_day = ?, updated_at = ?
             WHERE user_id = ? AND goal_id = ? AND id = ? AND deleted_at IS NULL`,
          )
          .run(
            oldPlannedStartAt,
            oldPlannedEndAt,
            change.oldStartDate ?? null,
            change.oldDueDate ?? null,
            oldIsAllDay ? 1 : 0,
            ts,
            userId,
            proposal.goalId,
            change.taskId,
          );
        if (info.changes === 0) {
          throw new AppError(404, 'not_found', `task ${change.taskId} not found`);
        }
        updatedIds.add(change.taskId);
      }
    }
    db.prepare('UPDATE schedule_proposals SET status = ? WHERE user_id = ? AND id = ?').run('undone', userId, id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return {
    proposal: getScheduleProposal(userId, id)!,
    tasks: [...updatedIds].map((taskId) => getTask(userId, taskId)).filter(Boolean),
  };
}

export function discardScheduleProposal(userId: string, id: string): ScheduleProposalDTO {
  const proposal = getScheduleProposal(userId, id);
  if (!proposal) throw new AppError(404, 'not_found', 'proposal not found');
  if (proposal.status !== 'draft') throw new AppError(409, 'proposal_not_draft', 'only draft proposals can be discarded');
  db.prepare('UPDATE schedule_proposals SET status = ? WHERE user_id = ? AND id = ?').run('discarded', userId, id);
  return getScheduleProposal(userId, id)!;
}
