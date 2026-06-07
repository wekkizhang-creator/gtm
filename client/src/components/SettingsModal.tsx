import { useEffect, useState } from 'react';
import { useSettings } from '../settings';
import { useAuth } from '../auth';
import { api } from '../api/client';
import { trackEvent } from '../analytics';
import { LEGAL_DOC_LINKS, legalDocEntries } from '../legalDocs';
import { normalizeModuleOrder, reorderModuleOrder, type ModuleKey } from '../moduleOrder';
import { clearSyncQueue, pendingSyncCount } from '../syncQueue';
import { dateInputToISO, isoToDateInput } from '../util';
import type {
  AccountDeletionPreview,
  AccountIdentity,
  AccountSyncStatus,
  AboutContact,
  AuthSession,
  BackgroundSound,
  DesktopShortcut,
  DesktopShortcutTemplate,
  DesktopStatus,
  DesktopWidget,
  DesktopWidgetTemplate,
  DiagnosticLogUpload,
  ImportCommitResult,
  ImportFormat,
  ImportPreviewResult,
  List,
  LocalCacheSummary,
  NotificationPermissionPromptReason,
  NotificationPermissionState,
  NotificationPermissionStatus,
  NotificationSound,
  OpenSourceLicenses,
  Priority,
  Tag,
} from '../types';

const APP_VERSION = '0.6.0';

const CATEGORIES = [
  { key: 'account', label: '账号', icon: '👤' },
  { key: 'modules', label: '功能模块', icon: '⊞' },
  { key: 'smartLists', label: '智能清单', icon: '📋' },
  { key: 'notifications', label: '提醒通知', icon: '🔔' },
  { key: 'focus', label: '番茄专注', icon: '◴' },
  { key: 'datetime', label: '日期与时间', icon: '🕐' },
  { key: 'appearance', label: '外观', icon: '🎨' },
  { key: 'taskDefaults', label: '任务默认值', icon: '✓' },
  { key: 'more', label: '更多设置', icon: '⚙' },
  { key: 'notes', label: '便签', icon: '▣' },
  { key: 'data', label: '关联与导入', icon: '🔗' },
  { key: 'widgets', label: '桌面小部件', icon: '▦' },
  { key: 'shortcuts', label: '快捷键', icon: '⌘' },
  { key: 'ai', label: 'AI 设置', icon: '✨' },
  { key: 'about', label: '关于', icon: 'ℹ️' },
] as const;

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  account: ['账号', '登录', '邮箱', '手机号', '绑定', '注销', '缓存'],
  modules: ['功能模块', '导航', '启动', '隐藏'],
  smartLists: ['智能清单', '今天', '最近7天', '收集箱', '已完成', '垃圾桶'],
  notifications: ['提醒', '通知', '邮件', '桌面通知', '免打扰', '完成声音'],
  datetime: ['日期', '时间', '默认日期', '时间格式', '周开始', '农历', '节假日', 'Mini 日历'],
  appearance: ['外观', '主题', '颜色', '字体', '密度', '动画', '语言', '国际化'],
  more: ['更多', '开机启动', '托盘', '关闭窗口', '应用锁', '自动锁定', '后台声音', '快速添加', '日期识别', '标签识别', '网址解析'],
  focus: ['番茄', '专注', '休息', '背景音', '音量'],
  taskDefaults: ['任务默认值', '默认清单', '默认优先级', '默认标签', '快速添加'],
  data: ['导入', '导出', '迁移', 'CSV', 'JSON'],
  notes: ['便签', '颜色', '透明度', '置顶', '尺寸'],
  widgets: ['桌面小部件', '小组件', '今日任务', '习惯', '倒数日', '番茄'],
  shortcuts: ['快捷键', '全局搜索', '回到今天', '锁定', '恢复默认'],
  ai: ['AI', '模型', 'API Key', 'Provider'],
  about: ['关于', '版本', '更新', '隐私', '协议'],
};

const ACCENTS = ['#c96442', '#3aa6a0', '#4a8cf0', '#7c5cff', '#e0568b', '#2f9e6f', '#e0922f', '#5b5750'];
const TIME_ZONES = ['Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'UTC'];
const MODULE_LABELS: Record<ModuleKey, string> = { goals: '目标', tasks: '任务', calendar: '日历', matrix: '四象限', focus: '番茄', habits: '习惯', countdown: '倒数日', notes: '便签' };
const LAUNCH_OPTIONS = [
  { value: 'goals', label: '目标' },
  { value: 'tasks', label: '任务' },
  { value: 'calendar', label: '日历' },
  { value: 'matrix', label: '四象限' },
  { value: 'focus', label: '番茄' },
  { value: 'habits', label: '习惯' },
  { value: 'countdown', label: '倒数日' },
  { value: 'notes', label: '便签' },
];
const SMARTLIST_LABELS: Record<string, string> = { today: '今天', next7days: '最近7天', inbox: '收集箱', completed: '已完成', trash: '垃圾桶' };
const NOTIFICATION_PERMISSION_LABELS: Record<NotificationPermissionStatus, string> = {
  unknown: '未同步',
  default: '待授权',
  granted: '已允许',
  denied: '已拒绝',
  unsupported: '不支持',
};
const SYNC_HEALTH_LABELS: Record<AccountSyncStatus['health'], string> = {
  never_synced: '从未同步',
  synced: '同步成功',
  conflict: '存在冲突',
  failed: '同步失败',
};

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('file_read_failed'));
    reader.readAsDataURL(file);
  });
}

function fmtTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '暂无';
}

function authDevicePayload(session: AuthSession) {
  return {
    deviceId: session.deviceId,
    deviceName: session.deviceName ?? undefined,
    platform: session.platform ?? undefined,
    appVersion: session.appVersion ?? undefined,
  };
}

