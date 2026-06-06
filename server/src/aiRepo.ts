import { randomUUID } from 'node:crypto';
import { db, nowISO } from './db';
import * as repo from './repo';
import * as scheduleRulesRepo from './scheduleRulesRepo';
import * as settings from './settingsRepo';
import {
  AppError,
  type AIBreakdownResultDTO,
  type AIBreakdownSuggestionDTO,
  type AIQuadrantSuggestionDTO,
  type AIQuadrantSuggestionResultDTO,
  type AIReviewResultDTO,
  type AIScheduleRuleParseResultDTO,
  type AIScheduleResultDTO,
  type AIScheduleSuggestionDTO,
  type AITaskStructureResultDTO,
  type AITaskStructureUpdateDTO,
  type Priority,
  type ScheduleEnergyType,
  type ScheduleRuleDraftDTO,
  type ScheduleRulePriority,
  type ScheduleRuleStatus,
  type ScheduleRuleType,
} from './types';

type OpenAIMessage = { role: 'system' | 'user'; content: string };

function logGeneration(input: {
  userId: string;
  scenario: string;
  provider: string | null;
  model: string | null;
  request: Record<string, unknown>;
  response?: unknown;
  status: 'success' | 'failed';
  error?: string | null;
}): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO ai_generation_logs
       (id, user_id, scenario, provider, model, request_json, response_json, status, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.userId,
    input.scenario,
    input.provider,
    input.model,
    JSON.stringify(input.request),
    input.response == null ? null : JSON.stringify(input.response),
    input.status,
    input.error ?? null,
    nowISO(),
  );
  return id;
}

function requireConfigured(userId: string): { provider: string; baseUrl: string; model: string; key: string } {
  const cfg = settings.getSettings(userId).ai;
  const key = settings.getRawApiKey(userId);
  if (!cfg.enabled) throw new AppError(409, 'ai_disabled', 'AI is disabled in settings');
  if (!cfg.baseUrl || !cfg.model || !key) {
    throw new AppError(409, 'ai_not_configured', 'AI provider, model, base URL and API key are required');
  }
  return { provider: cfg.provider || 'openai-compatible', baseUrl: cfg.baseUrl, model: cfg.model, key };
}

function normalizePriority(value: unknown): Priority {
  const n = Number(value);
  return ([0, 1, 2, 3] as Priority[]).includes(n as Priority) ? (n as Priority) : 0;
}

function normalizeSuggestion(value: unknown): AIBreakdownSuggestionDTO | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.title !== 'string' || !row.title.trim()) return null;
  const minutes = row.estimatedMinutes == null ? null : Number(row.estimatedMinutes);
  const estimatedMinutes = minutes != null && Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null;
  return {
    title: row.title.trim().slice(0, 160),
    note: typeof row.note === 'string' && row.note.trim() ? row.note.trim().slice(0, 1000) : null,
    estimatedMinutes,
    priority: normalizePriority(row.priority),
  };
}

function parseSuggestions(content: string): AIBreakdownSuggestionDTO[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new AppError(502, 'ai_invalid_response', 'AI response was not valid JSON');
    parsed = JSON.parse(match[0]);
  }
  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>)?.subtasks)
      ? ((parsed as Record<string, unknown>).subtasks as unknown[])
      : [];
  const suggestions = rawList.map(normalizeSuggestion).filter((item): item is AIBreakdownSuggestionDTO => !!item).slice(0, 12);
  if (!suggestions.length) throw new AppError(502, 'ai_invalid_response', 'AI did not return usable subtasks');
  return suggestions;
}

function normalizeQuadrantSuggestion(value: unknown): AIQuadrantSuggestionDTO | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.isImportant !== 'boolean' || typeof row.isUrgent !== 'boolean') return null;
  const confidenceRaw = Number(row.confidence ?? 0.7);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0.7;
  return {
    isImportant: row.isImportant,
    isUrgent: row.isUrgent,
    confidence,
    reason: typeof row.reason === 'string' && row.reason.trim() ? row.reason.trim().slice(0, 1000) : null,
  };
}

