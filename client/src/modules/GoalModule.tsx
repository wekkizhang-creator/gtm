import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { aiConfigurationIssue } from '../aiGuide';
import { buildGoalDetailSummary } from '../goalDetailSummary';
import { GOAL_STATUS_LABELS, goalCanAutoSchedule, goalStatusActions } from '../goalStatus';
import { buildGoalTaskDependencyState } from '../goalTaskDependencies';
import { buildGoalTaskCreateInput, buildGoalTaskEditPatch } from '../goalTaskForm';
import { GOAL_TASK_STATUS_LABELS, goalTaskDisplayStatus, goalTaskStatusActions } from '../goalTaskStatus';
import { buildGoalTaskStructureSummary, type GoalTaskStructureSummaryItem } from '../goalTaskStructureSummary';
import {
  buildScheduleProposalManualDragPatch,
  buildScheduleProposalManualShift,
  getScheduleProposalDragMaxOffsetMinutes,
  getScheduleProposalStartOffsetMinutes,
  listManualAdjustmentConflicts,
} from '../scheduleProposalManualAdjust';
import { buildScheduleProposalImpact } from '../scheduleProposalImpact';
import { buildScheduleProposalRegenerateInput } from '../scheduleProposalRegenerate';
import { buildScheduleRuleConflictActions, type ScheduleRuleConflictAction } from '../scheduleRuleConflictActions';
import { buildScheduleRuleEditProposalInput, type ScheduleRuleEditApplyMode } from '../scheduleRuleEditEffect';
import { useSettings } from '../settings';
import { PRIORITY_LABELS, dateInputToISO, isoToDateInput } from '../util';
import type {
  AIScheduleResult,
  AIScheduleSuggestion,
  AIScheduleRuleParseResult,
  DayPilotDashboard,
  Goal,
  GoalTaskScheduleInsight,
  PersonalScheduleRule,
  Priority,
  ScheduleEnergyType,
  ScheduleProposal,
  ScheduleRuleDraft,
  ScheduleRuleConflictList,
  ScheduleRuleDetails,
  ScheduleRuleImpactAnalysis,
  ScheduleRulePreview,
  ScheduleRulePriority,
  ScheduleRuleStatus,
  ScheduleRuleTemplate,
  ScheduleRuleType,
  Task,
} from '../types';

const DAY_OPTIONS = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 0, label: '日' },
];

const RULE_TYPE_LABELS: Record<ScheduleRuleType, string> = {
  time_boundary: '时间边界',
  energy_preference: '精力偏好',
  fixed_habit: '固定习惯',
  buffer: '缓冲时间',
  task_category: '任务分类',
  reminder: '提醒',
  plan_priority: '计划优先级',
};

const RULE_PRIORITY_LABELS: Record<ScheduleRulePriority, string> = {
  hard: '硬约束',
  normal: '普通',
  preference: '偏好',
};

const RULE_STATUS_LABELS: Record<ScheduleRuleStatus, string> = {
  enabled: '启用',
  disabled: '停用',
};

const RULE_IMPACT_RECOMMENDATION_LABELS: Record<ScheduleRuleImpactAnalysis['rules'][number]['recommendation'], string> = {
  loosen_rule: '建议放宽',
  review_conflicts: '复查冲突',
  keep_rule: '保持规则',
  unused_rule: '暂未命中',
};

const ENERGY_LABELS: Record<ScheduleEnergyType, string> = {
  high: '高精力',
  medium: '中等',
  low: '低精力',
};

const GOAL_PRIORITY_VALUES: Priority[] = [0, 1, 2, 3];

const AVOIDED_SOURCE_LABELS: Record<'task' | 'external' | 'rule' | 'scheduled', string> = {
  task: '已有任务',
  external: '外部日程',
  rule: '个人规则',
  scheduled: '本次方案',
};

