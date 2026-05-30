import { useEffect, useState } from 'react';
import { useSettings } from '../settings';
import { api } from '../api/client';
import type { List, Priority } from '../types';

const APP_VERSION = '0.6.0';

const CATEGORIES = [
  { key: 'account', label: '账号', icon: '👤' },
  { key: 'modules', label: '功能模块', icon: '⊞' },
  { key: 'smartLists', label: '智能清单', icon: '📋' },
  { key: 'datetime', label: '日期与时间', icon: '🕐' },
  { key: 'appearance', label: '外观', icon: '🎨' },
  { key: 'taskDefaults', label: '任务默认值', icon: '✓' },
  { key: 'more', label: '更多设置', icon: '⚙' },
  { key: 'data', label: '关联与导入', icon: '🔗' },
  { key: 'ai', label: 'AI 设置', icon: '✨' },
  { key: 'about', label: '关于', icon: 'ℹ️' },
] as const;

const ACCENTS = ['#c96442', '#3aa6a0', '#4a8cf0', '#7c5cff', '#e0568b', '#2f9e6f', '#e0922f', '#5b5750'];
const MODULE_LABELS: Record<string, string> = { calendar: '日历', matrix: '四象限', focus: '番茄', habits: '习惯', countdown: '倒数日' };
const LAUNCH_OPTIONS = [
  { value: 'tasks', label: '任务' },
  { value: 'calendar', label: '日历' },
  { value: 'matrix', label: '四象限' },
  { value: 'focus', label: '番茄' },
  { value: 'habits', label: '习惯' },
  { value: 'countdown', label: '倒数日' },
];
const SMARTLIST_LABELS: Record<string, string> = { today: '今天', next7days: '最近7天', inbox: '收集箱', completed: '已完成', trash: '垃圾桶' };

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
  const [cat, setCat] = useState<string>('appearance');
  const [lists, setLists] = useState<List[]>([]);

  // AI local form
  const [ai, setAi] = useState({ provider: '', baseUrl: '', model: '', apiKey: '' });
  const [aiResult, setAiResult] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    api.listLists().then(setLists).catch(() => {});
    setAi({ provider: settings.ai.provider, baseUrl: settings.ai.baseUrl, model: settings.ai.model, apiKey: '' });
    setAiResult(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const a = settings.appearance;
  const dt = settings.datetime;

  async function downloadExport() {
    const data = await api.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'efficiency-list-export.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  function ResetBtn({ group }: { group: string }) {
    return (
      <button className="set-reset" onClick={() => void reset(group)}>
        恢复默认
      </button>
    );
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <nav className="settings-nav">
          <div className="settings-nav-title">设置</div>
          {CATEGORIES.map((c) => (
            <button key={c.key} className={`settings-nav-item${cat === c.key ? ' active' : ''}`} onClick={() => setCat(c.key)}>
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
            </div>
          )}

          {cat === 'modules' && (
            <div className="settings-section">
              <h2>功能模块<ResetBtn group="modules" /></h2>
              <p className="set-note">任务 / 清单为核心模块，不可隐藏；隐藏模块不删除数据，仅不在左侧导航展示。</p>
              {Object.entries(MODULE_LABELS).map(([key, label]) => (
                <Row key={key} label={label}>
                  <Switch
                    checked={!settings.modules.hidden.includes(key)}
                    onChange={(visible) => {
                      const hidden = visible ? settings.modules.hidden.filter((h) => h !== key) : [...settings.modules.hidden, key];
                      update({ modules: { hidden } });
                    }}
                  />
                </Row>
              ))}
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

          {cat === 'taskDefaults' && (
            <div className="settings-section">
              <h2>任务默认值<ResetBtn group="taskDefaults" /></h2>
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
            </div>
          )}

          {cat === 'ai' && (
            <div className="settings-section">
              <h2>AI 设置</h2>
              <p className="set-note">AI 能力（目标拆解 / 智能排期 / 复盘）开发中；Key 仅本地加密保存、展示时脱敏，绝不外露完整 Key。</p>
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

          {cat === 'data' && (
            <div className="settings-section">
              <h2>关联与导入</h2>
              <Row label="导出全部数据" hint="任务 / 清单 / 习惯 / 专注 / 倒数日 / 设置（JSON）">
                <button className="btn-primary" onClick={() => void downloadExport()}>导出 JSON</button>
              </Row>
              <p className="set-note">外部日历只读订阅、从文件 / 竞品导入将在后续切片提供；导入前会提供预览与确认。</p>
            </div>
          )}

          {cat === 'about' && (
            <div className="settings-section">
              <h2>关于</h2>
              <Row label="版本"><span className="set-static">效率清单 v{APP_VERSION}</span></Row>
              <Row label="用户协议"><a className="set-link" href="#">查看</a></Row>
              <Row label="隐私政策"><a className="set-link" href="#">查看</a></Row>
              <Row label="技术栈"><span className="set-static">Vite + React · Express + node:sqlite</span></Row>
              <p className="set-note">基于界面截图逆向的真实全栈实现，无 mock 数据。</p>
            </div>
          )}

          {cat === 'account' && (
            <div className="settings-section">
              <h2>账号</h2>
              <div className="set-placeholder">
                <div className="set-placeholder-icon">👤</div>
                <p>当前为<strong>本地单用户模式</strong>。</p>
                <p className="set-note">登录、多端同步、第三方账号绑定、设备管理为后续切片（需账号体系）。</p>
              </div>
            </div>
          )}

          {cat === 'more' && (
            <div className="settings-section">
              <h2>更多设置</h2>
              <p className="set-note">以下设置依赖尚未实现的底层能力，暂以占位呈现（不提供无效开关）：</p>
              {[
                ['提醒与通知', '需通知引擎'],
                ['便签', '需便签模块'],
                ['桌面小部件', '需桌面端'],
                ['快捷键', '需全局快捷键'],
                ['开机启动 / 应用锁', '需桌面端'],
              ].map(([name, why]) => (
                <div key={name} className="set-row disabled">
                  <div className="set-label">{name}</div>
                  <div className="set-control"><span className="set-badge">{why} · 开发中</span></div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
