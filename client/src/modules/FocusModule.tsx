import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { hm } from '../calendarUtil';
import type { Task, FocusSession, FocusStats } from '../types';

const PRESETS = [25, 15, 45, 5];
const EMPTY_STATS: FocusStats = { todayCount: 0, todayDurationSec: 0, totalCount: 0, totalDurationSec: 0 };

function fmtClock(sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}
function fmtDur(sec: number): string {
  const m = Math.round(sec / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function FocusModule() {
  const [mode, setMode] = useState<'pomodoro' | 'countup'>('pomodoro');
  const [targetMin, setTargetMin] = useState(25);
  const [status, setStatus] = useState<'idle' | 'running' | 'paused'>('idle');
  const [taskId, setTaskId] = useState('');
  const [nowMs, setNowMs] = useState(Date.now());

  const [tasks, setTasks] = useState<Task[]>([]);
  const [sessions, setSessions] = useState<FocusSession[]>([]);
  const [stats, setStats] = useState<FocusStats>(EMPTY_STATS);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addMin, setAddMin] = useState('25');

  const accRef = useRef(0); // banked focused seconds (across pauses)
  const runStartRef = useRef<number | null>(null); // wall-clock ms when current run segment began
  const sessionStartRef = useRef<string | null>(null); // ISO of first "开始"
  const finalizingRef = useRef(false);

  const loadData = useCallback(async () => {
    try {
      const [ts, ss, st] = await Promise.all([api.getActiveTasks(), api.listFocusSessions(100), api.focusStats()]);
      setTasks(ts);
      setSessions(ss);
      setStats(st);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // tick while running (wall-clock based, drift-free)
  useEffect(() => {
    if (status !== 'running') return;
    const iv = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(iv);
  }, [status]);

  const elapsedSec = accRef.current + (status === 'running' && runStartRef.current ? (nowMs - runStartRef.current) / 1000 : 0);
  const targetSec = targetMin * 60;
  const displaySec = mode === 'pomodoro' ? Math.max(0, targetSec - elapsedSec) : elapsedSec;
  const progress = mode === 'pomodoro' ? Math.min(1, elapsedSec / targetSec) : 0;

  const resetTimer = useCallback(() => {
    accRef.current = 0;
    runStartRef.current = null;
    sessionStartRef.current = null;
    finalizingRef.current = false;
    setStatus('idle');
  }, []);

  const saveSession = useCallback(
    async (s: { mode: 'pomodoro' | 'countup'; durationSec: number; isPomodoro: boolean; startedAt: string; endedAt: string }) => {
      try {
        await api.createFocusSession({ ...s, taskId: taskId || null });
        await loadData();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [taskId, loadData],
  );

  const finishPomodoro = useCallback(() => {
    if (finalizingRef.current) return;
    finalizingRef.current = true;
    const startedAt = sessionStartRef.current ?? new Date(Date.now() - targetSec * 1000).toISOString();
    const endedAt = new Date().toISOString();
    resetTimer();
    void saveSession({ mode: 'pomodoro', durationSec: targetSec, isPomodoro: true, startedAt, endedAt });
  }, [targetSec, resetTimer, saveSession]);

  // auto-complete a pomodoro when the countdown reaches zero
  useEffect(() => {
    if (status === 'running' && mode === 'pomodoro' && elapsedSec >= targetSec) finishPomodoro();
  }, [nowMs, status, mode, elapsedSec, targetSec, finishPomodoro]);

  function start() {
    if (status === 'idle') {
      accRef.current = 0;
      sessionStartRef.current = new Date().toISOString();
      finalizingRef.current = false;
    }
    runStartRef.current = Date.now();
    setStatus('running');
    setNowMs(Date.now());
  }
  function pause() {
    if (runStartRef.current) accRef.current += (Date.now() - runStartRef.current) / 1000;
    runStartRef.current = null;
    setStatus('paused');
  }
  function stop() {
    if (mode === 'countup') {
      const total = accRef.current + (runStartRef.current ? (Date.now() - runStartRef.current) / 1000 : 0);
      const startedAt = sessionStartRef.current ?? new Date(Date.now() - total * 1000).toISOString();
      const endedAt = new Date().toISOString();
      resetTimer();
      if (Math.round(total) >= 1) {
        void saveSession({ mode: 'countup', durationSec: Math.round(total), isPomodoro: false, startedAt, endedAt });
      }
    } else if (window.confirm('放弃这个番茄？本次专注不会被记录。')) {
      resetTimer();
    }
  }

  async function manualAdd() {
    const min = Math.round(Number(addMin));
    if (!Number.isFinite(min) || min <= 0) return;
    const endedAt = new Date().toISOString();
    const startedAt = new Date(Date.now() - min * 60000).toISOString();
    await saveSession({ mode: 'pomodoro', durationSec: min * 60, isPomodoro: true, startedAt, endedAt });
    setShowAdd(false);
    setAddMin('25');
  }

  async function removeSession(id: string) {
    try {
      await api.deleteFocusSession(id);
      await loadData();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const groups = useMemo(() => {
    const out: { label: string; items: FocusSession[] }[] = [];
    const map = new Map<string, FocusSession[]>();
    for (const s of sessions) {
      const d = new Date(s.endedAt);
      const label = `${d.getMonth() + 1}月${d.getDate()}日`;
      if (!map.has(label)) {
        const arr: FocusSession[] = [];
        map.set(label, arr);
        out.push({ label, items: arr });
      }
      map.get(label)!.push(s);
    }
    return out;
  }, [sessions]);

  return (
    <>
      <main className="focus-main">
        <div className="focus-modes">
          <button
            className={`focus-mode-btn${mode === 'pomodoro' ? ' active' : ''}`}
            disabled={status !== 'idle'}
            onClick={() => setMode('pomodoro')}
          >
            番茄计时
          </button>
          <button
            className={`focus-mode-btn${mode === 'countup' ? ' active' : ''}`}
            disabled={status !== 'idle'}
            onClick={() => setMode('countup')}
          >
            正计时
          </button>
        </div>

        <div className="focus-task">
          <span>专注 ·</span>
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)} disabled={status === 'running'}>
            <option value="">不关联任务</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </div>

        <div className="focus-dial" style={{ ['--p']: progress } as React.CSSProperties}>
          <div className="focus-dial-inner">
            <div className="focus-time">{fmtClock(displaySec)}</div>
            {mode === 'pomodoro' && status === 'idle' && (
              <div className="focus-presets">
                {PRESETS.map((m) => (
                  <button
                    key={m}
                    className={`focus-preset${targetMin === m ? ' active' : ''}`}
                    onClick={() => setTargetMin(m)}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="focus-controls">
          {status === 'idle' && (
            <button className="focus-start" onClick={start}>
              开始
            </button>
          )}
          {status === 'running' && (
            <button className="focus-start" onClick={pause}>
              暂停
            </button>
          )}
          {status === 'paused' && (
            <button className="focus-start" onClick={start}>
              继续
            </button>
          )}
          {status !== 'idle' && (
            <button className="focus-stop" onClick={stop}>
              停止
            </button>
          )}
        </div>

        {error && <div className="banner banner-error">⚠ {error}</div>}
      </main>

      <aside className="focus-side">
        <div className="focus-side-title">概览</div>
        <div className="focus-overview">
          <div className="ov-card">
            <div className="ov-label">今日番茄</div>
            <div className="ov-value">{stats.todayCount}</div>
          </div>
          <div className="ov-card">
            <div className="ov-label">今日专注</div>
            <div className="ov-value">{fmtDur(stats.todayDurationSec)}</div>
          </div>
          <div className="ov-card">
            <div className="ov-label">总番茄</div>
            <div className="ov-value">{stats.totalCount}</div>
          </div>
          <div className="ov-card">
            <div className="ov-label">总专注时长</div>
            <div className="ov-value">{fmtDur(stats.totalDurationSec)}</div>
          </div>
        </div>

        <div className="focus-records-head">
          <span>专注记录</span>
          <button className="rec-add-btn" title="手动补录" onClick={() => setShowAdd((v) => !v)}>
            ＋
          </button>
        </div>
        {showAdd && (
          <div className="rec-add-form">
            <input type="number" min="1" value={addMin} onChange={(e) => setAddMin(e.target.value)} />
            <span>分钟</span>
            <button onClick={() => void manualAdd()}>添加</button>
          </div>
        )}

        <div className="focus-records">
          {groups.length === 0 && <div className="rec-empty">还没有专注记录</div>}
          {groups.map((g) => (
            <div key={g.label} className="rec-group">
              <div className="rec-date">{g.label}</div>
              {g.items.map((s) => (
                <div key={s.id} className="rec-item">
                  <span className="rec-icon">{s.isPomodoro ? '🍅' : '⏱'}</span>
                  <span className="rec-range">
                    {hm(s.startedAt)} - {hm(s.endedAt)}
                  </span>
                  {s.taskTitle && <span className="rec-task">{s.taskTitle}</span>}
                  <span className="rec-dur">{fmtDur(s.durationSec)}</span>
                  <button className="rec-del" title="删除" onClick={() => void removeSession(s.id)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
