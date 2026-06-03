// Mirror of the server DTOs (the API contract).
export type Priority = 0 | 1 | 2 | 3;

export interface List {
  id: string;
  folderId: string | null;
  name: string;
  color: string | null;
  icon: string | null;
  type: 'task' | 'note';
  sortOrder: number;
  isInbox: boolean;
  taskCount: number;
}

export interface ListFolder {
  id: string;
  name: string;
  sortOrder: number;
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus = 'todo' | 'doing' | 'waiting' | 'done' | 'skipped';

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  parentId: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskReminder {
  id: string;
  taskId: string;
  remindAt: string;
  channel: 'email';
  status: 'scheduled' | 'sent' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

export interface TaskChecklistItem {
  id: string;
  taskId: string;
  title: string;
  completed: boolean;
  sortOrder: number;
  convertedTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskActivity {
  id: string;
  taskId: string;
  action: string;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface LocalCacheSummary {
  soundCacheCount: number;
  soundCacheBytes: number;
  attachmentCacheCount: number;
  attachmentCacheBytes: number;
}

export interface LocalCacheClearResult extends LocalCacheSummary {
  soundCacheCleared: number;
  attachmentCacheCleared: number;
  clearedAt: string;
}

export type AccountSyncHealth = 'never_synced' | 'synced' | 'conflict' | 'failed';

export interface AccountSyncStatus {
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
    status: 'applied' | 'conflict' | 'failed';
    entityId: string | null;
    error: { code: string; message: string } | null;
    receivedAt: string;
    appliedAt: string | null;
  } | null;
}

export type ImportFormat = 'json' | 'csv';

export interface ImportRow {
  type: string;
  title: string;
  payload: Record<string, unknown>;
}

export interface ImportInvalidRow {
  type: string;
  reason: string;
  payload: unknown;
}

export interface ImportPreviewResult {
  summary: { total: number; valid: number; duplicates: number; invalid: number };
  rows: ImportRow[];
  duplicates: ImportRow[];
  invalidRows: ImportInvalidRow[];
}

export interface ImportCommitResult {
  created: ImportRow[];
  skippedDuplicates: ImportRow[];
  invalidRows: ImportInvalidRow[];
}

export interface TrashSummary {
  trashCount: number;
  expiredCount: number;
  retentionDays: number;
  oldestDeletedAt: string | null;
}

export interface TrashCleanupResult extends TrashSummary {
  purgedCount: number;
  clearedAt: string;
}

export interface Attachment {
  id: string;
  taskId: string | null;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  createdAt: string;
}

export interface Goal {
  id: string;
  title: string;
  description: string | null;
  startAt: string | null;
  deadlineAt: string | null;
  totalEstimatedMinutes: number | null;
  availableTimeRule: string | null;
  progressMode: 'auto' | 'manual';
  status: 'not_started' | 'active' | 'completed' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface Notification {
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

export interface NotificationPermissionState {
  permission: 'system-notifications';
  status: NotificationPermissionStatus;
  promptReason: NotificationPermissionPromptReason | null;
  lastPromptedAt: string | null;
  updatedAt: string | null;
  shouldPrompt: boolean;
  guidance: 'request_when_needed' | 'enabled' | 'blocked' | 'unsupported';
}

export interface NotificationSound {
  id: string;
  name: string;
  purpose: 'reminder' | 'completion' | 'both';
  mimeType: string;
  sizeBytes: number;
  downloadUrl: string;
  createdAt: string;
}

export interface SearchResult {
  type: 'tasks' | 'lists' | 'tags' | 'habits' | 'countdowns' | 'goals';
  id: string;
  title: string;
  subtitle: string | null;
  matchedFields: string[];
  updatedAt: string;
}

export interface SavedFilter {
  id: string;
  name: string;
  query: Record<string, unknown>;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface QuickParseToken {
  type: 'date' | 'time' | 'priority' | 'tag' | 'estimate' | 'recurrence' | 'url' | 'text';
  raw: string;
  value: string | number;
}

export interface QuickParseResult {
  tokens: QuickParseToken[];
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

export interface QuickCaptureResult {
  task: Task;
  parsed: QuickParseResult | null;
}

export interface DesktopWidget {
  id: string;
  type: string;
  title: string;
  config: Record<string, unknown>;
  position: { x: number; y: number; width: number; height: number; screen: string | null };
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopWidgetTemplate {
  type: string;
  label: string;
  priority: 'P1' | 'P2';
  defaultTitle: string;
  defaultConfig: Record<string, unknown>;
  defaultPosition: DesktopWidget['position'];
}

export interface DesktopTodayTasksWidgetData {
  type: 'today-tasks';
  widget: DesktopWidget;
  generatedAt: string;
  tasks: Task[];
  counts: { shown: number; total: number; overdue: number };
  allowComplete: boolean;
}

export type DesktopWidgetData = DesktopTodayTasksWidgetData;

export interface DesktopWidgetActionResult {
  widget: DesktopWidget;
  data: DesktopWidgetData;
  task?: Task;
}

export interface DesktopShortcut {
  id: string;
  action: string;
  accelerator: string;
  enabled: boolean;
  registeredAt: string | null;
  hostRegistered: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DesktopShortcutTemplate {
  action: string;
  label: string;
  accelerator: string;
  priority: 'P1' | 'P2';
}

export interface DesktopShellState {
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

export interface DesktopStatus {
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
  state: DesktopShellState;
  updatedAt: string | null;
}

export interface AIBreakdownSuggestion {
  title: string;
  note: string | null;
  estimatedMinutes: number | null;
  priority: Priority;
}

export interface AIBreakdownResult {
  logId: string;
  suggestions: AIBreakdownSuggestion[];
}

export interface AIQuadrantSuggestion {
  isImportant: boolean;
  isUrgent: boolean;
  confidence: number;
  reason: string | null;
}

export interface AIQuadrantSuggestionResult {
  logId: string;
  taskId: string;
  current: { isImportant: boolean | null; isUrgent: boolean | null };
  suggestion: AIQuadrantSuggestion;
}

export interface AIReviewNextAction {
  title: string;
  reason: string | null;
}

export interface AIReviewResult {
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
  nextActions: AIReviewNextAction[];
}

export interface AIScheduleSuggestion {
  taskId: string;
  title: string;
  plannedStartAt: string;
  plannedEndAt: string;
  reason: string | null;
}

export interface AIScheduleResult {
  logId: string;
  goalId: string | null;
  range: { from: string; to: string };
  suggestions: AIScheduleSuggestion[];
}

export interface StickyNote {
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
  parentId: string | null;
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
  subtaskConfig: { progressMode: 'auto' | 'count' | 'estimate'; autoCompleteParent: boolean; collapsed: boolean };
  recurrenceRule: string | null;
  source: string;
  manualProgress: number | null;
  pinned: boolean;
  status: TaskStatus;
  tags: Tag[];
  reminders: TaskReminder[];
  attachments: Attachment[];
  checklistTotal: number;
  checklistDone: number;
  subtaskTotal: number;
  subtaskDone: number;
  rollupProgress: number;
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
  backgroundSoundId: string | null;
  backgroundSoundName: string | null;
  backgroundVolume: number | null;
  soundPlayedDuration: number | null;
  isMuted: boolean;
  note: string | null;
  createdAt: string;
}

export interface FocusRestCycle {
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

export interface BackgroundSound {
  id: string;
  name: string;
  category: string | null;
  assetUrl: string;
  license: string | null;
  cacheStatus: string | null;
  localPath: string | null;
  volume: number | null;
}

export interface FocusReport {
  range: 'day' | 'week' | 'month';
  buckets: { label: string; count: number; durationSec: number }[];
  byTask: FocusReportDimension[];
  byList: FocusReportDimension[];
  byTag: FocusReportDimension[];
  totalCount: number;
  totalDurationSec: number;
}

export interface FocusReportDimension {
  id: string | null;
  name: string;
  count: number;
  durationSec: number;
}

export type FocusAchievementMetric = 'pomodoro_count' | 'focus_duration_sec' | 'daily_pomodoro_count';

export interface FocusAchievement {
  id: string;
  title: string;
  description: string;
  metric: FocusAchievementMetric;
  target: number;
  progress: number;
  achieved: boolean;
  achievedAt: string | null;
}

export interface CalendarSubscription {
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

export interface SystemCalendarPermission {
  permission: 'system-calendar-readonly';
  status: SystemCalendarPermissionStatus;
  promptReason: SystemCalendarPermissionReason | null;
  lastPromptedAt: string | null;
  updatedAt: string | null;
  shouldPrompt: boolean;
  guidance: 'request_when_needed' | 'enabled' | 'blocked' | 'unsupported';
}

export interface ExternalCalendarEvent {
  id: string;
  subscriptionId: string;
  externalUid: string;
  title: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  rawJson: string | null;
}

export interface CalendarDayInfo {
  date: string;
  lunarLabel: string;
  holidayName: string | null;
  holidayType: 'public_holiday' | 'adjusted_workday' | null;
  isOffDay: boolean;
  isAdjustedWorkday: boolean;
  source: string | null;
}

export interface Habit {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  daysOfWeek: number[];
  targetType: 'check' | 'count' | 'timer';
  targetValue: number | null;
  targetUnit: string | null;
  startDate: string | null;
  groupName: string | null;
  reminderTime: string | null;
  note: string | null;
  sortOrder: number;
  archived: boolean;
  checkins: string[];
  checkinDetails: { date: string; value: number | null; note: string | null }[];
  currentStreak: number;
  bestStreak: number;
  createdAt: string;
  updatedAt: string;
}

export interface HabitStats {
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
    defaultFontSize: StickyNote['fontSize'];
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

export interface User {
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

export interface AccountOnboarding {
  firstTaskCreated: boolean;
  showFirstTaskGuide: boolean;
  totalTaskCount: number;
  activeTaskCount: number;
}

export interface AuthSession {
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

export interface AccountDeletionPreview {
  user: User;
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

export interface AccountDeletionRequest {
  user: User;
  deleteScheduledAt: string;
  coolingDays: number;
}

export interface AccountIdentity {
  id: string;
  type: 'email' | 'phone' | 'oauth';
  provider: string | null;
  displayIdentifier: string;
  isPrimary: boolean;
  verifiedAt: string;
  boundAt: string;
}

export interface AboutContact {
  contactEmail: string | null;
  feedbackUrl: string | null;
  supportText: string | null;
}

export interface OpenSourceLicensePackage {
  name: string;
  version: string;
  license: string | null;
  dev: boolean;
  optional: boolean;
  resolved: string | null;
}

export interface OpenSourceLicenses {
  source: 'package-lock.json';
  generatedAt: string;
  packageCount: number;
  packages: OpenSourceLicensePackage[];
}

export interface DiagnosticLogUpload {
  id: string;
  filename: string;
  sizeBytes: number;
  uploadedAt: string;
  entryCount: number;
}

export type SettingsPatch = {
  account?: Partial<Settings['account']>;
  notifications?: Partial<Settings['notifications']>;
  focus?: Partial<Settings['focus']>;
  quickAdd?: Partial<Settings['quickAdd']>;
  miniCalendar?: Partial<Settings['miniCalendar']>;
  imports?: Partial<Settings['imports']>;
  calendar?: Partial<Settings['calendar']>;
  notes?: Partial<Settings['notes']>;
  widgets?: Partial<Settings['widgets']>;
  shortcuts?: Partial<Settings['shortcuts']>;
  desktop?: Partial<Settings['desktop']>;
  localization?: Partial<Settings['localization']>;
  appearance?: Partial<Settings['appearance']>;
  datetime?: Partial<Settings['datetime']>;
  modules?: Partial<Settings['modules']>;
  smartLists?: Partial<Settings['smartLists']>;
  taskDefaults?: Partial<Settings['taskDefaults']>;
  ai?: Partial<Settings['ai']> & { apiKey?: string };
};
