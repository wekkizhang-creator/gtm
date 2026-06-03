import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { aiConfigurationIssue } from '../aiGuide';
import { hm, localDateLabel } from '../calendarUtil';
import { FocusBackgroundAudioController, shouldPlayFocusBackgroundAudio } from '../focusBackgroundAudio';
import { confirmFocusStop, confirmImmersiveExit, enterImmersiveFocus, exitImmersiveFocus } from '../focusImmersive';
import { nextFocusRestPlan, type FocusRestPlan } from '../focusRestCycle';
import { ensureNotificationPermission } from '../notificationPermission';
import { useSettings } from '../settings';
import type { Task, FocusSession, FocusStats, BackgroundSound, FocusAchievement, FocusReport, AIReviewResult } from '../types';

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
  const { settings, loaded: settingsLoaded } = useSettings();
  const [mode, setMode] = useState<'pomodoro' | 'countup'>('pomodoro');
  const [targetMin, setTargetMin] = useState(25);
  const [status, setStatus] = useState<'idle' | 'running' | 'paused' | 'resting'>('idle');
  const [taskId, setTaskId] = useState('');
  const [nowMs, setNowMs] = useState(Date.now());

  const [tasks, setTasks] = useState<Task[]>([]);
  const [sessions, setSessions] = useState<FocusSession[]>([]);
  const [stats, setStats] = useState<FocusStats>(EMPTY_STATS);
  const [sounds, setSounds] = useState<BackgroundSound[]>([]);
  const [soundId, setSoundId] = useState('');
  const [soundVolume, setSoundVolume] = useState(50);
  const [achievements, setAchievements] = useState<FocusAchievement[]>([]);
  const [report, setReport] = useState<FocusReport | null>(null);
  const [review, setReview] = useState<AIReviewResult | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restCycleMessage, setRestCycleMessage] = useState<string | null>(null);
  const [currentRestPlan, setCurrentRestPlan] = useState<FocusRestPlan | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addMin, setAddMin] = useState('25');
  const [immersive, setImmersive] = useState(false);

  const focusShellRef = useRef<HTMLElement | null>(null);
  const accRef = useRef(0); // banked focused seconds (across pauses)
  const runStartRef = useRef<number | null>(null); // wall-clock ms when current run segment began
  const sessionStartRef = useRef<string | null>(null); // ISO of first "开始"
  const finalizingRef = useRef(false);
  const restFinalizingRef = useRef(false);
  const completedFocusSessionIdRef = useRef<string | null>(null);
  const completedPomodorosRef = useRef(0);
  const restStartRef = useRef<string | null>(null);
  const restStartedAtMsRef = useRef<number | null>(null);
  const backgroundAudioRef = useRef<FocusBackgroundAudioController | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [ts, ss, st, soundList, achievementList, weeklyReport] = await Promise.all([
        api.getActiveTasks(),
        api.listFocusSessions(100),
        api.focusStats(),
        api.listFocusSounds(),
        api.focusAchievements(),
        api.focusReport('week'),
      ]);
      setTasks(ts);
      setSessions(ss);
      setStats(st);
      completedPomodorosRef.current = st.totalCount;
      setSounds(soundList);
      setAchievements(achievementList);
      setReport(weeklyReport);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const controller = new FocusBackgroundAudioController();
    backgroundAudioRef.current = controller;
    return () => {
      controller.dispose();
      backgroundAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => setImmersive(document.fullscreenElement === focusShellRef.current);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!settingsLoaded || status !== 'idle') return;
    setTargetMin(settings.focus.defaultMinutes);
    setSoundId(settings.focus.soundId ?? '');
    setSoundVolume(settings.focus.defaultVolume);
  }, [settingsLoaded, settings.focus.defaultMinutes, settings.focus.soundId, settings.focus.defaultVolume, status]);

  // tick while running (wall-clock based, drift-free)
  useEffect(() => {
    if (status !== 'running' && status !== 'resting') return;
    const iv = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(iv);
  }, [status]);

  const elapsedSec = accRef.current + (status === 'running' && runStartRef.current ? (nowMs - runStartRef.current) / 1000 : 0);
  const targetSec = targetMin * 60;
  const restTargetSec = Math.max(1, (currentRestPlan?.minutes ?? settings.focus.restMinutes) * 60);
  const restElapsedSec = status === 'resting' && restStartedAtMsRef.current ? (nowMs - restStartedAtMsRef.current) / 1000 : 0;
  const displaySec = status === 'resting' ? Math.max(0, restTargetSec - restElapsedSec) : mode === 'pomodoro' ? Math.max(0, targetSec - elapsedSec) : elapsedSec;
  const progress = status === 'resting' ? Math.min(1, restElapsedSec / restTargetSec) : mode === 'pomodoro' ? Math.min(1, elapsedSec / targetSec) : 0;
  const selectedSound = useMemo(() => sounds.find((sound) => sound.id === soundId) ?? null, [sounds, soundId]);

  useEffect(() => {
    const controller = backgroundAudioRef.current;
    if (!controller) return;
    if (shouldPlayFocusBackgroundAudio(status, settings.focus, selectedSound)) {
      void controller.play(selectedSound!, soundVolume).then((result) => {
        if (!result.played && result.reason === 'play_failed') setError('背景音播放失败，已继续计时。');
      });
      return;
    }
    const fadeOut = settings.focus.fadeOutStop;
    if (status === 'idle') controller.stop({ fadeOut });
    else controller.pause({ fadeOut });
  }, [
    selectedSound,
    settings.focus.backgroundAudioAllowed,
    settings.focus.fadeOutStop,
    settings.focus.pauseSoundOnPause,
    settings.focus.playSoundDuringRest,
    soundVolume,
    status,
  ]);

  const resetTimer = useCallback(() => {
    accRef.current = 0;
    runStartRef.current = null;
    sessionStartRef.current = null;
    finalizingRef.current = false;
    restFinalizingRef.current = false;
    completedFocusSessionIdRef.current = null;
    setCurrentRestPlan(null);
    restStartRef.current = null;
    restStartedAtMsRef.current = null;
    setStatus('idle');
  }, []);

  const saveSession = useCallback(
    async (s: { mode: 'pomodoro' | 'countup'; durationSec: number; isPomodoro: boolean; startedAt: string; endedAt: string }) => {
      try {
        const session = await api.createFocusSession({
          ...s,
          taskId: taskId || null,
          backgroundSoundId: soundId || null,
          backgroundVolume: soundId ? soundVolume : null,
          soundPlayedDuration: soundId && settings.focus.backgroundAudioAllowed && soundVolume > 0 ? Math.round(s.durationSec) : null,
          isMuted: !!soundId && (!settings.focus.backgroundAudioAllowed || soundVolume === 0),
        });
        await loadData();
        return session;
      } catch (e) {
        setError((e as Error).message);
        return null;
      }
    },
    [taskId, soundId, soundVolume, settings.focus.backgroundAudioAllowed, loadData],
  );

  const startRest = useCallback((focusSessionId: string, restStartedAt: string, plan: FocusRestPlan) => {
    completedFocusSessionIdRef.current = focusSessionId;
    restStartRef.current = restStartedAt;
    restStartedAtMsRef.current = Date.now();
    setCurrentRestPlan(plan);
    runStartRef.current = null;
    sessionStartRef.current = null;
    accRef.current = 0;
    restFinalizingRef.current = false;
    setRestCycleMessage(`${plan.isLongRest ? '已进入长休息' : '已进入休息'} ${plan.minutes} 分钟，结束后自动开始下一轮。`);
    setStatus('resting');
    setNowMs(Date.now());
  }, []);

  const finishPomodoro = useCallback(() => {
    if (finalizingRef.current) return;
    finalizingRef.current = true;
    const startedAt = sessionStartRef.current ?? new Date(Date.now() - targetSec * 1000).toISOString();
    const endedAt = new Date().toISOString();
    void (async () => {
      const session = await saveSession({ mode: 'pomodoro', durationSec: targetSec, isPomodoro: true, startedAt, endedAt });
      if (session && settings.focus.restMinutes > 0) {
        const plan = nextFocusRestPlan(settings.focus, completedPomodorosRef.current);
        completedPomodorosRef.current = plan.completedPomodoros;
        startRest(session.id, endedAt, plan);
      } else {
        resetTimer();
      }
    })();
  }, [targetSec, resetTimer, saveSession, settings.focus, startRest]);

  const finishRestCycle = useCallback(
    (autoStartNext: boolean) => {
      if (restFinalizingRef.current) return;
      restFinalizingRef.current = true;
      const focusSessionId = completedFocusSessionIdRef.current;
      const restStartedAt = restStartRef.current ?? new Date(Date.now() - restTargetSec * 1000).toISOString();
      const restEndedAt = new Date().toISOString();
      const durationSec = Math.max(1, Math.round(restElapsedSec || restTargetSec));
      void (async () => {
        try {
          if (focusSessionId) {
            await api.createFocusRestCycle({
              focusSessionId,
              restStartedAt,
              restEndedAt,
              restDurationSec: durationSec,
              nextFocusStartedAt: autoStartNext ? restEndedAt : null,
            });
            await loadData();
          }
          completedFocusSessionIdRef.current = null;
          setCurrentRestPlan(null);
          restStartRef.current = null;
          restStartedAtMsRef.current = null;
          if (autoStartNext) {
            accRef.current = 0;
            runStartRef.current = Date.now();
            sessionStartRef.current = restEndedAt;
            finalizingRef.current = false;
            restFinalizingRef.current = false;
            setRestCycleMessage('休息结束，已自动开始下一轮番茄。');
            setStatus('running');
            setNowMs(Date.now());
          } else {
            setRestCycleMessage('休息已结束。');
            resetTimer();
          }
        } catch (e) {
          restFinalizingRef.current = false;
          setError((e as Error).message);
        }
      })();
    },
    [loadData, resetTimer, restElapsedSec, restTargetSec],
  );

  // auto-complete a pomodoro when the countdown reaches zero
  useEffect(() => {
    if (status === 'running' && mode === 'pomodoro' && elapsedSec >= targetSec) finishPomodoro();
  }, [nowMs, status, mode, elapsedSec, targetSec, finishPomodoro]);

  useEffect(() => {
    if (status === 'resting' && restElapsedSec >= restTargetSec) finishRestCycle(true);
  }, [nowMs, status, restElapsedSec, restTargetSec, finishRestCycle]);

  function start() {
    if (status === 'idle') {
      if (mode === 'pomodoro') void ensureNotificationPermission('focus_reminder').catch((err) => setError((err as Error).message));
      accRef.current = 0;
      sessionStartRef.current = new Date().toISOString();
      finalizingRef.current = false;
      setRestCycleMessage(null);
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
  async function enterImmersive() {
    const target = focusShellRef.current;
    if (!target) return;
    setError(null);
    try {
      await enterImmersiveFocus(target);
      setImmersive(true);
    } catch (e) {
      setError((e as Error).message === 'fullscreen_not_supported' ? '当前浏览器不支持全屏沉浸模式。' : (e as Error).message);
    }
  }
  async function exitImmersive() {
    if (!confirmImmersiveExit(status, window.confirm)) return;
    setError(null);
    try {
      await exitImmersiveFocus(document);
      setImmersive(false);
    } catch (e) {
      setError((e as Error).message === 'fullscreen_not_supported' ? '当前浏览器不支持退出全屏。' : (e as Error).message);
    }
  }
  function stop() {
    if (status === 'resting') {
      if (confirmFocusStop({ mode, status, immersive }, window.confirm)) finishRestCycle(false);
      return;
    }
    if (mode === 'countup') {
      if (!confirmFocusStop({ mode, status, immersive }, window.confirm)) return;
      const total = accRef.current + (runStartRef.current ? (Date.now() - runStartRef.current) / 1000 : 0);
      const startedAt = sessionStartRef.current ?? new Date(Date.now() - total * 1000).toISOString();
      const endedAt = new Date().toISOString();
      resetTimer();
      if (Math.round(total) >= 1) {
        void saveSession({ mode: 'countup', durationSec: Math.round(total), isPomodoro: false, startedAt, endedAt });
      }
    } else if (confirmFocusStop({ mode, status, immersive }, window.confirm)) {
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

  async function generateReview() {
    const issue = aiConfigurationIssue(settings.ai, 'AI 复盘');
    if (issue) {
      setError(issue);
      return;
    }
    setReviewBusy(true);
    try {
      const result = await api.aiWeeklyReview();
      setReview(result);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReviewBusy(false);
    }
  }

  const groups = useMemo(() => {
    const out: { label: string; items: FocusSession[] }[] = [];
    const map = new Map<string, FocusSession[]>();
    for (const s of sessions) {
      const d = new Date(s.endedAt);
      const label = localDateLabel(d, { month: 'short', day: 'numeric' });
      if (!map.has(label)) {
        const arr: FocusSession[] = [];
        map.set(label, arr);
        out.push({ label, items: arr });
      }
      map.get(label)!.push(s);
    }
    return out;
  }, [sessions]);

  function renderReportDimension(label: string, items: FocusReport['byTask']) {
    return (
      <div className="focus-report-dimension">
        <div className="focus-report-dimension-title">{label}</div>
        {items.length === 0 && <div className="rec-empty">暂无维度数据</div>}
        {items.slice(0, 5).map((item) => (
          <div key={`${label}-${item.id ?? item.name}`} className="focus-report-row focus-report-dimension-row">
            <span>{item.name}</span>
            <span>{item.count} 次</span>
            <strong>{fmtDur(item.durationSec)}</strong>
          </div>
        ))}
      </div>
    );
  }

  return (
    <section ref={focusShellRef} className={`focus-shell${immersive ? ' immersive' : ''}`}>
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
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)} disabled={status !== 'idle'}>
            <option value="">不关联任务</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </div>

        <div className="focus-task">
          <span>背景音 ·</span>
          <select value={soundId} onChange={(e) => setSoundId(e.target.value)} disabled={status !== 'idle'}>
            <option value="">不使用背景音</option>
            {sounds.map((sound) => (
              <option key={sound.id} value={sound.id}>
                {sound.name}
                {sound.cacheStatus === 'cached' ? '（已缓存）' : ''}
              </option>
            ))}
          </select>
          {soundId && (
            <>
              <input
                className="sound-volume"
                type="range"
                min={0}
                max={100}
                value={soundVolume}
                onChange={(e) => setSoundVolume(Number(e.target.value))}
                disabled={status !== 'idle'}
              />
              <span className="sound-volume-label">{soundVolume}%</span>
              <button className="sound-cache-btn" onClick={() => void api.cacheFocusSound(soundId).then(loadData)}>
                缓存
              </button>
            </>
          )}
        </div>

        <div className="focus-dial" style={{ ['--p']: progress } as React.CSSProperties}>
          <div className="focus-dial-inner">
            <div className="focus-time">{fmtClock(displaySec)}</div>
            {status === 'resting' && <div className="focus-phase">休息中</div>}
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
          {status === 'resting' && <span className="focus-rest-hint">休息结束后自动开始下一轮</span>}
          <button className="focus-immersive-btn" onClick={() => void (immersive ? exitImmersive() : enterImmersive())}>
            {immersive ? '退出沉浸' : '沉浸'}
          </button>
          {status !== 'idle' && (
            <button className="focus-stop" onClick={stop}>
              {status === 'resting' ? '结束休息' : '停止'}
            </button>
          )}
        </div>

        {error && <div className="banner banner-error">⚠ {error}</div>}
        {restCycleMessage && <div className="banner">{restCycleMessage}</div>}
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

        {achievements.length > 0 && (
          <div className="focus-achievements">
            <div className="focus-records-head">
              <span>专注成就</span>
              <strong>{achievements.filter((item) => item.achieved).length}/{achievements.length}</strong>
            </div>
            <div className="focus-achievement-grid">
              {achievements.map((achievement) => {
                const pct = achievement.target ? Math.min(100, Math.round((achievement.progress / achievement.target) * 100)) : 0;
                return (
                  <div key={achievement.id} className={`focus-achievement${achievement.achieved ? ' achieved' : ''}`}>
                    <div>
                      <strong>{achievement.title}</strong>
                      <span>{achievement.description}</span>
                    </div>
                    <div className="focus-achievement-progress">
                      <span>{achievement.achieved ? '已达成' : `${achievement.progress}/${achievement.target}`}</span>
                      <div><i style={{ width: `${pct}%` }} /></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {report && (
          <div className="focus-report">
            <div className="focus-records-head">
              <span>近 7 天报告</span>
              <strong>{fmtDur(report.totalDurationSec)}</strong>
            </div>
            {report.buckets.map((bucket) => (
              <div key={bucket.label} className="focus-report-row">
                <span>{bucket.label}</span>
                <span>{bucket.count} 次</span>
                <strong>{fmtDur(bucket.durationSec)}</strong>
              </div>
            ))}
            {report.buckets.length === 0 && <div className="rec-empty">暂无报告数据</div>}
            <div className="focus-report-dimensions">
              {renderReportDimension('按任务', report.byTask)}
              {renderReportDimension('按清单', report.byList)}
              {renderReportDimension('按标签', report.byTag)}
            </div>
          </div>
        )}

        <div className="focus-report ai-review">
          <div className="focus-records-head">
            <span>AI 复盘</span>
            <button className="rec-add-btn" onClick={() => void generateReview()} disabled={reviewBusy}>
              {reviewBusy ? '生成中...' : '生成'}
            </button>
          </div>
          {review ? (
            <div className="ai-review-body">
              <p>{review.summary}</p>
              <div className="ai-review-metrics">
                <span>完成 {review.metrics.completedTasks}</span>
                <span>逾期 {review.metrics.openOverdueTasks}</span>
                <span>专注 {review.metrics.focusMinutes}m</span>
                <span>打卡 {review.metrics.habitCheckins}</span>
              </div>
              {review.wins.length > 0 && (
                <ul>
                  {review.wins.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
              {review.risks.length > 0 && (
                <ul>
                  {review.risks.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
              {review.nextActions.length > 0 && (
                <div className="ai-next-actions">
                  {review.nextActions.map((item) => (
                    <div key={item.title}>
                      <strong>{item.title}</strong>
                      {item.reason && <span>{item.reason}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="rec-empty">使用已配置的 AI 服务生成本周任务、专注、习惯和目标复盘。</div>
          )}
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
    </section>
  );
}