function parseQuadrantSuggestion(content: string): AIQuadrantSuggestionDTO {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new AppError(502, 'ai_invalid_response', 'AI response was not valid JSON');
    parsed = JSON.parse(match[0]);
  }
  const row = (parsed as Record<string, unknown>)?.suggestion ?? parsed;
  const suggestion = normalizeQuadrantSuggestion(row);
  if (!suggestion) throw new AppError(502, 'ai_invalid_response', 'AI did not return a usable quadrant suggestion');
  return suggestion;
}

function strList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 500))
    .slice(0, limit);
}

function parseReview(content: string, fallbackMetrics: AIReviewResultDTO['metrics']): Omit<AIReviewResultDTO, 'logId' | 'range' | 'metrics'> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new AppError(502, 'ai_invalid_response', 'AI response was not valid JSON');
    parsed = JSON.parse(match[0]);
  }
  const row = parsed as Record<string, unknown>;
  const summary = typeof row.summary === 'string' && row.summary.trim() ? row.summary.trim().slice(0, 1200) : '';
  const nextActionsRaw = Array.isArray(row.nextActions) ? row.nextActions : [];
  const nextActions = nextActionsRaw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const action = item as Record<string, unknown>;
      if (typeof action.title !== 'string' || !action.title.trim()) return null;
      return {
        title: action.title.trim().slice(0, 160),
        reason: typeof action.reason === 'string' && action.reason.trim() ? action.reason.trim().slice(0, 500) : null,
      };
    })
    .filter((item): item is { title: string; reason: string | null } => !!item)
    .slice(0, 6);
  if (!summary) throw new AppError(502, 'ai_invalid_response', 'AI review did not include a summary');
  return {
    summary,
    wins: strList(row.wins, 6),
    risks: strList(row.risks, 6),
    suggestions: strList(row.suggestions, 6),
    nextActions:
      nextActions.length > 0
        ? nextActions
        : [{ title: fallbackMetrics.openOverdueTasks > 0 ? '处理逾期任务' : '规划下一轮重点', reason: null }],
  };
}

function parseScheduleSuggestions(content: string, allowedTaskIds: Set<string>): AIScheduleSuggestionDTO[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new AppError(502, 'ai_invalid_response', 'AI response was not valid JSON');
    parsed = JSON.parse(match[0]);
  }
  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>)?.suggestions)
      ? ((parsed as Record<string, unknown>).suggestions as unknown[])
      : [];
  const suggestions = rawList
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      if (typeof row.taskId !== 'string' || !allowedTaskIds.has(row.taskId)) return null;
      if (typeof row.plannedStartAt !== 'string' || typeof row.plannedEndAt !== 'string') return null;
      const startMs = Date.parse(row.plannedStartAt);
      const endMs = Date.parse(row.plannedEndAt);
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
      if (startMs >= endMs) return null;
      return {
        taskId: row.taskId,
        title: typeof row.title === 'string' && row.title.trim() ? row.title.trim().slice(0, 160) : row.taskId,
        plannedStartAt: row.plannedStartAt,
        plannedEndAt: row.plannedEndAt,
        reason: typeof row.reason === 'string' && row.reason.trim() ? row.reason.trim().slice(0, 500) : null,
      };
    })
    .filter((item): item is AIScheduleSuggestionDTO => !!item)
    .slice(0, 20);
  if (!suggestions.length) throw new AppError(502, 'ai_invalid_response', 'AI did not return usable schedule suggestions');
  return suggestions;
}

function normalizeScheduleEnergyType(value: unknown): ScheduleEnergyType | null {
  return value === 'high' || value === 'medium' || value === 'low' ? value : null;
}

function normalizeScheduleMinutes(value: unknown): number | null {
  if (value == null) return null;
  const n = Math.round(Number(value));
  return Number.isInteger(n) && n >= 15 && n <= 1440 ? n : null;
}

