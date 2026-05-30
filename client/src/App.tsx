import { useState } from 'react';
import ModuleRail, { type ModuleKey } from './components/ModuleRail';
import TaskModule from './modules/TaskModule';
import CalendarModule from './modules/CalendarModule';
import MatrixModule from './modules/MatrixModule';
import FocusModule from './modules/FocusModule';
import HabitsModule from './modules/HabitsModule';
import CountdownModule from './modules/CountdownModule';

export default function App() {
  const [module, setModule] = useState<ModuleKey>('tasks');
  return (
    <div className="app">
      <ModuleRail active={module} onSelect={setModule} />
      {module === 'tasks' && <TaskModule />}
      {module === 'calendar' && <CalendarModule />}
      {module === 'matrix' && <MatrixModule />}
      {module === 'focus' && <FocusModule />}
      {module === 'habits' && <HabitsModule />}
      {module === 'countdown' && <CountdownModule />}
    </div>
  );
}
