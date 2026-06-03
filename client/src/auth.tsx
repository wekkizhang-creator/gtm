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
const LOGIN_METHOD_KEY = 'efficiency-list.lastLoginMethod';

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

function defaultRedirectUri() {
  return `${window.location.origin}/oauth/callback`;
}

function LoginScreen({ onAuthed }: { onAuthed: (s: { user: User; session: AuthSession }) => void }) {
  const [loginType, setLoginType] = useState<'email' | 'phone'>(() => {
    const saved = localStorage.getItem(LOGIN_METHOD_KEY);
    return saved === 'phone' ? 'phone' : 'email';
  });
  const [identifier, setIdentifier] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [masked, setMasked] = useState('');
  const [code, setCode] = useState('');
  const [oauthProvider, setOauthProvider] = useState('test');
  const [oauthToken, setOauthToken] = useState('');
  const [oauthRedirectUri, setOauthRedirectUri] = useState(defaultRedirectUri);
  const [oauthAuthorizationUrl, setOauthAuthorizationUrl] = useState('');
  const [oauthState, setOauthState] = useState('');
  const [oauthCode, setOauthCode] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isRiskRestricted = error?.includes('账号验证受限') ?? false;

  useEffect(() => {
    trackEvent('auth_page_view', { entry: 'app_start', platform: 'web', is_offline: !navigator.onLine });
    const params = new URLSearchParams(window.location.search);
    const state = params.get('state');
    const authCode = params.get('code');
    if (state) setOauthState(state);
    if (authCode) setOauthCode(authCode);
  }, []);

  function selectLoginType(type: 'email' | 'phone') {
    setLoginType(type);
    localStorage.setItem(LOGIN_METHOD_KEY, type);
    trackEvent('auth_method_select', { method: type, entry: 'login_page' });
  }

  async function requestCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.requestVerificationCode({ type: loginType, identifier: identifier.trim(), purpose: 'login' });
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
      localStorage.setItem(LOGIN_METHOD_KEY, loginType);
      onAuthed({ user: r.user, session: r.session });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function startOAuthAuthorization() {
    setBusy(true);
    setError(null);
    trackEvent('auth_third_party_start', { provider: oauthProvider.trim(), entry: 'login_page', flow: 'authorization_code' });
    try {
      const r = await api.startOAuthAuthorization(oauthProvider.trim(), { redirectUri: oauthRedirectUri.trim() });
      setOauthAuthorizationUrl(r.authorizationUrl);
      setOauthState(r.state);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function completeOAuthLogin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.completeOAuthLogin(oauthProvider.trim(), {
        state: oauthState.trim(),
        code: oauthCode.trim(),
        redirectUri: oauthRedirectUri.trim(),
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

  async function oauthTokenLogin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    trackEvent('auth_third_party_start', { provider: oauthProvider.trim(), entry: 'login_page', flow: 'access_token' });
    try {
      const r = await api.loginWithOAuth(oauthProvider.trim(), {
        accessToken: oauthToken.trim(),
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
      <section className="auth-panel">
        <div className="auth-brand">效率清单</div>
        <h1>登录后继续</h1>
        <p>使用邮箱或手机号验证码登录。第三方账号走真实 OAuth 授权码回调，未配置服务商时后端会返回 501。</p>

        {!challengeId ? (
          <form onSubmit={requestCode} className="auth-form">
            <label>
              {loginType === 'email' ? '邮箱' : '手机号'}
              <input
                autoFocus
                type={loginType === 'email' ? 'email' : 'tel'}
                value={identifier}
                placeholder={loginType === 'email' ? 'name@example.com' : '+8613800000000'}
                onChange={(e) => setIdentifier(e.target.value)}
                disabled={busy}
              />
            </label>
            <div className="auth-type">
              <button type="button" className={loginType === 'email' ? 'active' : ''} onClick={() => selectLoginType('email')}>
                邮箱
              </button>
              <button type="button" className={loginType === 'phone' ? 'active' : ''} onClick={() => selectLoginType('phone')}>
                手机
              </button>
            </div>
            <button className="btn-primary" disabled={busy || !identifier.trim()}>
              {busy ? '发送中...' : '发送验证码'}
            </button>
          </form>
        ) : (
          <form onSubmit={login} className="auth-form">
            <div className="auth-muted">验证码已发送至 {masked}</div>
            <label>
              验证码
              <input
                autoFocus
                inputMode="numeric"
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
            <button className="btn-primary" disabled={busy || code.trim().length < 6}>
              {busy ? '登录中...' : '登录 / 注册'}
            </button>
            <button type="button" className="auth-link" onClick={() => setChallengeId('')} disabled={busy}>
              换一个账号
            </button>
          </form>
        )}

        <form onSubmit={completeOAuthLogin} className="auth-form auth-oauth">
          <div className="auth-muted">第三方账号</div>
          <input value={oauthProvider} placeholder="provider" onChange={(e) => setOauthProvider(e.target.value)} disabled={busy} />
          <label>
            回调地址
            <input value={oauthRedirectUri} onChange={(e) => setOauthRedirectUri(e.target.value)} disabled={busy} />
          </label>
          <button type="button" className="btn-primary" disabled={busy || !oauthProvider.trim() || !oauthRedirectUri.trim()} onClick={() => void startOAuthAuthorization()}>
            生成授权链接
          </button>
          {oauthAuthorizationUrl && (
            <a className="auth-link" href={oauthAuthorizationUrl}>
              打开授权页
            </a>
          )}
          <label>
            state
            <input value={oauthState} onChange={(e) => setOauthState(e.target.value)} disabled={busy} />
          </label>
          <label>
            code
            <input value={oauthCode} onChange={(e) => setOauthCode(e.target.value)} disabled={busy} />
          </label>
          <label className="auth-check">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => {
                setAgreed(e.target.checked);
                trackEvent('auth_agreement_check', { checked: e.target.checked, entry: 'oauth_login' });
              }}
            />
            我已阅读并同意用户协议与隐私政策
          </label>
          <button className="btn-primary" disabled={busy || !oauthProvider.trim() || !oauthState.trim() || !oauthCode.trim()}>
            完成第三方登录
          </button>
        </form>

        <form onSubmit={oauthTokenLogin} className="auth-form auth-oauth">
          <div className="auth-muted">Access Token 登录</div>
          <input value={oauthProvider} placeholder="provider" onChange={(e) => setOauthProvider(e.target.value)} disabled={busy} />
          <input type="password" value={oauthToken} placeholder="access token" onChange={(e) => setOauthToken(e.target.value)} disabled={busy} />
          <button className="btn-primary" disabled={busy || !oauthProvider.trim() || !oauthToken.trim()}>
            使用访问令牌登录
          </button>
        </form>

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
