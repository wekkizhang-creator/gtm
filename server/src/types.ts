// Shared DTO types (API response shapes) and error type.

export type Priority = 0 | 1 | 2 | 3; // 0 none, 1 low, 2 medium, 3 high

export interface ListDTO {
  id: string;
  folderId: string | null;
  name: string;
  color: string | null;
  icon: string | null;
  type: 'task' | 'note';
  sortOrder: number;
  isInbox: boolean;
  taskCount: number; // active (incomplete, not deleted) tasks in this list
}

export interface ListFolderDTO {
  id: string;
  name: string;
  sortOrder: number;
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus = 'todo' | 'doing' | 'waiting' | 'done' | 'skipped';

export interface TagDTO {
  id: string;
  name: string;
  color: string | null;
  parentId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskReminderDTO {
  id: string;
  taskId: string;
  remindAt: string;
  channel: 'email';
  status: 'scheduled' | 'sent' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

export interface TaskChecklistItemDTO {
  id: string;
  taskId: string;
  title: string;
  completed: boolean;
  sortOrder: number;
  convertedTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskActivityDTO {
  id: string;
  taskId: string;
  action: string;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface LocalCacheSummaryDTO {
  soundCacheCount: number;
  soundCacheBytes: number;
  attachmentCacheCount: number;
  attachmentCacheBytes: number;
}

export interface LocalCacheClearResultDTO extends LocalCacheSummaryDTO {
  soundCacheCleared: number;
  attachmentCacheCleared: number;
  clearedAt: string;
}

export interface TrashSummaryDTO {
  trashCount: number;
  expiredCount: number;
  retentionDays: number;
  oldestDeletedAt: string | null;
}

export interface TrashCleanupResultDTO extends TrashSummaryDTO {
  purgedCount: number;
  clearedAt: string;
}

export interface AttachmentDTO {
  id: string;
  taskId: string | null;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  createdAt: string;
}

export interface GoalDTO {
  id: string;
  title: string;
  description: string | null;
  startAt: string | null;
  deadlineAt: string | null;
  priority: Priority;
  totalEstimatedMinutes: number | null;
  availableTimeRule: string | null;
  progressMode: 'auto' | 'manual';
  status: 'not_started' | 'active' | 'paused' | 'completed' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface GoalTaskScheduleInsightDTO {
  taskId: string;
  proposalId: string;
  proposalStatus: 'draft' | 'confirmed' | 'discarded' | 'undone';
  plannedStartAt: string;
  plannedEndAt: string;
  reason: string | null;
  explanation: string | null;
  ruleIds: string[];
  rules: Array<{ id: string; name: string; priority: ScheduleRulePriority; status: ScheduleRuleStatus }>;
  avoidedBlocks: ScheduleProposalAvoidedBlockDTO[];
  createdAt: string;
}

export interface DayPilotDashboardTaskDTO {
  id: string;
  title: string;
  goalId: string;
  goalTitle: string;
  priority: Priority;
  startDate: string | null;
  dueDate: string | null;
  estimatedMinutes: number | null;
  scheduleEnergyType: ScheduleEnergyType | null;
  scheduleTaskType: string | null;
  status: TaskStatus;
  dependencyTaskIds: string[];
  blockingDependencies: Array<{ id: string; title: string; status: TaskStatus; completed: boolean }>;
}

export interface DayPilotDashboardGoalDTO {
  id: string;
  title: string;
  deadlineAt: string | null;
  priority: Priority;
  status: GoalDTO['status'];
  scheduledTodayCount: number;
  unscheduledTaskCount: number;
  openTaskCount: number;
}

export interface DayPilotDashboardRiskDTO {
  type: 'deadline_risk' | 'rule_conflict' | 'unscheduled_today' | 'dependency_blocked';
  severity: 'info' | 'warning' | 'blocking';
  goalId: string | null;
  goalTitle: string | null;
  taskId: string | null;
  taskTitle: string | null;
  ruleIds: string[];
  rules: Array<{ id: string; name: string; priority: ScheduleRulePriority; status: ScheduleRuleStatus }>;
  message: string;
  suggestions: string[];
}

export interface DayPilotDashboardRuleImpactDTO {
  proposalId: string;
  proposalStatus: 'draft' | 'confirmed' | 'discarded' | 'undone';
  goalId: string | null;
  goalTitle: string | null;
  taskId: string | null;
  taskTitle: string;
  plannedStartAt: string;
  plannedEndAt: string;
  ruleIds: string[];
  rules: Array<{ id: string; name: string; priority: ScheduleRulePriority; status: ScheduleRuleStatus }>;
  avoidedBlocks: ScheduleProposalAvoidedBlockDTO[];
  reason: string | null;
  createdAt: string;
}

export interface DayPilotDashboardDTO {
  date: string;
  range: { from: string; to: string };
  summary: {
    topTaskCount: number;
    activeGoalCount: number;
    scheduledTodayCount: number;
    unscheduledTaskCount: number;
    riskCount: number;
    ruleImpactCount: number;
  };
  topTasks: DayPilotDashboardTaskDTO[];
  activeGoals: DayPilotDashboardGoalDTO[];
  scheduledTasks: DayPilotDashboardTaskDTO[];
  unscheduledTasks: DayPilotDashboardTaskDTO[];
  risks: DayPilotDashboardRiskDTO[];
  ruleImpacts: DayPilotDashboardRuleImpactDTO[];
}

export type ScheduleRuleType =
  | 'time_boundary'
  | 'energy_preference'
  | 'fixed_habit'
  | 'buffer'
  | 'task_category'
  | 'reminder'
  | 'plan_priority';

export type ScheduleRuleStatus = 'enabled' | 'disabled';
export type ScheduleRulePriority = 'hard' | 'normal' | 'preference';
export type ScheduleEnergyType = 'high' | 'medium' | 'low';

export interface PersonalScheduleRuleDTO {
  id: string;
  name: string;
  description: string | null;
  type: ScheduleRuleType;
  status: ScheduleRuleStatus;
  priority: ScheduleRulePriority;
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
  scope: Record<string, unknown>;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRuleDraftDTO {
  name: string;
  description: string | null;
  type: ScheduleRuleType;
  status: ScheduleRuleStatus;
  priority: ScheduleRulePriority;
  condition: Record<string, unknown>;
  action: Record<string, unknown>;
  scope: Record<string, unknown>;
}

export interface ScheduleRuleTemplateDTO extends ScheduleRuleDraftDTO {
  id: string;
  sortOrder: number;
}

export interface ScheduleProposalAvoidedBlockDTO {
  source: 'task' | 'external' | 'rule' | 'scheduled';
  title: string;
  start: string;
  end: string;
  ruleId?: string | null;
}

export interface ScheduleProposalChangeDTO {
  changeKey: string;
  taskId: string;
  title: string;
  operation: 'schedule_task' | 'create_split_segment';
  segmentIndex: number | null;
  segmentTotal: number | null;
  createdTaskId: string | null;
  oldStartDate: string | null;
  oldDueDate: string | null;
  oldPlannedStartAt: string | null;
  oldPlannedEndAt: string | null;
  oldIsAllDay: boolean;
  plannedStartAt: string;
  plannedEndAt: string;
  durationMinutes: number;
  ruleIds: string[];
  avoidedBlocks: ScheduleProposalAvoidedBlockDTO[];
  reason: string;
  conflict: boolean;
  confirmed: boolean;
}

export interface ScheduleProposalExplanationDTO {
  taskId: string;
  ruleIds: string[];
  message: string;
}

export interface ScheduleProposalConflictDTO {
  type:
    | 'rule_conflict'
    | 'schedule_overflow'
    | 'dependency_cycle'
    | 'dependency_blocked'
    | 'invalid_rule'
    | 'task_blocked'
    | 'reschedule_impact'
    | 'manual_adjustment_conflict';
  severity: 'info' | 'warning' | 'blocking';
  taskId?: string | null;
  ruleIds: string[];
  message: string;
  suggestions: string[];
}

export interface ScheduleProposalDTO {
  id: string;
  goalId: string;
  status: 'draft' | 'confirmed' | 'discarded' | 'undone';
  range: { from: string; to: string };
  changes: ScheduleProposalChangeDTO[];
  explanations: ScheduleProposalExplanationDTO[];
  conflicts: ScheduleProposalConflictDTO[];
  riskScore: number;
  createdAt: string;
  confirmedAt: string | null;
}

export interface ScheduleRulePreviewBlockDTO {
  start: string;
  end: string;
  ruleId: string | null;
  ruleName: string;
}

export interface ScheduleRulePreviewAffectedTaskDTO {
  taskId: string;
  title: string;
  startDate: string;
  dueDate: string;
  ruleBlockStart: string;
  ruleBlockEnd: string;
}

export interface ScheduleRulePreviewDTO {
  range: { from: string; to: string };
  blockedSlots: ScheduleRulePreviewBlockDTO[];
  affectedTasks: ScheduleRulePreviewAffectedTaskDTO[];
  summary: {
    blockedSlotCount: number;
    affectedTaskCount: number;
  };
}

export interface ScheduleRuleDetailImpactDTO {
  proposalId: string;
  proposalStatus: ScheduleProposalDTO['status'];
  taskId: string;
  title: string;
  operation: ScheduleProposalChangeDTO['operation'];
  plannedStartAt: string;
  plannedEndAt: string;
  durationMinutes: number;
  reason: string;
  createdAt: string;
}

export interface ScheduleRuleDetailConflictDTO {
  proposalId: string;
  proposalStatus: ScheduleProposalDTO['status'];
  type: ScheduleProposalConflictDTO['type'];
  severity: ScheduleProposalConflictDTO['severity'];
  taskId: string | null;
  message: string;
  suggestions: string[];
  createdAt: string;
}

export interface ScheduleRuleDetailsDTO {
  rule: PersonalScheduleRuleDTO;
  hitCount: number;
  conflictCount: number;
  recentImpacts: ScheduleRuleDetailImpactDTO[];
  recentConflicts: ScheduleRuleDetailConflictDTO[];
}

export interface ScheduleRuleConflictRuleDTO {
  id: string;
  name: string;
  priority: ScheduleRulePriority;
  status: ScheduleRuleStatus;
}

export interface ScheduleRuleConflictItemDTO {
  id: string;
  proposalId: string;
  proposalStatus: ScheduleProposalDTO['status'];
  goalId: string;
  createdAt: string;
  type: ScheduleProposalConflictDTO['type'];
  severity: ScheduleProposalConflictDTO['severity'];
  taskId: string | null;
  taskTitle: string | null;
  ruleIds: string[];
  rules: ScheduleRuleConflictRuleDTO[];
  message: string;
  suggestions: string[];
}

export interface ScheduleRuleConflictListDTO {
  conflicts: ScheduleRuleConflictItemDTO[];
  summary: {
    total: number;
    blocking: number;
    warning: number;
    info: number;
  };
}

export interface NotificationDTO {
  id: string;
  type: string;
  title: string;
  body: string | null;
  targetType: string | null;
  targetId: string | null;
  scheduledAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  actionState: string | null;
  createdAt: string;
}

export type NotificationPermissionStatus = 'unknown' | 'default' | 'granted' | 'denied' | 'unsupported';
export type NotificationPermissionPromptReason = 'settings' | 'task_reminder' | 'habit_reminder' | 'focus_reminder';

export interface NotificationPermissionDTO {
  permission: 'system-notifications';
  status: NotificationPermissionStatus;
  promptReason: NotificationPermissionPromptReason | null;
  lastPromptedAt: string | null;
  updatedAt: string | null;
  shouldPrompt: boolean;
  guidance: 'request_when_needed' | 'enabled' | 'blocked' | 'unsupported';
}

export interface NotificationSoundDTO {
  id: string;
  name: string;
  purpose: 'reminder' | 'completion' | 'both';
  mimeType: string;
  sizeBytes: number;
  downloadUrl: string;
  createdAt: string;
}

export interface SearchResultDTO {
  type: 'tasks' | 'lists' | 'tags' | 'habits' | 'countdowns' | 'goals';
  id: string;
  title: string;
  subtitle: string | null;
  matchedFields: string[];
  updatedAt: string;
}

export interface SavedFilterDTO {
  id: string;
  name: string;
  query: Record<string, unknown>;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface QuickParseTokenDTO {
  type: 'date' | 'time' | 'priority' | 'tag' | 'estimate' | 'recurrence' | 'url' | 'text';
  raw: string;
  value: string | number;
}

export interface QuickParseResultDTO {
  tokens: QuickParseTokenDTO[];
  draft: {
    title: string;
    dueDate: string | null;
    startDate: string | null;
    isAllDay: boolean;
    priority: Priority;
    estimatedMinutes: number | null;
    recurrenceRule: string | null;
    note: string | null;
    tags: string[];
  };
}

export type QuickCaptureSource = 'voice' | 'system_share' | 'desktop_widget' | 'shortcut' | 'web';

export interface QuickCaptureResultDTO {
  task: TaskDTO;
  parsed: QuickParseResultDTO | null;
}

export interface DesktopWidgetDTO {
  id: string;
  type: string;
  title: string;
  config: Record<string, unknown>;
  position: { x: number; y: number; width: number; height: number; screen: string | null };
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopWidgetTemplateDTO {
  type: string;
  label: string;
  priority: 'P1' | 'P2';
  defaultTitle: string;
  defaultConfig: Record<string, unknown>;
  defaultPosition: DesktopWidgetDTO['position'];
}

export interface DesktopTodayTasksWidgetDataDTO {
  type: 'today-tasks';
  widget: DesktopWidgetDTO;
  generatedAt: string;
  tasks: TaskDTO[];
  counts: { shown: number; total: number; overdue: number };
  allowComplete: boolean;
}

export interface DesktopInboxQuickAddWidgetDataDTO {
  type: 'inbox-quick-add';
  widget: DesktopWidgetDTO;
  generatedAt: string;
  tasks: TaskDTO[];
  counts: { shown: number; total: number };
  quickAdd: boolean;
}

export interface DesktopHabitCheckinWidgetDataDTO {
  type: 'habit-checkin';
  widget: DesktopWidgetDTO;
  generatedAt: string;
  date: string;
  habits: HabitDTO[];
  counts: { shown: number; total: number; checked: number };
  allowCheckin: boolean;
}

export interface DesktopFocusTimerStateDTO {
  status: 'idle' | 'running' | 'paused';
  mode: 'pomodoro';
  targetDurationSec: number;
  elapsedSec: number;
  remainingSec: number;
  startedAt: string | null;
  pausedAt: string | null;
  updatedAt: string | null;
}

export interface DesktopFocusTimerWidgetDataDTO {
  type: 'focus-timer';
  widget: DesktopWidgetDTO;
  generatedAt: string;
  timer: DesktopFocusTimerStateDTO;
  stats: FocusStats;
  allowStartPause: boolean;
}

export interface DesktopCountdownsWidgetDataDTO {
  type: 'countdowns';
  widget: DesktopWidgetDTO;
  generatedAt: string;
  countdowns: CountdownDTO[];
  counts: { shown: number; total: number; pinned: number; elapsed: number };
  pinnedFirst: boolean;
}

export interface DesktopGoalProgressItemDTO {
  goal: GoalDTO;
  progress: {
    totalTasks: number;
    completedTasks: number;
    totalEstimatedMinutes: number;
    completedEstimatedMinutes: number;
    percent: number;
  };
  todaySuggestion: {
    taskId: string;
    title: string;
    estimatedMinutes: number | null;
    plannedStartAt: string | null;
    dueDate: string | null;
  } | null;
}

export interface DesktopGoalProgressWidgetDataDTO {
  type: 'goal-progress';
  widget: DesktopWidgetDTO;
  generatedAt: string;
  goals: DesktopGoalProgressItemDTO[];
  counts: { shown: number; total: number; active: number; completed: number };
  showTodaySuggestion: boolean;
}

export type DesktopWidgetDataDTO =
  | DesktopTodayTasksWidgetDataDTO
  | DesktopInboxQuickAddWidgetDataDTO
  | DesktopHabitCheckinWidgetDataDTO
  | DesktopFocusTimerWidgetDataDTO
  | DesktopCountdownsWidgetDataDTO
  | DesktopGoalProgressWidgetDataDTO;

export interface DesktopWidgetActionResultDTO {
  widget: DesktopWidgetDTO;
  data: DesktopWidgetDataDTO;
  task?: TaskDTO;
  habit?: HabitDTO;
  checkin?: { checked: boolean; currentStreak: number; bestStreak: number };
}

export interface DesktopShortcutDTO {
  id: string;
  action: string;
  accelerator: string;
  enabled: boolean;
  registeredAt: string | null;
  hostRegistered: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopShortcutTemplateDTO {
  action: string;
  label: string;
  accelerator: string;
  priority: 'P1' | 'P2';
}

export interface DesktopShellStateDTO {
  startup: boolean;
  tray: boolean;
  closeBehavior: 'minimize_to_tray' | 'quit';
  appLock: boolean;
  locked: boolean;
  autoLockMinutes: 0 | 1 | 5 | 10;
  lastActiveAt: string | null;
  autoLockedAt: string | null;
  backgroundAudioAllowed: boolean;
}

export interface DesktopStatusDTO {
  hostAvailable: boolean;
  hostAdapter: 'web-bridge';
  appLockPasswordSet: boolean;
  capabilities: {
    widgets: 'persisted';
    globalShortcuts: 'host_required';
    startup: 'persisted';
    tray: 'persisted';
    closeBehavior: 'persisted';
    appLock: 'persisted';
    autoLock: 'web_bridge';
    systemCalendar: 'calendar_subscriptions';
    backgroundAudio: 'web_only';
  };
  state: DesktopShellStateDTO;
  updatedAt: string | null;
}

export interface AIBreakdownSuggestionDTO {
  title: string;
  note: string | null;
  estimatedMinutes: number | null;
  priority: Priority;
}

export interface AIBreakdownResultDTO {
  logId: string;
  suggestions: AIBreakdownSuggestionDTO[];
}

export interface AIQuadrantSuggestionDTO {
  isImportant: boolean;
  isUrgent: boolean;
  confidence: number;
  reason: string | null;
}

export interface AIQuadrantSuggestionResultDTO {
  logId: string;
  taskId: string;
  current: { isImportant: boolean | null; isUrgent: boolean | null };
  suggestion: AIQuadrantSuggestionDTO;
}

export interface AIReviewNextActionDTO {
  title: string;
  reason: string | null;
}

export interface AIReviewResultDTO {
  logId: string;
  range: { from: string; to: string };
  metrics: {
    completedTasks: number;
    openOverdueTasks: number;
    focusMinutes: number;
    focusSessions: number;
    habitCheckins: number;
    activeGoals: number;
    completedGoals: number;
  };
  summary: string;
  wins: string[];
  risks: string[];
  suggestions: string[];
  nextActions: AIReviewNextActionDTO[];
}

export interface AIScheduleSuggestionDTO {
  taskId: string;
  title: string;
  plannedStartAt: string;
  plannedEndAt: string;
  reason: string | null;
}

export interface AIScheduleResultDTO {
  logId: string;
  goalId: string | null;
  range: { from: string; to: string };
  suggestions: AIScheduleSuggestionDTO[];
}

export interface AITaskStructureUpdateDTO {
  taskId: string;
  title: string;
  estimatedMinutes: number | null;
  scheduleEnergyType: ScheduleEnergyType | null;
  scheduleTaskType: string | null;
  isSplittable: boolean;
  minScheduleMinutes: number | null;
  reason: string | null;
}

export interface AITaskStructureResultDTO {
  logId: string;
  goalId: string;
  updates: AITaskStructureUpdateDTO[];
  tasks: TaskDTO[];
}

export interface AIScheduleRuleParseResultDTO {
  logId: string;
  text: string;
  rule: ScheduleRuleDraftDTO;
  explanation: string | null;
  confidence: number;
}

export interface StickyNoteDTO {
  id: string;
  taskId: string | null;
  title: string;
  body: string;
  color: string | null;
  opacity: number;
  fontSize: 'small' | 'normal' | 'large' | 'xlarge';
  pinned: boolean;
  position: { x: number; y: number; width: number; height: number };
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
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
  parentId: string | null; // null = top-level task; otherwise a subtask
  parentTitle: string | null;
  hierarchyPath: string[];
  goalId: string | null;
  rootTaskId: string | null;
  level: number;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  actualStartAt: string | null;
  actualEndAt: string | null;
  dependencyTaskIds: string[];
  autoScheduleEnabled: boolean;
  isLockedSchedule: boolean;
  estimatedMinutes: number | null;
  scheduleEnergyType: ScheduleEnergyType | null;
  scheduleTaskType: string | null;
  isSplittable: boolean;
  minScheduleMinutes: number | null;
  subtaskConfig: { progressMode: 'auto' | 'count' | 'estimate'; autoCompleteParent: boolean; collapsed: boolean };
  recurrenceRule: string | null;
  source: string;
  manualProgress: number | null;
  pinned: boolean;
  status: TaskStatus;
  tags: TagDTO[];
  reminders: TaskReminderDTO[];
  attachments: AttachmentDTO[];
  checklistTotal: number;
  checklistDone: number;
  subtaskTotal: number; // # of (non-deleted) direct children
  subtaskDone: number; // # of completed direct children
  rollupProgress: number; // 0..1 progress rolled up from children (or self-completion for leaves)
  completed: boolean;
  completedAt: string | null;
  deletedAt: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type SyncOperationStatus = 'applied' | 'duplicate' | 'conflict' | 'failed';
export type AccountSyncHealth = 'never_synced' | 'synced' | 'conflict' | 'failed';

export interface SyncOperationResultDTO {
  clientOperationId: string;
  entityType: 'task';
  action: 'create' | 'update' | 'delete';
  status: SyncOperationStatus;
  entityId: string | null;
  task?: TaskDTO | null;
  conflict?: { serverTask: TaskDTO | null; baseUpdatedAt: string | null } | null;
  error?: { code: string; message: string } | null;
  appliedAt: string | null;
}

export interface AccountSyncStatusDTO {
  health: AccountSyncHealth;
  lastSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  pendingServerOperationCount: number;
  statusCounts: {
    applied: number;
    conflict: number;
    failed: number;
  };
  lastOperation: {
    clientOperationId: string;
    entityType: 'task';
    action: 'create' | 'update' | 'delete';
    status: Exclude<SyncOperationStatus, 'duplicate'>;
    entityId: string | null;
    error: { code: string; message: string } | null;
    receivedAt: string;
    appliedAt: string | null;
  } | null;
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
  backgroundSoundId: string | null;
  backgroundSoundName: string | null;
  backgroundVolume: number | null;
  soundPlayedDuration: number | null;
  isMuted: boolean;
  note: string | null;
  createdAt: string;
}

export interface FocusRestCycleDTO {
  id: string;
  focusSessionId: string;
  restStartedAt: string;
  restEndedAt: string;
  restDurationSec: number;
  nextFocusStartedAt: string | null;
  reminderStatus: 'created' | 'suppressed';
  notificationId: string | null;
  createdAt: string;
}

export interface FocusStats {
  todayCount: number;
  todayDurationSec: number;
  totalCount: number;
  totalDurationSec: number;
}

export interface BackgroundSoundDTO {
  id: string;
  name: string;
  category: string | null;
  assetUrl: string;
  license: string | null;
  cacheStatus: string | null;
  localPath: string | null;
  volume: number | null;
}

export interface FocusReportDTO {
  range: 'day' | 'week' | 'month';
  buckets: { label: string; count: number; durationSec: number }[];
  byTask: FocusReportDimensionDTO[];
  byList: FocusReportDimensionDTO[];
  byTag: FocusReportDimensionDTO[];
  totalCount: number;
  totalDurationSec: number;
}

export interface FocusReportDimensionDTO {
  id: string | null;
  name: string;
  count: number;
  durationSec: number;
}

export type FocusAchievementMetric = 'pomodoro_count' | 'focus_duration_sec' | 'daily_pomodoro_count';

export interface FocusAchievementDTO {
  id: string;
  title: string;
  description: string;
  metric: FocusAchievementMetric;
  target: number;
  progress: number;
  achieved: boolean;
  achievedAt: string | null;
}

export interface CalendarSubscriptionDTO {
  id: string;
  type: string;
  name: string;
  url: string | null;
  color: string | null;
  enabled: boolean;
  lastSyncedAt: string | null;
  createdAt: string;
}

export type SystemCalendarPermissionStatus = 'unknown' | 'granted' | 'denied' | 'unsupported';
export type SystemCalendarPermissionReason = 'system_calendar_subscription';

export interface SystemCalendarPermissionDTO {
  permission: 'system-calendar-readonly';
  status: SystemCalendarPermissionStatus;
  promptReason: SystemCalendarPermissionReason | null;
  lastPromptedAt: string | null;
  updatedAt: string | null;
  shouldPrompt: boolean;
  guidance: 'request_when_needed' | 'enabled' | 'blocked' | 'unsupported';
}

export interface ExternalCalendarEventDTO {
  id: string;
  subscriptionId: string;
  externalUid: string;
  title: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  rawJson: string | null;
}

export interface CalendarDayInfoDTO {
  date: string;
  lunarLabel: string;
  holidayName: string | null;
  holidayType: 'public_holiday' | 'adjusted_workday' | null;
  isOffDay: boolean;
  isAdjustedWorkday: boolean;
  source: string | null;
}

export interface HabitDTO {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  daysOfWeek: number[]; // 0=Sun .. 6=Sat
  targetType: 'check' | 'count' | 'timer';
  targetValue: number | null;
  targetUnit: string | null;
  startDate: string | null;
  groupName: string | null;
  reminderTime: string | null;
  note: string | null;
  sortOrder: number;
  archived: boolean;
  checkins: string[]; // checked dates (YYYY-MM-DD) within the queried range
  checkinDetails: { date: string; value: number | null; note: string | null }[];
  currentStreak: number;
  bestStreak: number;
  createdAt: string;
  updatedAt: string;
}

export interface HabitStatsDTO {
  habitId: string;
  from: string;
  to: string;
  scheduledDays: number;
  completedDays: number;
  completionRate: number;
  totalValue: number;
  currentStreak: number;
  bestStreak: number;
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

export interface Settings {
  account: Record<string, never>;
  notifications: {
    enabled: boolean;
    email: boolean;
    desktop: boolean;
    doNotDisturb: boolean;
    doNotDisturbStart: string | null;
    doNotDisturbEnd: string | null;
    reminderSound: 'default' | 'custom';
    reminderSoundId: string | null;
    detailVisibility: 'when_unlocked' | 'always' | 'hidden';
    completionSound: 'ding' | 'none' | 'custom';
    completionSoundId: string | null;
    reminderVolume: number;
    taskReminders: boolean;
    habitReminders: boolean;
    focusReminders: boolean;
    goalReminders: boolean;
  };
  focus: {
    defaultMinutes: number;
    restMinutes: number;
    longRestMinutes: number;
    longRestInterval: number;
    soundId: string | null;
    defaultVolume: number;
    pauseSoundOnPause: boolean;
    playSoundDuringRest: boolean;
    backgroundAudioAllowed: boolean;
    autoCacheSounds: boolean;
    fadeOutStop: boolean;
  };
  quickAdd: {
    defaultListId: string | null;
    parseEnabled: boolean;
    dateRecognition: boolean;
    removeDateText: boolean;
    tagRecognition: boolean;
    removeTagText: boolean;
    urlParsing: boolean;
  };
  miniCalendar: { enabled: boolean; showLunar: 'follow' | 'on' | 'off'; showWeekNumbers: boolean };
  imports: { lastSource: string | null };
  calendar: { view: 'day' | '3day' | 'week' | 'month' };
  notes: {
    enabled: boolean;
    defaultColor: string;
    defaultOpacity: number;
    defaultFontSize: StickyNoteDTO['fontSize'];
    defaultPinned: boolean;
    defaultPosition: { x: number; y: number; width: number; height: number };
  };
  widgets: { enabled: boolean };
  shortcuts: { enabled: boolean };
  desktop: { startup: boolean; tray: boolean; appLock: boolean };
  localization: {
    language: 'system' | 'zh-CN' | 'en-US';
  };
  appearance: {
    themeMode: 'light' | 'dark' | 'system';
    accent: string;
    fontSize: 'small' | 'normal' | 'large' | 'xlarge';
    density: 'compact' | 'standard' | 'loose';
    animations: boolean;
    sidebarBackground: { type: 'default' | 'color' | 'image'; color: string; imageUrl: string | null };
    appOpacity: number;
  };
  datetime: {
    weekStart: 0 | 1;
    timeFormat: 'system' | '12' | '24';
    showLunar: boolean;
    showHolidayAdjustments: boolean;
    timeZoneMode: 'system' | 'manual';
    timeZone: string | null;
  };
  modules: { hidden: string[]; defaultLaunch: string; order: string[] };
  smartLists: { hidden: string[] };
  taskDefaults: {
    priority: 0 | 1 | 2 | 3;
    listId: string | null;
    defaultDate: 'none' | 'today' | 'tomorrow' | 'custom';
    customDate: string | null;
    dateMode: 'date' | 'timeBlock' | 'allDay';
    defaultTimeBlockMinutes: number;
    defaultTimeBlockStart: string;
    timedReminder: 'none' | 'at_start' | '5m_before' | '30m_before' | 'custom';
    timedReminderCustomMinutes: number;
    allDayReminder: 'none' | '1d_before' | 'same_day';
    allDayReminderTime: string;
    defaultTagIds: string[];
    addPosition: 'top' | 'bottom';
    overduePosition: 'top' | 'original' | 'grouped';
  };
  ai: { enabled: boolean; provider: string; baseUrl: string; model: string; hasApiKey: boolean; apiKeyMasked: string };
}

export interface UserDTO {
  id: string;
  nickname: string | null;
  avatarUrl: string | null;
  phoneMasked: string | null;
  emailMasked: string | null;
  status: 'normal' | 'frozen' | 'deleting' | 'deleted';
  registeredAt: string;
  lastLoginAt: string | null;
  deleteRequestedAt: string | null;
  deleteScheduledAt: string | null;
}

export interface AccountOnboardingDTO {
  firstTaskCreated: boolean;
  showFirstTaskGuide: boolean;
  totalTaskCount: number;
  activeTaskCount: number;
}

export interface SessionDTO {
  id: string;
  userId: string;
  deviceId: string;
  deviceName: string | null;
  platform: string | null;
  appVersion: string | null;
  loginAt: string;
  lastActiveAt: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  isCurrentDevice: boolean;
  revokedAt: string | null;
}

export interface AccountDeletionPreviewDTO {
  user: UserDTO;
  coolingDays: number;
  deletionImpact: {
    lists: number;
    tasks: number;
    goals: number;
    tags: number;
    attachments: number;
    notifications: number;
    focusSessions: number;
    habits: number;
    countdowns: number;
    notes: number;
    settings: number;
  };
}

export interface AccountDeletionRequestDTO {
  user: UserDTO;
  deleteScheduledAt: string;
  coolingDays: number;
}

export interface AccountIdentityDTO {
  id: string;
  type: 'email' | 'phone' | 'oauth';
  provider: string | null;
  displayIdentifier: string;
  isPrimary: boolean;
  verifiedAt: string;
  boundAt: string;
}

export interface AuthContext {
  userId: string;
  sessionId: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
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