function normalizeTaskStructureUpdate(value: unknown, allowedTaskIds: Set<string>): AITaskStructureUpdateDTO | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.taskId !== 'string' || !allowedTaskIds.has(row.taskId)) return null;
  const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim().slice(0, 160) : row.taskId;
  const isSplittable = row.isSplittable === true;
  const estimatedMinutes = normalizeScheduleMinutes(row.estimatedMinutes);
  const minScheduleMinutes = isSplittable ? normalizeScheduleMinutes(row.minScheduleMinutes) : null;
  return {
    taskId: row.taskId,
    title,
    estimatedMinutes,
    scheduleEnergyType: normalizeScheduleEnergyType(row.scheduleEnergyType),
    scheduleTaskType: typeof row.scheduleTaskType === 'string' && row.scheduleTaskType.trim() ? row.scheduleTaskType.trim().slice(0, 80) : null,
    isSplittable,
    minScheduleMinutes,
    reason: typeof row.reason === 'string' && row.reason.trim() ? row.reason.trim().slice(0, 500) : null,
  };
}

const SCHEDULE_RULE_TYPES: ScheduleRuleType[] = [
  'time_boundary',
  'energy_preference',
  'fixed_habit',
  'buffer',
  'task_category',
  'reminder',
  'plan_priority',
];
const SCHEDULE_RULE_STATUSES: ScheduleRuleStatus[] = ['enabled', 'disabled'];
const SCHEDULE_RULE_PRIORITIES: ScheduleRulePriority[] = ['hard', 'normal', 'preference'];

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function normalizeScheduleRuleDraft(value: unknown): ScheduleRuleDraftDTO | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 120) : '';
  if (!name) return null;
  const type = SCHEDULE_RULE_TYPES.includes(row.type as ScheduleRuleType) ? (row.type as ScheduleRuleType) : null;
  if (!type) return null;
  const status = SCHEDULE_RULE_STATUSES.includes(row.status as ScheduleRuleStatus) ? (row.status as ScheduleRuleStatus) : 'enabled';
  const priority = SCHEDULE_RULE_PRIORITIES.includes(row.priority as ScheduleRulePriority) ? (row.priority as ScheduleRulePriority) : 'normal';
  return {
    name,
    description: typeof row.description === 'string' && row.description.trim() ? row.description.trim().slice(0, 500) : null,
    type,
    status,
    priority,
    condition: plainObject(row.condition),
    action: plainObject(row.action),
    scope: plainObject(row.scope),
  };
}

function parseScheduleRuleDraft(content: string): Omit<AIScheduleRuleParseResultDTO, 'logId' | 'text'> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new AppError(502, 'ai_invalid_response', 'AI response was not valid JSON');
    parsed = JSON.parse(match[0]);
  }
  const row = parsed as Record<string, unknown>;
  const rule = normalizeScheduleRuleDraft(row.rule ?? parsed);
  if (!rule) throw new AppError(502, 'ai_invalid_response', 'AI did not return a usable schedule rule');
  const confidenceRaw = Number(row.confidence ?? 0.7);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0.7;
  return {
    rule,
    explanation: typeof row.explanation === 'string' && row.explanation.trim() ? row.explanation.trim().slice(0, 800) : null,
    confidence,
  };
}

function parseTaskStructureUpdates(content: string, allowedTaskIds: Set<string>): AITaskStructureUpdateDTO[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new AppError(502, 'ai_invalid_response', 'AI response was not valid JSON');
    parsed = JSON.parse(match[0]);
  }
  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>)?.tasks)
      ? ((parsed as Record<string, unknown>).tasks as unknown[])
      : [];
  const seen = new Set<string>();
  const updates: AITaskStructureUpdateDTO[] = [];
  for (const item of rawList) {
    const update = normalizeTaskStructureUpdate(item, allowedTaskIds);
    if (!update || seen.has(update.taskId)) continue;
    seen.add(update.taskId);
    updates.push(update);
  }
  if (!updates.length) throw new AppError(502, 'ai_invalid_response', 'AI did not return usable task structure updates');
  return updates;
}

function defaultReviewRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 6);
  from.setHours(0, 0, 0, 0);
  to.setHours(23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}

function normalizeRange(input: { from?: string | null; to?: string | null }): { from: string; to: string } {
  const def = defaultReviewRange();
  const from = input.from ?? def.from;
  const to = input.to ?? def.to;
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || from > to) {
    throw new AppError(400, 'invalid', 'from/to must be valid ISO date strings');
  }
  return { from, to };
}

