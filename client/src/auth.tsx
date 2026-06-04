import { createContext, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { api } from './api/client';
import { getDeviceId, trackEvent } from './analytics';
import { resolveLogoutFlow } from './logoutFlow';
import type { AuthSession, User } from './types';

interface AuthCtx {
  user: User;
  session: AuthSession;
  logout: (opts?: { confirm?: boolean }) => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('Auth context is not ready');
  return ctx;
}

function devicePayload() {
  return {
    deviceId: getDeviceId(),
    deviceName: navigator.userAgent.includes('Windows') ? 'Windows PC' : 'Web browser',
    platform: 'Web',
    appVersion: '0.6.0',
  };
}

function LoginScreen({ onAuthed }: { onAuthed: (s: { user: User; session: AuthSession }) => void }) {
  const [identifier, setIdentifier] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [masked, setMasked] = useState('');
  const [code, setCode] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isRiskRestricted = error?.includes('账号验证受限') ?? false;

  useEffect(() => {
    trackEvent('auth_page_view', { entry: 'app_start', platform: 'web', is_offline: !navigator.onLine });
  }, []);

  async function requestCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.requestVerificationCode({ type: 'email', identifier: identifier.trim(), purpose: 'login' });
      setChallengeId(r.challengeId);
      setMasked(r.maskedIdentifier);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function login(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.loginWithCode({
        challengeId,
        code: code.trim(),
        agreedToTerms: agreed,
        device: devicePayload(),
      });
      onAuthed({ user: r.user, session: r.session });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-ambient">
        <div className="auth-ambient-brand">效率清单</div>
        <p>把今天整理清楚，再开始行动。</p>
      </div>
      <section className="auth-panel">
        <div className="auth-kicker">邮箱验证码</div>
        <div className="auth-brand">效率清单</div>
        <h1>{challengeId ? '输入验证码' : '登录 / 注册'}</h1>
        <p>{challengeId ? `验证码已发送至 ${masked}` : '使用邮箱接收验证码，首次登录会自动创建账号。'}</p>

        {!challengeId ? (
          <form onSubmit={requestCode} className="auth-form">
            <label>
              邮箱地址
              <input
                autoFocus
                type="email"
                autoComplete="email"
                value={identifier}
                placeholder="name@example.com"
                onChange={(e) => setIdentifier(e.target.value)}
                disabled={busy}
              />
            </label>
            <button className="btn-primary" disabled={busy || !identifier.trim()}>
              {busy ? '发送中...' : '获取邮箱验证码'}
            </button>
          </form>
        ) : (
          <form onSubmit={login} className="auth-form">
            <label>
              验证码
              <input
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                placeholder="6 位验证码"
                onChange={(e) => setCode(e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="auth-check">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => {
                  setAgreed(e.target.checked);
                  trackEvent('auth_agreement_check', { checked: e.target.checked, entry: 'code_login' });
                }}
              />
              我已阅读并同意用户协议与隐私政策
            </label>
            <button className="btn-primary" disabled={busy || code.trim().length < 6 || !agreed}>
              {busy ? '登录中...' : '登录 / 注册'}
            </button>
            <button type="button" className="auth-link" onClick={() => setChallengeId('')} disabled={busy}>
              更换邮箱
            </button>
          </form>
        )}

        {error && (
          <div className="banner banner-error">
            {error}
            {isRiskRestricted && (
              <div className="auth-muted">
                <a className="auth-link" href="mailto:support@example.com">联系客服</a>
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

function AccountDeletingScreen({
  user,
  onCancelled,
  onLogout,
}: {
  user: User;
  onCancelled: (user: User) => void;
  onLogout: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancelDeletion() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.cancelAccountDeletion();
      trackEvent('auth_delete_account_cancel', { entry: 'account_deleting_screen', success: true });
      onCancelled(result);
    } catch (err) {
      const message = (err as Error).message;
      trackEvent('auth_delete_account_cancel', { entry: 'account_deleting_screen', success: false, fail_reason: message });
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="auth-brand">效率清单</div>
        <h1>账号注销中</h1>
        <p>
          当前账号已进入注销冷静期，主功能暂不可使用。冷静期结束后会删除账号业务数据；撤销注销后可继续使用原账号数据。
        </p>
        <div className="auth-muted">
          {user.deleteScheduledAt ? `预计删除时间：${new Date(user.deleteScheduledAt).toLocaleString()}` : '删除时间待确认'}
        </div>
        <div className="auth-form">
          <button className="btn-primary" type="button" onClick={() => void cancelDeletion()} disabled={busy}>
            {busy ? '撤销中...' : '撤销注销'}
          </button>
          <button type="button" className="auth-link" onClick={() => void onLogout()} disabled={busy}>
            退出登录
          </button>
        </div>
        {error && <div className="banner banner-error">{error}</div>}
      </section>
    </main>
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ user: User; session: AuthSession } | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    async function loadSession() {
      try {
        const session = await api.getSession();
        if (active) setState(session);
      } catch {
        try {
          const refreshed = await api.refreshSession();
          if (active) setState(refreshed);
        } catch {
          if (active) setState(null);
        }
      } finally {
        if (active) setLoaded(true);
      }
    }
    void loadSession();
    return () => {
      active = false;
    };
  }, []);

  const value = useMemo<AuthCtx | null>(() => {
    if (!state) return null;
    return {
      user: state.user,
      session: state.session,
      logout: async (opts?: { confirm?: boolean }) => {
        const logoutFlow = await resolveLogoutFlow(state.user.id, { confirmRequired: opts?.confirm !== false });
        trackEvent('auth_logout_click', {
          has_unsynced_data: logoutFlow.pendingBefore > 0,
          pending_sync_count: logoutFlow.pendingBefore,
          pending_sync_remaining: logoutFlow.pendingAfter,
          logout_choice: logoutFlow.action,
          success: logoutFlow.shouldLogout,
          fail_reason: logoutFlow.error ?? null,
        });
        if (!logoutFlow.shouldLogout) return;
        await api.logout();
        trackEvent('account_logout_success', {
          device: 'web',
          had_unsynced_data: logoutFlow.pendingBefore > 0,
          pending_sync_remaining: logoutFlow.pendingAfter,
        });
        setState(null);
      },
    };
  }, [state]);

  if (!loaded) {
    return (
      <main className="auth-page">
        <div className="auth-loading">加载登录状态...</div>
      </main>
    );
  }
  if (!state || !value) return <LoginScreen onAuthed={setState} />;
  if (state.user.status === 'deleting') {
    return (
      <AccountDeletingScreen
        user={state.user}
        onCancelled={(user) => setState({ user, session: state.session })}
        onLogout={() => value.logout({ confirm: false })}
      />
    );
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
