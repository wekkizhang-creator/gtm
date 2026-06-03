// Real HTTP client. Every call hits a real backend route. On failure it throws —
// the UI surfaces the error instead of showing fabricated data.
import type {
  AIBreakdownResult,
  AIQuadrantSuggestionResult,
  AIReviewResult,
  AIScheduleResult,
  AboutContact,
  AccountDeletionPreview,
  AccountDeletionRequest,
  AccountIdentity,
  AccountOnboarding,
  AccountSyncStatus,
  AuthSession,
  Attachment,
  BackgroundSound,
  CalendarDayInfo,
  CalendarSubscription,
  Countdown,
  DesktopShellState,
  DesktopShortcut,
  DesktopShortcutTemplate,
  DesktopStatus,
  DesktopWidget,
  DesktopWidgetActionResult,
  DesktopWidgetData,
  DesktopWidgetTemplate,
  DiagnosticLogUpload,
  ExternalCalendarEvent,
  FocusSession,
  FocusRestCycle,
  FocusAchievement,
  FocusReport,
  FocusStats,
  Goal,
  Habit,
  HabitStats,
  ImportCommitResult,
  ImportFormat,
  ImportPreviewResult,
  List,
  ListFolder,
  LocalCacheClearResult,
  LocalCacheSummary,
  Notification,
  NotificationPermissionPromptReason,
  NotificationPermissionState,
  NotificationPermissionStatus,
  NotificationSound,
  OpenSourceLicenses,
  Priority,
  QuickCaptureResult,
  QuickCaptureSource,
  QuickParseResult,
  SearchResult,
  SavedFilter,
  Settings,
  SettingsPatch,
  SmartCounts,
  StickyNote,
  SystemCalendarPermission,
  SystemCalendarPermissionReason,
  SystemCalendarPermissionStatus,
  Tag,
  Task,
  TaskActivity,
  TaskChecklistItem,
  TaskReminder,
  TaskStatus,
  TrashCleanupResult,
  TrashSummary,
  User,
} from '../types';

const BASE = '/api';

export function isNetworkError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { isNetworkError?: boolean }).isNetworkError === true;
}

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...opts,
    });
  } catch (cause) {
    const err = new Error('network_unavailable');
    (err as Error & { isNetworkError?: boolean; cause?: unknown }).isNetworkError = true;
    (err as Error & { cause?: unknown }).cause = cause;
    throw err;
  }
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
  tagIds?: string[];
  priority?: Priority;
  dueDate?: string | null;
  startDate?: string | null;
  isAllDay?: boolean;
  isImportant?: boolean | null;
  isUrgent?: boolean | null;
  parentId?: string | null;
  estimatedMinutes?: number | null;
  note?: string | null;
  recurrenceRule?: string | null;
  source?: string | null;
  manualProgress?: number | null;
  pinned?: boolean;
  status?: TaskStatus;
}

export interface QuickCaptureInput {
  source: QuickCaptureSource;
  text?: string;
  title?: string;
  url?: string | null;
  listId?: string | null;
  priority?: Priority;
  dueDate?: string | null;
  startDate?: string | null;
  isAllDay?: boolean;
  parse?: boolean;
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
  parentId: string | null;
  estimatedMinutes: number | null;
  subtaskConfig: Partial<{ progressMode: 'auto' | 'count' | 'estimate'; autoCompleteParent: boolean; collapsed: boolean }>;
  recurrenceRule: string | null;
  source: string;
  manualProgress: number | null;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  actualStartAt: string | null;
  actualEndAt: string | null;
  autoScheduleEnabled: boolean;
  isLockedSchedule: boolean;
  pinned: boolean;
  status: TaskStatus;
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
  backgroundSoundId?: string | null;
  backgroundVolume?: number | null;
  soundPlayedDuration?: number | null;
  isMuted?: boolean;
  note?: string | null;
}

export interface CreateFocusRestCycleInput {
  focusSessionId: string;
  restStartedAt: string;
  restEndedAt: string;
  restDurationSec: number;
  nextFocusStartedAt?: string | null;
}

export interface CreateGoalInput {
  title: string;
  description?: string | null;
  startAt?: string | null;
  deadlineAt?: string | null;
  totalEstimatedMinutes?: number | null;
  availableTimeRule?: string | null;
  progressMode?: Goal['progressMode'];
  status?: Goal['status'];
}

export interface AnalyticsEventInput {
  name: string;
  properties?: Record<string, unknown>;
  occurredAt?: string;
  anonymousId?: string;
  deviceId?: string;
  source?: string;
}