function defaultScheduleRange(): { from: string; to: string } {
  const from = new Date();
  from.setHours(9, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 6);
  to.setHours(18, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}

function normalizeScheduleRange(input: { from?: string | null; to?: string | null }): { from: string; to: string } {
  const def = defaultScheduleRange();
  return normalizeRange({ from: input.from ?? def.from, to: input.to ?? def.to });
}

function reviewContext(userId: string, range: { from: string; to: string }): { metrics: AIReviewResultDTO['metrics']; samples: Record<string, unknown> } {
  const completed = db
    .prepare(
      `SELECT title, priority, completed_at
       FROM tasks
       WHERE user_id = ? AND completed = 1 AND deleted_at IS NULL AND completed_at >= ? AND completed_at <= ?
       ORDER BY completed_at DESC LIMIT 20`,
    )
    .all(userId, range.from, range.to) as Array<{ title: string; priority: number; completed_at: string }>;
  const overdue = db
    .prepare(
      `SELECT title, priority, due_date
       FROM tasks
       WHERE user_id = ? AND completed = 0 AND deleted_at IS NULL AND due_date IS NOT NULL AND due_date < ?
       ORDER BY priority DESC, due_date ASC LIMIT 20`,
    )
    .all(userId, range.to) as Array<{ title: string; priority: number; due_date: string }>;
  const focus = db
    .prepare(
      `SELECT COUNT(*) count, COALESCE(SUM(duration_sec), 0) duration
       FROM focus_sessions
       WHERE user_id = ? AND ended_at >= ? AND ended_at <= ?`,
    )
    .get(userId, range.from, range.to) as { count: number; duration: number };
  const habit = db
    .prepare(
      `SELECT COUNT(*) checkins
       FROM habit_checkins
       WHERE user_id = ? AND date >= substr(?, 1, 10) AND date <= substr(?, 1, 10)`,
    )
    .get(userId, range.from, range.to) as { checkins: number };
  const goals = db
    .prepare(
      `SELECT
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) active,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) completed
       FROM goals WHERE user_id = ?`,
    )
    .get(userId) as { active: number | null; completed: number | null };
  const metrics = {
    completedTasks: completed.length,
    openOverdueTasks: overdue.length,
    focusMinutes: Math.round((focus.duration ?? 0) / 60),
    focusSessions: focus.count ?? 0,
    habitCheckins: habit.checkins ?? 0,
    activeGoals: goals.active ?? 0,
    completedGoals: goals.completed ?? 0,
  };
  return {
    metrics,
    samples: {
      completedTasks: completed,
      overdueTasks: overdue,
      focus,
      habit,
      goals,
    },
  };
}

async function callChatCompletions(input: {
  baseUrl: string;
  key: string;
  model: string;
  messages: OpenAIMessage[];
}): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const response = await fetch(`${input.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      throw new AppError(response.status >= 500 ? 502 : 400, 'ai_provider_error', `AI provider returned HTTP ${response.status}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function contentFromChatResponse(body: unknown): string {
  const choices = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new AppError(502, 'ai_invalid_response', 'AI response content is empty');
  return content;
}

export async function breakdownTask(
  userId: string,
  input: { taskId?: string | null; title?: string | null; note?: string | null; maxItems?: number | null },
): Promise<AIBreakdownResultDTO> {
  const cfg = requireConfigured(userId);
  const task = input.taskId ? repo.getTask(userId, input.taskId) : null;
  if (input.taskId && !task) throw new AppError(404, 'not_found', 'task not found');
  const title = (task?.title ?? input.title ?? '').trim();
  if (!title) throw new AppError(400, 'invalid', 'task title is required');
  const note = task?.note ?? input.note ?? null;
  const maxItems = Math.min(12, Math.max(2, Math.round(Number(input.maxItems ?? 6))));
  const request = {
    taskId: task?.id ?? null,
    title,
    note,
    maxItems,
  };
  const messages: OpenAIMessage[] = [
    {
      role: 'system',
      content:
        'You decompose a task into concrete subtasks. Return only JSON with key "subtasks". Each subtask must have title, optional note, optional estimatedMinutes, and priority 0-3. Do not add markdown.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        title,
        note,
        maxItems,
        outputSchema: {
          subtasks: [{ title: 'string', note: 'string|null', estimatedMinutes: 'number|null', priority: '0|1|2|3' }],
        },
      }),
    },
  ];
  try {
    const response = await callChatCompletions({ ...cfg, messages });
    const suggestions = parseSuggestions(contentFromChatResponse(response));
    const logId = logGeneration({
      userId,
      scenario: 'task_breakdown',
      provider: cfg.provider,
      model: cfg.model,
      request,
      response: { suggestions, providerResponse: response },
      status: 'success',
    });
    return { logId, suggestions };
  } catch (e) {
    if (e instanceof AppError && (e.code === 'ai_disabled' || e.code === 'ai_not_configured' || e.code === 'not_found')) throw e;
    const logId = logGeneration({
      userId,
      scenario: 'task_breakdown',
      provider: cfg.provider,
      model: cfg.model,
      request,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    });
    if (e instanceof AppError) throw new AppError(e.status, e.code, `${e.message}; logId=${logId}`);
    throw new AppError(502, 'ai_provider_error', `AI task breakdown failed; logId=${logId}`);
  }
}