function formatDateTime(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

function isoToDateTimeLocalValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function dateTimeLocalValueToISO(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function weekdayLabel(rule: PersonalScheduleRule): string {
  const days = rule.condition.daysOfWeek;
  if (!Array.isArray(days) || days.length === 0) return '每天';
  return DAY_OPTIONS.filter((day) => days.includes(day.value))
    .map((day) => day.label)
    .join(' ');
}

function blockingDependencyText(task: { blockingDependencies: Array<{ title: string }> }): string {
  return task.blockingDependencies.map((dependency) => dependency.title).join('、');
}

export default function GoalModule() {
  const { settings } = useSettings();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [scheduleInsights, setScheduleInsights] = useState<GoalTaskScheduleInsight[]>([]);
  const [dashboard, setDashboard] = useState<DayPilotDashboard | null>(null);
  const [scheduleRules, setScheduleRules] = useState<PersonalScheduleRule[]>([]);
  const [deletedScheduleRules, setDeletedScheduleRules] = useState<PersonalScheduleRule[]>([]);
  const [scheduleRuleTemplates, setScheduleRuleTemplates] = useState<ScheduleRuleTemplate[]>([]);
  const [proposal, setProposal] = useState<ScheduleProposal | null>(null);
  const [recentConfirmedProposal, setRecentConfirmedProposal] = useState<ScheduleProposal | null>(null);
  const [selectedProposalChangeKeys, setSelectedProposalChangeKeys] = useState<Set<string>>(new Set());
  const [proposalEditDrafts, setProposalEditDrafts] = useState<Record<string, { start: string; end: string }>>({});
  const [ruleConflicts, setRuleConflicts] = useState<ScheduleRuleConflictList | null>(null);
  const [ruleDetails, setRuleDetails] = useState<ScheduleRuleDetails | null>(null);
  const [ruleImpactAnalysis, setRuleImpactAnalysis] = useState<ScheduleRuleImpactAnalysis | null>(null);
  const [rulePreview, setRulePreview] = useState<ScheduleRulePreview | null>(null);
  const [deletePreviewRule, setDeletePreviewRule] = useState<PersonalScheduleRule | null>(null);
  const [deletePreview, setDeletePreview] = useState<ScheduleRulePreview | null>(null);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [ruleConflictBusy, setRuleConflictBusy] = useState(false);
  const [ruleConflictActionBusy, setRuleConflictActionBusy] = useState<string | null>(null);
  const [ruleImpactBusy, setRuleImpactBusy] = useState(false);
  const [ruleDetailsBusy, setRuleDetailsBusy] = useState<string | null>(null);
  const [rulePreviewBusy, setRulePreviewBusy] = useState(false);
  const [deletePreviewBusy, setDeletePreviewBusy] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [goalDescription, setGoalDescription] = useState('');
  const [deadline, setDeadline] = useState('');
  const [goalPriority, setGoalPriority] = useState<Priority>(0);
  const [initialTasksText, setInitialTasksText] = useState('');
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalEditTitle, setGoalEditTitle] = useState('');
  const [goalEditDescription, setGoalEditDescription] = useState('');
  const [goalEditDeadline, setGoalEditDeadline] = useState('');
  const [goalEditPriority, setGoalEditPriority] = useState<Priority>(0);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskEstimate, setTaskEstimate] = useState('60');
  const [taskEnergy, setTaskEnergy] = useState<'' | ScheduleEnergyType>('');
  const [taskType, setTaskType] = useState('');
  const [taskSplittable, setTaskSplittable] = useState(false);
  const [taskMinScheduleMinutes, setTaskMinScheduleMinutes] = useState('60');
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [taskEditTitle, setTaskEditTitle] = useState('');
  const [taskEditPriority, setTaskEditPriority] = useState<Priority>(0);
  const [taskEditDueDate, setTaskEditDueDate] = useState('');
  const [taskEditEstimate, setTaskEditEstimate] = useState('60');
  const [taskEditEnergy, setTaskEditEnergy] = useState<'' | ScheduleEnergyType>('');
  const [taskEditType, setTaskEditType] = useState('');
  const [taskEditSplittable, setTaskEditSplittable] = useState(false);
  const [taskEditMinScheduleMinutes, setTaskEditMinScheduleMinutes] = useState('60');
  const [parentId, setParentId] = useState('');
  const [ruleName, setRuleName] = useState('');
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleType, setRuleType] = useState<ScheduleRuleType>('time_boundary');
  const [rulePriority, setRulePriority] = useState<ScheduleRulePriority>('hard');
  const [ruleStatus, setRuleStatus] = useState<ScheduleRuleStatus>('enabled');
  const [ruleStartTime, setRuleStartTime] = useState('21:30');
  const [ruleEndTime, setRuleEndTime] = useState('23:59');
  const [ruleDays, setRuleDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [ruleBufferMinutes, setRuleBufferMinutes] = useState('15');
  const [ruleEnergy, setRuleEnergy] = useState<ScheduleEnergyType>('high');
  const [ruleTaskType, setRuleTaskType] = useState('');
  const [ruleEditApplyMode, setRuleEditApplyMode] = useState<ScheduleRuleEditApplyMode>('future_only');
  const [naturalRuleText, setNaturalRuleText] = useState('');
  const [naturalRuleBusy, setNaturalRuleBusy] = useState(false);
  const [lastRuleParse, setLastRuleParse] = useState<AIScheduleRuleParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiSchedule, setAiSchedule] = useState<AIScheduleResult | null>(null);
  const [taskStructureSummary, setTaskStructureSummary] = useState<GoalTaskStructureSummaryItem[] | null>(null);
  const [structureBusy, setStructureBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [deleteGoalConfirm, setDeleteGoalConfirm] = useState(false);

  const selected = goals.find((g) => g.id === selectedId) ?? null;
  const ruleNames = useMemo(() => new Map(scheduleRules.map((rule) => [rule.id, rule.name])), [scheduleRules]);
  const scheduleInsightByTaskId = useMemo(() => new Map(scheduleInsights.map((insight) => [insight.taskId, insight])), [scheduleInsights]);
  const goalDetailSummary = useMemo(() => (selected ? buildGoalDetailSummary(selected, tasks) : null), [selected, tasks]);
  const proposalImpact = useMemo(() => (proposal ? buildScheduleProposalImpact(proposal) : null), [proposal]);
  const proposalExplanationByKey = useMemo(() => {
    const map = new Map<string, ScheduleProposal['explanations'][number]>();
    proposal?.explanations.forEach((explanation) => {
      if (explanation.changeKey) map.set(explanation.changeKey, explanation);
      if (!map.has(`task:${explanation.taskId}`)) map.set(`task:${explanation.taskId}`, explanation);
    });
    return map;
  }, [proposal]);

  useEffect(() => {
    setEditingGoal(false);
    setGoalEditTitle(selected?.title ?? '');
    setGoalEditDescription(selected?.description ?? '');
    setGoalEditDeadline(selected?.deadlineAt ? isoToDateInput(selected.deadlineAt) : '');
    setGoalEditPriority(selected?.priority ?? 0);
  }, [selected?.id, selected?.title, selected?.description, selected?.deadlineAt, selected?.priority]);

  function setProposalWithSelection(next: ScheduleProposal | null) {
    setProposal(next);
    setSelectedProposalChangeKeys(new Set(next?.changes.filter((change) => !change.confirmed).map((change) => change.changeKey) ?? []));
    setProposalEditDrafts(
      Object.fromEntries(
        next?.changes.map((change) => [
          change.changeKey,
          {
            start: isoToDateTimeLocalValue(change.plannedStartAt),
            end: isoToDateTimeLocalValue(change.plannedEndAt),
          },
        ]) ?? [],
      ),
    );
  }

  const loadGoals = useCallback(async () => {
    const list = await api.listGoals();
    setGoals(list);
    setSelectedId((cur) => cur || list[0]?.id || '');
  }, []);

  const loadDashboard = useCallback(async () => {
    setDashboard(await api.getDayPilotDashboard());
  }, []);

  const loadTree = useCallback(async () => {
    if (!selectedId) {
      setTasks([]);
      setScheduleInsights([]);
      setRecentConfirmedProposal(null);
      return;
    }
    const [tree, latestProposal] = await Promise.all([
      api.getGoalTree(selectedId),
      api.getLatestConfirmedScheduleProposal(selectedId),
    ]);
    setTasks(tree.tasks);
    setScheduleInsights(tree.scheduleInsights ?? []);
    setRecentConfirmedProposal(latestProposal);
  }, [selectedId]);

  const loadRules = useCallback(async () => {
    const [rules, allRules, templates] = await Promise.all([
      api.listScheduleRules(),
      api.listScheduleRules({ includeDeleted: true }),
      api.listScheduleRuleTemplates(),
    ]);
    setScheduleRules(rules);
    setDeletedScheduleRules(allRules.filter((rule) => rule.deletedAt));
    setScheduleRuleTemplates(templates);
  }, []);

  const reload = useCallback(async () => {
    try {
      await loadGoals();
      await loadDashboard();
      await loadTree();
      await loadRules();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [loadGoals, loadDashboard, loadTree, loadRules]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    setAiSchedule(null);
    setTaskStructureSummary(null);
    setProposalWithSelection(null);
    setRecentConfirmedProposal(null);
    setSelectedProposalChangeKeys(new Set());
    setRuleConflicts(null);
    setRuleDetails(null);
    setRuleImpactAnalysis(null);
    setDeletePreviewRule(null);
    setDeletePreview(null);
    setDeleteGoalConfirm(false);
    setEditingTaskId(null);
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

  async function createGoal(e: FormEvent) {
    e.preventDefault();
    const name = title.trim();
    if (!name) return;
    await mutate(async () => {
      const goal = await api.createGoal({
        title: name,
        description: goalDescription.trim() || null,
        deadlineAt: dateInputToISO(deadline),
        priority: goalPriority,
        availableTimeRule: JSON.stringify({ startHour: 9, endHour: 18 }),
        tasksText: initialTasksText,
      });
      setSelectedId(goal.id);
      setTitle('');
      setGoalDescription('');
      setDeadline('');
      setGoalPriority(0);
      setInitialTasksText('');
    });
  }

  async function saveGoalEdit(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const nextTitle = goalEditTitle.trim();
    if (!nextTitle) return;
    await mutate(async () => {
      await api.updateGoal(selected.id, {
        title: nextTitle,
        description: goalEditDescription.trim() || null,
        deadlineAt: dateInputToISO(goalEditDeadline),
        priority: goalEditPriority,
      });
      setEditingGoal(false);
    });
  }

  async function createTask(e: FormEvent) {
    e.preventDefault();
    const name = taskTitle.trim();
    if (!selectedId || !name) return;
    await mutate(async () => {
      await api.createGoalTask(
        selectedId,
        buildGoalTaskCreateInput({
          title: name,
          parentId,
          estimatedMinutesText: taskEstimate,
          scheduleEnergyType: taskEnergy,
          scheduleTaskType: taskType,
          isSplittable: taskSplittable,
          minScheduleMinutesText: taskMinScheduleMinutes,
        }),
      );
      setTaskTitle('');
      setTaskType('');
      setTaskSplittable(false);
      setTaskMinScheduleMinutes('60');
      setParentId('');
    });
  }

  function beginTaskEdit(task: Task) {
    setEditingTaskId(task.id);
    setTaskEditTitle(task.title);
    setTaskEditPriority(task.priority);
    setTaskEditDueDate(isoToDateInput(task.dueDate));
    setTaskEditEstimate(String(task.estimatedMinutes ?? 60));
    setTaskEditEnergy(task.scheduleEnergyType ?? '');
    setTaskEditType(task.scheduleTaskType ?? '');
    setTaskEditSplittable(task.isSplittable);
    setTaskEditMinScheduleMinutes(String(task.minScheduleMinutes ?? 60));
  }

  async function saveTaskEdit(e: FormEvent, task: Task) {
    e.preventDefault();
    if (!taskEditTitle.trim()) return;
    await mutate(async () => {
      await api.updateTask(
        task.id,
        buildGoalTaskEditPatch({
          title: taskEditTitle,
          priority: taskEditPriority,
          dueDateText: taskEditDueDate,
          estimatedMinutesText: taskEditEstimate,
          scheduleEnergyType: taskEditEnergy,
          scheduleTaskType: taskEditType,
          isSplittable: taskEditSplittable,
          minScheduleMinutesText: taskEditMinScheduleMinutes,
        }),
      );
      setEditingTaskId(null);
    });
  }

  async function applyTaskStatusAction(task: Task, action: ReturnType<typeof goalTaskStatusActions>[number]) {
    await mutate(async () => {
      await api.updateTask(task.id, action.patch);
    });
  }

  async function setGoalStatus(status: Goal['status']) {
    if (!selected) return;
    await mutate(async () => {
      await api.updateGoal(selected.id, { status });
      setProposalWithSelection(null);
      setAiSchedule(null);
    });
  }

  async function deleteSelectedGoal() {
    if (!selected) return;
    const id = selected.id;
    await mutate(async () => {
      await api.deleteGoal(id);
      setSelectedId((cur) => (cur === id ? '' : cur));
      setProposalWithSelection(null);
      setAiSchedule(null);
      setDeleteGoalConfirm(false);
    });
  }

  async function addDependency(task: Task, dependencyId: string) {
    if (!dependencyId || dependencyId === task.id || task.dependencyTaskIds.includes(dependencyId)) return;
    await mutate(async () => {
      await api.addTaskDependency(task.id, dependencyId);
    });
  }

  async function removeDependency(task: Task, dependencyId: string) {
    await mutate(async () => {
      await api.removeTaskDependency(task.id, dependencyId);
    });
  }

  async function completeDependency(dependencyId: string) {
    await mutate(async () => {
      await api.updateTask(dependencyId, { completed: true, status: 'done', actualEndAt: new Date().toISOString() });
    });
  }

  function buildRulePayload() {
    const days = ruleDays.length ? ruleDays : DAY_OPTIONS.map((day) => day.value);
    if (ruleType === 'buffer') {
      return {
        condition: {},
        action: { effect: 'buffer', minutes: Math.max(0, Number(ruleBufferMinutes) || 0) },
      };
    }
    if (ruleType === 'energy_preference') {
      return {
        condition: { energyType: ruleEnergy },
        action: { effect: 'prefer', period: ruleEnergy === 'high' ? 'morning' : ruleEnergy === 'low' ? 'evening' : 'afternoon' },
      };
    }
    if (ruleType === 'task_category') {
      return {
        condition: { taskType: ruleTaskType.trim() || null },
        action: { effect: 'min_block', minScheduleMinutes: Math.max(15, Number(ruleBufferMinutes) || 90) },
      };
    }
    if (ruleType === 'reminder') {
      return {
        condition: {},
        action: { effect: 'remind', minutesBefore: Math.max(0, Number(ruleBufferMinutes) || 10) },
      };
    }
    if (ruleType === 'plan_priority') {
      return {
        condition: {},
        action: { effect: 'prefer_priority' },
      };
    }
    return {
      condition: { daysOfWeek: days, startTime: ruleStartTime, endTime: ruleEndTime },
      action: { effect: 'block' },
    };
  }

  function buildRuleScope() {
    if (ruleType === 'plan_priority' && selected) {
      return { goalIds: [selected.id] };
    }
    return {};
  }

  async function createRule(e: FormEvent) {
    e.preventDefault();
    const name = ruleName.trim();
    if (!name) return;
    const payload = buildRulePayload();
    await mutate(async () => {
      const input = {
        name,
        type: ruleType,
        priority: rulePriority,
        status: ruleStatus,
        condition: payload.condition,
        action: payload.action,
        scope: buildRuleScope(),
      };
      if (editingRuleId) {
        const rule = await api.updateScheduleRule(editingRuleId, input);
        if (selected && goalCanAutoSchedule(selected.status)) {
          const proposalInput = buildScheduleRuleEditProposalInput(ruleEditApplyMode, rule.id);
          if (proposalInput) {
            setProposalWithSelection(await api.createScheduleProposal(selected.id, proposalInput));
          }
        }
      } else {
        await api.createScheduleRule(input);
      }
      setRuleName('');
      setEditingRuleId(null);
      setRuleEditApplyMode('future_only');
      setRulePreview(null);
      setRuleDetails(null);
      setLastRuleParse(null);
    });
  }

  async function previewRule() {
    if (!selected) return;
    const name = ruleName.trim();
    if (!name) return;
    const payload = buildRulePayload();
    setRulePreviewBusy(true);
    try {
      const from = selected.startAt || new Date().toISOString();
      const to = selected.deadlineAt || new Date(new Date(from).getTime() + 7 * 24 * 3600_000).toISOString();
      const preview = await api.previewScheduleRule({
        id: editingRuleId ?? undefined,
        name,
        type: ruleType,
        priority: rulePriority,
        status: ruleStatus,
        condition: payload.condition,
        action: payload.action,
        scope: buildRuleScope(),
        from,
        to,
        goalId: selected.id,
      });
      setRulePreview(preview);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRulePreviewBusy(false);
    }
  }

  function nextSevenDaysRange() {
    const from = new Date();
    const to = new Date(from.getTime() + 7 * 24 * 3600_000);
    return { from: from.toISOString(), to: to.toISOString() };
  }

  async function previewRuleDelete(rule: PersonalScheduleRule) {
    const range = nextSevenDaysRange();
    setDeletePreviewBusy(rule.id);
    try {
      const preview = await api.previewScheduleRule({
        id: rule.id,
        name: rule.name,
        description: rule.description,
        type: rule.type,
        priority: rule.priority,
        status: rule.status,
        condition: rule.condition,
        action: rule.action,
        scope: rule.scope,
        from: range.from,
        to: range.to,
      });
      setDeletePreviewRule(rule);
      setDeletePreview(preview);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeletePreviewBusy(null);
    }
  }

  async function confirmRuleDelete() {
    if (!deletePreviewRule) return;
    const ruleId = deletePreviewRule.id;
    await mutate(async () => {
      await api.deleteScheduleRule(ruleId);
      setDeletePreviewRule(null);
      setDeletePreview(null);
      if (editingRuleId === ruleId) setEditingRuleId(null);
    });
  }

  function cancelRuleDelete() {
    setDeletePreviewRule(null);
    setDeletePreview(null);
  }

  async function restoreRule(rule: PersonalScheduleRule) {
    await mutate(async () => {
      await api.restoreScheduleRule(rule.id);
    });
  }

  async function showRuleDetails(rule: PersonalScheduleRule) {
    setRuleDetailsBusy(rule.id);
    try {
      setRuleDetails(await api.getScheduleRuleDetails(rule.id));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRuleDetailsBusy(null);
    }
  }

  async function showRuleConflicts() {
    setRuleConflictBusy(true);
    try {
      setRuleConflicts(await api.listScheduleRuleConflicts());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRuleConflictBusy(false);
    }
  }

  async function showRuleImpactAnalysis() {
    setRuleImpactBusy(true);
    try {
      setRuleImpactAnalysis(await api.getScheduleRuleImpactAnalysis());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRuleImpactBusy(false);
    }
  }

  async function applyRuleConflictAction(conflictId: string, action: ScheduleRuleConflictAction) {
    const busyKey = `${conflictId}:${action.type}:${action.type === 'reschedule' ? action.goalId : action.ruleId}`;
    setRuleConflictActionBusy(busyKey);
    try {
      if (action.type === 'reschedule' || action.type === 'temporary_override') {
        const next = await api.createScheduleProposal(action.goalId, action.proposalInput);
        setSelectedId(action.goalId);
        setProposalWithSelection(next);
        await loadDashboard();
      } else if (action.type === 'disable_rule') {
        await api.updateScheduleRule(action.ruleId, { status: 'disabled' });
        await loadRules();
        setRuleConflicts(await api.listScheduleRuleConflicts());
      } else {
        setRuleDetails(await api.getScheduleRuleDetails(action.ruleId));
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRuleConflictActionBusy(null);
    }
  }

  function fillRuleForm(rule: ScheduleRuleDraft) {
    setRuleName(rule.name);
    setRuleType(rule.type);
    setRulePriority(rule.priority);
    setRuleStatus(rule.status);
    if (rule.type === 'time_boundary' || rule.type === 'fixed_habit') {
      setRuleStartTime(typeof rule.condition.startTime === 'string' ? rule.condition.startTime : '21:30');
      setRuleEndTime(typeof rule.condition.endTime === 'string' ? rule.condition.endTime : '23:59');
      setRuleDays(Array.isArray(rule.condition.daysOfWeek) ? rule.condition.daysOfWeek.filter((day): day is number => typeof day === 'number') : []);
    }
    if (rule.type === 'buffer') {
      setRuleBufferMinutes(String(rule.action.minutes ?? rule.condition.minutes ?? 15));
    }
    if (rule.type === 'reminder') {
      setRuleBufferMinutes(String(rule.action.minutesBefore ?? 10));
    }
    if (rule.type === 'energy_preference') {
      setRuleEnergy((rule.condition.energyType as ScheduleEnergyType) ?? 'high');
    }
    if (rule.type === 'task_category') {
      setRuleTaskType(typeof rule.condition.taskType === 'string' ? rule.condition.taskType : '');
      setRuleBufferMinutes(String(rule.action.minScheduleMinutes ?? rule.action.minMinutes ?? rule.condition.minScheduleMinutes ?? 90));
    }
  }

  function beginEditRule(rule: PersonalScheduleRule) {
    setEditingRuleId(rule.id);
    setRuleEditApplyMode('future_only');
    fillRuleForm(rule);
    setLastRuleParse(null);
  }

  function useRuleTemplate(template: ScheduleRuleTemplate) {
    setEditingRuleId(null);
    setRuleEditApplyMode('future_only');
    fillRuleForm(template);
    setLastRuleParse(null);
    setRulePreview(null);
  }

  async function toggleRule(rule: PersonalScheduleRule) {
    await mutate(async () => {
      await api.updateScheduleRule(rule.id, { status: rule.status === 'enabled' ? 'disabled' : 'enabled' });
    });
  }

  async function generateProposal() {
    if (!selected) return;
    if (!goalCanAutoSchedule(selected.status)) {
      setError('当前计划已暂停、完成或归档，恢复为进行中后才能生成排期方案。');
      return;
    }
    setProposalBusy(true);
    try {
      const next = await api.createScheduleProposal(selected.id, {
        from: selected.startAt,
        to: selected.deadlineAt,
      });
      setProposalWithSelection(next);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProposalBusy(false);
    }
  }

  async function generateRescheduleProposal() {
    if (!selected) return;
    if (!goalCanAutoSchedule(selected.status)) {
      setError('当前计划已暂停、完成或归档，恢复为进行中后才能生成重排建议。');
      return;
    }
    setProposalBusy(true);
    try {
      const next = await api.createScheduleProposal(selected.id, {
        from: selected.startAt,
        to: selected.deadlineAt,
        mode: 'reschedule',
        trigger: 'manual_reschedule',
      });
      setProposalWithSelection(next);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProposalBusy(false);
    }
  }

  async function arrangeDashboardToday(goalId?: string | null) {
    if (!dashboard) return;
    const targetGoalId = goalId ?? selected?.id ?? dashboard.activeGoals[0]?.id ?? null;
    if (!targetGoalId) return;
    setProposalBusy(true);
    try {
      const next = await api.createScheduleProposal(targetGoalId, {
        from: dashboard.range.from,
        to: dashboard.range.to,
      });
      setSelectedId(targetGoalId);
      setProposalWithSelection(next);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProposalBusy(false);
    }
  }

  async function confirmProposal() {
    if (!proposal) return;
    await mutate(async () => {
      const result = await api.confirmScheduleProposal(proposal.id, { changeKeys: [...selectedProposalChangeKeys] });
      setProposalWithSelection(result.proposal);
    });
  }

  async function regenerateProposal() {
    if (!selected || !proposal) return;
    if (!goalCanAutoSchedule(selected.status)) {
      setError('当前计划已暂停、完成或归档，恢复为进行中后才能重新生成排期方案。');
      return;
    }
    setProposalBusy(true);
    try {
      const next = await api.createScheduleProposal(selected.id, buildScheduleProposalRegenerateInput(proposal));
      setProposalWithSelection(next);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProposalBusy(false);
    }
  }

  async function undoProposal() {
    if (!proposal) return;
    await mutate(async () => {
      const result = await api.undoScheduleProposal(proposal.id);
      setProposalWithSelection(result.proposal);
      setRecentConfirmedProposal(null);
    });
  }

  async function undoRecentConfirmedProposal() {
    if (!recentConfirmedProposal) return;
    await mutate(async () => {
      const result = await api.undoScheduleProposal(recentConfirmedProposal.id);
      setProposalWithSelection(result.proposal);
      setRecentConfirmedProposal(null);
    });
  }

  async function discardProposal() {
    if (!proposal) return;
    await mutate(async () => {
      setProposalWithSelection(await api.discardScheduleProposal(proposal.id));
    });
  }

  function toggleProposalChange(changeKey: string) {
    setSelectedProposalChangeKeys((cur) => {
      const next = new Set(cur);
      if (next.has(changeKey)) next.delete(changeKey);
      else next.add(changeKey);
      return next;
    });
  }

  async function parseNaturalRule(e: FormEvent) {
    e.preventDefault();
    const text = naturalRuleText.trim();
    if (!text) return;
    setNaturalRuleBusy(true);
    try {
      const result = await api.parseScheduleRuleNaturalLanguage(text);
      fillRuleForm(result.rule);
      setEditingRuleId(null);
      setLastRuleParse(result);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setNaturalRuleBusy(false);
    }
  }

  function updateProposalEditDraft(changeKey: string, patch: Partial<{ start: string; end: string }>) {
    setProposalEditDrafts((cur) => ({ ...cur, [changeKey]: { start: cur[changeKey]?.start ?? '', end: cur[changeKey]?.end ?? '', ...patch } }));
  }

  function updateProposalDragDraft(item: ScheduleProposal['changes'][number], offsetMinutes: number) {
    if (!proposal) return;
    try {
      const patch = buildScheduleProposalManualDragPatch(proposal.range, item, offsetMinutes);
      updateProposalEditDraft(item.changeKey, {
        start: isoToDateTimeLocalValue(patch.plannedStartAt),
        end: isoToDateTimeLocalValue(patch.plannedEndAt),
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function shiftProposalChange(item: ScheduleProposal['changes'][number], deltaMinutes: number) {
    if (!proposal) return;
    setProposalBusy(true);
    try {
      const patch = buildScheduleProposalManualShift(item, deltaMinutes);
      setProposalWithSelection(await api.updateScheduleProposalChange(proposal.id, item.changeKey, patch));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProposalBusy(false);
    }
  }

  async function saveProposalChange(item: ScheduleProposal['changes'][number]) {
    if (!proposal) return;
    const draft = proposalEditDrafts[item.changeKey];
    const plannedStartAt = dateTimeLocalValueToISO(draft?.start ?? '');
    const plannedEndAt = dateTimeLocalValueToISO(draft?.end ?? '');
    if (!plannedStartAt || !plannedEndAt) {
      setError('请输入有效的开始和结束时间');
      return;
    }
    setProposalBusy(true);
    try {
      setProposalWithSelection(await api.updateScheduleProposalChange(proposal.id, item.changeKey, { plannedStartAt, plannedEndAt }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProposalBusy(false);
    }
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

  async function structureGoalTasks() {
    if (!selected) return;
    const issue = aiConfigurationIssue(settings.ai, 'AI 任务识别');
    if (issue) {
      setError(issue);
      return;
    }
    setStructureBusy(true);
    try {
      const result = await api.structureGoalTasks(selected.id);
      setTaskStructureSummary(buildGoalTaskStructureSummary(result));
      await reload();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStructureBusy(false);
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
          <select value={goalPriority} onChange={(e) => setGoalPriority(Number(e.target.value) as Priority)} aria-label="计划重要程度">
            {GOAL_PRIORITY_VALUES.map((priority) => (
              <option key={priority} value={priority}>
                {PRIORITY_LABELS[priority]}
              </option>
            ))}
          </select>
          <textarea
            rows={3}
            placeholder="目标描述"
            value={goalDescription}
            onChange={(e) => setGoalDescription(e.target.value)}
          />
          <textarea
            rows={5}
            placeholder="按行输入任务"
            value={initialTasksText}
            onChange={(e) => setInitialTasksText(e.target.value)}
          />
          <button type="submit" disabled={!title.trim()}>
            创建
          </button>
        </form>
        <div className="goal-items">
          {goals.map((goal) => (
            <button key={goal.id} className={`goal-item${goal.id === selectedId ? ' active' : ''}`} onClick={() => setSelectedId(goal.id)}>
              <span>{goal.title}</span>
              <small>
                {GOAL_STATUS_LABELS[goal.status]} · {PRIORITY_LABELS[goal.priority]} · {goal.deadlineAt ? isoToDateInput(goal.deadlineAt) : '无截止'}
              </small>
            </button>
          ))}
          {goals.length === 0 && <div className="goal-empty">还没有目标</div>}
        </div>
      </aside>

      <section className="goal-detail">
        <header className="goal-head">
          <div>
            <h1>{selected?.title ?? '选择或创建目标'}</h1>
            {selected && (
              <p>
                {GOAL_STATUS_LABELS[selected.status]}
                {` · ${PRIORITY_LABELS[selected.priority]}`}
                {selected.deadlineAt ? ` · 截止 ${isoToDateInput(selected.deadlineAt)}` : ' · 无截止'}
              </p>
            )}
          </div>
          {selected && (
            <div className="goal-actions">
              <button className="goal-primary" onClick={() => void generateProposal()} disabled={proposalBusy || !goalCanAutoSchedule(selected.status)}>
                {proposalBusy ? '生成中' : '生成排期方案'}
              </button>
              <button className="goal-secondary" onClick={() => void generateRescheduleProposal()} disabled={proposalBusy || !goalCanAutoSchedule(selected.status)}>
                重排建议
              </button>
              <button className="goal-secondary" onClick={() => void structureGoalTasks()} disabled={structureBusy || tasks.length === 0}>
                {structureBusy ? '识别中' : '识别任务属性'}
              </button>
              <button className="goal-secondary" onClick={() => void suggestAiSchedule()} disabled={aiBusy}>
                {aiBusy ? '生成中' : 'AI 排期建议'}
              </button>
              <button className="goal-secondary" type="button" onClick={() => setEditingGoal((cur) => !cur)}>
                {editingGoal ? '收起编辑' : '编辑计划'}
              </button>
              {goalStatusActions(selected.status).map((action) => (
                <button key={action.status} className="goal-secondary" type="button" onClick={() => void setGoalStatus(action.status)}>
                  {action.label}
                </button>
              ))}
              {deleteGoalConfirm ? (
                <>
                  <button className="goal-danger" type="button" onClick={() => void deleteSelectedGoal()}>
                    确认删除
                  </button>
                  <button className="goal-secondary" type="button" onClick={() => setDeleteGoalConfirm(false)}>
                    取消
                  </button>
                </>
              ) : (
                <button className="goal-secondary" type="button" onClick={() => setDeleteGoalConfirm(true)}>
                  删除
                </button>
              )}
            </div>
          )}
        </header>

        {selected && recentConfirmedProposal && (
          <section className="goal-recent-undo" role="status">
            <div>
              <strong>最近排期可撤销</strong>
              <span>
                {recentConfirmedProposal.changes.filter((change) => change.confirmed).length} 个时间块 ·{' '}
                {recentConfirmedProposal.confirmedAt ? formatDateTime(recentConfirmedProposal.confirmedAt) : formatDateTime(recentConfirmedProposal.createdAt)}
              </span>
            </div>
            <button type="button" onClick={() => void undoRecentConfirmedProposal()}>
              撤销最近排期
            </button>
          </section>
        )}

        {selected && (
          <section className="goal-summary">
            {editingGoal ? (
              <form className="goal-edit-form" onSubmit={(e) => void saveGoalEdit(e)}>
                <input value={goalEditTitle} onChange={(e) => setGoalEditTitle(e.target.value)} placeholder="计划名称" />
                <textarea
                  rows={3}
                  value={goalEditDescription}
                  onChange={(e) => setGoalEditDescription(e.target.value)}
                  placeholder="目标描述"
                />
                <input type="date" value={goalEditDeadline} onChange={(e) => setGoalEditDeadline(e.target.value)} />
                <select value={goalEditPriority} onChange={(e) => setGoalEditPriority(Number(e.target.value) as Priority)} aria-label="编辑计划重要程度">
                  {GOAL_PRIORITY_VALUES.map((priority) => (
                    <option key={priority} value={priority}>
                      {PRIORITY_LABELS[priority]}
                    </option>
                  ))}
                </select>
                <div>
                  <button type="submit" disabled={!goalEditTitle.trim()}>
                    保存计划
                  </button>
                  <button type="button" onClick={() => setEditingGoal(false)}>
                    取消
                  </button>
                </div>
              </form>
            ) : (
              <p>{selected.description || '还没有填写目标描述'}</p>
            )}
            {goalDetailSummary && (
              <div className="goal-detail-metrics">
                <div>
                  <strong>{goalDetailSummary.completionPercent}%</strong>
                  <span>完成进度</span>
                  <em>
                    {goalDetailSummary.completedTaskCount}/{goalDetailSummary.totalTaskCount} 个任务
                  </em>
                </div>
                <div>
                  <strong>{goalDetailSummary.scheduledTaskCount}</strong>
                  <span>已排期</span>
                  <em>{goalDetailSummary.unscheduledTaskCount} 个待排期</em>
                </div>
                <div>
                  <strong>{goalDetailSummary.estimatedMinutes.open}</strong>
                  <span>剩余分钟</span>
                  <em>总计 {goalDetailSummary.estimatedMinutes.total} 分钟</em>
                </div>
                <div className={goalDetailSummary.overdueTaskCount > 0 ? 'is-risk' : ''}>
                  <strong>{goalDetailSummary.overdueTaskCount}</strong>
                  <span>延期风险</span>
                  <em>{goalDetailSummary.riskMessages[0] ?? '暂无延期风险'}</em>
                </div>
              </div>
            )}
          </section>
        )}

        {taskStructureSummary && (
          <section className="goal-structure-summary">
            <div className="goal-section-head">
              <strong>任务属性识别结果</strong>
              <div>
                <span>{taskStructureSummary.length} 个任务已回写</span>
                <button type="button" onClick={() => setTaskStructureSummary(null)}>
                  关闭
                </button>
              </div>
            </div>
            <ul>
              {taskStructureSummary.map((item) => {
                const task = tasks.find((candidate) => candidate.id === item.taskId);
                return (
                  <li key={item.taskId}>
                    <div>
                      <span>{item.title}</span>
                      {item.reason && <em>{item.reason}</em>}
                      <div className="goal-structure-fields">
                        {item.changes.map((change) => (
                          <small key={change.field}>
                            {change.label}：{change.value}
                          </small>
                        ))}
                      </div>
                    </div>
                    {task && (
                      <button type="button" onClick={() => beginTaskEdit(task)}>
                        编辑确认
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {dashboard && (
          <section className="goal-dashboard">
            <div className="goal-dashboard-head">
              <div>
                <strong>今日驾驶舱</strong>
                <span>
                  {dashboard.date} · {dashboard.summary.activeGoalCount} 个进行中计划 · {dashboard.summary.riskCount} 条提醒 ·{' '}
                  {dashboard.summary.ruleImpactCount} 个规则影响
                </span>
              </div>
              <div>
                <button type="button" onClick={() => void arrangeDashboardToday()} disabled={proposalBusy || dashboard.activeGoals.length === 0}>
                  {proposalBusy ? '生成中' : '自动安排今日任务'}
                </button>
                <button type="button" onClick={() => void showRuleConflicts()} disabled={ruleConflictBusy}>
                  查看规则影响
                </button>
              </div>
            </div>
            <div className="goal-dashboard-grid">
              <div>
                <small>今日 Top 3</small>
                <ul>
                  {dashboard.topTasks.map((task) => (
                    <li key={task.id}>
                      <span>{task.title}</span>
                      <em>
                        {task.goalTitle}
                        {task.dueDate ? ` · 截止 ${formatDateTime(task.dueDate)}` : ''}
                      </em>
                      {task.blockingDependencies.length > 0 && <em>等待前置：{blockingDependencyText(task)}</em>}
                    </li>
                  ))}
                  {dashboard.topTasks.length === 0 && <li className="goal-empty">今天没有需要优先推进的任务</li>}
                </ul>
              </div>
              <div>
                <small>正在进行的计划</small>
                <ul>
                  {dashboard.activeGoals.map((goal) => (
                    <li key={goal.id}>
                      <span>{goal.title}</span>
                      <em>
                        {PRIORITY_LABELS[goal.priority]} · 已排 {goal.scheduledTodayCount} · 待排 {goal.unscheduledTaskCount} · 未完成 {goal.openTaskCount}
                      </em>
                    </li>
                  ))}
                  {dashboard.activeGoals.length === 0 && <li className="goal-empty">暂无进行中的计划</li>}
                </ul>
              </div>
              <div>
                <small>今日已排期</small>
                <ul>
                  {dashboard.scheduledTasks.slice(0, 5).map((task) => (
                    <li key={task.id}>
                      <span>{task.title}</span>
                      <em>
                        {task.startDate ? formatDateTime(task.startDate) : ''}
                        {task.dueDate ? ` - ${new Date(task.dueDate).toLocaleTimeString()}` : ''}
                      </em>
                      {task.blockingDependencies.length > 0 && <em>等待前置：{blockingDependencyText(task)}</em>}
                    </li>
                  ))}
                  {dashboard.scheduledTasks.length === 0 && <li className="goal-empty">今日还没有写入日历的计划任务</li>}
                </ul>
              </div>
              <div>
                <small>待排期 / 风险</small>
                <ul>
                  {dashboard.unscheduledTasks.slice(0, 3).map((task) => (
                    <li key={task.id}>
                      <span>{task.title}</span>
                      <em>{task.goalTitle}</em>
                      {task.blockingDependencies.length > 0 && <em>等待前置：{blockingDependencyText(task)}</em>}
                    </li>
                  ))}
                  {dashboard.risks.slice(0, 3).map((risk, index) => (
                    <li key={`${risk.type}-${risk.goalId ?? ''}-${risk.taskId ?? ''}-${index}`} className={`risk-${risk.severity}`}>
                      <span>{risk.message}</span>
                      {risk.rules.length > 0 && <em>相关规则：{risk.rules.map((rule) => rule.name).join('、')}</em>}
                      {risk.suggestions.length > 0 && <em>{risk.suggestions.join('、')}</em>}
                    </li>
                  ))}
                  {dashboard.unscheduledTasks.length === 0 && dashboard.risks.length === 0 && <li className="goal-empty">暂无待排期任务和风险提醒</li>}
                </ul>
              </div>
              <div>
                <small>规则影响</small>
                <ul>
                  {dashboard.ruleImpacts.slice(0, 4).map((impact) => (
                    <li key={`${impact.proposalId}-${impact.taskId ?? impact.taskTitle}-${impact.plannedStartAt}`}>
                      <span>{impact.taskTitle}</span>
                      <em>
                        {formatDateTime(impact.plannedStartAt)} - {new Date(impact.plannedEndAt).toLocaleTimeString()}
                      </em>
                      {impact.rules.length > 0 && <em>规则：{impact.rules.map((rule) => rule.name).join('、')}</em>}
                      {impact.avoidedBlocks.length > 0 && (
                        <em>
                          避让：{impact.avoidedBlocks.map((block) => `${AVOIDED_SOURCE_LABELS[block.source]} ${block.title}`).join('、')}
                        </em>
                      )}
                    </li>
                  ))}
                  {dashboard.ruleImpacts.length === 0 && <li className="goal-empty">暂无受规则影响的排期记录</li>}
                </ul>
              </div>
            </div>
          </section>
        )}

        {error && <div className="banner banner-error">错误：{error}</div>}

        {selected && (
          <>
            <form className="goal-task-form" onSubmit={(e) => void createTask(e)}>
              <input placeholder="拆一个可执行任务" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
              <input type="number" min="15" step="15" value={taskEstimate} onChange={(e) => setTaskEstimate(e.target.value)} />
              <select value={taskEnergy} onChange={(e) => setTaskEnergy(e.target.value as '' | ScheduleEnergyType)}>
                <option value="">精力</option>
                <option value="high">高精力</option>
                <option value="medium">中等</option>
                <option value="low">低精力</option>
              </select>
              <input placeholder="任务类型" value={taskType} onChange={(e) => setTaskType(e.target.value)} />
              <label className="goal-task-split">
                <input type="checkbox" checked={taskSplittable} onChange={(e) => setTaskSplittable(e.target.checked)} />
                <span>允许拆分</span>
              </label>
              <input
                type="number"
                min="15"
                step="15"
                aria-label="最小排期块分钟"
                value={taskMinScheduleMinutes}
                onChange={(e) => setTaskMinScheduleMinutes(e.target.value)}
                disabled={!taskSplittable}
              />
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

            <section className="goal-rules">
              <div className="goal-section-head">
                <strong>个人规则</strong>
                <div>
                  <span>{scheduleRules.filter((rule) => rule.status === 'enabled').length} 条启用</span>
                  <button type="button" onClick={() => void showRuleConflicts()} disabled={ruleConflictBusy}>
                    {ruleConflictBusy ? '读取中' : '冲突'}
                  </button>
                  <button type="button" onClick={() => void showRuleImpactAnalysis()} disabled={ruleImpactBusy}>
                    {ruleImpactBusy ? '分析中' : '影响分析'}
                  </button>
                </div>
              </div>
              <form className="goal-rule-natural" onSubmit={(e) => void parseNaturalRule(e)}>
                <input
                  placeholder="用一句话创建规则，例如：工作日 21:30 后不排工作任务"
                  value={naturalRuleText}
                  onChange={(e) => setNaturalRuleText(e.target.value)}
                />
                <button type="submit" disabled={!naturalRuleText.trim() || naturalRuleBusy}>
                  {naturalRuleBusy ? '解析中' : 'AI 解析'}
                </button>
                {lastRuleParse && (
                  <small>
                    已填入：{lastRuleParse.rule.name}
                    {lastRuleParse.explanation ? ` · ${lastRuleParse.explanation}` : ''}
                  </small>
                )}
              </form>
              {scheduleRuleTemplates.length > 0 && (
                <div className="goal-rule-templates">
                  {scheduleRuleTemplates.map((template) => (
                    <button key={template.id} type="button" onClick={() => useRuleTemplate(template)}>
                      <span>{template.name}</span>
                      <small>{template.description ?? RULE_TYPE_LABELS[template.type]}</small>
                    </button>
                  ))}
                </div>
              )}
              <form className="goal-rule-form" onSubmit={(e) => void createRule(e)}>
                <input placeholder="规则名称" value={ruleName} onChange={(e) => setRuleName(e.target.value)} />
                <select value={ruleType} onChange={(e) => setRuleType(e.target.value as ScheduleRuleType)}>
                  {Object.entries(RULE_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <select value={rulePriority} onChange={(e) => setRulePriority(e.target.value as ScheduleRulePriority)}>
                  {Object.entries(RULE_PRIORITY_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <select value={ruleStatus} onChange={(e) => setRuleStatus(e.target.value as ScheduleRuleStatus)}>
                  <option value="enabled">启用</option>
                  <option value="disabled">停用</option>
                </select>
                {editingRuleId && (
                  <div className="goal-rule-apply-mode" role="radiogroup" aria-label="规则更新生效方式">
                    <label className={ruleEditApplyMode === 'future_only' ? 'active' : ''}>
                      <input
                        type="radio"
                        name="rule-edit-apply-mode"
                        value="future_only"
                        checked={ruleEditApplyMode === 'future_only'}
                        onChange={() => setRuleEditApplyMode('future_only')}
                      />
                      <span>仅影响未来</span>
                    </label>
                    <label className={ruleEditApplyMode === 'recalculate_7d' ? 'active' : ''}>
                      <input
                        type="radio"
                        name="rule-edit-apply-mode"
                        value="recalculate_7d"
                        checked={ruleEditApplyMode === 'recalculate_7d'}
                        onChange={() => setRuleEditApplyMode('recalculate_7d')}
                        disabled={!selected || !goalCanAutoSchedule(selected.status)}
                      />
                      <span>重排未来 7 天</span>
                    </label>
                  </div>
                )}
                {(ruleType === 'time_boundary' || ruleType === 'fixed_habit') && (
                  <>
                    <input type="time" value={ruleStartTime} onChange={(e) => setRuleStartTime(e.target.value)} />
                    <input type="time" value={ruleEndTime} onChange={(e) => setRuleEndTime(e.target.value)} />
                    <div className="goal-weekdays">
                      {DAY_OPTIONS.map((day) => (
                        <button
                          key={day.value}
                          type="button"
                          className={ruleDays.includes(day.value) ? 'active' : ''}
                          onClick={() =>
                            setRuleDays((cur) =>
                              cur.includes(day.value) ? cur.filter((value) => value !== day.value) : [...cur, day.value],
                            )
                          }
                        >
                          {day.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {(ruleType === 'buffer' || ruleType === 'reminder') && (
                  <input type="number" min="0" max="240" value={ruleBufferMinutes} onChange={(e) => setRuleBufferMinutes(e.target.value)} />
                )}
                {ruleType === 'energy_preference' && (
                  <select value={ruleEnergy} onChange={(e) => setRuleEnergy(e.target.value as ScheduleEnergyType)}>
                    <option value="high">高精力</option>
                    <option value="medium">中等</option>
                    <option value="low">低精力</option>
                  </select>
                )}
                {ruleType === 'task_category' && (
                  <div className="goal-rule-inline-fields">
                    <input placeholder="任务类型" value={ruleTaskType} onChange={(e) => setRuleTaskType(e.target.value)} />
                    <input
                      type="number"
                      min="15"
                      max="1440"
                      placeholder="每块最少分钟"
                      value={ruleBufferMinutes}
                      onChange={(e) => setRuleBufferMinutes(e.target.value)}
                    />
                  </div>
                )}
                {ruleType === 'plan_priority' && selected && <small className="goal-rule-scope-note">优先推进：{selected.title}</small>}
                <button type="submit" disabled={!ruleName.trim()}>
                  {editingRuleId ? (ruleEditApplyMode === 'recalculate_7d' ? '更新并重排' : '更新规则') : '保存规则'}
                </button>
                <button type="button" onClick={() => void previewRule()} disabled={!selected || !ruleName.trim() || rulePreviewBusy}>
                  {rulePreviewBusy ? '预览中' : '预览 7 天'}
                </button>
                {editingRuleId && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingRuleId(null);
                      setRuleEditApplyMode('future_only');
                    }}
                  >
                    取消
                  </button>
                )}
              </form>
              {rulePreview && (
                <div className="goal-rule-preview">
                  <strong>
                    预览：{rulePreview.summary.blockedSlotCount} 个不可用时间块，影响 {rulePreview.summary.affectedTaskCount} 个已排任务
                  </strong>
                  <ul>
                    {rulePreview.affectedTasks.slice(0, 5).map((item) => (
                      <li key={`${item.taskId}-${item.ruleBlockStart}`}>
                        {item.title} · {formatDateTime(item.startDate)} - {new Date(item.dueDate).toLocaleTimeString()}
                      </li>
                    ))}
                    {rulePreview.affectedTasks.length === 0 && <li>没有已排任务会被这个规则挡住</li>}
                  </ul>
                </div>
              )}
              {deletePreviewRule && deletePreview && (
                <div className="goal-rule-preview goal-rule-delete-preview">
                  <strong>
                    删除「{deletePreviewRule.name}」前确认：未来 7 天会释放 {deletePreview.summary.blockedSlotCount} 个规则时间块，当前影响{' '}
                    {deletePreview.summary.affectedTaskCount} 个已排任务
                  </strong>
                  <ul>
                    {deletePreview.affectedTasks.slice(0, 5).map((item) => (
                      <li key={`${item.taskId}-${item.ruleBlockStart}`}>
                        {item.title} · {formatDateTime(item.startDate)} - {new Date(item.dueDate).toLocaleTimeString()}
                      </li>
                    ))}
                    {deletePreview.affectedTasks.length === 0 && <li>未来 7 天没有已排任务会受这个规则删除影响</li>}
                  </ul>
                  <div className="goal-rule-delete-actions">
                    <button type="button" onClick={() => void confirmRuleDelete()}>
                      确认删除
                    </button>
                    <button type="button" onClick={cancelRuleDelete}>
                      取消
                    </button>
                  </div>
                </div>
              )}
              {ruleConflicts && (
                <div className="goal-rule-conflicts">
                  <div className="goal-rule-details-head">
                    <strong>规则冲突</strong>
                    <span>
                      总计 {ruleConflicts.summary.total} · 阻塞 {ruleConflicts.summary.blocking} · 提醒 {ruleConflicts.summary.warning + ruleConflicts.summary.info}
                    </span>
                  </div>
                  <ul>
                    {ruleConflicts.conflicts.map((item) => {
                      const actions = buildScheduleRuleConflictActions(item);
                      return (
                        <li key={item.id}>
                          <div>
                            <span>
                              {item.severity} · {item.type}
                              {item.taskTitle ? ` · ${item.taskTitle}` : ''}
                            </span>
                            <em>{item.message}</em>
                            {item.rules.length > 0 && <small>规则：{item.rules.map((rule) => rule.name).join('、')}</small>}
                            {item.suggestions.length > 0 && <small>建议：{item.suggestions.join('、')}</small>}
                            {actions.length > 0 && (
                              <div className="goal-rule-conflict-actions">
                                {actions.map((action) => {
                                  const busyKey = `${item.id}:${action.type}:${action.type === 'reschedule' ? action.goalId : action.ruleId}`;
                                  return (
                                    <button
                                      key={`${action.type}-${action.type === 'reschedule' ? action.goalId : action.ruleId}`}
                                      type="button"
                                      onClick={() => void applyRuleConflictAction(item.id, action)}
                                      disabled={ruleConflictActionBusy === busyKey}
                                    >
                                      {ruleConflictActionBusy === busyKey ? '处理中' : action.label}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                    {ruleConflicts.conflicts.length === 0 && <li className="goal-empty">暂无规则冲突</li>}
                  </ul>
                </div>
              )}
              {ruleImpactAnalysis && (
                <div className="goal-rule-impact-analysis">
                  <div className="goal-rule-details-head">
                    <strong>规则影响分析</strong>
                    <span>
                      {ruleImpactAnalysis.summary.activeRuleCount} 条启用 · 命中 {ruleImpactAnalysis.summary.totalHits} 次 · 冲突{' '}
                      {ruleImpactAnalysis.summary.totalConflicts} 次
                    </span>
                  </div>
                  <div className="goal-rule-impact-grid">
                    <div>
                      <strong>{ruleImpactAnalysis.summary.delayRiskRuleCount}</strong>
                      <span>延期风险规则</span>
                    </div>
                    <div>
                      <strong>{ruleImpactAnalysis.proposalCount}</strong>
                      <span>已分析方案</span>
                    </div>
                    <div>
                      <strong>{ruleImpactAnalysis.summary.ruleCount}</strong>
                      <span>规则总数</span>
                    </div>
                  </div>
                  <ul>
                    {ruleImpactAnalysis.rules.slice(0, 6).map((item) => (
                      <li key={item.rule.id}>
                        <div>
                          <span>
                            {item.rule.name} · {RULE_IMPACT_RECOMMENDATION_LABELS[item.recommendation]}
                          </span>
                          <em>
                            命中 {item.hitCount} · 冲突 {item.conflictCount} · 阻塞 {item.blockingConflictCount} · 影响任务 {item.affectedTaskCount}
                          </em>
                        </div>
                      </li>
                    ))}
                    {ruleImpactAnalysis.rules.length === 0 && <li className="goal-empty">还没有可分析的个人规则</li>}
                  </ul>
                </div>
              )}
              {ruleDetails && (
                <div className="goal-rule-details">
                  <div className="goal-rule-details-head">
                    <strong>{ruleDetails.rule.name}</strong>
                    <span>
                      命中 {ruleDetails.hitCount} 次 · 冲突 {ruleDetails.conflictCount} 次
                    </span>
                  </div>
                  <div className="goal-rule-details-grid">
                    <div>
                      <small>最近影响</small>
                      <ul>
                        {ruleDetails.recentImpacts.map((item) => (
                          <li key={`${item.proposalId}-${item.taskId}-${item.plannedStartAt}`}>
                            <span>{item.title}</span>
                            <em>
                              {formatDateTime(item.plannedStartAt)} - {new Date(item.plannedEndAt).toLocaleTimeString()}
                            </em>
                          </li>
                        ))}
                        {ruleDetails.recentImpacts.length === 0 && <li className="goal-empty">暂无排期命中</li>}
                      </ul>
                    </div>
                    <div>
                      <small>最近冲突</small>
                      <ul>
                        {ruleDetails.recentConflicts.map((item) => (
                          <li key={`${item.proposalId}-${item.type}-${item.createdAt}`}>
                            <span>
                              {item.severity} · {item.type}
                            </span>
                            <em>{item.message}</em>
                          </li>
                        ))}
                        {ruleDetails.recentConflicts.length === 0 && <li className="goal-empty">暂无冲突记录</li>}
                      </ul>
                    </div>
                  </div>
                </div>
              )}
              <div className="goal-rule-list">
                {scheduleRules.map((rule) => (
                  <div key={rule.id} className="goal-rule-item">
                    <div>
                      <strong>{rule.name}</strong>
                      <small>
                        {RULE_TYPE_LABELS[rule.type]} · {RULE_PRIORITY_LABELS[rule.priority]} · {weekdayLabel(rule)}
                      </small>
                    </div>
                    <div className="goal-rule-actions">
                      <button onClick={() => void showRuleDetails(rule)} disabled={ruleDetailsBusy === rule.id}>
                        {ruleDetailsBusy === rule.id ? '读取中' : '详情'}
                      </button>
                      <button onClick={() => beginEditRule(rule)}>编辑</button>
                      <button onClick={() => void toggleRule(rule)}>{RULE_STATUS_LABELS[rule.status]}</button>
                      <button onClick={() => void previewRuleDelete(rule)} disabled={deletePreviewBusy === rule.id}>
                        {deletePreviewBusy === rule.id ? '预览中' : '删除'}
                      </button>
                    </div>
                  </div>
                ))}
                {scheduleRules.length === 0 && <div className="goal-empty">还没有个人规则</div>}
              </div>
              {deletedScheduleRules.length > 0 && (
                <div className="goal-rule-deleted">
                  <small>最近删除</small>
                  {deletedScheduleRules.slice(0, 5).map((rule) => (
                    <div key={rule.id} className="goal-rule-deleted-row">
                      <span>
                        {rule.name}
                        {rule.deletedAt ? ` · ${new Date(rule.deletedAt).toLocaleString()}` : ''}
                      </span>
                      <button type="button" onClick={() => void restoreRule(rule)}>
                        恢复
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {proposal && (
              <section className="goal-proposal">
                <div className="goal-ai-head">
                  <div>
                    <strong>排期方案</strong>
                    <span>
                      {new Date(proposal.range.from).toLocaleDateString()} - {new Date(proposal.range.to).toLocaleDateString()} ·{' '}
                      {proposal.status}
                    </span>
                  </div>
                  <div className="goal-ai-actions">
                    <button onClick={() => void confirmProposal()} disabled={proposal.status !== 'draft' || selectedProposalChangeKeys.size === 0}>
                      确认选中 {selectedProposalChangeKeys.size}
                    </button>
                    <button
                      onClick={() => setSelectedProposalChangeKeys(new Set(proposal.changes.map((item) => item.changeKey)))}
                      disabled={proposal.status !== 'draft' || proposal.changes.length === selectedProposalChangeKeys.size}
                    >
                      全选
                    </button>
                    <button onClick={() => void regenerateProposal()} disabled={proposal.status !== 'draft' || proposalBusy}>
                      {proposalBusy ? '生成中' : '重新生成'}
                    </button>
                    <button onClick={() => void undoProposal()} disabled={proposal.status !== 'confirmed'}>
                      撤销排期
                    </button>
                    <button onClick={() => void discardProposal()} disabled={proposal.status !== 'draft'}>
                      丢弃
                    </button>
                  </div>
                </div>
                {proposalImpact && (
                  <div className="goal-proposal-impact">
                    <div className="goal-proposal-impact-grid">
                      <div>
                        <strong>{proposalImpact.counts.added}</strong>
                        <span>新增时间块</span>
                      </div>
                      <div>
                        <strong>{proposalImpact.counts.moved}</strong>
                        <span>移动时间块</span>
                      </div>
                      <div>
                        <strong>{proposalImpact.counts.blocked}</strong>
                        <span>无法排期任务</span>
                      </div>
                      <div>
                        <strong>{proposalImpact.counts.risks}</strong>
                        <span>排期风险</span>
                      </div>
                    </div>
                    {(proposalImpact.affectedConflicts.length > 0 ||
                      proposalImpact.movedChanges.length > 0 ||
                      proposalImpact.blockedConflicts.length > 0) && (
                      <div className="goal-proposal-impact-detail">
                        {proposalImpact.affectedConflicts.length > 0 && (
                          <div>
                            <small>受影响任务</small>
                            {proposalImpact.affectedConflicts.slice(0, 3).map((conflict, index) => (
                              <p key={`affected-${conflict.taskId ?? index}`}>
                                {conflict.message}
                                {conflict.suggestions.length > 0 && ` · 建议：${conflict.suggestions.join('、')}`}
                              </p>
                            ))}
                          </div>
                        )}
                        {proposalImpact.movedChanges.length > 0 && (
                          <div>
                            <small>移动时间块</small>
                            {proposalImpact.movedChanges.slice(0, 3).map((change) => (
                              <p key={`moved-${change.changeKey}`}>
                                {change.title}：{formatDateTime(change.oldPlannedStartAt ?? change.oldStartDate)} → {formatDateTime(change.plannedStartAt)}
                              </p>
                            ))}
                          </div>
                        )}
                        {proposalImpact.blockedConflicts.length > 0 && (
                          <div>
                            <small>无法排期任务</small>
                            {proposalImpact.blockedConflicts.slice(0, 3).map((conflict, index) => (
                              <p key={`blocked-${conflict.taskId ?? index}`}>
                                {conflict.message}
                                {conflict.suggestions.length > 0 && ` · 建议：${conflict.suggestions.join('、')}`}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {proposal.conflicts.length > 0 && (
                  <div className="goal-conflicts">
                    {proposal.conflicts.map((conflict, index) => (
                      <p key={`${conflict.type}-${index}`}>
                        {conflict.severity}：{conflict.message}
                      </p>
                    ))}
                  </div>
                )}
                <ul>
                  {proposal.changes.map((item) => {
                    const draft = proposalEditDrafts[item.changeKey] ?? {
                      start: isoToDateTimeLocalValue(item.plannedStartAt),
                      end: isoToDateTimeLocalValue(item.plannedEndAt),
                    };
                    const draftStartIso = dateTimeLocalValueToISO(draft.start) ?? item.plannedStartAt;
                    const dragValue = getScheduleProposalStartOffsetMinutes(proposal.range, draftStartIso);
                    const dragMax = getScheduleProposalDragMaxOffsetMinutes(proposal.range, item);
                    const manualConflicts = listManualAdjustmentConflicts(proposal, item.taskId);
                    const explanation = proposalExplanationByKey.get(item.changeKey) ?? proposalExplanationByKey.get(`task:${item.taskId}`);
                    const matchedRules =
                      explanation?.matchedRules.length
                        ? explanation.matchedRules
                        : item.ruleIds.map((id) => ({ id, name: ruleNames.get(id) ?? id }));
                    const avoidedBlocks = explanation?.avoidedBlocks.length ? explanation.avoidedBlocks : item.avoidedBlocks;
                    return (
                      <li key={item.changeKey} className={item.conflict ? 'has-conflict' : undefined}>
                        {proposal.status === 'draft' && (
                          <input
                            type="checkbox"
                            checked={selectedProposalChangeKeys.has(item.changeKey)}
                            onChange={() => toggleProposalChange(item.changeKey)}
                            aria-label={`选择 ${item.title}`}
                          />
                        )}
                        <div>
                          <span>{item.title}</span>
                          <small>
                            {formatDateTime(item.plannedStartAt)} - {new Date(item.plannedEndAt).toLocaleTimeString()}
                            {proposal.status !== 'draft' ? ` · ${item.confirmed ? '已确认' : '未写入'}` : ''}
                          </small>
                          {proposal.status === 'draft' && (
                            <div className="goal-proposal-edit">
                              <label className="goal-proposal-drag">
                                拖动调整
                                <input
                                  type="range"
                                  min={0}
                                  max={dragMax}
                                  step={15}
                                  value={Math.min(dragValue, dragMax)}
                                  onChange={(e) => updateProposalDragDraft(item, Number(e.target.value))}
                                  aria-label={`拖动调整 ${item.title} 开始时间`}
                                />
                              </label>
                              <label>
                                开始
                                <input
                                  type="datetime-local"
                                  value={draft.start}
                                  onChange={(e) => updateProposalEditDraft(item.changeKey, { start: e.target.value })}
                                />
                              </label>
                              <label>
                                结束
                                <input
                                  type="datetime-local"
                                  value={draft.end}
                                  onChange={(e) => updateProposalEditDraft(item.changeKey, { end: e.target.value })}
                                />
                              </label>
                              <button type="button" onClick={() => void saveProposalChange(item)} disabled={proposalBusy}>
                                更新时间
                              </button>
                              <div className="goal-proposal-nudge">
                                <button type="button" onClick={() => void shiftProposalChange(item, -15)} disabled={proposalBusy}>
                                  提前 15 分钟
                                </button>
                                <button type="button" onClick={() => void shiftProposalChange(item, 15)} disabled={proposalBusy}>
                                  后移 15 分钟
                                </button>
                              </div>
                            </div>
                          )}
                          {manualConflicts.length > 0 && (
                            <div className="goal-proposal-manual-impact">
                              {manualConflicts.map((conflict, index) => (
                                <p key={`${item.changeKey}-manual-${index}`}>
                                  手动调整影响：{conflict.message}
                                  {conflict.suggestions.length > 0 && ` · 建议：${conflict.suggestions.join('、')}`}
                                </p>
                              ))}
                            </div>
                          )}
                          <div className="goal-proposal-explanation">
                            <p>{explanation?.message || item.reason}</p>
                            {matchedRules.length > 0 && <small>命中规则：{matchedRules.map((rule) => rule.name).join('、')}</small>}
                            {avoidedBlocks.length > 0 && (
                              <small>
                                避让日程：{' '}
                                {avoidedBlocks
                                  .map((block) => `${AVOIDED_SOURCE_LABELS[block.source]} ${block.title}`)
                                  .join('、')}
                              </small>
                            )}
                            {explanation?.risks.length ? <small>风险原因：{explanation.risks.join('、')}</small> : null}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                  {proposal.changes.length === 0 && <li className="goal-empty">当前没有可写入的排期变更</li>}
                </ul>
              </section>
            )}

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
              {tasks.map((task) => {
                const dependencyOptions = tasks.filter((candidate) => candidate.id !== task.id && !task.dependencyTaskIds.includes(candidate.id));
                const scheduleInsight = scheduleInsightByTaskId.get(task.id);
                const displayStatus = goalTaskDisplayStatus(task);
                const statusActions = goalTaskStatusActions(task);
                const dependencyState = buildGoalTaskDependencyState(task, tasks);
                return (
                  <li key={task.id} className={`goal-task is-${displayStatus}`} style={{ paddingLeft: 12 + (task.level - 1) * 20 }}>
                    <span className="goal-task-title-row">
                      {task.title}
                      <span className={`goal-task-status is-${displayStatus}`}>{GOAL_TASK_STATUS_LABELS[displayStatus]}</span>
                      <span className="goal-task-row-actions">
                        {statusActions.map((action) => (
                          <button key={action.key} type="button" onClick={() => void applyTaskStatusAction(task, action)}>
                            {action.label}
                          </button>
                        ))}
                        <button type="button" onClick={() => beginTaskEdit(task)}>
                          编辑
                        </button>
                      </span>
                    </span>
                    <small>
                      {task.plannedStartAt && task.plannedEndAt
                        ? `${new Date(task.plannedStartAt).toLocaleString()} - ${new Date(task.plannedEndAt).toLocaleTimeString()}`
                        : `${task.estimatedMinutes ?? 60} 分钟`}
                      {task.scheduleEnergyType ? ` · ${ENERGY_LABELS[task.scheduleEnergyType]}` : ''}
                      {task.scheduleTaskType ? ` · ${task.scheduleTaskType}` : ''}
                    </small>
                    {editingTaskId === task.id && (
                      <form className="goal-task-edit-form" onSubmit={(e) => void saveTaskEdit(e, task)}>
                        <input value={taskEditTitle} onChange={(e) => setTaskEditTitle(e.target.value)} placeholder="任务名称" />
                        <input type="number" min="15" step="15" value={taskEditEstimate} onChange={(e) => setTaskEditEstimate(e.target.value)} />
                        <select value={taskEditPriority} onChange={(e) => setTaskEditPriority(Number(e.target.value) as Priority)}>
                          <option value={0}>无优先级</option>
                          <option value={1}>低</option>
                          <option value={2}>中</option>
                          <option value={3}>高</option>
                        </select>
                        <input type="date" value={taskEditDueDate} onChange={(e) => setTaskEditDueDate(e.target.value)} />
                        <select value={taskEditEnergy} onChange={(e) => setTaskEditEnergy(e.target.value as '' | ScheduleEnergyType)}>
                          <option value="">精力</option>
                          <option value="high">高精力</option>
                          <option value="medium">中等</option>
                          <option value="low">低精力</option>
                        </select>
                        <input placeholder="任务类型" value={taskEditType} onChange={(e) => setTaskEditType(e.target.value)} />
                        <label className="goal-task-split">
                          <input type="checkbox" checked={taskEditSplittable} onChange={(e) => setTaskEditSplittable(e.target.checked)} />
                          <span>允许拆分</span>
                        </label>
                        <input
                          type="number"
                          min="15"
                          step="15"
                          aria-label="编辑最小排期块分钟"
                          value={taskEditMinScheduleMinutes}
                          onChange={(e) => setTaskEditMinScheduleMinutes(e.target.value)}
                          disabled={!taskEditSplittable}
                        />
                        <div>
                          <button type="submit" disabled={!taskEditTitle.trim()}>
                            保存
                          </button>
                          <button type="button" onClick={() => setEditingTaskId(null)}>
                            取消
                          </button>
                        </div>
                      </form>
                    )}
                    {scheduleInsight && (
                      <div className="goal-task-insight">
                        <strong>排期解释</strong>
                        <span>{scheduleInsight.explanation ?? scheduleInsight.reason ?? '最近排期方案已为这个任务生成时间块。'}</span>
                        <em>
                          {new Date(scheduleInsight.plannedStartAt).toLocaleString()} - {new Date(scheduleInsight.plannedEndAt).toLocaleTimeString()}
                        </em>
                        {scheduleInsight.rules.length > 0 && <em>命中规则：{scheduleInsight.rules.map((rule) => rule.name).join('、')}</em>}
                        {scheduleInsight.avoidedBlocks.length > 0 && (
                          <em>
                            避让：{scheduleInsight.avoidedBlocks.map((block) => `${AVOIDED_SOURCE_LABELS[block.source]} ${block.title}`).join('、')}
                          </em>
                        )}
                      </div>
                    )}
                    <div className="goal-task-dependencies">
                      <div>
                        {dependencyState.dependencies.map((dependency) => {
                          return (
                            <span key={dependency.id} className={`goal-task-dependency-chip${dependency.satisfied ? ' is-satisfied' : ' is-blocking'}`}>
                              <span>
                                {dependency.title} · {dependency.satisfied ? '已完成' : '未完成'}
                              </span>
                              {!dependency.satisfied && dependency.task && (
                                <button type="button" onClick={() => void completeDependency(dependency.id)}>
                                  完成前置
                                </button>
                              )}
                              <button type="button" onClick={() => void removeDependency(task, dependency.id)} aria-label={`移除 ${dependency.title} 前置任务`}>
                                ×
                              </button>
                            </span>
                          );
                        })}
                        {task.dependencyTaskIds.length === 0 && <em>无前置任务</em>}
                      </div>
                      <select value="" onChange={(e) => void addDependency(task, e.target.value)} aria-label={`设置 ${task.title} 的前置任务`}>
                        <option value="">添加前置任务</option>
                        {dependencyOptions.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {'—'.repeat(Math.max(0, candidate.level - 1))} {candidate.title}
                          </option>
                        ))}
                      </select>
                    </div>
                    {dependencyState.isBlocked && (
                      <div className="goal-task-dependency-warning">
                        自动排期会等待前置任务：{dependencyState.blockers.map((dependency) => dependency.title).join('、')}。
                      </div>
                    )}
                  </li>
                );
              })}
              {tasks.length === 0 && <li className="goal-empty">把目标拆成任务后，可以一键排进日历。</li>}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