export interface SyncOperationInput {
  clientOperationId: string;
  entityType: 'task';
  action: 'create' | 'update' | 'delete';
  entityId?: string | null;
  baseUpdatedAt?: string | null;
  clientCreatedAt?: string | null;
  payload: Record<string, unknown>;
}

export interface SyncOperationResult {
  clientOperationId: string;
  entityType: 'task';
  action: 'create' | 'update' | 'delete';
  status: 'applied' | 'duplicate' | 'conflict' | 'failed';
  entityId: string | null;
  task?: Task | null;
  conflict?: { serverTask: Task | null; baseUpdatedAt: string | null } | null;
  error?: { code: string; message: string } | null;
  appliedAt: string | null;
}

export const api = {
  // auth
  getSession: () => req<{ user: User; session: AuthSession }>('/auth/session'),
  requestVerificationCode: (input: { type: 'email' | 'phone'; identifier: string; purpose?: 'login' | 'account_delete' | 'account_bind' }) =>
    req<{ challengeId: string; maskedIdentifier: string; expiresAt: string; resendAfterSec: number; isNewIdentifier: boolean }>(
      '/auth/verification-codes',
      { method: 'POST', body: JSON.stringify(input) },
    ),
  loginWithCode: (input: {
    challengeId: string;
    code: string;
    agreedToTerms: boolean;
    device: { deviceId: string; deviceName?: string; platform?: string; appVersion?: string };
  }) =>
    req<{ user: User; session: AuthSession; isNewUser: boolean }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  loginWithOAuth: (provider: string, input: {
    accessToken: string;
    agreedToTerms: boolean;
    device: { deviceId: string; deviceName?: string; platform?: string; appVersion?: string };
  }) =>
    req<{ user: User; session: AuthSession; isNewUser: boolean }>(`/auth/oauth/${encodeURIComponent(provider)}/login`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  startOAuthAuthorization: (provider: string, input: { redirectUri: string; scope?: string }) =>
    req<{ authorizationUrl: string; state: string; expiresAt: string }>(`/auth/oauth/${encodeURIComponent(provider)}/authorize`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  completeOAuthLogin: (provider: string, input: {
    state: string;
    code: string;
    redirectUri: string;
    agreedToTerms: boolean;
    device: { deviceId: string; deviceName?: string; platform?: string; appVersion?: string };
  }) =>
    req<{ user: User; session: AuthSession; isNewUser: boolean }>(`/auth/oauth/${encodeURIComponent(provider)}/callback`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  refreshSession: () => req<{ user: User; session: AuthSession }>('/auth/refresh', { method: 'POST' }),
  logout: () => req<void>('/auth/logout', { method: 'POST' }),
  getAccount: () => req<{ user: User }>('/account').then((r) => r.user),
  updateAccount: (patch: { nickname?: string | null; avatarUrl?: string | null }) =>
    req<{ user: User }>('/account', { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.user),
  getAccountOnboarding: () => req<{ onboarding: AccountOnboarding }>('/account/onboarding').then((r) => r.onboarding),
  listAccountSessions: () => req<{ sessions: AuthSession[] }>('/account/sessions').then((r) => r.sessions),
  revokeAccountSession: (id: string) => req<void>(`/account/sessions/${id}`, { method: 'DELETE' }),
  listAccountIdentities: () => req<{ identities: AccountIdentity[] }>('/account/identities').then((r) => r.identities),
  getLocalCacheSummary: () => req<{ cache: LocalCacheSummary }>('/account/local-cache').then((r) => r.cache),
  getAccountSyncStatus: () => req<{ syncStatus: AccountSyncStatus }>('/account/sync-status').then((r) => r.syncStatus),
  clearLocalCache: () => req<{ cache: LocalCacheClearResult }>('/account/local-cache/clear', { method: 'POST' }).then((r) => r.cache),
  bindAccountEmail: (input: { challengeId: string; code: string }) =>
    req<{ user: User; identities: AccountIdentity[] }>('/account/email/bind', { method: 'POST', body: JSON.stringify(input) }),
  bindAccountPhone: (input: { challengeId: string; code: string }) =>
    req<{ user: User; identities: AccountIdentity[] }>('/account/phone/bind', { method: 'POST', body: JSON.stringify(input) }),
  bindAccountOAuth: (provider: string, input: { accessToken: string }) =>
    req<{ user: User; identities: AccountIdentity[] }>(`/account/oauth/${encodeURIComponent(provider)}/bind`, { method: 'POST', body: JSON.stringify(input) }),
  startAccountOAuthAuthorization: (provider: string, input: { redirectUri: string; scope?: string }) =>
    req<{ authorizationUrl: string; state: string; expiresAt: string }>(`/account/oauth/${encodeURIComponent(provider)}/authorize`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  completeAccountOAuthBinding: (provider: string, input: { state: string; code: string; redirectUri: string }) =>
    req<{ user: User; identities: AccountIdentity[] }>(`/account/oauth/${encodeURIComponent(provider)}/callback`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  unbindAccountIdentity: (id: string) =>
    req<{ user: User; identities: AccountIdentity[] }>(`/account/identities/${id}`, { method: 'DELETE' }),
  getAccountDeletionPreview: () => req<AccountDeletionPreview>('/account/deletion/preview'),
  requestAccountDeletion: (input: { challengeId: string; code: string; confirmText: 'DELETE'; exportAcknowledged: boolean }) =>
    req<AccountDeletionRequest>('/account/deletion/request', { method: 'POST', body: JSON.stringify(input) }),
  cancelAccountDeletion: () => req<{ user: User }>('/account/deletion/cancel', { method: 'POST' }).then((r) => r.user),
  trackAnalyticsEvents: (events: AnalyticsEventInput[]) =>
    req<{ accepted: number }>('/analytics/events', { method: 'POST', body: JSON.stringify({ events }) }),
  pushSyncOperations: (operations: SyncOperationInput[]) =>
    req<{ results: SyncOperationResult[] }>('/sync/operations', { method: 'POST', body: JSON.stringify({ operations }) }),

  // lists
  listLists: () => req<{ lists: List[] }>('/lists').then((r) => r.lists),
  listFolders: () => req<{ folders: ListFolder[] }>('/lists/folders').then((r) => r.folders),
  createFolder: (input: { name: string; collapsed?: boolean; sortOrder?: number }) =>
    req<{ folder: ListFolder }>('/lists/folders', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.folder),
  updateFolder: (id: string, patch: Partial<Pick<ListFolder, 'name' | 'collapsed' | 'sortOrder'>>) =>
    req<{ folder: ListFolder }>(`/lists/folders/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.folder),
  deleteFolder: (id: string) => req<void>(`/lists/folders/${id}`, { method: 'DELETE' }),
  createList: (name: string, folderId?: string | null, type: List['type'] = 'task') =>
    req<{ list: List }>('/lists', { method: 'POST', body: JSON.stringify({ name, folderId: folderId ?? null, type }) }).then((r) => r.list),
  updateList: (id: string, patch: Partial<Pick<List, 'name' | 'color' | 'icon' | 'type' | 'sortOrder' | 'folderId'>>) =>
    req<{ list: List }>(`/lists/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.list),
  deleteList: (id: string) => req<void>(`/lists/${id}`, { method: 'DELETE' }),

  // tags
  listTags: () => req<{ tags: Tag[] }>('/tags').then((r) => r.tags),
  createTag: (input: { name: string; color?: string | null; parentId?: string | null }) =>
    req<{ tag: Tag }>('/tags', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.tag),
  updateTag: (id: string, patch: Partial<Pick<Tag, 'name' | 'color' | 'parentId' | 'sortOrder'>>) =>
    req<{ tag: Tag }>(`/tags/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.tag),
  mergeTag: (id: string, targetId: string) =>
    req<{ merge: { sourceId: string; targetTag: Tag; movedTaskTags: number; skippedDuplicates: number; reparentedChildTags: number } }>(
      `/tags/${id}/merge`,
      { method: 'POST', body: JSON.stringify({ targetId }) },
    ).then((r) => r.merge),
  deleteTag: (id: string) => req<void>(`/tags/${id}`, { method: 'DELETE' }),

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
  getSubtasks: (parentId: string) => req<{ tasks: Task[] }>(`/tasks?parentId=${parentId}`).then((r) => r.tasks),
  getTask: (id: string) => req<{ task: Task }>(`/tasks/${id}`).then((r) => r.task),
  listTaskActivity: (id: string, limit = 50) =>
    req<{ activities: TaskActivity[] }>(`/tasks/${id}/activity?limit=${encodeURIComponent(String(limit))}`).then((r) => r.activities),
  createTask: (input: CreateTaskInput) =>
    req<{ task: Task }>('/tasks', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.task),
  updateTask: (id: string, patch: UpdateTaskInput) =>
    req<{ task: Task }>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.task),
  reparentTask: (id: string, parentId: string | null) =>
    req<{ task: Task }>(`/tasks/${id}/reparent`, { method: 'POST', body: JSON.stringify({ parentId }) }).then((r) => r.task),
  deferRecurringTask: (id: string) => req<{ task: Task }>(`/tasks/${id}/recurrence/defer`, { method: 'POST' }).then((r) => r.task),
  skipRecurringTask: (id: string) => req<{ task: Task; nextTask: Task | null }>(`/tasks/${id}/recurrence/skip`, { method: 'POST' }),
  deleteTask: (id: string) => req<void>(`/tasks/${id}`, { method: 'DELETE' }),
  restoreTask: (id: string) => req<{ task: Task }>(`/tasks/${id}/restore`, { method: 'POST' }).then((r) => r.task),
  purgeTask: (id: string) => req<void>(`/tasks/${id}?permanent=1`, { method: 'DELETE' }),
  getTrashSummary: (retentionDays = 30) =>
    req<{ trash: TrashSummary }>(`/tasks/trash/summary?retentionDays=${encodeURIComponent(String(retentionDays))}`).then((r) => r.trash),
  purgeExpiredTrash: (retentionDays = 30) =>
    req<{ trash: TrashCleanupResult }>('/tasks/trash/purge-expired', {
      method: 'POST',
      body: JSON.stringify({ retentionDays }),
    }).then((r) => r.trash),
  emptyTrash: () => req<{ trash: TrashCleanupResult }>('/tasks/trash/empty', { method: 'POST' }).then((r) => r.trash),
  quickParseTask: (
    text: string,
    options?: Partial<{ dateRecognition: boolean; removeDateText: boolean; tagRecognition: boolean; removeTagText: boolean; urlParsing: boolean }>,
  ) => req<QuickParseResult>('/tasks/quick-parse', { method: 'POST', body: JSON.stringify({ text, ...(options ? { options } : {}) }) }),
  quickCaptureTask: (input: QuickCaptureInput) =>
    req<QuickCaptureResult>('/tasks/quick-capture', { method: 'POST', body: JSON.stringify(input) }),
  addTaskTag: (taskId: string, tagId: string) =>
    req<{ task: Task }>(`/tasks/${taskId}/tags/${tagId}`, { method: 'POST' }).then((r) => r.task),
  removeTaskTag: (taskId: string, tagId: string) =>
    req<{ task: Task }>(`/tasks/${taskId}/tags/${tagId}`, { method: 'DELETE' }).then((r) => r.task),
  listTaskReminders: (taskId: string) =>
    req<{ reminders: TaskReminder[] }>(`/tasks/${taskId}/reminders`).then((r) => r.reminders),
  createTaskReminder: (taskId: string, input: { remindAt: string; channel?: 'email' }) =>
    req<{ reminder: TaskReminder }>(`/tasks/${taskId}/reminders`, {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.reminder),
  deleteTaskReminder: (taskId: string, reminderId: string) =>
    req<void>(`/tasks/${taskId}/reminders/${reminderId}`, { method: 'DELETE' }),
  listTaskChecklist: (taskId: string) =>
    req<{ items: TaskChecklistItem[] }>(`/tasks/${taskId}/checklist`).then((r) => r.items),
  createTaskChecklistItem: (taskId: string, input: { title: string; sortOrder?: number }) =>
    req<{ item: TaskChecklistItem }>(`/tasks/${taskId}/checklist`, {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.item),
  updateTaskChecklistItem: (taskId: string, itemId: string, patch: Partial<Pick<TaskChecklistItem, 'title' | 'completed' | 'sortOrder'>>) =>
    req<{ item: TaskChecklistItem }>(`/tasks/${taskId}/checklist/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).then((r) => r.item),
  deleteTaskChecklistItem: (taskId: string, itemId: string) =>
    req<void>(`/tasks/${taskId}/checklist/${itemId}`, { method: 'DELETE' }),
  convertChecklistItemToSubtask: (taskId: string, itemId: string) =>
    req<{ item: TaskChecklistItem; task: Task }>(`/tasks/${taskId}/checklist/${itemId}/convert-to-subtask`, { method: 'POST' }),
  createTaskAttachment: (taskId: string, input: { fileName: string; mimeType?: string | null; contentBase64: string }) =>
    req<{ attachment: Attachment }>(`/tasks/${taskId}/attachments`, {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.attachment),
  addTaskDependency: (taskId: string, dependencyId: string) =>
    req<{ task: Task }>(`/tasks/${taskId}/dependencies`, {
      method: 'POST',
      body: JSON.stringify({ dependencyId }),
    }).then((r) => r.task),
  removeTaskDependency: (taskId: string, dependencyId: string) =>
    req<{ task: Task }>(`/tasks/${taskId}/dependencies/${dependencyId}`, { method: 'DELETE' }).then((r) => r.task),
  batchTasks: (input: {
    taskIds: string[];
    action: 'update' | 'delete' | 'restore' | 'purge';
    patch?: Partial<Pick<Task, 'dueDate' | 'startDate' | 'priority' | 'listId' | 'completed' | 'status'>>;
  }) => req<{ affected: number; tasks: Task[] }>('/tasks/batch', { method: 'POST', body: JSON.stringify(input) }),

  // goals
  listGoals: () => req<{ goals: Goal[] }>('/goals').then((r) => r.goals),
  createGoal: (input: CreateGoalInput) =>
    req<{ goal: Goal }>('/goals', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.goal),
  updateGoal: (id: string, patch: Partial<CreateGoalInput>) =>
    req<{ goal: Goal }>(`/goals/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.goal),
  deleteGoal: (id: string) => req<void>(`/goals/${id}`, { method: 'DELETE' }),
  getGoalTree: (id: string) => req<{ goal: Goal; tasks: Task[] }>(`/goals/${id}/tree`),
  createGoalTask: (
    id: string,
    input: { title: string; note?: string | null; parentId?: string | null; priority?: Priority; estimatedMinutes?: number | null },
  ) => req<{ task: Task }>(`/goals/${id}/tasks`, { method: 'POST', body: JSON.stringify(input) }).then((r) => r.task),
  autoScheduleGoal: (id: string) => req<{ goal: Goal; scheduled: Task[] }>(`/goals/${id}/auto-schedule`, { method: 'POST' }),

  // notifications
  listNotifications: (unreadOnly = false) =>
    req<{ notifications: Notification[] }>(`/notifications${unreadOnly ? '?unread=1' : ''}`).then((r) => r.notifications),
  markNotificationRead: (id: string) =>
    req<{ notification: Notification }>(`/notifications/${id}/read`, { method: 'POST' }).then((r) => r.notification),
  snoozeNotification: (id: string, snoozedUntil: string) =>
    req<{ notification: Notification }>(`/notifications/${id}/snooze`, {
      method: 'POST',
      body: JSON.stringify({ snoozedUntil }),
    }).then((r) => r.notification),
  getNotificationPermission: () => req<{ permission: NotificationPermissionState }>('/notifications/permission').then((r) => r.permission),
  updateNotificationPermission: (input: { status: NotificationPermissionStatus; promptReason?: NotificationPermissionPromptReason }) =>
    req<{ permission: NotificationPermissionState }>('/notifications/permission', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.permission),
  listNotificationSounds: (purpose?: 'reminder' | 'completion') =>
    req<{ sounds: NotificationSound[] }>(`/notification-sounds${purpose ? `?purpose=${encodeURIComponent(purpose)}` : ''}`).then((r) => r.sounds),
  createNotificationSound: (input: { name: string; purpose?: 'reminder' | 'completion' | 'both'; mimeType?: string | null; contentBase64: string }) =>
    req<{ sound: NotificationSound }>('/notification-sounds', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.sound),
  runReminderTick: () => req<{ created: number; notifications: Notification[] }>('/reminder-runner/tick', { method: 'POST' }),

  // search
  search: (q: string, types?: string) =>
    req<{ results: SearchResult[] }>(
      `/search?q=${encodeURIComponent(q)}${types ? `&types=${encodeURIComponent(types)}` : ''}`,
    ).then((r) => r.results),
  listSavedFilters: () => req<{ filters: SavedFilter[] }>('/filters').then((r) => r.filters),
  createSavedFilter: (input: { name: string; query: Record<string, unknown>; sortOrder?: number }) =>
    req<{ filter: SavedFilter }>('/filters', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.filter),
  updateSavedFilter: (id: string, patch: Partial<Pick<SavedFilter, 'name' | 'query' | 'sortOrder'>>) =>
    req<{ filter: SavedFilter }>(`/filters/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.filter),
  deleteSavedFilter: (id: string) => req<void>(`/filters/${id}`, { method: 'DELETE' }),

  // desktop bridge
  getDesktopStatus: () => req<{ status: DesktopStatus }>('/desktop/status').then((r) => r.status),
  patchDesktopState: (patch: Partial<DesktopShellState>) =>
    req<{ status: DesktopStatus }>('/desktop/state', { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.status),
  listDesktopWidgets: () => req<{ widgets: DesktopWidget[] }>('/desktop/widgets').then((r) => r.widgets),
  listDesktopWidgetTemplates: () =>
    req<{ widgetTemplates: DesktopWidgetTemplate[] }>('/desktop/widget-templates').then((r) => r.widgetTemplates),
  createDesktopWidget: (input: {
    type: string;
    title: string;
    config?: Record<string, unknown>;
    position?: Partial<DesktopWidget['position']>;
    enabled?: boolean;
  }) => req<{ widget: DesktopWidget }>('/desktop/widgets', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.widget),
  updateDesktopWidget: (
    id: string,
    patch: Partial<Pick<DesktopWidget, 'type' | 'title' | 'config' | 'position' | 'enabled'>>,
  ) => req<{ widget: DesktopWidget }>(`/desktop/widgets/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.widget),
  getDesktopWidgetData: (id: string) => req<{ data: DesktopWidgetData }>(`/desktop/widgets/${id}/data`).then((r) => r.data),
  runDesktopWidgetAction: (
    id: string,
    input:
      | { action: 'complete_task'; taskId: string }
      | { action: 'quick_add_task'; text: string }
      | { action: 'toggle_habit'; habitId: string; value?: number | null; note?: string | null }
      | { action: 'start_focus' }
      | { action: 'pause_focus' },
  ) =>
    req<DesktopWidgetActionResult>(`/desktop/widgets/${id}/actions`, { method: 'POST', body: JSON.stringify(input) }),
  deleteDesktopWidget: (id: string) => req<void>(`/desktop/widgets/${id}`, { method: 'DELETE' }),
  listDesktopShortcuts: () => req<{ shortcuts: DesktopShortcut[] }>('/desktop/shortcuts').then((r) => r.shortcuts),
  listDesktopShortcutTemplates: () =>
    req<{ shortcutTemplates: DesktopShortcutTemplate[] }>('/desktop/shortcut-templates').then((r) => r.shortcutTemplates),
  createDesktopShortcut: (input: { action: string; accelerator: string; enabled?: boolean }) =>
    req<{ shortcut: DesktopShortcut }>('/desktop/shortcuts', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.shortcut),
  resetDesktopShortcuts: () =>
    req<{ shortcuts: DesktopShortcut[] }>('/desktop/shortcuts/reset', { method: 'POST' }).then((r) => r.shortcuts),
  updateDesktopShortcut: (id: string, patch: Partial<Pick<DesktopShortcut, 'action' | 'accelerator' | 'enabled'>>) =>
    req<{ shortcut: DesktopShortcut }>(`/desktop/shortcuts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then(
      (r) => r.shortcut,
    ),
  deleteDesktopShortcut: (id: string) => req<void>(`/desktop/shortcuts/${id}`, { method: 'DELETE' }),
  registerDesktopShortcut: (id: string) =>
    req<{ shortcut: DesktopShortcut; status: DesktopStatus }>(`/desktop/shortcuts/${id}/register`, { method: 'POST' }),
  resolveDesktopCloseIntent: () =>
    req<{ action: DesktopShellState['closeBehavior']; status: DesktopStatus }>('/desktop/window/close-intent', { method: 'POST' }),
  lockDesktopBridge: () => req<{ status: DesktopStatus }>('/desktop/app-lock/lock', { method: 'POST' }).then((r) => r.status),
  unlockDesktopBridge: (password?: string) =>
    req<{ status: DesktopStatus }>('/desktop/app-lock/unlock', {
      method: 'POST',
      body: JSON.stringify({ ...(password ? { password } : {}) }),
    }).then((r) => r.status),
  setDesktopAppLockPassword: (input: { password: string; currentPassword?: string }) =>
    req<{ status: DesktopStatus }>('/desktop/app-lock/password', { method: 'PUT', body: JSON.stringify(input) }).then((r) => r.status),
  clearDesktopAppLockPassword: (currentPassword: string) =>
    req<{ status: DesktopStatus }>('/desktop/app-lock/password', { method: 'DELETE', body: JSON.stringify({ currentPassword }) }).then(
      (r) => r.status,
    ),
  recordDesktopActivity: (occurredAt?: string) =>
    req<{ status: DesktopStatus }>('/desktop/app-lock/activity', { method: 'POST', body: JSON.stringify({ ...(occurredAt ? { occurredAt } : {}) }) }).then(
      (r) => r.status,
    ),
  checkDesktopAutoLock: () => req<{ status: DesktopStatus }>('/desktop/app-lock/auto-lock-check', { method: 'POST' }).then((r) => r.status),

  // calendar subscriptions
  listCalendarEvents: (from: string, to: string) =>
    req<{ events: ExternalCalendarEvent[] }>(`/calendar/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then((r) => r.events),
  listCalendarDayInfo: (from: string, to: string) =>
    req<{ days: CalendarDayInfo[] }>(`/calendar/day-info?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then((r) => r.days),
  listCalendarSubscriptions: () => req<{ subscriptions: CalendarSubscription[] }>('/calendar/subscriptions').then((r) => r.subscriptions),
  getSystemCalendarPermission: () => req<{ permission: SystemCalendarPermission }>('/calendar/system-permission').then((r) => r.permission),
  updateSystemCalendarPermission: (input: { status: SystemCalendarPermissionStatus; promptReason?: SystemCalendarPermissionReason }) =>
    req<{ permission: SystemCalendarPermission }>('/calendar/system-permission', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.permission),
  createSystemCalendarSubscription: (input: { name?: string; color?: string | null } = {}) =>
    req<{ subscription: CalendarSubscription }>('/calendar/system-subscription', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.subscription),
  createCalendarSubscription: (input: { type?: string; name: string; url?: string | null; color?: string | null; enabled?: boolean }) =>
    req<{ subscription: CalendarSubscription }>('/calendar/subscriptions', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.subscription),
  syncCalendarSubscription: (id: string, icsText?: string) =>
    req<{ subscription: CalendarSubscription; events: ExternalCalendarEvent[] }>(`/calendar/subscriptions/${id}/sync`, {
      method: 'POST',
      body: JSON.stringify({ icsText }),
    }),
  importPreview: (input: { format: ImportFormat; data: unknown }) =>
    req<ImportPreviewResult>('/import/preview', { method: 'POST', body: JSON.stringify(input) }),
  importCommit: (input: { format: ImportFormat; data: unknown; confirm: true }) =>
    req<ImportCommitResult>('/import/commit', { method: 'POST', body: JSON.stringify(input) }),

  // focus (pomodoro)
  getActiveTasks: () => req<{ tasks: Task[] }>('/tasks?view=active').then((r) => r.tasks),
  listFocusSessions: (limit = 100) =>
    req<{ sessions: FocusSession[] }>(`/focus/sessions?limit=${limit}`).then((r) => r.sessions),
  createFocusSession: (input: CreateFocusInput) =>
    req<{ session: FocusSession }>('/focus/sessions', { method: 'POST', body: JSON.stringify(input) }).then(
      (r) => r.session,
    ),
  deleteFocusSession: (id: string) => req<void>(`/focus/sessions/${id}`, { method: 'DELETE' }),
  listFocusRestCycles: (limit = 100) =>
    req<{ restCycles: FocusRestCycle[] }>(`/focus/rest-cycles?limit=${limit}`).then((r) => r.restCycles),
  createFocusRestCycle: (input: CreateFocusRestCycleInput) =>
    req<{ restCycle: FocusRestCycle }>('/focus/rest-cycles', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.restCycle),
  focusStats: () => req<{ stats: FocusStats }>('/focus/stats').then((r) => r.stats),
  focusAchievements: () => req<{ achievements: FocusAchievement[] }>('/focus/achievements').then((r) => r.achievements),
  listFocusSounds: () => req<{ sounds: BackgroundSound[] }>('/focus/sounds').then((r) => r.sounds),
  cacheFocusSound: (id: string) => req<{ sound: BackgroundSound }>(`/focus/sounds/${id}/cache`, { method: 'POST' }).then((r) => r.sound),
  deleteCachedFocusSound: (id: string) => req<void>(`/focus/sounds/${id}/cache`, { method: 'DELETE' }),
  focusReport: (range: 'day' | 'week' | 'month') => req<{ report: FocusReport }>(`/focus/reports?range=${range}`).then((r) => r.report),

  // habits
  listHabits: (from: string, to: string) =>
    req<{ habits: Habit[] }>(`/habits?from=${from}&to=${to}`).then((r) => r.habits),
  createHabit: (input: {
    name: string;
    icon?: string | null;
    color?: string | null;
    daysOfWeek?: number[];
    targetType?: Habit['targetType'];
    targetValue?: number | null;
    targetUnit?: string | null;
    startDate?: string | null;
    groupName?: string | null;
    reminderTime?: string | null;
    note?: string | null;
  }) =>
    req<{ habit: Habit }>('/habits', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.habit),
  getHabit: (id: string, from: string, to: string) => req<{ habit: Habit }>(`/habits/${id}?from=${from}&to=${to}`).then((r) => r.habit),
  updateHabit: (id: string, patch: Partial<Habit>) =>
    req<{ habit: Habit }>(`/habits/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.habit),
  archiveHabit: (id: string) => req<{ habit: Habit }>(`/habits/${id}/archive`, { method: 'POST' }).then((r) => r.habit),
  habitStats: (id: string, from: string, to: string) =>
    req<{ stats: HabitStats }>(`/habits/${id}/stats?from=${from}&to=${to}`).then((r) => r.stats),
  deleteHabit: (id: string) => req<void>(`/habits/${id}`, { method: 'DELETE' }),
  toggleHabit: (id: string, date: string, value?: number | null, note?: string | null) =>
    req<{ checked: boolean; currentStreak: number; bestStreak: number }>(`/habits/${id}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ date, value, note }),
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

  // settings
  getSettings: () => req<{ settings: Settings }>('/settings').then((r) => r.settings),
  patchSettings: (patch: SettingsPatch) =>
    req<{ settings: Settings }>('/settings', { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.settings),
  resetSettings: (group: string) =>
    req<{ settings: Settings }>('/settings/reset', { method: 'POST', body: JSON.stringify({ group }) }).then(
      (r) => r.settings,
    ),
  aiTest: () => req<{ ok: boolean; message: string }>('/settings/ai/test', { method: 'POST' }),
  exportData: () => req<Record<string, unknown>>('/settings/export'),
  checkUpdate: (currentVersion: string) =>
    req<{
      currentVersion: string;
      latestVersion: string;
      updateAvailable: boolean;
      downloadUrl: string | null;
      releaseNotes: string | null;
      checkedAt: string;
    }>(`/about/update-check?currentVersion=${encodeURIComponent(currentVersion)}`),
  getAboutContact: () => req<AboutContact>('/about/contact'),
  getOpenSourceLicenses: () => req<OpenSourceLicenses>('/about/licenses'),
  uploadDiagnosticLogs: (input: {
    consent: boolean;
    clientContext: Record<string, unknown>;
    entries: Array<{ level?: string; message: string; occurredAt?: string; context?: Record<string, unknown> }>;
  }) => req<{ upload: DiagnosticLogUpload }>('/about/diagnostic-logs', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.upload),

  // AI
  aiBreakdownTask: (input: { taskId?: string; title?: string; note?: string | null; maxItems?: number }) =>
    req<AIBreakdownResult>('/ai/task-breakdown', { method: 'POST', body: JSON.stringify(input) }),
  aiSuggestQuadrant: (input: { taskId: string }) =>
    req<AIQuadrantSuggestionResult>('/ai/quadrant-suggestion', { method: 'POST', body: JSON.stringify(input) }),
  aiWeeklyReview: (input: { from?: string | null; to?: string | null } = {}) =>
    req<AIReviewResult>('/ai/weekly-review', { method: 'POST', body: JSON.stringify(input) }),
  aiScheduleSuggestion: (input: { goalId?: string | null; taskIds?: string[] | null; from?: string | null; to?: string | null }) =>
    req<AIScheduleResult>('/ai/schedule-suggestion', { method: 'POST', body: JSON.stringify(input) }),

  // notes
  listNotes: (includeDeleted = false) =>
    req<{ notes: StickyNote[] }>(`/notes${includeDeleted ? '?includeDeleted=1' : ''}`).then((r) => r.notes),
  createNote: (input: {
    taskId?: string | null;
    title?: string | null;
    body?: string | null;
    color?: string | null;
    opacity?: number | null;
    fontSize?: StickyNote['fontSize'];
    pinned?: boolean;
    position?: Partial<StickyNote['position']>;
  }) => req<{ note: StickyNote }>('/notes', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.note),
  createNoteFromTask: (taskId: string) =>
    req<{ note: StickyNote }>('/notes/from-task', { method: 'POST', body: JSON.stringify({ taskId }) }).then((r) => r.note),
  updateNote: (id: string, patch: Partial<Pick<StickyNote, 'taskId' | 'title' | 'body' | 'color' | 'opacity' | 'fontSize' | 'pinned' | 'position'>>) =>
    req<{ note: StickyNote }>(`/notes/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.note),
  deleteNote: (id: string) => req<void>(`/notes/${id}`, { method: 'DELETE' }),
  restoreNote: (id: string) => req<{ note: StickyNote }>(`/notes/${id}/restore`, { method: 'POST' }).then((r) => r.note),
  convertNoteToTask: (id: string) => req<{ note: StickyNote; task: Task }>(`/notes/${id}/convert-to-task`, { method: 'POST' }),
};