export async function suggestQuadrant(userId: string, input: { taskId?: string | null }): Promise<AIQuadrantSuggestionResultDTO> {
  const cfg = requireConfigured(userId);
  if (!input.taskId) throw new AppError(400, 'invalid', 'taskId is required');
  const task = repo.getTask(userId, input.taskId);
  if (!task) throw new AppError(404, 'not_found', 'task not found');
  const request = {
    taskId: task.id,
    title: task.title,
    note: task.note,
    dueDate: task.dueDate,
    priority: task.priority,
    estimatedMinutes: task.estimatedMinutes,
    current: { isImportant: task.isImportant, isUrgent: task.isUrgent },
  };
  const messages: OpenAIMessage[] = [
    {
      role: 'system',
      content:
        'You classify a task for an Eisenhower matrix. Return only JSON with key "suggestion". The suggestion must include boolean isImportant, boolean isUrgent, confidence 0-1, and a short reason. Do not change priority or due date.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: request,
        outputSchema: {
          suggestion: { isImportant: 'boolean', isUrgent: 'boolean', confidence: 'number 0..1', reason: 'string|null' },
        },
      }),
    },
  ];
  try {
    const response = await callChatCompletions({ ...cfg, messages });
    const suggestion = parseQuadrantSuggestion(contentFromChatResponse(response));
    const logId = logGeneration({
      userId,
      scenario: 'quadrant_suggestion',
      provider: cfg.provider,
      model: cfg.model,
      request,
      response: { suggestion, providerResponse: response },
      status: 'success',
    });
    return {
      logId,
      taskId: task.id,
      current: { isImportant: task.isImportant, isUrgent: task.isUrgent },
      suggestion,
    };
  } catch (e) {
    if (e instanceof AppError && (e.code === 'ai_disabled' || e.code === 'ai_not_configured' || e.code === 'not_found')) throw e;
    const logId = logGeneration({
      userId,
      scenario: 'quadrant_suggestion',
      provider: cfg.provider,
      model: cfg.model,
      request,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    });
    if (e instanceof AppError) throw new AppError(e.status, e.code, `${e.message}; logId=${logId}`);
    throw new AppError(502, 'ai_provider_error', `AI quadrant suggestion failed; logId=${logId}`);
  }
}

