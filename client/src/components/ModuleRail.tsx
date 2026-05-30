export type ModuleKey = 'tasks' | 'calendar' | 'matrix' | 'focus' | 'habits' | 'countdown';

interface Props {
  active: ModuleKey;
  onSelect: (m: ModuleKey) => void;
  hidden: string[];
  onOpenSettings: () => void;
}

const ITEMS: { key: ModuleKey; icon: string; label: string }[] = [
  { key: 'tasks', icon: '✓', label: '任务' },
  { key: 'calendar', icon: '📅', label: '日历' },
  { key: 'matrix', icon: '⊞', label: '四象限' },
  { key: 'focus', icon: '🍅', label: '番茄' },
  { key: 'habits', icon: '🔁', label: '习惯' },
  { key: 'countdown', icon: '⏳', label: '倒数日' },
];

export default function ModuleRail({ active, onSelect, hidden, onOpenSettings }: Props) {
  return (
    <div className="module-rail">
      {ITEMS.filter((it) => it.key === 'tasks' || !hidden.includes(it.key)).map((it) => (
        <button
          key={it.key}
          className={`rail-item${active === it.key ? ' active' : ''}`}
          title={it.label}
          onClick={() => onSelect(it.key)}
        >
          <span className="rail-icon">{it.icon}</span>
          <span className="rail-label">{it.label}</span>
        </button>
      ))}
      <button className="rail-item rail-settings" title="设置" onClick={onOpenSettings}>
        <span className="rail-icon">⚙</span>
        <span className="rail-label">设置</span>
      </button>
    </div>
  );
}
