import { type FormEvent, useEffect, useRef, useState } from 'react';
import { SettingsProvider, useSettings } from './settings';
import { AuthProvider } from './auth';
import { api } from './api/client';
import ModuleRail, { type ModuleKey } from './components/ModuleRail';
import SettingsModal from './components/SettingsModal';
import NotificationCenter from './components/NotificationCenter';
import GlobalSearch from './components/GlobalSearch';
import TaskModule from './modules/TaskModule';
import GoalModule from './modules/GoalModule';
import CalendarModule from './modules/CalendarModule';
import MatrixModule from './modules/MatrixModule';
import FocusModule from './modules/FocusModule';
import HabitsModule from './modules/HabitsModule';
import CountdownModule from './modules/CountdownModule';
import NotesModule from './modules/NotesModule';
import { createSearchNavigationTarget, moduleForSearchResult, type SearchNavigationTarget } from './searchNavigation';
import type { DesktopStatus, SearchResult } from './types';

function AppInner() {
  const { settings, loaded } = useSettings();
  const [module, setModule] = useState<ModuleKey>('tasks');
  const [initialized, setInitialized] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchTarget, setSearchTarget] = useState<SearchNavigationTarget | null>(null);
  const [desktopLocked, setDesktopLocked] = useState(false);
  const [desktopPasswordRequired, setDesktopPasswordRequired] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const lastActivitySync = useRef(0);
  const searchTargetModule = searchTarget ? moduleForSearchResult(searchTarget.type) : null;

  function applyDesktopStatus(status: DesktopStatus) {
    const locked = status.state.appLock && status.state.locked;
    setDesktopLocked(locked);
    setDesktopPasswordRequired(status.appLockPasswordSet);
    if (!locked) {
      setUnlockPassword('');
      setUnlockError(null);
    }
  }

  // adopt the configured default-launch module once settings load (first time only)
  useEffect(() => {
    if (loaded && !initialized) {
      setModule((settings.modules.defaultLaunch as ModuleKey) || 'tasks');
      setInitialized(true);
    }
  }, [loaded, initialized, settings.modules.defaultLaunch]);

  // if the active module gets hidden, fall back to tasks
  useEffect(() => {
    if (module !== 'tasks' && module !== searchTargetModule && settings.modules.hidden.includes(module)) setModule('tasks');
  }, [settings.modules.hidden, module, searchTargetModule]);

  useEffect(() => {
    if (!loaded) return;
    api.getDesktopStatus().then(applyDesktopStatus).catch(() => {});
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    const syncActivity = () => {
      const now = Date.now();
      if (now - lastActivitySync.current < 15_000) return;
      lastActivitySync.current = now;
      api.recordDesktopActivity().then(applyDesktopStatus).catch(() => {});
    };
    syncActivity();
    for (const event of ['pointerdown', 'keydown', 'focus'] as const) window.addEventListener(event, syncActivity);
    return () => {
      for (const event of ['pointerdown', 'keydown', 'focus'] as const) window.removeEventListener(event, syncActivity);
    };
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    const check = () => api.checkDesktopAutoLock().then(applyDesktopStatus).catch(() => {});
    const id = window.setInterval(check, 30_000);
    check();
    return () => window.clearInterval(id);
  }, [loaded]);

  async function unlockDesktop(event?: FormEvent) {
    event?.preventDefault();
    if (desktopPasswordRequired && !unlockPassword) {
      setUnlockError('请输入应用锁密码');
      return;
    }
    setUnlockError(null);
    try {
      const status = await api.unlockDesktopBridge(desktopPasswordRequired ? unlockPassword : undefined);
      applyDesktopStatus(status);
    } catch (err) {
      setUnlockError((err as Error).message);
    }
  }

  function openSearchResult(item: SearchResult) {
    const target = createSearchNavigationTarget(item, Date.now());
    setSearchTarget(target);
    setModule(moduleForSearchResult(item.type));
  }

  return (
    <div className="app">
      <ModuleRail
        active={module}
        onSelect={setModule}
        hidden={settings.modules.hidden}
        order={settings.modules.order}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {module === 'tasks' && <TaskModule searchTarget={searchTarget} />}
      {module === 'goals' && <GoalModule searchTarget={searchTarget} />}
      {module === 'calendar' && <CalendarModule />}
      {module === 'matrix' && <MatrixModule />}
      {module === 'focus' && <FocusModule />}
      {module === 'habits' && <HabitsModule searchTarget={searchTarget} />}
      {module === 'countdown' && <CountdownModule searchTarget={searchTarget} />}
      {module === 'notes' && <NotesModule />}
      <GlobalSearch onOpenResult={openSearchResult} />
      <NotificationCenter locked={desktopLocked} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {desktopLocked && (
        <div className="desktop-lock-overlay">
          <form className="desktop-lock-panel" onSubmit={(event) => void unlockDesktop(event)}>
            <h2>应用已锁定</h2>
            {desktopPasswordRequired && (
              <input
                autoFocus
                type="password"
                value={unlockPassword}
                onChange={(event) => setUnlockPassword(event.target.value)}
                placeholder="输入应用锁密码"
                aria-label="应用锁密码"
              />
            )}
            {unlockError && <div className="desktop-lock-error">{unlockError}</div>}
            <button className="btn-primary" type="submit">解锁</button>
          </form>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <SettingsProvider>
        <AppInner />
      </SettingsProvider>
    </AuthProvider>
  );
}
