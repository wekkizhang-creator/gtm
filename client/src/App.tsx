import { useEffect, useState } from 'react';
import { SettingsProvider, useSettings } from './settings';
import ModuleRail, { type ModuleKey } from './components/ModuleRail';
import SettingsModal from './components/SettingsModal';
import TaskModule from './modules/TaskModule';
import CalendarModule from './modules/CalendarModule';
import MatrixModule from './modules/MatrixModule';
import FocusModule from './modules/FocusModule';
import HabitsModule from './modules/HabitsModule';
import CountdownModule from './modules/CountdownModule';

function AppInner() {
  const { settings, loaded } = useSettings();
  const [module, setModule] = useState<ModuleKey>('tasks');
  const [initialized, setInitialized] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // adopt the configured default-launch module once settings load (first time only)
  useEffect(() => {
    if (loaded && !initialized) {
      setModule((settings.modules.defaultLaunch as ModuleKey) || 'tasks');
      setInitialized(true);
    }
  }, [loaded, initialized, settings.modules.defaultLaunch]);

  // if the active module gets hidden, fall back to tasks
  useEffect(() => {
    if (module !== 'tasks' && settings.modules.hidden.includes(module)) setModule('tasks');
  }, [settings.modules.hidden, module]);

  return (
    <div className="app">
      <ModuleRail
        active={module}
        onSelect={setModule}
        hidden={settings.modules.hidden}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {module === 'tasks' && <TaskModule />}
      {module === 'calendar' && <CalendarModule />}
      {module === 'matrix' && <MatrixModule />}
      {module === 'focus' && <FocusModule />}
      {module === 'habits' && <HabitsModule />}
      {module === 'countdown' && <CountdownModule />}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

export default function App() {
  return (
    <SettingsProvider>
      <AppInner />
    </SettingsProvider>
  );
}