function Seg<T extends string | number>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={String(o.value)} className={`seg-btn${value === o.value ? ' active' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`switch${checked ? ' on' : ''}`} onClick={() => onChange(!checked)} role="switch" aria-checked={checked}>
      <span className="switch-knob" />
    </button>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-label">
        {label}
        {hint && <div className="set-hint">{hint}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

export default function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { settings, update, reset } = useSettings();
  const { user, session, logout, updateUser } = useAuth();
  const [cat, setCat] = useState<string>('appearance');
  const [lists, setLists] = useState<List[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [desktopStatus, setDesktopStatus] = useState<DesktopStatus | null>(null);
  const [desktopWidgets, setDesktopWidgets] = useState<DesktopWidget[]>([]);
  const [widgetTemplates, setWidgetTemplates] = useState<DesktopWidgetTemplate[]>([]);
  const [desktopShortcuts, setDesktopShortcuts] = useState<DesktopShortcut[]>([]);
  const [shortcutTemplates, setShortcutTemplates] = useState<DesktopShortcutTemplate[]>([]);
  const [settingsQuery, setSettingsQuery] = useState('');
  const [dragModuleKey, setDragModuleKey] = useState<ModuleKey | null>(null);
  const [desktopMessage, setDesktopMessage] = useState<string | null>(null);
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const [appLockPassword, setAppLockPassword] = useState('');
  const [appLockCurrentPassword, setAppLockCurrentPassword] = useState('');
  const [appLockPasswordMessage, setAppLockPasswordMessage] = useState<string | null>(null);
  const [appLockPasswordError, setAppLockPasswordError] = useState<string | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState | null>(null);
  const [notificationPermissionMessage, setNotificationPermissionMessage] = useState<string | null>(null);
  const [notificationPermissionError, setNotificationPermissionError] = useState<string | null>(null);
  const [notificationSounds, setNotificationSounds] = useState<NotificationSound[]>([]);
  const [notificationSoundBusy, setNotificationSoundBusy] = useState(false);
  const [notificationSoundError, setNotificationSoundError] = useState<string | null>(null);
  const [focusSounds, setFocusSounds] = useState<BackgroundSound[]>([]);
  const [widgetType, setWidgetType] = useState('today-tasks');
  const [widgetTitle, setWidgetTitle] = useState('');
  const [shortcutAction, setShortcutAction] = useState('task.quickAdd');
  const [shortcutAccelerator, setShortcutAccelerator] = useState('CommandOrControl+N');
  const [deletionPreview, setDeletionPreview] = useState<AccountDeletionPreview | null>(null);
  const [deleteEmail, setDeleteEmail] = useState('');
  const [deleteChallengeId, setDeleteChallengeId] = useState('');
  const [deleteCode, setDeleteCode] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteAck, setDeleteAck] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [identities, setIdentities] = useState<AccountIdentity[]>([]);
  const [accountSessions, setAccountSessions] = useState<AuthSession[]>([]);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [bindEmail, setBindEmail] = useState('');
  const [bindChallengeId, setBindChallengeId] = useState('');
  const [bindCode, setBindCode] = useState('');
  const [bindPhone, setBindPhone] = useState('');
  const [bindPhoneChallengeId, setBindPhoneChallengeId] = useState('');
  const [bindPhoneCode, setBindPhoneCode] = useState('');
  const [oauthProvider, setOauthProvider] = useState('test');
  const [oauthToken, setOauthToken] = useState('');
  const [oauthRedirectUri, setOauthRedirectUri] = useState(() => `${window.location.origin}/oauth/account-callback`);
  const [oauthAuthorizationUrl, setOauthAuthorizationUrl] = useState('');
  const [oauthState, setOauthState] = useState('');
  const [oauthCode, setOauthCode] = useState('');
  const [bindBusy, setBindBusy] = useState(false);
  const [bindMessage, setBindMessage] = useState<string | null>(null);
  const [bindError, setBindError] = useState<string | null>(null);
  const [accountEmailMasked, setAccountEmailMasked] = useState(user.emailMasked);
  const [passwordCurrent, setPasswordCurrent] = useState('');
  const [passwordNext, setPasswordNext] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [localCache, setLocalCache] = useState<(LocalCacheSummary & { pendingSyncCount: number }) | null>(null);
  const [syncStatus, setSyncStatus] = useState<AccountSyncStatus | null>(null);
  const [syncStatusError, setSyncStatusError] = useState<string | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheMessage, setCacheMessage] = useState<string | null>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [importFormat, setImportFormat] = useState<ImportFormat>('json');
  const [importText, setImportText] = useState('');
  const [importPreviewResult, setImportPreviewResult] = useState<ImportPreviewResult | null>(null);
  const [importCommitResult, setImportCommitResult] = useState<ImportCommitResult | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // AI local form
  const [ai, setAi] = useState({ provider: '', baseUrl: '', model: '', apiKey: '' });
  const [aiResult, setAiResult] = useState<string | null>(null);
  const [updateResult, setUpdateResult] = useState<string | null>(null);
  const [aboutContact, setAboutContact] = useState<AboutContact | null>(null);
  const [aboutContactError, setAboutContactError] = useState<string | null>(null);
  const [openSourceLicenses, setOpenSourceLicenses] = useState<OpenSourceLicenses | null>(null);
  const [openSourceLicensesError, setOpenSourceLicensesError] = useState<string | null>(null);
  const [diagnosticConsent, setDiagnosticConsent] = useState(false);
  const [diagnosticNote, setDiagnosticNote] = useState('');
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticUpload, setDiagnosticUpload] = useState<DiagnosticLogUpload | null>(null);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [tagManagerMessage, setTagManagerMessage] = useState<string | null>(null);
  const [tagManagerError, setTagManagerError] = useState<string | null>(null);
  const [profileNickname, setProfileNickname] = useState(user.nickname ?? '');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    trackEvent('setting_page_view', { entry: 'module_rail' });
    api.listLists().then(setLists).catch(() => {});
    void refreshTags();
    api.getAccountDeletionPreview().then(setDeletionPreview).catch(() => setDeletionPreview(null));
    api.listAccountIdentities().then(setIdentities).catch(() => setIdentities([]));
    api.listFocusSounds().then(setFocusSounds).catch(() => setFocusSounds([]));
    void refreshAccountSessions();
    void refreshLocalCache();
    void refreshSyncStatus();
    void refreshDesktop();
    void refreshNotificationPermission();
    void refreshNotificationSounds();
    setAi({ provider: settings.ai.provider, baseUrl: settings.ai.baseUrl, model: settings.ai.model, apiKey: '' });
    setAiResult(null);
    setUpdateResult(null);
    void refreshAboutContact();
    void refreshOpenSourceLicenses();
    setDiagnosticConsent(false);
    setDiagnosticNote('');
    setDiagnosticUpload(null);
    setDiagnosticError(null);
    setTagManagerMessage(null);
    setTagManagerError(null);
    setProfileNickname(user.nickname ?? '');
    setProfileMessage(null);
    setProfileError(null);
    setDeleteChallengeId('');
    setDeleteCode('');
    setDeleteConfirm('');
    setDeleteAck(false);
    setDeleteMessage(null);
    setDeleteError(null);
    setBindChallengeId('');
    setBindCode('');
    setBindPhoneChallengeId('');
    setBindPhoneCode('');
    setOauthToken('');
    setOauthAuthorizationUrl('');
    setOauthState('');
    setOauthCode('');
    setOauthRedirectUri(`${window.location.origin}/oauth/account-callback`);
    setBindMessage(null);
    setBindError(null);
    setSessionMessage(null);
    setSessionError(null);
    setCacheMessage(null);
    setCacheError(null);
    setDesktopMessage(null);
    setDesktopError(null);
    setAppLockPassword('');
    setAppLockCurrentPassword('');
    setAppLockPasswordMessage(null);
    setAppLockPasswordError(null);
    setNotificationPermissionMessage(null);
    setNotificationPermissionError(null);
    setNotificationSoundError(null);
    setImportPreviewResult(null);
    setImportCommitResult(null);
    setImportError(null);
    setAccountEmailMasked(user.emailMasked);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function refreshTags() {
    try {
      setTags(await api.listTags());
    } catch {
      setTags([]);
    }
  }

  async function saveProfile() {
    const nickname = profileNickname.trim();
    setProfileBusy(true);
    setProfileMessage(null);
    setProfileError(null);
    try {
      const updated = await api.updateAccount({ nickname: nickname || null });
      updateUser(updated);
      setProfileNickname(updated.nickname ?? '');
      setProfileMessage('账号资料已保存');
    } catch (err) {
      setProfileError((err as Error).message);
    } finally {
      setProfileBusy(false);
    }
  }

  async function uploadProfileAvatar(file: File | null) {
    if (!file) return;
    setProfileBusy(true);
    setProfileMessage(null);
    setProfileError(null);
    try {
      const contentBase64 = await readFileAsBase64(file);
      const updated = await api.uploadAccountAvatar({ fileName: file.name, mimeType: file.type || null, contentBase64 });
      updateUser(updated);
      setProfileMessage('头像已上传');
    } catch (err) {
      setProfileError((err as Error).message);
    } finally {
      setProfileBusy(false);
    }
  }

  async function removeProfileAvatar() {
    setProfileBusy(true);
    setProfileMessage(null);
    setProfileError(null);
    try {
      const updated = await api.updateAccount({ avatarUrl: null });
      updateUser(updated);
      setProfileMessage('头像已移除');
    } catch (err) {
      setProfileError((err as Error).message);
    } finally {
      setProfileBusy(false);
    }
  }

  async function updateTagParent(tag: Tag, parentId: string | null) {
    setTagManagerError(null);
    setTagManagerMessage(null);
    try {
      await api.updateTag(tag.id, { parentId });
      await refreshTags();
      setTagManagerMessage('标签层级已保存');
    } catch (err) {
      setTagManagerError((err as Error).message);
    }
  }

  async function mergeTag(source: Tag, targetId: string) {
    if (!targetId) return;
    const target = tags.find((tag) => tag.id === targetId);
    if (!target) return;
    if (!window.confirm(`确认将「${source.name}」合并到「${target.name}」？`)) return;
    setTagManagerError(null);
    setTagManagerMessage(null);
    try {
      const result = await api.mergeTag(source.id, targetId);
      if (settings.taskDefaults.defaultTagIds.includes(source.id)) {
        const next = Array.from(new Set(settings.taskDefaults.defaultTagIds.map((id) => (id === source.id ? targetId : id))));
        await update({ taskDefaults: { defaultTagIds: next } });
      }
      await refreshTags();
      setTagManagerMessage(`已迁移 ${result.movedTaskTags} 个任务标签`);
    } catch (err) {
      setTagManagerError((err as Error).message);
    }
  }

  if (!open) return null;

  const a = settings.appearance;
  const dt = settings.datetime;
  const noti = settings.notifications;
  const focus = settings.focus;
  const noteDefaults = settings.notes;
  const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const selectedTimeZone = dt.timeZone ?? systemTimeZone;
  const moduleOrder = normalizeModuleOrder(settings.modules.order);
  const sidebarBg = a.sidebarBackground ?? { type: 'default' as const, color: '#f0eee6', imageUrl: null };
  const appOpacity = Number.isInteger(a.appOpacity) ? a.appOpacity : 100;
  const updateSidebarBackground = (patch: Partial<typeof sidebarBg>) => {
    const next = { ...sidebarBg, ...patch };
    void update({ appearance: { sidebarBackground: next } });
  };
  const saveModuleOrder = (order: ModuleKey[]) => void update({ modules: { order } });
  const dropModule = (target: ModuleKey) => {
    if (!dragModuleKey) return;
    saveModuleOrder(reorderModuleOrder(moduleOrder, dragModuleKey, target));
    setDragModuleKey(null);
  };
  const moveModule = (key: ModuleKey, direction: -1 | 1) => {
    const index = moduleOrder.indexOf(key);
    const target = moduleOrder[index + direction];
    if (!target) return;
    saveModuleOrder(reorderModuleOrder(moduleOrder, key, target));
  };
  const normalizedSettingsQuery = settingsQuery.trim().toLowerCase();
  const visibleCategories = normalizedSettingsQuery
    ? CATEGORIES.filter((category) => {
        const haystack = [category.label, category.key, ...(CATEGORY_KEYWORDS[category.key] ?? [])].join(' ').toLowerCase();
        return haystack.includes(normalizedSettingsQuery);
      })
    : CATEGORIES;
  const selectedWidgetTemplate = widgetTemplates.find((template) => template.type === widgetType);
  const selectedShortcutTemplate = shortcutTemplates.find((template) => template.action === shortcutAction);
  const reminderSoundOptions = notificationSounds.filter((sound) => sound.purpose === 'reminder' || sound.purpose === 'both');
  const completionSoundOptions = notificationSounds.filter((sound) => sound.purpose === 'completion' || sound.purpose === 'both');

  async function downloadExport() {
    trackEvent('export_start', { export_type: 'account_data' });
    try {
      const data = await api.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'efficiency-list-export.json';
      link.click();
      URL.revokeObjectURL(url);
      trackEvent('export_success', { export_type: 'account_data', file_type: 'json' });
    } catch (err) {
      trackEvent('export_fail', { export_type: 'account_data', fail_reason: (err as Error).message });
      throw err;
    }
  }

  function ResetBtn({ group }: { group: string }) {
    return (
      <button className="set-reset" onClick={() => window.confirm('恢复该分类默认设置？') && void reset(group)}>
        恢复默认
      </button>
    );
  }

  async function refreshDesktop() {
    const [status, widgets, widgetTemplatesResult, shortcuts, templates] = await Promise.all([
      api.getDesktopStatus(),
      api.listDesktopWidgets(),
      api.listDesktopWidgetTemplates(),
      api.listDesktopShortcuts(),
      api.listDesktopShortcutTemplates(),
    ]);
    setDesktopStatus(status);
    setDesktopWidgets(widgets);
    setWidgetTemplates(widgetTemplatesResult);
    setDesktopShortcuts(shortcuts);
    setShortcutTemplates(templates);
    const firstWidgetTemplate = widgetTemplatesResult[0];
    if (firstWidgetTemplate) {
      setWidgetType((current) => (widgetTemplatesResult.some((template) => template.type === current) ? current : firstWidgetTemplate.type));
      setWidgetTitle((current) => current || firstWidgetTemplate.defaultTitle);
    }
    const firstTemplate = templates[0];
    if (firstTemplate) {
      setShortcutAction((current) => (templates.some((template) => template.action === current) ? current : firstTemplate.action));
      setShortcutAccelerator((current) => current || firstTemplate.accelerator);
    }
  }

  async function refreshLocalCache() {
    try {
      const cache = await api.getLocalCacheSummary();
      setLocalCache({ ...cache, pendingSyncCount: pendingSyncCount(user.id) });
    } catch {
      setLocalCache(null);
    }
  }

  async function refreshSyncStatus() {
    setSyncStatusError(null);
    try {
      setSyncStatus(await api.getAccountSyncStatus());
    } catch (err) {
      setSyncStatusError((err as Error).message);
    }
  }

  function readBrowserNotificationPermission(): NotificationPermissionStatus {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    return window.Notification.permission as NotificationPermissionStatus;
  }

  async function refreshNotificationPermission() {
    setNotificationPermissionError(null);
    try {
      const status = readBrowserNotificationPermission();
      const permission = await api.updateNotificationPermission({ status });
      setNotificationPermission(permission);
    } catch (err) {
      setNotificationPermissionError((err as Error).message);
      try {
        setNotificationPermission(await api.getNotificationPermission());
      } catch {
        setNotificationPermission(null);
      }
    }
  }

  async function requestNotificationPermission(promptReason: NotificationPermissionPromptReason = 'settings') {
    setNotificationPermissionMessage(null);
    setNotificationPermissionError(null);
    try {
      if (typeof window === 'undefined' || !('Notification' in window)) {
        const permission = await api.updateNotificationPermission({ status: 'unsupported', promptReason });
        setNotificationPermission(permission);
        setNotificationPermissionMessage('当前环境不支持系统通知');
        return permission;
      }
      const status = (await window.Notification.requestPermission()) as NotificationPermissionStatus;
      const permission = await api.updateNotificationPermission({ status, promptReason });
      setNotificationPermission(permission);
      setNotificationPermissionMessage(status === 'granted' ? '系统通知已允许' : '系统通知未允许，应用内通知仍可使用');
      return permission;
    } catch (err) {
      setNotificationPermissionError((err as Error).message);
      return null;
    }
  }

  async function updateDesktopNotificationSetting(enabled: boolean) {
    if (enabled) await requestNotificationPermission('settings');
    await update({ notifications: { desktop: enabled } });
  }

  async function refreshNotificationSounds() {
    try {
      setNotificationSounds(await api.listNotificationSounds());
    } catch (err) {
      setNotificationSoundError((err as Error).message);
      setNotificationSounds([]);
    }
  }

  async function uploadNotificationSound(file: File | null, purpose: 'reminder' | 'completion') {
    if (!file) return;
    setNotificationSoundBusy(true);
    setNotificationSoundError(null);
    try {
      const contentBase64 = await readFileAsBase64(file);
      const sound = await api.createNotificationSound({ name: file.name, purpose, mimeType: file.type || null, contentBase64 });
      await refreshNotificationSounds();
      if (purpose === 'reminder') {
        await update({ notifications: { reminderSound: 'custom', reminderSoundId: sound.id } });
      } else {
        await update({ notifications: { completionSound: 'custom', completionSoundId: sound.id } });
      }
    } catch (err) {
      setNotificationSoundError((err as Error).message);
    } finally {
      setNotificationSoundBusy(false);
    }
  }

  async function clearAccountLocalCache() {
    if (!window.confirm('Clear this account local cache on this device?')) return;
    setCacheBusy(true);
    setCacheMessage(null);
    setCacheError(null);
    try {
      const pendingCleared = clearSyncQueue(user.id);
      const cache = await api.clearLocalCache();
      setLocalCache({ ...cache, pendingSyncCount: 0 });
      await refreshSyncStatus();
      setCacheMessage(`Cleared ${pendingCleared} offline operations and ${cache.soundCacheCleared} cached sounds.`);
      trackEvent('auth_cache_clear', {
        cache_type: 'all',
        success: true,
        pending_sync_cleared: pendingCleared,
        sound_cache_cleared: cache.soundCacheCleared,
      });
    } catch (err) {
      const message = (err as Error).message;
      setCacheError(message);
      trackEvent('auth_cache_clear', { cache_type: 'all', success: false, fail_reason: message });
    } finally {
      setCacheBusy(false);
    }
  }

  async function readImportFile(file: File | null) {
    if (!file) return;
    setImportError(null);
    setImportPreviewResult(null);
    setImportCommitResult(null);
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.csv')) setImportFormat('csv');
    if (lower.endsWith('.json')) setImportFormat('json');
    setImportText(await file.text());
  }

  async function previewImport() {
    if (!importText.trim()) {
      setImportError('请选择文件或粘贴要导入的内容');
      return;
    }
    setImportBusy(true);
    setImportError(null);
    setImportCommitResult(null);
    try {
      trackEvent('import_preview_start', { format: importFormat });
      const result = await api.importPreview({ format: importFormat, data: importText });
      setImportPreviewResult(result);
      trackEvent('import_preview_success', { format: importFormat, ...result.summary });
    } catch (err) {
      const message = (err as Error).message;
      setImportError(message);
      trackEvent('import_preview_fail', { format: importFormat, fail_reason: message });
    } finally {
      setImportBusy(false);
    }
  }

  async function commitImport() {
    if (!importPreviewResult) {
      setImportError('请先预览导入内容');
      return;
    }
    if (!window.confirm(`确认导入 ${importPreviewResult.summary.valid - importPreviewResult.summary.duplicates} 条新数据？`)) return;
    setImportBusy(true);
    setImportError(null);
    try {
      trackEvent('import_commit_start', { format: importFormat });
      const result = await api.importCommit({ format: importFormat, data: importText, confirm: true });
      setImportCommitResult(result);
      setImportPreviewResult(null);
      api.listLists().then(setLists).catch(() => {});
      trackEvent('import_commit_success', { format: importFormat, created: result.created.length });
    } catch (err) {
      const message = (err as Error).message;
      setImportError(message);
      trackEvent('import_commit_fail', { format: importFormat, fail_reason: message });
    } finally {
      setImportBusy(false);
    }
  }

  async function updateDesktopState(patch: Parameters<typeof api.patchDesktopState>[0]) {
    setDesktopError(null);
    try {
      const status = await api.patchDesktopState(patch);
      setDesktopStatus(status);
      setDesktopMessage('桌面设置已保存');
    } catch (err) {
      setDesktopError((err as Error).message);
    }
  }

  async function saveAppLockPassword() {
    setAppLockPasswordMessage(null);
    setAppLockPasswordError(null);
    if (!appLockPassword) {
      setAppLockPasswordError('请输入 4-128 字符的应用锁密码');
      return;
    }
    try {
      const status = await api.setDesktopAppLockPassword({
        password: appLockPassword,
        ...(desktopStatus?.appLockPasswordSet ? { currentPassword: appLockCurrentPassword } : {}),
      });
      setDesktopStatus(status);
      setAppLockPassword('');
      setAppLockCurrentPassword('');
      setAppLockPasswordMessage(status.appLockPasswordSet ? '应用锁密码已保存' : '应用锁密码已更新');
    } catch (err) {
      setAppLockPasswordError((err as Error).message);
    }
  }

  async function clearAppLockPassword() {
    setAppLockPasswordMessage(null);
    setAppLockPasswordError(null);
    if (!appLockCurrentPassword) {
      setAppLockPasswordError('请输入当前应用锁密码');
      return;
    }
    try {
      const status = await api.clearDesktopAppLockPassword(appLockCurrentPassword);
      setDesktopStatus(status);
      setAppLockPassword('');
      setAppLockCurrentPassword('');
      setAppLockPasswordMessage('应用锁密码已停用');
    } catch (err) {
      setAppLockPasswordError((err as Error).message);
    }
  }

  async function unlockDesktopFromSettings() {
    setDesktopError(null);
    setAppLockPasswordError(null);
    try {
      const status = await api.unlockDesktopBridge(desktopStatus?.appLockPasswordSet ? appLockCurrentPassword : undefined);
      setDesktopStatus(status);
      setDesktopMessage('应用已解锁');
      if (!status.state.locked) setAppLockCurrentPassword('');
    } catch (err) {
      setAppLockPasswordError((err as Error).message);
    }
  }

  async function addDesktopWidget() {
    const template = selectedWidgetTemplate;
    const title = widgetTitle.trim() || template?.defaultTitle;
    if (!title) return;
    setDesktopError(null);
    try {
      const widget = await api.createDesktopWidget({
        type: widgetType,
        title,
        config: template?.defaultConfig,
        position: template?.defaultPosition ?? { x: 0, y: 0, width: 320, height: 240, screen: 'primary' },
      });
      setDesktopWidgets((items) => [widget, ...items]);
      setDesktopMessage('桌面小部件已添加');
    } catch (err) {
      setDesktopError((err as Error).message);
    }
  }

  async function addDesktopShortcut() {
    const action = shortcutAction.trim();
    const accelerator = shortcutAccelerator.trim();
    if (!action || !accelerator) return;
    setDesktopError(null);
    try {
      const shortcut = await api.createDesktopShortcut({ action, accelerator });
      setDesktopShortcuts((items) => [shortcut, ...items]);
      setDesktopMessage('快捷键已保存');
    } catch (err) {
      setDesktopError((err as Error).message);
    }
  }

  async function registerDesktopShortcut(id: string) {
    setDesktopError(null);
    try {
      const result = await api.registerDesktopShortcut(id);
      setDesktopStatus(result.status);
      setDesktopShortcuts((items) => items.map((item) => (item.id === id ? result.shortcut : item)));
      setDesktopMessage('已登记快捷键请求');
    } catch (err) {
      setDesktopError((err as Error).message);
    }
  }

  async function updateDesktopShortcut(id: string, patch: Parameters<typeof api.updateDesktopShortcut>[1]) {
    setDesktopError(null);
    try {
      const shortcut = await api.updateDesktopShortcut(id, patch);
      setDesktopShortcuts((items) => items.map((item) => (item.id === id ? shortcut : item)));
      setDesktopMessage('快捷键已更新');
    } catch (err) {
      setDesktopError((err as Error).message);
    }
  }

  async function resetDesktopShortcuts() {
    if (!window.confirm('恢复默认快捷键？这会替换当前账号保存的快捷键。')) return;
    setDesktopError(null);
    try {
      const shortcuts = await api.resetDesktopShortcuts();
      setDesktopShortcuts(shortcuts);
      setDesktopMessage('默认快捷键已恢复');
    } catch (err) {
      setDesktopError((err as Error).message);
    }
  }

  async function deleteDesktopWidget(id: string) {
    setDesktopError(null);
    try {
      await api.deleteDesktopWidget(id);
      setDesktopWidgets((items) => items.filter((item) => item.id !== id));
      setDesktopMessage('桌面小部件已删除');
    } catch (err) {
      setDesktopError((err as Error).message);
    }
  }

  async function deleteDesktopShortcut(id: string) {
    setDesktopError(null);
    try {
      await api.deleteDesktopShortcut(id);
      setDesktopShortcuts((items) => items.filter((item) => item.id !== id));
      setDesktopMessage('快捷键已删除');
    } catch (err) {
      setDesktopError((err as Error).message);
    }
  }

  async function requestDeletionCode() {
    setDeleteBusy(true);
    setDeleteError(null);
    setDeleteMessage(null);
    try {
      const result = await api.requestVerificationCode({
        type: 'email',
        identifier: deleteEmail.trim(),
        purpose: 'account_delete',
        device: authDevicePayload(session),
      });
      setDeleteChallengeId(result.challengeId);
      setDeleteMessage(`验证码已发送至 ${result.maskedIdentifier}`);
    } catch (err) {
      setDeleteError((err as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  }

  async function requestBindCode() {
    trackEvent('auth_binding_start', { identity_type: 'email', entry: 'settings' });
    setBindBusy(true);
    setBindError(null);
    setBindMessage(null);
    try {
      const result = await api.requestVerificationCode({
        type: 'email',
        identifier: bindEmail.trim(),
        purpose: 'account_bind',
        device: authDevicePayload(session),
      });
      setBindChallengeId(result.challengeId);
      setBindMessage(`验证码已发送至 ${result.maskedIdentifier}`);
    } catch (err) {
      setBindError((err as Error).message);
    } finally {
      setBindBusy(false);
    }
  }

  async function requestPhoneBindCode() {
    trackEvent('auth_binding_start', { identity_type: 'phone', entry: 'settings' });
    setBindBusy(true);
    setBindError(null);
    setBindMessage(null);
    try {
      const result = await api.requestVerificationCode({
        type: 'phone',
        identifier: bindPhone.trim(),
        purpose: 'account_bind',
        device: authDevicePayload(session),
      });
      setBindPhoneChallengeId(result.challengeId);
      setBindMessage(`验证码已发送至 ${result.maskedIdentifier}`);
    } catch (err) {
      setBindError((err as Error).message);
    } finally {
      setBindBusy(false);
    }
  }

  async function changeAccountPassword() {
    setPasswordMessage(null);
    setPasswordError(null);
    if (passwordNext.length < 8 || passwordNext.length > 128) {
      setPasswordError('密码需为 8 到 128 个字符');
      return;
    }
    if (passwordNext !== passwordConfirm) {
      setPasswordError('两次输入的新密码不一致');
      return;
    }
    setPasswordBusy(true);
    try {
      await api.changeAccountPassword({ currentPassword: passwordCurrent, newPassword: passwordNext });
      setPasswordCurrent('');
      setPasswordNext('');
      setPasswordConfirm('');
      setPasswordMessage('登录密码已更新');
    } catch (err) {
      setPasswordError((err as Error).message);
    } finally {
      setPasswordBusy(false);
    }
  }

  async function bindNewEmail() {
    setBindBusy(true);
    setBindError(null);
    setBindMessage(null);
    try {
      const result = await api.bindAccountEmail({ challengeId: bindChallengeId, code: bindCode.trim() });
      setIdentities(result.identities);
      setBindEmail('');
      setBindChallengeId('');
      setBindCode('');
      setAccountEmailMasked(result.user.emailMasked);
      setBindMessage(`邮箱已换绑为 ${result.user.emailMasked ?? '新邮箱'}`);
    } catch (err) {
      setBindError((err as Error).message);
    } finally {
      setBindBusy(false);
    }
  }

  async function bindNewPhone() {
    setBindBusy(true);
    setBindError(null);
    setBindMessage(null);
    try {
      const result = await api.bindAccountPhone({ challengeId: bindPhoneChallengeId, code: bindPhoneCode.trim() });
      setIdentities(result.identities);
      setBindPhone('');
      setBindPhoneChallengeId('');
      setBindPhoneCode('');
      setBindMessage(`手机号已绑定为 ${result.user.phoneMasked ?? '新手机号'}`);
    } catch (err) {
      setBindError((err as Error).message);
    } finally {
      setBindBusy(false);
    }
  }

  async function bindOAuthAccount() {
    trackEvent('auth_binding_start', { identity_type: 'oauth', entry: 'settings', provider: oauthProvider.trim() });
    setBindBusy(true);
    setBindError(null);
    setBindMessage(null);
    try {
      const result = await api.bindAccountOAuth(oauthProvider.trim(), { accessToken: oauthToken.trim() });
      setIdentities(result.identities);
      setOauthToken('');
      setAccountEmailMasked(result.user.emailMasked);
      setBindMessage('第三方账号已绑定');
    } catch (err) {
      setBindError((err as Error).message);
    } finally {
      setBindBusy(false);
    }
  }

  async function startOAuthBinding() {
    trackEvent('auth_binding_start', { identity_type: 'oauth', entry: 'settings', provider: oauthProvider.trim(), flow: 'authorization_code' });
    setBindBusy(true);
    setBindError(null);
    setBindMessage(null);
    try {
      const result = await api.startAccountOAuthAuthorization(oauthProvider.trim(), { redirectUri: oauthRedirectUri.trim() });
      setOauthAuthorizationUrl(result.authorizationUrl);
      setOauthState(result.state);
      setBindMessage('OAuth authorization link is ready.');
    } catch (err) {
      setBindError((err as Error).message);
    } finally {
      setBindBusy(false);
    }
  }

  async function completeOAuthBinding() {
    setBindBusy(true);
    setBindError(null);
    setBindMessage(null);
    try {
      const result = await api.completeAccountOAuthBinding(oauthProvider.trim(), {
        state: oauthState.trim(),
        code: oauthCode.trim(),
        redirectUri: oauthRedirectUri.trim(),
      });
      setIdentities(result.identities);
      setOauthAuthorizationUrl('');
      setOauthState('');
      setOauthCode('');
      setAccountEmailMasked(result.user.emailMasked);
      setBindMessage('OAuth account has been bound.');
    } catch (err) {
      setBindError((err as Error).message);
    } finally {
      setBindBusy(false);
    }
  }

  async function unbindIdentity(id: string) {
    setBindBusy(true);
    setBindError(null);
    setBindMessage(null);
    try {
      const result = await api.unbindAccountIdentity(id);
      setIdentities(result.identities);
      setAccountEmailMasked(result.user.emailMasked);
      setBindMessage('登录方式已解绑');
    } catch (err) {
      setBindError((err as Error).message);
    } finally {
      setBindBusy(false);
    }
  }

  async function refreshAccountSessions() {
    setSessionBusy(true);
    setSessionError(null);
    try {
      const sessions = await api.listAccountSessions();
      setAccountSessions(sessions);
    } catch (err) {
      setAccountSessions([]);
      setSessionError((err as Error).message);
    } finally {
      setSessionBusy(false);
    }
  }

  async function revokeLoginSession(target: AuthSession) {
    if (target.isCurrentDevice) {
      await logout();
      return;
    }
    const label = target.deviceName ?? target.deviceId;
    if (!window.confirm(`退出设备「${label}」？`)) return;
    setSessionBusy(true);
    setSessionMessage(null);
    setSessionError(null);
    try {
      await api.revokeAccountSession(target.id);
      const sessions = await api.listAccountSessions();
      setAccountSessions(sessions);
      setSessionMessage('设备已退出');
    } catch (err) {
      setSessionError((err as Error).message);
    } finally {
      setSessionBusy(false);
    }
  }

  async function requestDeletion() {
    if (deleteConfirm.trim() !== 'DELETE') {
      setDeleteError('请输入 DELETE 作为最终确认');
      return;
    }
    setDeleteBusy(true);
    setDeleteError(null);
    setDeleteMessage(null);
    try {
      const result = await api.requestAccountDeletion({
        challengeId: deleteChallengeId,
        code: deleteCode.trim(),
        confirmText: 'DELETE',
        exportAcknowledged: deleteAck,
      });
      setDeleteMessage(`账号已进入 ${result.coolingDays} 天冷静期，将于 ${new Date(result.deleteScheduledAt).toLocaleString()} 后删除`);
      await logout({ confirm: false });
    } catch (err) {
      setDeleteError((err as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  }

  async function checkForUpdates() {
    setUpdateResult('检查中...');
    try {
      const result = await api.checkUpdate(APP_VERSION);
      setUpdateResult(
        result.updateAvailable
          ? `发现新版本 ${result.latestVersion}${result.downloadUrl ? `：${result.downloadUrl}` : ''}`
          : `当前已是最新版本 ${result.currentVersion}`,
      );
    } catch (err) {
      setUpdateResult((err as Error).message);
    }
  }

  async function refreshAboutContact() {
    setAboutContactError(null);
    try {
      const contact = await api.getAboutContact();
      setAboutContact(contact);
    } catch (err) {
      setAboutContact(null);
      setAboutContactError((err as Error).message);
    }
  }

  async function refreshOpenSourceLicenses() {
    setOpenSourceLicensesError(null);
    try {
      const licenses = await api.getOpenSourceLicenses();
      setOpenSourceLicenses(licenses);
    } catch (err) {
      setOpenSourceLicenses(null);
      setOpenSourceLicensesError((err as Error).message);
    }
  }

  async function uploadDiagnosticLogs() {
    setDiagnosticBusy(true);
    setDiagnosticError(null);
    setDiagnosticUpload(null);
    try {
      const now = new Date().toISOString();
      const upload = await api.uploadDiagnosticLogs({
        consent: diagnosticConsent,
        clientContext: {
          appVersion: APP_VERSION,
          userAgent: navigator.userAgent,
          language: navigator.language,
          online: navigator.onLine,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          path: window.location.pathname,
          settingsCategory: cat,
          screen: { width: window.screen.width, height: window.screen.height },
        },
        entries: [
          {
            level: 'info',
            message: 'diagnostic_upload_requested',
            occurredAt: now,
            context: {
              pendingSyncCount: pendingSyncCount(user.id),
              currentDevice: session.deviceName ?? session.deviceId,
              accountStatus: user.status,
            },
          },
          ...(diagnosticNote.trim()
            ? [
                {
                  level: 'user',
                  message: diagnosticNote.trim(),
                  occurredAt: now,
                  context: { source: 'about_settings' },
                },
              ]
            : []),
        ],
      });
      setDiagnosticUpload(upload);
      setDiagnosticNote('');
    } catch (err) {
      setDiagnosticError((err as Error).message);
    } finally {
      setDiagnosticBusy(false);
    }
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <nav className="settings-nav">
          <div className="settings-nav-title">设置</div>
          <input
            className="settings-nav-search"
            value={settingsQuery}
            onChange={(e) => setSettingsQuery(e.target.value)}
            placeholder="搜索设置"
          />
          {visibleCategories.map((c) => (
            <button
              key={c.key}
              className={`settings-nav-item${cat === c.key ? ' active' : ''}`}
              onClick={() => {
                setCat(c.key);
                trackEvent('setting_tab_click', { tab_name: c.key });
              }}
            >
              <span className="settings-nav-icon">{c.icon}</span>
              {c.label}
            </button>
          ))}
        </nav>

        <section className="settings-content">
          <button className="settings-close" onClick={onClose} title="关闭">✕</button>

          {cat === 'appearance' && (
            <div className="settings-section">
              <h2>外观<ResetBtn group="appearance" /></h2>
              <Row label="主题模式">
                <Seg options={[{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }, { value: 'system', label: '跟随系统' }]} value={a.themeMode} onChange={(v) => update({ appearance: { themeMode: v } })} />
              </Row>
              <Row label="显示语言">
                <Seg
                  options={[
                    { value: 'system', label: '跟随系统' },
                    { value: 'zh-CN', label: '中文' },
                    { value: 'en-US', label: 'English' },
                  ]}
                  value={settings.localization.language}
                  onChange={(v) => update({ localization: { language: v } })}
                />
              </Row>
              <Row label="主题色">
                <div className="accent-swatches">
                  {ACCENTS.map((c) => (
                    <button key={c} className={`accent-swatch${a.accent === c ? ' active' : ''}`} style={{ background: c }} onClick={() => update({ appearance: { accent: c } })} />
                  ))}
                </div>
              </Row>
              <Row label="字体大小">
                <Seg options={[{ value: 'small', label: '小' }, { value: 'normal', label: '正常' }, { value: 'large', label: '大' }, { value: 'xlarge', label: '超大' }]} value={a.fontSize} onChange={(v) => update({ appearance: { fontSize: v } })} />
              </Row>
              <Row label="任务密度">
                <Seg options={[{ value: 'compact', label: '紧凑' }, { value: 'standard', label: '标准' }, { value: 'loose', label: '宽松' }]} value={a.density} onChange={(v) => update({ appearance: { density: v } })} />
              </Row>
              <Row label="侧栏背景" hint="自定义图片使用 http/https 图片地址">
                <div className="set-stack appearance-bg-control">
                  <Seg
                    options={[
                      { value: 'default', label: '默认' },
                      { value: 'color', label: '纯色' },
                      { value: 'image', label: '图片' },
                    ]}
                    value={sidebarBg.type}
                    onChange={(v) => updateSidebarBackground({ type: v })}
                  />
                  {sidebarBg.type === 'color' && (
                    <input
                      type="color"
                      value={sidebarBg.color}
                      onChange={(e) => updateSidebarBackground({ color: e.target.value })}
                      aria-label="侧栏背景颜色"
                    />
                  )}
                  {sidebarBg.type === 'image' && (
                    <input
                      className="sidebar-bg-url"
                      type="url"
                      value={sidebarBg.imageUrl ?? ''}
                      onChange={(e) => updateSidebarBackground({ imageUrl: e.target.value.trim() || null })}
                      placeholder="https://example.com/sidebar.jpg"
                    />
                  )}
                </div>
              </Row>
              <Row label="应用透明度">
                <div className="set-inline-item appearance-opacity-control">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={appOpacity}
                    onChange={(e) => update({ appearance: { appOpacity: Number(e.target.value) } })}
                    aria-label="应用透明度"
                  />
                  <span>{appOpacity}%</span>
                </div>
              </Row>
              <Row label="动效">
                <Switch checked={a.animations} onChange={(v) => update({ appearance: { animations: v } })} />
              </Row>
            </div>
          )}

          {cat === 'datetime' && (
            <div className="settings-section">
              <h2>日期与时间<ResetBtn group="datetime" /></h2>
              <Row label="一周开始于" hint="影响日历周视图、习惯周视图">
                <Seg options={[{ value: 1, label: '周一' }, { value: 0, label: '周日' }]} value={dt.weekStart} onChange={(v) => update({ datetime: { weekStart: v as 0 | 1 } })} />
              </Row>
              <Row label="时间格式">
                <Seg options={[{ value: 'system', label: '跟随系统' }, { value: '24', label: '24 小时' }, { value: '12', label: '12 小时' }]} value={dt.timeFormat} onChange={(v) => update({ datetime: { timeFormat: v } })} />
              </Row>
              <Row label="时区选择">
                <Seg
                  options={[
                    { value: 'system', label: '关闭' },
                    { value: 'manual', label: '开启' },
                  ]}
                  value={dt.timeZoneMode}
                  onChange={(v) =>
                    update({
                      datetime: {
                        timeZoneMode: v,
                        timeZone: v === 'manual' ? selectedTimeZone : null,
                      },
                    })
                  }
                />
              </Row>
              {dt.timeZoneMode === 'manual' && (
                <Row label="默认时区" hint="影响时间轴、专注记录等时间显示">
                  <select value={selectedTimeZone} onChange={(e) => update({ datetime: { timeZoneMode: 'manual', timeZone: e.target.value } })}>
                    {!TIME_ZONES.includes(systemTimeZone) && <option value={systemTimeZone}>{systemTimeZone}</option>}
                    {TIME_ZONES.map((zone) => (
                      <option key={zone} value={zone}>{zone}</option>
                    ))}
                  </select>
                </Row>
              )}
              <Row label="显示农历">
                <Switch checked={dt.showLunar} onChange={(v) => update({ datetime: { showLunar: v } })} />
              </Row>
              <Row label="显示节假日调休">
                <Switch checked={dt.showHolidayAdjustments} onChange={(v) => update({ datetime: { showHolidayAdjustments: v } })} />
              </Row>
              <Row label="侧边栏 Mini 日历">
                <Switch checked={settings.miniCalendar.enabled} onChange={(v) => update({ miniCalendar: { enabled: v } })} />
              </Row>
              <Row label="Mini 日历农历">
                <Seg
                  options={[
                    { value: 'follow', label: '跟随日期设置' },
                    { value: 'on', label: '显示' },
                    { value: 'off', label: '隐藏' },
                  ]}
                  value={settings.miniCalendar.showLunar}
                  onChange={(v) => update({ miniCalendar: { showLunar: v } })}
                />
              </Row>
              <Row label="Mini 日历周数">
                <Switch checked={settings.miniCalendar.showWeekNumbers} onChange={(v) => update({ miniCalendar: { showWeekNumbers: v } })} />
              </Row>
            </div>
          )}

          {cat === 'modules' && (
            <div className="settings-section">
              <h2>功能模块<ResetBtn group="modules" /></h2>
              <p className="set-note">任务 / 清单为核心模块，不可隐藏；隐藏模块不删除数据，仅不在左侧导航展示。</p>
              {moduleOrder.filter((key) => key !== 'tasks').map((key) => (
                <Row key={key} label={MODULE_LABELS[key]}>
                  <Switch
                    checked={!settings.modules.hidden.includes(key)}
                    onChange={(visible) => {
                      const hidden = visible ? settings.modules.hidden.filter((h) => h !== key) : [...settings.modules.hidden, key];
                      update({ modules: { hidden } });
                    }}
                  />
                </Row>
              ))}
              <Row label="模块排序" hint="拖动条目调整左侧导航顺序">
                <div className="module-order-list">
                  {moduleOrder.map((key, index) => (
                    <div
                      key={key}
                      className={`module-order-item${dragModuleKey === key ? ' dragging' : ''}`}
                      draggable
                      onDragStart={() => setDragModuleKey(key)}
                      onDragEnd={() => setDragModuleKey(null)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={() => dropModule(key)}
                    >
                      <span className="module-drag-handle" aria-hidden="true">⋮⋮</span>
                      <span>{MODULE_LABELS[key]}</span>
                      <button disabled={index === 0} onClick={() => moveModule(key, -1)} title="上移">↑</button>
                      <button disabled={index === moduleOrder.length - 1} onClick={() => moveModule(key, 1)} title="下移">↓</button>
                    </div>
                  ))}
                </div>
              </Row>
              <Row label="默认启动模块">
                <select value={settings.modules.defaultLaunch} onChange={(e) => update({ modules: { defaultLaunch: e.target.value } })}>
                  {LAUNCH_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </Row>
            </div>
          )}

          {cat === 'smartLists' && (
            <div className="settings-section">
              <h2>智能清单<ResetBtn group="smartLists" /></h2>
              <p className="set-note">隐藏只影响入口展示，不删除数据。</p>
              {Object.entries(SMARTLIST_LABELS).map(([key, label]) => (
                <Row key={key} label={label}>
                  <Switch
                    checked={!settings.smartLists.hidden.includes(key)}
                    onChange={(visible) => {
                      const hidden = visible ? settings.smartLists.hidden.filter((h) => h !== key) : [...settings.smartLists.hidden, key];
                      update({ smartLists: { hidden } });
                    }}
                  />
                </Row>
              ))}
            </div>
          )}

          {cat === 'notifications' && (
            <div className="settings-section">
              <h2>提醒通知<ResetBtn group="notifications" /></h2>
              <Row label="启用提醒">
                <Switch checked={noti.enabled} onChange={(v) => update({ notifications: { enabled: v } })} />
              </Row>
              <Row label="邮箱提醒">
                <Switch checked={noti.email} onChange={(v) => update({ notifications: { email: v } })} />
              </Row>
              <Row label="桌面通知">
                <Switch checked={noti.desktop} onChange={(v) => void updateDesktopNotificationSetting(v)} />
              </Row>
              <Row label="显示通知详情">
                <Seg
                  options={[
                    { value: 'when_unlocked', label: '解锁时' },
                    { value: 'always', label: '始终显示' },
                    { value: 'hidden', label: '不显示详情' },
                  ]}
                  value={noti.detailVisibility}
                  onChange={(v) => update({ notifications: { detailVisibility: v } })}
                />
              </Row>
              <Row label="系统通知权限">
                <div className="set-stack">
                  <div className="set-actions compact">
                    <span className="set-badge">
                      {NOTIFICATION_PERMISSION_LABELS[notificationPermission?.status ?? 'unknown']}
                    </span>
                    <button onClick={() => void refreshNotificationPermission()}>同步状态</button>
                    {notificationPermission?.status !== 'granted' && notificationPermission?.status !== 'unsupported' && (
                      <button className="btn-primary" onClick={() => void requestNotificationPermission('settings')}>申请权限</button>
                    )}
                  </div>
                  {notificationPermission?.guidance === 'blocked' && <span className="set-static">请在浏览器或系统设置中重新允许通知</span>}
                  {notificationPermissionMessage && <div className="set-feedback success">{notificationPermissionMessage}</div>}
                  {notificationPermissionError && <div className="set-feedback error">{notificationPermissionError}</div>}
                </div>
              </Row>
              <Row label="免打扰时段" hint="开启后，提醒 runner 在此时间段不创建新通知；结束后会继续发送到期提醒。">
                <Switch checked={noti.doNotDisturb} onChange={(v) => update({ notifications: { doNotDisturb: v } })} />
              </Row>
              <Row label="免打扰开始">
                <input
                  type="time"
                  value={noti.doNotDisturbStart ?? '22:00'}
                  onChange={(e) => update({ notifications: { doNotDisturbStart: e.target.value } })}
                />
              </Row>
              <Row label="免打扰结束">
                <input
                  type="time"
                  value={noti.doNotDisturbEnd ?? '08:00'}
                  onChange={(e) => update({ notifications: { doNotDisturbEnd: e.target.value } })}
                />
              </Row>
              <Row label="提醒铃声">
                <div className="set-stack">
                  <select
                    value={noti.reminderSound}
                    onChange={(e) => {
                      const value = e.target.value as 'default' | 'custom';
                      const fallback = reminderSoundOptions[0]?.id ?? noti.reminderSoundId;
                      void update({ notifications: { reminderSound: value, reminderSoundId: value === 'custom' ? fallback : null } });
                    }}
                  >
                    <option value="default">默认</option>
                    <option value="custom" disabled={reminderSoundOptions.length === 0}>自定义</option>
                  </select>
                  {noti.reminderSound === 'custom' && (
                    <select
                      value={noti.reminderSoundId ?? ''}
                      onChange={(e) => update({ notifications: { reminderSoundId: e.target.value || null } })}
                    >
                      {reminderSoundOptions.map((sound) => (
                        <option key={sound.id} value={sound.id}>
                          {sound.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <label className="td-file-upload">
                    上传
                    <input
                      type="file"
                      accept="audio/*"
                      disabled={notificationSoundBusy}
                      onChange={(e) => {
                        void uploadNotificationSound(e.target.files?.[0] ?? null, 'reminder');
                        e.currentTarget.value = '';
                      }}
                    />
                  </label>
                </div>
              </Row>
              <Row label="完成提示音">
                <div className="set-stack">
                  <select
                    value={noti.completionSound}
                    onChange={(e) => {
                      const value = e.target.value as 'ding' | 'none' | 'custom';
                      const fallback = completionSoundOptions[0]?.id ?? noti.completionSoundId;
                      void update({ notifications: { completionSound: value, completionSoundId: value === 'custom' ? fallback : null } });
                    }}
                  >
                    <option value="ding">叮</option>
                    <option value="none">无声音</option>
                    <option value="custom" disabled={completionSoundOptions.length === 0}>自定义</option>
                  </select>
                  {noti.completionSound === 'custom' && (
                    <select
                      value={noti.completionSoundId ?? ''}
                      onChange={(e) => update({ notifications: { completionSoundId: e.target.value || null } })}
                    >
                      {completionSoundOptions.map((sound) => (
                        <option key={sound.id} value={sound.id}>
                          {sound.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <label className="td-file-upload">
                    上传
                    <input
                      type="file"
                      accept="audio/*"
                      disabled={notificationSoundBusy}
                      onChange={(e) => {
                        void uploadNotificationSound(e.target.files?.[0] ?? null, 'completion');
                        e.currentTarget.value = '';
                      }}
                    />
                  </label>
                  {notificationSoundError && <div className="set-feedback error">{notificationSoundError}</div>}
                </div>
              </Row>
              <Row label="提醒音量">
                <div className="set-inline-item">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={noti.reminderVolume}
                    onChange={(e) => update({ notifications: { reminderVolume: Number(e.target.value) } })}
                    aria-label="提醒音量"
                  />
                  <span className="set-badge">{noti.reminderVolume}%</span>
                </div>
              </Row>
              <Row label="任务到期提醒">
                <Switch checked={noti.taskReminders} onChange={(v) => update({ notifications: { taskReminders: v } })} />
              </Row>
              <Row label="习惯打卡提醒">
                <Switch checked={noti.habitReminders} onChange={(v) => update({ notifications: { habitReminders: v } })} />
              </Row>
              <Row label="番茄结束提醒">
                <Switch checked={noti.focusReminders} onChange={(v) => update({ notifications: { focusReminders: v } })} />
              </Row>
              <Row label="目标任务提醒">
                <Switch checked={noti.goalReminders} onChange={(v) => update({ notifications: { goalReminders: v } })} />
              </Row>
            </div>
          )}

          {cat === 'focus' && (
            <div className="settings-section">
              <h2>番茄专注<ResetBtn group="focus" /></h2>
              <Row label="默认番茄时长">
                <input
                  type="number"
                  min={1}
                  value={focus.defaultMinutes}
                  onChange={(e) => update({ focus: { defaultMinutes: Number(e.target.value) } })}
                />
              </Row>
              <Row label="默认休息时长">
                <input
                  type="number"
                  min={1}
                  value={focus.restMinutes}
                  onChange={(e) => update({ focus: { restMinutes: Number(e.target.value) } })}
                />
              </Row>
              <Row label="长休息时长">
                <input
                  type="number"
                  min={1}
                  value={focus.longRestMinutes}
                  onChange={(e) => update({ focus: { longRestMinutes: Number(e.target.value) } })}
                />
              </Row>
              <Row label="长休间隔">
                <input
                  type="number"
                  min={1}
                  value={focus.longRestInterval}
                  onChange={(e) => update({ focus: { longRestInterval: Number(e.target.value) } })}
                />
              </Row>
              <Row label="默认背景音">
                <select value={focus.soundId ?? ''} onChange={(e) => update({ focus: { soundId: e.target.value || null } })}>
                  <option value="">无声音</option>
                  {focusSounds.map((sound) => (
                    <option key={sound.id} value={sound.id}>
                      {sound.name}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="默认音量">
                <div className="set-inline-item">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={focus.defaultVolume}
                    onChange={(e) => update({ focus: { defaultVolume: Number(e.target.value) } })}
                  />
                  <span className="set-badge">{focus.defaultVolume}%</span>
                </div>
              </Row>
              <Row label="暂停时同步暂停背景音">
                <Switch checked={focus.pauseSoundOnPause} onChange={(v) => update({ focus: { pauseSoundOnPause: v } })} />
              </Row>
              <Row label="休息时继续播放">
                <Switch checked={focus.playSoundDuringRest} onChange={(v) => update({ focus: { playSoundDuringRest: v } })} />
              </Row>
              <Row label="允许后台播放">
                <Switch checked={focus.backgroundAudioAllowed} onChange={(v) => update({ focus: { backgroundAudioAllowed: v } })} />
              </Row>
              <Row label="自动缓存常用背景音">
                <Switch checked={focus.autoCacheSounds} onChange={(v) => update({ focus: { autoCacheSounds: v } })} />
              </Row>
              <Row label="停止时渐弱">
                <Switch checked={focus.fadeOutStop} onChange={(v) => update({ focus: { fadeOutStop: v } })} />
              </Row>
              <p className="set-note">新专注记录未显式指定背景音或音量时，会使用这里的账号级默认设置。</p>
            </div>
          )}

          {cat === 'taskDefaults' && (
            <div className="settings-section">
              <h2>任务默认值<ResetBtn group="taskDefaults" /></h2>
              <Row label="默认日期">
                <Seg
                  options={[
                    { value: 'none', label: '无' },
                    { value: 'today', label: '今天' },
                    { value: 'tomorrow', label: '明天' },
                    { value: 'custom', label: '自定义' },
                  ]}
                  value={settings.taskDefaults.defaultDate}
                  onChange={(v) => update({ taskDefaults: { defaultDate: v } })}
                />
              </Row>
              {settings.taskDefaults.defaultDate === 'custom' && (
                <Row label="自定义日期">
                  <input
                    type="date"
                    value={isoToDateInput(settings.taskDefaults.customDate)}
                    onChange={(e) => update({ taskDefaults: { customDate: dateInputToISO(e.target.value) } })}
                  />
                </Row>
              )}
              <Row label="默认日期模式">
                <Seg
                  options={[
                    { value: 'date', label: '日期' },
                    { value: 'timeBlock', label: '时间段' },
                    { value: 'allDay', label: '全天' },
                  ]}
                  value={settings.taskDefaults.dateMode}
                  onChange={(v) => update({ taskDefaults: { dateMode: v } })}
                />
              </Row>
              {settings.taskDefaults.dateMode === 'timeBlock' && (
                <>
                  <Row label="默认开始时间">
                    <input
                      type="time"
                      value={settings.taskDefaults.defaultTimeBlockStart}
                      onChange={(e) => update({ taskDefaults: { defaultTimeBlockStart: e.target.value } })}
                    />
                  </Row>
                  <Row label="默认时间段">
                    <Seg
                      options={[
                        { value: 15, label: '15 分钟' },
                        { value: 30, label: '30 分钟' },
                        { value: 45, label: '45 分钟' },
                        { value: 60, label: '60 分钟' },
                      ]}
                      value={settings.taskDefaults.defaultTimeBlockMinutes}
                      onChange={(v) => update({ taskDefaults: { defaultTimeBlockMinutes: v } })}
                    />
                  </Row>
                  <Row label="有时间任务提醒">
                    <Seg
                      options={[
                        { value: 'none', label: '无' },
                        { value: 'at_start', label: '开始时' },
                        { value: '5m_before', label: '提前 5 分钟' },
                        { value: '30m_before', label: '提前 30 分钟' },
                        { value: 'custom', label: '自定义' },
                      ]}
                      value={settings.taskDefaults.timedReminder}
                      onChange={(v) => update({ taskDefaults: { timedReminder: v } })}
                    />
                  </Row>
                  {settings.taskDefaults.timedReminder === 'custom' && (
                    <Row label="自定义提前分钟">
                      <input
                        type="number"
                        min={0}
                        max={10080}
                        value={settings.taskDefaults.timedReminderCustomMinutes}
                        onChange={(e) => update({ taskDefaults: { timedReminderCustomMinutes: Number(e.target.value) } })}
                      />
                    </Row>
                  )}
                </>
              )}
              {settings.taskDefaults.dateMode !== 'timeBlock' && (
                <>
                  <Row label="全天任务提醒">
                    <Seg
                      options={[
                        { value: 'none', label: '无' },
                        { value: '1d_before', label: '提前 1 天' },
                        { value: 'same_day', label: '当天' },
                      ]}
                      value={settings.taskDefaults.allDayReminder}
                      onChange={(v) => update({ taskDefaults: { allDayReminder: v } })}
                    />
                  </Row>
                  {settings.taskDefaults.allDayReminder !== 'none' && (
                    <Row label="全天提醒时间">
                      <input
                        type="time"
                        value={settings.taskDefaults.allDayReminderTime}
                        onChange={(e) => update({ taskDefaults: { allDayReminderTime: e.target.value } })}
                      />
                    </Row>
                  )}
                </>
              )}
              <Row label="默认优先级">
                <Seg options={[{ value: 0, label: '无' }, { value: 1, label: '低' }, { value: 2, label: '中' }, { value: 3, label: '高' }]} value={settings.taskDefaults.priority} onChange={(v) => update({ taskDefaults: { priority: v as Priority } })} />
              </Row>
              <Row label="默认清单" hint="快速添加无清单时的默认归属">
                <select value={settings.taskDefaults.listId ?? ''} onChange={(e) => update({ taskDefaults: { listId: e.target.value || null } })}>
                  <option value="">收集箱</option>
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </Row>
              <Row label="默认标签" hint="新建顶层任务未显式指定标签时自动添加">
                <div className="set-check-list">
                  {tags.map((tag) => {
                    const checked = settings.taskDefaults.defaultTagIds.includes(tag.id);
                    return (
                      <label key={tag.id} className="set-check-item">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...settings.taskDefaults.defaultTagIds, tag.id]
                              : settings.taskDefaults.defaultTagIds.filter((id) => id !== tag.id);
                            update({ taskDefaults: { defaultTagIds: next } });
                          }}
                        />
                        <span>{tag.name}</span>
                      </label>
                    );
                  })}
                  {tags.length === 0 && <span className="set-static">暂无标签，可先在任务详情中创建标签</span>}
                </div>
              </Row>
              <Row label="标签管理" hint="调整父标签，或把重复标签合并到目标标签">
                <div className="tag-manager">
                  {tags.map((tag) => (
                    <div key={tag.id} className="tag-manager-row">
                      <span className="tag-manager-name">{tag.parentId ? '— ' : ''}{tag.name}</span>
                      <select value={tag.parentId ?? ''} onChange={(e) => void updateTagParent(tag, e.target.value || null)}>
                        <option value="">无父标签</option>
                        {tags.filter((item) => item.id !== tag.id).map((item) => (
                          <option key={item.id} value={item.id}>{item.name}</option>
                        ))}
                      </select>
                      <select value="" onChange={(e) => void mergeTag(tag, e.target.value)}>
                        <option value="">合并到…</option>
                        {tags.filter((item) => item.id !== tag.id).map((item) => (
                          <option key={item.id} value={item.id}>{item.name}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                  {tags.length === 0 && <span className="set-static">暂无标签</span>}
                  {tagManagerMessage && <span className="set-success">{tagManagerMessage}</span>}
                  {tagManagerError && <span className="set-error">{tagManagerError}</span>}
                </div>
              </Row>
              <Row label="默认添加到">
                <Seg
                  options={[
                    { value: 'top', label: '清单顶部' },
                    { value: 'bottom', label: '清单底部' },
                  ]}
                  value={settings.taskDefaults.addPosition}
                  onChange={(v) => update({ taskDefaults: { addPosition: v } })}
                />
              </Row>
              <Row label="已过期任务位置">
                <Seg
                  options={[
                    { value: 'top', label: '清单顶部' },
                    { value: 'original', label: '原位置' },
                    { value: 'grouped', label: '单独分组' },
                  ]}
                  value={settings.taskDefaults.overduePosition}
                  onChange={(v) => update({ taskDefaults: { overduePosition: v } })}
                />
              </Row>
            </div>
          )}

          {cat === 'ai' && (
            <div className="settings-section">
              <h2>AI 设置</h2>
              <p className="set-note">AI 拆解子任务已接入 OpenAI 兼容接口；智能排期 / 复盘会继续按同一配置扩展。Key 仅本地加密保存、展示时脱敏，绝不外露完整 Key。</p>
              <Row label="启用 AI 能力">
                <Switch checked={settings.ai.enabled} onChange={(v) => update({ ai: { enabled: v } })} />
              </Row>
              <Row label="模型服务商">
                <input value={ai.provider} placeholder="如 openai / deepseek / 自定义" onChange={(e) => setAi({ ...ai, provider: e.target.value })} />
              </Row>
              <Row label="API Base URL">
                <input value={ai.baseUrl} placeholder="https://api.openai.com/v1" onChange={(e) => setAi({ ...ai, baseUrl: e.target.value })} />
              </Row>
              <Row label="模型名称">
                <input value={ai.model} placeholder="如 gpt-4o-mini" onChange={(e) => setAi({ ...ai, model: e.target.value })} />
              </Row>
              <Row label="API Key" hint={settings.ai.hasApiKey ? `已保存：${settings.ai.apiKeyMasked}` : '未设置'}>
                <input type="password" value={ai.apiKey} placeholder={settings.ai.hasApiKey ? '留空不修改' : 'sk-...'} onChange={(e) => setAi({ ...ai, apiKey: e.target.value })} />
              </Row>
              <div className="set-actions">
                <button className="btn-primary" onClick={() => void update({ ai: { provider: ai.provider, baseUrl: ai.baseUrl, model: ai.model, ...(ai.apiKey ? { apiKey: ai.apiKey } : {}) } }).then(() => setAi({ ...ai, apiKey: '' }))}>保存</button>
                <button onClick={() => api.aiTest().then((r) => setAiResult(r.message)).catch((e) => setAiResult(e.message))}>测试连接</button>
                {settings.ai.hasApiKey && <button className="btn-danger" onClick={() => void update({ ai: { apiKey: '' } })}>删除 Key</button>}
              </div>
              {aiResult && <div className="ai-result">{aiResult}</div>}
            </div>
          )}

          {cat === 'notes' && (
            <div className="settings-section">
              <h2>便签<ResetBtn group="notes" /></h2>
              <Row label="启用便签">
                <Switch checked={noteDefaults.enabled} onChange={(v) => update({ notes: { enabled: v } })} />
              </Row>
              <Row label="默认颜色">
                <input type="color" value={noteDefaults.defaultColor} onChange={(e) => update({ notes: { defaultColor: e.target.value } })} />
              </Row>
              <Row label="默认不透明度">
                <div className="set-inline-item">
                  <input
                    type="range"
                    min={20}
                    max={100}
                    value={noteDefaults.defaultOpacity}
                    onChange={(e) => update({ notes: { defaultOpacity: Number(e.target.value) } })}
                  />
                  <span className="set-badge">{noteDefaults.defaultOpacity}%</span>
                </div>
              </Row>
              <Row label="默认字体">
                <Seg
                  options={[
                    { value: 'small', label: '小' },
                    { value: 'normal', label: '正常' },
                    { value: 'large', label: '大' },
                    { value: 'xlarge', label: '超大' },
                  ]}
                  value={noteDefaults.defaultFontSize}
                  onChange={(v) => update({ notes: { defaultFontSize: v } })}
                />
              </Row>
              <Row label="默认置顶">
                <Switch checked={noteDefaults.defaultPinned} onChange={(v) => update({ notes: { defaultPinned: v } })} />
              </Row>
              <Row label="默认尺寸">
                <div className="set-actions compact">
                  <input
                    type="number"
                    min={160}
                    value={noteDefaults.defaultPosition.width}
                    onChange={(e) =>
                      update({ notes: { defaultPosition: { ...noteDefaults.defaultPosition, width: Number(e.target.value) } } })
                    }
                  />
                  <input
                    type="number"
                    min={120}
                    value={noteDefaults.defaultPosition.height}
                    onChange={(e) =>
                      update({ notes: { defaultPosition: { ...noteDefaults.defaultPosition, height: Number(e.target.value) } } })
                    }
                  />
                </div>
              </Row>
            </div>
          )}

          {cat === 'data' && (
            <div className="settings-section">
              <h2>关联与导入</h2>
              <Row label="导出全部数据" hint="任务 / 清单 / 习惯 / 专注 / 倒数日 / 设置（JSON）">
                <button className="btn-primary" onClick={() => void downloadExport()}>导出 JSON</button>
              </Row>
              <Row label="导入格式" hint="JSON 支持任务、清单、标签、习惯、倒数日、目标；CSV 会按任务导入。">
                <Seg options={[{ value: 'json', label: 'JSON' }, { value: 'csv', label: 'CSV' }]} value={importFormat} onChange={setImportFormat} />
              </Row>
              <Row label="选择文件">
                <input type="file" accept=".json,.csv,application/json,text/csv,text/plain" onChange={(e) => void readImportFile(e.target.files?.[0] ?? null)} />
              </Row>
              <Row label="导入内容" hint="先预览，再确认写入当前账号数据。">
                <textarea
                  className="set-textarea"
                  value={importText}
                  onChange={(e) => {
                    setImportText(e.target.value);
                    setImportPreviewResult(null);
                    setImportCommitResult(null);
                    setImportError(null);
                  }}
                  spellCheck={false}
                />
              </Row>
              <div className="set-actions">
                <button className="btn-primary" onClick={() => void previewImport()} disabled={importBusy || !importText.trim()}>
                  {importBusy ? '处理中...' : '预览导入'}
                </button>
                <button onClick={() => void commitImport()} disabled={importBusy || !importPreviewResult}>
                  确认导入
                </button>
              </div>
              {importPreviewResult && (
                <div className="import-summary">
                  <div className="set-static">
                    共 {importPreviewResult.summary.total} 行，有效 {importPreviewResult.summary.valid}，重复 {importPreviewResult.summary.duplicates}，无效 {importPreviewResult.summary.invalid}
                  </div>
                  <div className="import-rows">
                    {importPreviewResult.rows.slice(0, 6).map((row, index) => (
                      <span key={`${row.type}-${row.title}-${index}`}>{row.type} · {row.title}</span>
                    ))}
                  </div>
                  {importPreviewResult.invalidRows.length > 0 && (
                    <div className="banner banner-error">
                      {importPreviewResult.invalidRows.length} 行无法导入：{importPreviewResult.invalidRows[0].reason}
                    </div>
                  )}
                </div>
              )}
              {importCommitResult && (
                <div className="banner">
                  已导入 {importCommitResult.created.length} 条，跳过重复 {importCommitResult.skippedDuplicates.length} 条，无效 {importCommitResult.invalidRows.length} 条。
                </div>
              )}
              {importError && <div className="banner banner-error">{importError}</div>}
              <p className="set-note">外部日历只读订阅在日历模块中维护；导入会走后端预览和确认接口，不直接在前端写本地数据。</p>
            </div>
          )}

          {cat === 'about' && (
            <div className="settings-section">
              <h2>关于</h2>
              <Row label="版本"><span className="set-static">效率清单 v{APP_VERSION}</span></Row>
              <Row label="检查更新">
                <button className="btn-primary" onClick={() => void checkForUpdates()}>检查</button>
              </Row>
              <Row label="用户协议"><a className="set-link" href={LEGAL_DOC_LINKS.terms.href} target="_blank" rel="noreferrer">查看</a></Row>
              <Row label="隐私政策"><a className="set-link" href={LEGAL_DOC_LINKS.privacy.href} target="_blank" rel="noreferrer">查看</a></Row>
              <Row label="问题反馈">
                <div className="set-stack about-contact">
                  {aboutContact?.feedbackUrl ? (
                    <a className="set-link" href={aboutContact.feedbackUrl} target="_blank" rel="noreferrer">打开反馈入口</a>
                  ) : (
                    <span className="set-static">未配置反馈入口</span>
                  )}
                </div>
              </Row>
              <Row label="联系我们">
                <div className="set-stack about-contact">
                  {aboutContact?.contactEmail && <a className="set-link" href={`mailto:${aboutContact.contactEmail}`}>{aboutContact.contactEmail}</a>}
                  {aboutContact?.supportText && <span className="set-static">{aboutContact.supportText}</span>}
                  {!aboutContact?.contactEmail && !aboutContact?.supportText && <span className="set-static">未配置联系方式</span>}
                  <div className="set-actions compact">
                    <button onClick={() => void refreshAboutContact()}>刷新联系方式</button>
                  </div>
                </div>
              </Row>
              <Row label="开源许可">
                <div className="set-stack license-list">
                  <div className="set-actions compact">
                    <button onClick={() => void refreshOpenSourceLicenses()}>刷新许可</button>
                  </div>
                  {openSourceLicenses && (
                    <>
                      <span className="set-static">
                        {openSourceLicenses.source} · {openSourceLicenses.packageCount} 个依赖
                      </span>
                      <div className="license-items">
                        {openSourceLicenses.packages.slice(0, 12).map((pkg) => (
                          <div className="license-item" key={`${pkg.name}@${pkg.version}`}>
                            <span className="license-name">{pkg.name}</span>
                            <span className="license-meta">
                              {pkg.version} · {pkg.license ?? '未声明'}{pkg.dev ? ' · dev' : ''}{pkg.optional ? ' · optional' : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  {openSourceLicensesError && <div className="set-feedback error">{openSourceLicensesError}</div>}
                </div>
              </Row>
              <Row label="诊断日志" hint="需要你主动勾选授权；上传前服务端会脱敏邮箱、手机号、验证码、Token 和密钥。">
                <div className="set-stack diagnostic-upload">
                  <textarea
                    value={diagnosticNote}
                    onChange={(e) => setDiagnosticNote(e.target.value)}
                    placeholder="补充问题现象（可选）"
                    rows={4}
                  />
                  <label className="danger-check">
                    <input type="checkbox" checked={diagnosticConsent} onChange={(e) => setDiagnosticConsent(e.target.checked)} />
                    我同意上传当前设备的诊断信息用于问题排查
                  </label>
                  <div className="set-actions compact">
                    <button className="btn-primary" onClick={() => void uploadDiagnosticLogs()} disabled={diagnosticBusy || !diagnosticConsent}>
                      {diagnosticBusy ? '上传中...' : '上传诊断日志'}
                    </button>
                  </div>
                  {diagnosticUpload && (
                    <div className="set-feedback success">
                      已上传 {diagnosticUpload.entryCount} 条诊断信息，文件 {diagnosticUpload.filename}，大小 {diagnosticUpload.sizeBytes} 字节。
                    </div>
                  )}
                  {diagnosticError && <div className="set-feedback error">{diagnosticError}</div>}
                </div>
              </Row>
              <Row label="技术栈"><span className="set-static">Vite + React · Express + node:sqlite</span></Row>
              {updateResult && <div className="set-feedback">{updateResult}</div>}
              {aboutContactError && <div className="set-feedback error">{aboutContactError}</div>}
              <p className="set-note">基于界面截图逆向的真实全栈实现，无 mock 数据。</p>
            </div>
          )}

          {cat === 'account' && (
            <div className="settings-section">
              <h2>账号</h2>
              <Row label="账号 ID"><span className="set-static">{user.id}</span></Row>
              <Row label="账号资料" hint="昵称和头像写入当前登录账号，切换账号后不会复用上一账号资料。">
                <div className="set-stack account-profile-editor">
                  <div className="account-profile-preview">
                    {user.avatarUrl ? (
                      <img src={user.avatarUrl} alt="账号头像" />
                    ) : (
                      <span>{(user.nickname || accountEmailMasked || user.id).slice(0, 1).toUpperCase()}</span>
                    )}
                    <div>
                      <strong>{user.nickname || accountEmailMasked || '未设置昵称'}</strong>
                      <small>注册时间 {new Date(user.registeredAt).toLocaleString()}</small>
                    </div>
                  </div>
                  <div className="set-actions compact">
                    <input
                      value={profileNickname}
                      maxLength={40}
                      placeholder="昵称（最多 40 个字符）"
                      onChange={(e) => setProfileNickname(e.target.value)}
                      disabled={profileBusy}
                    />
                    <button className="btn-primary" onClick={() => void saveProfile()} disabled={profileBusy}>
                      {profileBusy ? '保存中...' : '保存昵称'}
                    </button>
                  </div>
                  <div className="set-actions compact">
                    <label className="set-file-button">
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        disabled={profileBusy}
                        onChange={(e) => {
                          void uploadProfileAvatar(e.currentTarget.files?.[0] ?? null);
                          e.currentTarget.value = '';
                        }}
                      />
                      上传头像
                    </label>
                    <button onClick={() => void removeProfileAvatar()} disabled={profileBusy || !user.avatarUrl}>
                      移除头像
                    </button>
                  </div>
                  {profileMessage && <div className="set-feedback success">{profileMessage}</div>}
                  {profileError && <div className="set-feedback error">{profileError}</div>}
                </div>
              </Row>
              <Row label="邮箱"><span className="set-static">{accountEmailMasked ?? '未绑定'}</span></Row>
              <Row label="手机号"><span className="set-static">{identities.find((identity) => identity.type === 'phone')?.displayIdentifier ?? '未绑定'}</span></Row>
              <Row label="账号状态"><span className="set-static">{user.status}</span></Row>
              <Row label="用户协议 / 隐私政策" hint="与登录注册页一致，打开本产品当前版本的法律文档。">
                <div className="set-actions compact">
                  {legalDocEntries().map((item) => (
                    <a key={item.href} className="set-link" href={item.href} target="_blank" rel="noreferrer">
                      {item.label}
                    </a>
                  ))}
                </div>
              </Row>
              <Row label="当前设备"><span className="set-static">{session.deviceName ?? session.deviceId}</span></Row>
              <Row label="最近活跃"><span className="set-static">{new Date(session.lastActiveAt).toLocaleString()}</span></Row>
              <Row label="修改登录密码" hint="需要输入当前密码；保存后会使用新的邮箱密码登录。">
                <div className="set-stack">
                  <div className="set-actions compact">
                    <input
                      type="password"
                      value={passwordCurrent}
                      placeholder="当前密码"
                      autoComplete="current-password"
                      onChange={(e) => setPasswordCurrent(e.target.value)}
                      disabled={passwordBusy}
                    />
                    <input
                      type="password"
                      value={passwordNext}
                      placeholder="新密码"
                      autoComplete="new-password"
                      onChange={(e) => setPasswordNext(e.target.value)}
                      disabled={passwordBusy}
                    />
                    <input
                      type="password"
                      value={passwordConfirm}
                      placeholder="确认新密码"
                      autoComplete="new-password"
                      onChange={(e) => setPasswordConfirm(e.target.value)}
                      disabled={passwordBusy}
                    />
                    <button
                      className="btn-primary"
                      onClick={() => void changeAccountPassword()}
                      disabled={passwordBusy || !passwordCurrent || !passwordNext || !passwordConfirm}
                    >
                      {passwordBusy ? '保存中...' : '保存密码'}
                    </button>
                  </div>
                  {passwordMessage && <div className="set-feedback success">{passwordMessage}</div>}
                  {passwordError && <div className="set-feedback error">{passwordError}</div>}
                </div>
              </Row>
              <Row label="同步状态" hint="读取服务端同步操作记录，并合并当前浏览器的离线队列数量。">
                <div className="set-stack">
                  <span className="set-static">
                    {SYNC_HEALTH_LABELS[syncStatus?.health ?? 'never_synced']} · 最近同步 {fmtTime(syncStatus?.lastSyncAt)}
                  </span>
                  <span className="set-static">
                    未同步：本机 {pendingSyncCount(user.id)} · 服务端待处理 {syncStatus?.pendingServerOperationCount ?? 0}
                  </span>
                  <span className="set-static">
                    成功 {syncStatus?.statusCounts.applied ?? 0} · 冲突 {syncStatus?.statusCounts.conflict ?? 0} · 失败 {syncStatus?.statusCounts.failed ?? 0}
                  </span>
                  {syncStatus?.lastOperation?.error && <span className="set-static">最近错误：{syncStatus.lastOperation.error.message}</span>}
                  <div className="set-actions compact">
                    <button onClick={() => void refreshSyncStatus()}>刷新同步状态</button>
                  </div>
                  {syncStatusError && <div className="set-feedback error">{syncStatusError}</div>}
                </div>
              </Row>
              <Row label="登录设备" hint="查看当前账号的真实服务端会话；退出其他设备后，对方下一次请求会回到登录页。">
                <div className="set-stack account-device-list">
                  <div className="set-actions compact">
                    <button onClick={() => void refreshAccountSessions()} disabled={sessionBusy}>
                      {sessionBusy ? '刷新中...' : '刷新设备'}
                    </button>
                  </div>
                  {accountSessions.length === 0 && !sessionError && <span className="set-static">暂无登录设备记录</span>}
                  {accountSessions.map((item) => (
                    <div className={`set-inline-item account-device-item${item.revokedAt ? ' revoked' : ''}`} key={item.id}>
                      <div className="account-device-main">
                        <span className="account-device-title">{item.deviceName ?? item.deviceId}</span>
                        <span className="account-device-meta">
                          {[item.platform, item.appVersion].filter(Boolean).join(' · ') || '未知平台'} · 最近活跃 {new Date(item.lastActiveAt).toLocaleString()}
                        </span>
                      </div>
                      {item.isCurrentDevice && <span className="set-badge">当前设备</span>}
                      {item.revokedAt && <span className="set-badge">已退出</span>}
                      {!item.revokedAt && (
                        <button className={item.isCurrentDevice ? '' : 'btn-danger'} onClick={() => void revokeLoginSession(item)} disabled={sessionBusy}>
                          {item.isCurrentDevice ? '退出当前设备' : '退出设备'}
                        </button>
                      )}
                    </div>
                  ))}
                  {sessionMessage && <div className="set-feedback success">{sessionMessage}</div>}
                  {sessionError && <div className="set-feedback error">{sessionError}</div>}
                </div>
              </Row>
              <Row label="清理本机缓存" hint="Clears cached sounds on the server record and this account's offline sync queue in this browser.">
                <div className="set-stack">
                  <span className="set-static">
                    Offline queue {localCache?.pendingSyncCount ?? pendingSyncCount(user.id)} · cached sounds {localCache?.soundCacheCount ?? 0} · attachment cache 0
                  </span>
                  <div className="set-actions compact">
                    <button onClick={() => void refreshLocalCache()} disabled={cacheBusy}>
                      Refresh
                    </button>
                    <button className="btn-danger" onClick={() => void clearAccountLocalCache()} disabled={cacheBusy}>
                      {cacheBusy ? 'Clearing...' : 'Clear local cache'}
                    </button>
                  </div>
                  {cacheMessage && <div className="banner">{cacheMessage}</div>}
                  {cacheError && <div className="banner banner-error">{cacheError}</div>}
                </div>
              </Row>
              <Row label="登录方式">
                <div className="set-stack">
                  {identities.map((identity) => (
                    <div className="set-inline-item" key={identity.id}>
                      <span>
                        {identity.type === 'email' ? '邮箱' : identity.type === 'phone' ? '手机' : `第三方 ${identity.provider ?? ''}`} · {identity.displayIdentifier}
                      </span>
                      {identity.isPrimary && <span className="set-badge">primary</span>}
                      <button onClick={() => void unbindIdentity(identity.id)} disabled={bindBusy || identities.length <= 1}>
                        解绑
                      </button>
                    </div>
                  ))}
                </div>
              </Row>
              <Row label="绑定 / 换绑邮箱" hint="使用新邮箱收到的 SMTP 验证码完成绑定；新邮箱会成为主邮箱，旧邮箱仍保留为可用登录方式。">
                <div className="set-stack">
                  <div className="set-actions compact">
                    <input
                      type="email"
                      value={bindEmail}
                      placeholder="new@example.com"
                      onChange={(e) => setBindEmail(e.target.value)}
                      disabled={bindBusy}
                    />
                    <button onClick={() => void requestBindCode()} disabled={bindBusy || !bindEmail.trim()}>
                      发送验证码
                    </button>
                  </div>
                  <div className="set-actions compact">
                    <input
                      inputMode="numeric"
                      value={bindCode}
                      placeholder="邮箱验证码"
                      onChange={(e) => setBindCode(e.target.value)}
                      disabled={bindBusy || !bindChallengeId}
                    />
                    <button className="btn-primary" onClick={() => void bindNewEmail()} disabled={bindBusy || !bindChallengeId || bindCode.trim().length < 6}>
                      确认换绑
                    </button>
                  </div>
                  {bindMessage && <div className="set-feedback success">{bindMessage}</div>}
                  {bindError && <div className="set-feedback error">{bindError}</div>}
                </div>
              </Row>
              <Row label="绑定手机号" hint="需要配置真实 SMS 服务商；未配置时会直接返回错误，不会生成假验证码。">
                <div className="set-stack">
                  <div className="set-actions compact">
                    <input
                      type="tel"
                      value={bindPhone}
                      placeholder="+8613800000000"
                      onChange={(e) => setBindPhone(e.target.value)}
                      disabled={bindBusy}
                    />
                    <button onClick={() => void requestPhoneBindCode()} disabled={bindBusy || !bindPhone.trim()}>
                      发送验证码
                    </button>
                  </div>
                  <div className="set-actions compact">
                    <input
                      inputMode="numeric"
                      value={bindPhoneCode}
                      placeholder="短信验证码"
                      onChange={(e) => setBindPhoneCode(e.target.value)}
                      disabled={bindBusy || !bindPhoneChallengeId}
                    />
                    <button className="btn-primary" onClick={() => void bindNewPhone()} disabled={bindBusy || !bindPhoneChallengeId || bindPhoneCode.trim().length < 6}>
                      确认绑定
                    </button>
                  </div>
                </div>
              </Row>
              <Row label="绑定第三方账号" hint="使用已配置 OAuth/OIDC Provider 的访问令牌读取 UserInfo；未配置 Provider 时返回 501。">
                <div className="set-stack">
                  <div className="set-actions compact">
                    <input value={oauthProvider} placeholder="provider" onChange={(e) => setOauthProvider(e.target.value)} disabled={bindBusy} />
                    <input value={oauthRedirectUri} placeholder="redirect uri" onChange={(e) => setOauthRedirectUri(e.target.value)} disabled={bindBusy} />
                    <button className="btn-primary" onClick={() => void startOAuthBinding()} disabled={bindBusy || !oauthProvider.trim() || !oauthRedirectUri.trim()}>
                      Start OAuth
                    </button>
                  </div>
                  {oauthAuthorizationUrl && (
                    <a className="auth-link" href={oauthAuthorizationUrl}>
                      Open authorization link
                    </a>
                  )}
                  <div className="set-actions compact">
                    <input value={oauthState} placeholder="state" onChange={(e) => setOauthState(e.target.value)} disabled={bindBusy} />
                    <input value={oauthCode} placeholder="code" onChange={(e) => setOauthCode(e.target.value)} disabled={bindBusy} />
                    <button className="btn-primary" onClick={() => void completeOAuthBinding()} disabled={bindBusy || !oauthProvider.trim() || !oauthState.trim() || !oauthCode.trim()}>
                      Complete OAuth
                    </button>
                  </div>
                  <div className="set-actions compact">
                    <input value={oauthProvider} placeholder="provider" onChange={(e) => setOauthProvider(e.target.value)} disabled={bindBusy} />
                    <input type="password" value={oauthToken} placeholder="access token" onChange={(e) => setOauthToken(e.target.value)} disabled={bindBusy} />
                    <button className="btn-primary" onClick={() => void bindOAuthAccount()} disabled={bindBusy || !oauthProvider.trim() || !oauthToken.trim()}>
                      绑定
                    </button>
                  </div>
                </div>
              </Row>
              <Row label="退出登录" hint="退出后主界面不展示任何业务数据。">
                <button className="btn-danger" onClick={() => void logout()}>
                  退出登录
                </button>
              </Row>
              <div className="danger-zone">
                <h3>注销账号</h3>
                <p className="set-note">
                  注销需要当前邮箱验证码和二次确认。提交后会立即退出登录，账号进入 {deletionPreview?.coolingDays ?? 7} 天冷静期；冷静期内重新登录会自动取消注销。
                </p>
                {deletionPreview && (
                  <div className="deletion-impact">
                    <span>清单 {deletionPreview.deletionImpact.lists}</span>
                    <span>任务 {deletionPreview.deletionImpact.tasks}</span>
                    <span>目标 {deletionPreview.deletionImpact.goals}</span>
                    <span>标签 {deletionPreview.deletionImpact.tags}</span>
                    <span>提醒 {deletionPreview.deletionImpact.notifications}</span>
                    <span>附件 {deletionPreview.deletionImpact.attachments}</span>
                    <span>专注 {deletionPreview.deletionImpact.focusSessions}</span>
                    <span>习惯 {deletionPreview.deletionImpact.habits}</span>
                    <span>倒数日 {deletionPreview.deletionImpact.countdowns}</span>
                    <span>便签 {deletionPreview.deletionImpact.notes}</span>
                  </div>
                )}
                <div className="danger-form">
                  <input
                    type="email"
                    value={deleteEmail}
                    placeholder="输入当前完整邮箱"
                    onChange={(e) => setDeleteEmail(e.target.value)}
                    disabled={deleteBusy}
                  />
                  <button onClick={() => void requestDeletionCode()} disabled={deleteBusy || !deleteEmail.trim()}>
                    发送注销验证码
                  </button>
                  <input
                    inputMode="numeric"
                    value={deleteCode}
                    placeholder="邮箱验证码"
                    onChange={(e) => setDeleteCode(e.target.value)}
                    disabled={deleteBusy || !deleteChallengeId}
                  />
                  <input
                    value={deleteConfirm}
                    placeholder="输入 DELETE 确认"
                    onChange={(e) => setDeleteConfirm(e.target.value)}
                    disabled={deleteBusy}
                  />
                  <label className="danger-check">
                    <input type="checkbox" checked={deleteAck} onChange={(e) => setDeleteAck(e.target.checked)} disabled={deleteBusy} />
                    我已导出或确认放弃导出账号数据
                  </label>
                  <button
                    className="btn-danger"
                    onClick={() => void requestDeletion()}
                    disabled={deleteBusy || !deleteChallengeId || deleteCode.trim().length < 6 || deleteConfirm.trim() !== 'DELETE' || !deleteAck}
                  >
                    申请注销账号
                  </button>
                </div>
                {deleteMessage && <div className="set-feedback success">{deleteMessage}</div>}
                {deleteError && <div className="set-feedback error">{deleteError}</div>}
              </div>
            </div>
          )}

          {cat === 'widgets' && (
            <div className="settings-section">
              <h2>桌面小部件<ResetBtn group="widgets" /></h2>
              <Row label="启用桌面小部件">
                <Switch checked={settings.widgets.enabled} onChange={(v) => update({ widgets: { enabled: v } })} />
              </Row>
              <Row label="新增小部件">
                <div className="set-stack">
                  <div className="set-actions compact">
                    <select
                      value={widgetType}
                      onChange={(e) => {
                        const template = widgetTemplates.find((item) => item.type === e.target.value);
                        setWidgetType(e.target.value);
                        if (template) setWidgetTitle(template.defaultTitle);
                      }}
                    >
                      {widgetTemplates.map((template) => (
                        <option key={template.type} value={template.type}>
                          {template.label}
                        </option>
                      ))}
                    </select>
                    <input
                      value={widgetTitle}
                      placeholder={selectedWidgetTemplate?.defaultTitle ?? '小部件标题'}
                      onChange={(e) => setWidgetTitle(e.target.value)}
                    />
                    <button className="btn-primary" onClick={() => void addDesktopWidget()}>添加</button>
                  </div>
                  <div className="set-actions compact">
                    {widgetTemplates.map((template) => (
                      <span className="set-badge" key={template.type}>
                        {template.label} {template.priority}
                      </span>
                    ))}
                  </div>
                  {desktopStatus && (
                    <span className="set-badge">
                      {desktopStatus.capabilities.widgets} / {desktopStatus.hostAvailable ? 'native host' : 'web bridge'}
                    </span>
                  )}
                </div>
              </Row>
              <Row label="已保存小部件">
                <div className="set-stack">
                  {desktopWidgets.length === 0 && <span className="set-static">暂无桌面小部件</span>}
                  {desktopWidgets.map((widget) => (
                    <div className="set-inline-item" key={widget.id}>
                      <span>{widget.title}</span>
                      <span className="set-badge">{widgetTemplates.find((template) => template.type === widget.type)?.label ?? widget.type}</span>
                      <Switch
                        checked={widget.enabled}
                        onChange={(enabled) =>
                          void api.updateDesktopWidget(widget.id, { enabled }).then((updated) => {
                            setDesktopWidgets((items) => items.map((item) => (item.id === widget.id ? updated : item)));
                          }).catch((err) => setDesktopError((err as Error).message))
                        }
                      />
                      <button onClick={() => void deleteDesktopWidget(widget.id)}>删除</button>
                    </div>
                  ))}
                </div>
              </Row>
              {desktopMessage && <div className="set-feedback success">{desktopMessage}</div>}
              {desktopError && <div className="set-feedback error">{desktopError}</div>}
            </div>
          )}

          {cat === 'shortcuts' && (
            <div className="settings-section">
              <h2>快捷键<ResetBtn group="shortcuts" /></h2>
              <Row label="启用快捷键">
                <Switch checked={settings.shortcuts.enabled} onChange={(v) => update({ shortcuts: { enabled: v } })} />
              </Row>
              <Row label="快捷键方案">
                <div className="set-stack">
                  <div className="set-actions compact">
                    <select
                      value={shortcutAction}
                      onChange={(e) => {
                        const next = shortcutTemplates.find((template) => template.action === e.target.value);
                        setShortcutAction(e.target.value);
                        if (next) setShortcutAccelerator(next.accelerator);
                      }}
                    >
                      {shortcutTemplates.map((template) => (
                        <option key={template.action} value={template.action}>
                          {template.label}
                        </option>
                      ))}
                    </select>
                    <input
                      value={shortcutAccelerator}
                      placeholder={selectedShortcutTemplate?.accelerator ?? 'CommandOrControl+N'}
                      onChange={(e) => setShortcutAccelerator(e.target.value)}
                    />
                    <button className="btn-primary" onClick={() => void addDesktopShortcut()}>保存</button>
                  </div>
                  <div className="set-actions compact">
                    <button onClick={() => selectedShortcutTemplate && setShortcutAccelerator(selectedShortcutTemplate.accelerator)}>
                      使用默认按键
                    </button>
                    <button onClick={() => void resetDesktopShortcuts()}>恢复默认快捷键</button>
                  </div>
                </div>
              </Row>
              <Row label="已保存快捷键">
                <div className="set-stack">
                  {desktopShortcuts.length === 0 && <span className="set-static">暂无快捷键，点击恢复默认快捷键可创建默认方案</span>}
                  {desktopShortcuts.map((shortcut) => {
                    const template = shortcutTemplates.find((item) => item.action === shortcut.action);
                    return (
                      <div className="set-inline-item" key={shortcut.id}>
                        <span>{template?.label ?? shortcut.action}</span>
                        <span className="set-badge">{shortcut.accelerator}</span>
                        <Switch checked={shortcut.enabled} onChange={(enabled) => void updateDesktopShortcut(shortcut.id, { enabled })} />
                        <button onClick={() => void registerDesktopShortcut(shortcut.id)}>登记</button>
                        <button onClick={() => void deleteDesktopShortcut(shortcut.id)}>删除</button>
                      </div>
                    );
                  })}
                </div>
              </Row>
              <p className="set-note">当前 Web 桥接会真实保存快捷键登记请求；系统级全局绑定仍等待未来桌面宿主提供授权。</p>
              {desktopMessage && <div className="set-feedback success">{desktopMessage}</div>}
              {desktopError && <div className="set-feedback error">{desktopError}</div>}
            </div>
          )}

          {cat === 'more' && (
            <div className="settings-section">
              <h2>更多设置</h2>
              <Row label="快速添加智能解析">
                <Switch checked={settings.quickAdd.parseEnabled} onChange={(v) => update({ quickAdd: { parseEnabled: v } })} />
              </Row>
              <Row label="日期识别">
                <Switch checked={settings.quickAdd.dateRecognition} onChange={(v) => update({ quickAdd: { dateRecognition: v } })} />
              </Row>
              <Row label="移除日期文本" hint="关闭时仍识别日期，但保留在任务标题里">
                <Switch checked={settings.quickAdd.removeDateText} onChange={(v) => update({ quickAdd: { removeDateText: v } })} />
              </Row>
              <Row label="标签识别">
                <Switch checked={settings.quickAdd.tagRecognition} onChange={(v) => update({ quickAdd: { tagRecognition: v } })} />
              </Row>
              <Row label="移除标签文本" hint="关闭时仍挂载标签，但保留 #标签 到标题">
                <Switch checked={settings.quickAdd.removeTagText} onChange={(v) => update({ quickAdd: { removeTagText: v } })} />
              </Row>
              <Row label="网址解析" hint="标题为网页 URL 时由后端抓取真实网页标题">
                <Switch checked={settings.quickAdd.urlParsing} onChange={(v) => update({ quickAdd: { urlParsing: v } })} />
              </Row>
              <Row label="开机自动启动">
                <Switch checked={desktopStatus?.state.startup ?? false} onChange={(v) => void updateDesktopState({ startup: v })} />
              </Row>
              <Row label="启动到托盘">
                <Switch checked={desktopStatus?.state.tray ?? false} onChange={(v) => void updateDesktopState({ tray: v })} />
              </Row>
              <Row label="关闭窗口行为">
                <Seg
                  options={[
                    { value: 'minimize_to_tray', label: '最小化到托盘' },
                    { value: 'quit', label: '直接退出' },
                  ]}
                  value={desktopStatus?.state.closeBehavior ?? 'minimize_to_tray'}
                  onChange={(v) => void updateDesktopState({ closeBehavior: v })}
                />
              </Row>
              <Row label="应用锁">
                <Switch checked={desktopStatus?.state.appLock ?? false} onChange={(v) => void updateDesktopState({ appLock: v })} />
              </Row>
              <Row label="应用锁密码" hint="只保存加盐哈希，账号数据导出不会包含应用锁凭据">
                <div className="set-stack">
                  <span className="set-badge">{desktopStatus?.appLockPasswordSet ? '已设置密码' : '未设置密码'}</span>
                  {desktopStatus?.appLockPasswordSet && (
                    <input
                      type="password"
                      value={appLockCurrentPassword}
                      onChange={(event) => setAppLockCurrentPassword(event.target.value)}
                      placeholder="当前密码"
                      aria-label="当前应用锁密码"
                    />
                  )}
                  <input
                    type="password"
                    value={appLockPassword}
                    onChange={(event) => setAppLockPassword(event.target.value)}
                    placeholder={desktopStatus?.appLockPasswordSet ? '新密码（4-128 字符）' : '设置密码（4-128 字符）'}
                    aria-label="新的应用锁密码"
                  />
                  <div className="set-actions compact">
                    <button type="button" onClick={() => void saveAppLockPassword()}>保存密码</button>
                    {desktopStatus?.appLockPasswordSet && (
                      <button type="button" onClick={() => void clearAppLockPassword()}>停用密码</button>
                    )}
                  </div>
                  {appLockPasswordMessage && <div className="set-feedback success">{appLockPasswordMessage}</div>}
                  {appLockPasswordError && <div className="set-feedback error">{appLockPasswordError}</div>}
                </div>
              </Row>
              <Row label="自动锁定">
                <Seg
                  options={[
                    { value: 0, label: '关闭' },
                    { value: 1, label: '1 分钟' },
                    { value: 5, label: '5 分钟' },
                    { value: 10, label: '10 分钟' },
                  ]}
                  value={desktopStatus?.state.autoLockMinutes ?? 0}
                  onChange={(v) => void updateDesktopState({ autoLockMinutes: v })}
                />
              </Row>
              <Row label="锁定状态">
                <div className="set-actions compact">
                  <span className="set-badge">{desktopStatus?.state.locked ? '已锁定' : '未锁定'}</span>
                  <button type="button" onClick={() => api.lockDesktopBridge().then(setDesktopStatus).catch((e) => setDesktopError((e as Error).message))}>锁定</button>
                  <button type="button" onClick={() => void unlockDesktopFromSettings()}>解锁</button>
                </div>
              </Row>
              <Row label="后台声音">
                <Switch
                  checked={desktopStatus?.state.backgroundAudioAllowed ?? false}
                  onChange={(v) => void updateDesktopState({ backgroundAudioAllowed: v })}
                />
              </Row>
              <Row label="桌面桥接">
                <span className="set-badge">
                  {desktopStatus?.hostAdapter ?? 'loading'} / {desktopStatus?.hostAvailable ? 'native host' : 'web bridge'}
                </span>
              </Row>
              {desktopMessage && <div className="set-feedback success">{desktopMessage}</div>}
              {desktopError && <div className="set-feedback error">{desktopError}</div>}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