export async function weeklyReview(userId: string, input: { from?: string | null; to?: string | null }): Promise<AIReviewResultDTO> {
  const cfg = requireConfigured(userId);
  const range = normalizeRange(input);
  const context = reviewContext(userId, range);
  const request = {
    range,
    metrics: context.metrics,
    samples: context.samples,
  };
  const messages: OpenAIMessage[] = [
    {
      role: 'system',
      content:
        'You are a productivity review assistant. Return only JSON with summary, wins, risks, suggestions, and nextActions. Be concise, specific, and grounded only in the provided metrics and samples.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        reviewRange: range,
        reviewMetrics: context.metrics,
        samples: context.samples,
        outputSchema: {
          summary: 'string',
          wins: ['string'],
          risks: ['string'],
          suggestions: ['string'],
          nextActions: [{ title: 'string', reason: 'string|null' }],
        },
      }),
    },
  ];
  try {
    const response = await callChatCompletions({ ...cfg, messages });
    const parsed = parseReview(contentFromChatResponse(response), context.metrics);
    const logId = logGeneration({
      userId,
      scenario: 'weekly_review',
      provider: cfg.provider,
      model: cfg.model,
      request,
      response: { ...parsed, providerResponse: response },
      status: 'success',
    });
    return { logId, range, metrics: context.metrics, ...parsed };
  } catch (e) {
    if (e instanceof AppError && (e.code === 'ai_disabled' || e.code === 'ai_not_configured')) throw e;
    const logId = logGeneration({
      userId,
      scenario: 'weekly_review',
      provider: cfg.provider,
      model: cfg.model,
      request,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    });
    if (e instanceof AppError) throw new AppError(e.status, e.code, `${e.message}; logId=${logId}`);
    throw new AppError(502, 'ai_provider_error', `AI weekly review failed; logId=${logId}`);
  }
}

export async function parseScheduleRuleNaturalLanguage(
  userId: string,
  input: { text?: string | null },
): Promise<AIScheduleRuleParseResultDTO> {
  const cfg = requireConfigured(userId);
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) throw new AppError(400, 'invalid', 'text is required');
  if (text.length > 500) throw new AppError(400, 'invalid', 'text must be at most 500 characters');
  const request = {
    text,
    supportedTypes: SCHEDULE_RULE_TYPES,
    supportedPriorities: SCHEDULE_RULE_PRIORITIES,
  };
  const messages: OpenAIMessage[] = [
    {
      role: 'system',
      content:
        'You parse a personal scheduling rule into a structured rule draft. Return only JSON with keys rule, explanation, and confidence. Do not create or save anything. Supported rule.type values are time_boundary, energy_preference, fixed_habit, buffer, task_category, reminder, plan_priority. For time_boundary and fixed_habit include condition.startTime, condition.endTime as HH:mm and optional condition.daysOfWeek numbers 0-6, with action.effect="block". For buffer include action.minutes. For reminder include action.minutesBefore. For energy_preference include condition.energyType high|medium|low and action.effect="prefer". Use priority hard|normal|preference and status enabled|disabled.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        ruleParseRequest: request,
        outputSchema: {
          rule: {
            name: 'string',
            description: 'string|null',
            type: 'time_boundary|energy_preference|fixed_habit|buffer|task_category|reminder|plan_priority',
            status: 'enabled|disabled',
            priority: 'hard|normal|preference',
            condition: 'object',
            action: 'object',
            scope: 'object',
          },
          explanation: 'string|null',
          confidence: 'number 0..1',
        },
      }),
    },
  ];
  try {
    const response = await callChatCompletions({ ...cfg, messages });
    const parsed = parseScheduleRuleDraft(contentFromChatResponse(response));
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 7);
    scheduleRulesRepo.previewScheduleRule(userId, { ...parsed.rule, from: from.toISOString(), to: to.toISOString() });
    const logId = logGeneration({
      userId,
      scenario: 'schedule_rule_parse',
      provider: cfg.provider,
      model: cfg.model,
      request,
      response: { ...parsed, providerResponse: response },
      status: 'success',
    });
    return { logId, text, ...parsed };
  } catch (e) {
    if (e instanceof AppError && (e.code === 'ai_disabled' || e.code === 'ai_not_configured')) throw e;
    const logId = logGeneration({
      userId,
      scenario: 'schedule_rule_parse',
      provider: cfg.provider,
      model: cfg.model,
      request,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    });
    if (e instanceof AppError) throw new AppError(e.status, e.code, `${e.message}; logId=${logId}`);
    throw new AppError(502, 'ai_provider_error', `AI schedule rule parsing failed; logId=${logId}`);
  }
}

export async function structureGoalTasks(
  userId: string,
  input: { goalId?: string | null; taskIds?: string[] | null },
): Promise<AITaskStructureResultDTO> {
  const cfg = requireConfigured(userId);
  if (!input.goalId) throw new AppError(400, 'invalid', 'goalId is required');
  const tree = repo.getGoalTree(userId, input.goalId);
  if (!tree) throw new AppError(404, 'not_found', 'goal not found');
  const requestedIds = Array.isArray(input.taskIds) && input.taskIds.length > 0
    ? new Set(input.taskIds.filter((id): id is string => typeof id === 'string' && !!id))
    : null;
  let tasks = tree.tasks.filter((task) => task.status !== 'done' && task.status !== 'skipped');
  if (requestedIds) {
    tasks = tasks.filter((task) => requestedIds.has(task.id));
    if (tasks.length !== requestedIds.size) throw new AppError(404, 'not_found', 'one or more tasks were not found in the goal');
  }
  tasks = tasks.slice(0, 30);
  if (!tasks.length) throw new AppError(400, 'invalid', 'no goal tasks found to structure');
  const taskPayload = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    note: task.note,
    priority: task.priority,
    dueDate: task.dueDate,
    estimatedMinutes: task.estimatedMinutes,
    scheduleEnergyType: task.scheduleEnergyType,
    scheduleTaskType: task.scheduleTaskType,
    isSplittable: task.isSplittable,
    minScheduleMinutes: task.minScheduleMinutes,
  }));
  const request = {
    goal: {
      id: tree.goal.id,
      title: tree.goal.title,
      description: tree.goal.description,
      startAt: tree.goal.startAt,
      deadlineAt: tree.goal.deadlineAt,
    },
    tasks: taskPayload,
  };
  const messages: OpenAIMessage[] = [
    {
      role: 'system',
      content:
        'You structure plan tasks for calendar scheduling. Return only JSON with key "tasks". For each task include taskId, title, estimatedMinutes, scheduleEnergyType (high|medium|low|null), scheduleTaskType, isSplittable, minScheduleMinutes, and reason. Do not invent task IDs.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        taskStructureRequest: request,
        outputSchema: {
          tasks: [
            {
              taskId: 'string from input',
              title: 'string',
              estimatedMinutes: 'integer 15..1440|null',
              scheduleEnergyType: 'high|medium|low|null',
              scheduleTaskType: 'string|null',
              isSplittable: 'boolean',
              minScheduleMinutes: 'integer 15..1440|null',
              reason: 'string|null',
            },
          ],
        },
      }),
    },
  ];
  try {
    const response = await callChatCompletions({ ...cfg, messages });
    const updates = parseTaskStructureUpdates(contentFromChatResponse(response), new Set(tasks.map((task) => task.id)));
    const updatedTasks = updates.map((update) =>
      repo.updateTask(userId, update.taskId, {
        estimatedMinutes: update.estimatedMinutes,
        scheduleEnergyType: update.scheduleEnergyType,
        scheduleTaskType: update.scheduleTaskType,
        isSplittable: update.isSplittable,
        minScheduleMinutes: update.minScheduleMinutes,
      }),
    ).filter((task): task is NonNullable<typeof task> => !!task);
    const logId = logGeneration({
      userId,
      scenario: 'goal_task_structure',
      provider: cfg.provider,
      model: cfg.model,
      request,
      response: { updates, providerResponse: response },
      status: 'success',
    });
    return { logId, goalId: tree.goal.id, updates, tasks: updatedTasks };
  } catch (e) {
    if (e instanceof AppError && (e.code === 'ai_disabled' || e.code === 'ai_not_configured' || e.code === 'not_found')) throw e;
    const logId = logGeneration({
      userId,
      scenario: 'goal_task_structure',
      provider: cfg.provider,
      model: cfg.model,
      request,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    });
    if (e instanceof AppError) throw new AppError(e.status, e.code, `${e.message}; logId=${logId}`);
    throw new AppError(502, 'ai_provider_error', `AI task structure failed; logId=${logId}`);
  }
}

export async function scheduleSuggestions(
  userId: string,
  input: { goalId?: string | null; taskIds?: string[] | null; from?: string | null; to?: string | null },
): Promise<AIScheduleResultDTO> {
  const cfg = requireConfigured(userId);
  const range = normalizeScheduleRange(input);
  let tasks: any[] = [];
  if (input.goalId) {
    tasks = db
      .prepare(
        `SELECT id, title, priority, due_date, estimated_minutes, planned_start_at, planned_end_at, dependency_task_ids
         FROM tasks
         WHERE user_id = ? AND goal_id = ? AND completed = 0 AND deleted_at IS NULL
         ORDER BY level ASC, priority DESC, created_at ASC LIMIT 30`,
      )
      .all(userId, input.goalId) as any[];
  } else if (Array.isArray(input.taskIds) && input.taskIds.length > 0) {
    const ids = Array.from(new Set(input.taskIds.filter((id) => typeof id === 'string' && id)));
    const ph = ids.map(() => '?').join(',');
    tasks = db
      .prepare(
        `SELECT id, title, priority, due_date, estimated_minutes, planned_start_at, planned_end_at, dependency_task_ids
         FROM tasks
         WHERE user_id = ? AND id IN (${ph}) AND completed = 0 AND deleted_at IS NULL
         ORDER BY priority DESC, created_at ASC LIMIT 30`,
      )
      .all(userId, ...ids) as any[];
    if (tasks.length !== ids.length) throw new AppError(404, 'not_found', 'one or more tasks were not found');
  } else {
    tasks = db
      .prepare(
        `SELECT id, title, priority, due_date, estimated_minutes, planned_start_at, planned_end_at, dependency_task_ids
         FROM tasks
         WHERE user_id = ? AND completed = 0 AND deleted_at IS NULL AND due_date IS NOT NULL
         ORDER BY priority DESC, due_date ASC LIMIT 30`,
      )
      .all(userId) as any[];
  }
  if (!tasks.length) throw new AppError(400, 'invalid', 'no schedulable tasks found');
  const events = db
    .prepare(
      `SELECT title, starts_at, ends_at, is_all_day
       FROM external_calendar_events
       WHERE user_id = ? AND starts_at <= ? AND ends_at >= ?
       ORDER BY starts_at ASC LIMIT 50`,
    )
    .all(userId, range.to, range.from) as any[];
  const request = { range, goalId: input.goalId ?? null, tasks, externalEvents: events };
  const messages: OpenAIMessage[] = [
    {
      role: 'system',
      content:
        'You create advisory calendar schedule suggestions. Return only JSON with key "suggestions". Each suggestion must include taskId, title, plannedStartAt, plannedEndAt, and reason. Do not create tasks. Avoid overlapping provided external events.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        scheduleRange: range,
        schedulableTasks: tasks,
        externalEvents: events,
        outputSchema: {
          suggestions: [{ taskId: 'string', title: 'string', plannedStartAt: 'ISO string', plannedEndAt: 'ISO string', reason: 'string|null' }],
        },
      }),
    },
  ];
  try {
    const response = await callChatCompletions({ ...cfg, messages });
    const suggestions = parseScheduleSuggestions(contentFromChatResponse(response), new Set(tasks.map((task) => task.id)));
    const logId = logGeneration({
      userId,
      scenario: 'schedule_suggestion',
      provider: cfg.provider,
      model: cfg.model,
      request,
      response: { suggestions, providerResponse: response },
      status: 'success',
    });
    return { logId, goalId: input.goalId ?? null, range, suggestions };
  } catch (e) {
    if (e instanceof AppError && (e.code === 'ai_disabled' || e.code === 'ai_not_configured' || e.code === 'not_found')) throw e;
    const logId = logGeneration({
      userId,
      scenario: 'schedule_suggestion',
      provider: cfg.provider,
      model: cfg.model,
      request,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    });
    if (e instanceof AppError) throw new AppError(e.status, e.code, `${e.message}; logId=${logId}`);
    throw new AppError(502, 'ai_provider_error', `AI schedule suggestion failed; logId=${logId}`);
  }
}
