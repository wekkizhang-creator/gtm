import { createContext, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { api } from './api/client';
import { getDeviceId, trackEvent } from './analytics';
import { authAgreementCheckProperties, authAgreementClickProperties } from './authAgreementAnalytics';
import { authDeleteAccountCancelProperties } from './authDeletionAnalytics';
import { authMethodSelectProperties, type AuthMethodSelectEntry } from './authMethodAnalytics';
import { resolveLogoutFlow } from './logoutFlow';
import { describeAuthError, passwordScore } from './authMessages';
import { authOfflineNotice, browserOnlineStatus } from './authNetworkState';
import { validateEmailInput } from './emailAuthValidation';
import { LEGAL_DOC_LINKS } from './legalDocs';
import { readLoginMemory, rememberEmailLogin, type LoginMemory } from './loginMemory';
import { SESSION_EXPIRED_EVENT, sessionExpiredMessage, type SessionExpiredEventDetail } from './sessionExpiry';
import type { AuthSession, User } from './types';

interface AuthCtx {
  user: User;
  session: AuthSession;
  updateUser: (user: User) => void;
  logout: (opts?: { confirm?: boolean }) => Promise<void>;
}

type AuthMode = 'login' | 'register' | 'reset';

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

function PasswordField({
  label,
  value,
  placeholder,
  autoComplete,
  onChange,
  disabled,
  autoFocus,
}: {
  label: string;
  value: string;
  placeholder: string;
  autoComplete: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <label>
      {label}
      <div className="auth-input-wrap">
        <input
          type={show ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          autoFocus={autoFocus}
        />
        <button
          type="button"
          className="auth-eye"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? '隐藏密码' : '显示密码'}
          tabIndex={-1}
        >
          {show ? '隐藏' : '显示'}
        </button>
      </div>
    </label>
  );
}

function PasswordAuthScreen({
  onAuthed,
  notice,
}: {
  onAuthed: (s: { user: User; session: AuthSession }) => void;
  notice?: string | null;
}) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [loginMemory, setLoginMemory] = useState<LoginMemory>(readLoginMemory);
  const [challengeId, setChallengeId] = useState('');
  const [masked, setMasked] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(browserOnlineStatus);
  const isRiskRestricted = error?.includes('账号验证受限') ?? false;
  const waitingForCode = mode !== 'login' && !!challengeId;
  const strength = passwordScore(password);

  useEffect(() => {
    trackEvent('auth_page_view', { entry: 'app_start', platform: 'web', is_offline: !navigator.onLine });
  }, []);

  useEffect(() => {
    function updateOnlineStatus() {
      setOnline(browserOnlineStatus());
    }
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    return () => {
      window.removeEventListener('online', updateOnlineStatus);
      window.removeEventListener('offline', updateOnlineStatus);
    };
  }, []);

  // Tick the resend cooldown down to zero. The boolean dependency keeps a single
  // stable interval running until it reaches zero, then clears it.
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setInterval(() => setResendIn((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(timer);
  }, [resendIn > 0]);

  function switchMode(next: AuthMode, analyticsEntry?: AuthMethodSelectEntry) {
    if (analyticsEntry && next !== mode) {
      trackEvent('auth_method_select', authMethodSelectProperties(analyticsEntry));
    }
    setMode(next);
    setChallengeId('');
    setMasked('');
    setCode('');
    setPassword('');
    setPasswordConfirm('');
    setAgreed(false);
    setResendIn(0);
    setError(null);
  }

  // Return to the email-entry step. Keeps the email so the user can edit it, but
  // clears the verification code and passwords (previously left stale).
  function resetCodeStep() {
    setChallengeId('');
    setCode('');
    setPassword('');
    setPasswordConfirm('');
    setAgreed(false);
    setResendIn(0);
    setError(null);
  }

  function validateNewPassword(): boolean {
    if (password.length < 8 || password.length > 128) {
      setError('密码需要 8 到 128 个字符');
      return false;
    }
    if (password !== passwordConfirm) {
      setError('两次输入的密码不一致');
      return false;
    }
    if (mode === 'register' && !agreed) {
      setError('请先同意用户协议与隐私政策');
      return false;
    }
    return true;
  }

  function requireValidEmail(): string | null {
    const result = validateEmailInput(email);
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    return result.email;
  }

  async function submitLogin(e: FormEvent) {
    e.preventDefault();
    const normalizedEmail = requireValidEmail();
    if (!normalizedEmail) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.loginWithPassword({
        email: normalizedEmail,
        password,
        device: devicePayload(),
      });
      setLoginMemory(rememberEmailLogin(normalizedEmail));
      onAuthed({ user: result.user, session: result.session });
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  async function startCodeFlow(e: FormEvent) {
    e.preventDefault();
    const normalizedEmail = requireValidEmail();
    if (!normalizedEmail) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'register'
          ? await api.startRegistration({ email: normalizedEmail, device: devicePayload() })
          : await api.startPasswordReset({ email: normalizedEmail, device: devicePayload() });
      setChallengeId(result.challengeId);
      setMasked(result.maskedIdentifier);
      setResendIn(result.resendAfterSec);
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  async function resendCode() {
    if (busy || resendIn > 0) return;
    const normalizedEmail = requireValidEmail();
    if (!normalizedEmail) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'register'
          ? await api.startRegistration({ email: normalizedEmail, device: devicePayload() })
          : await api.startPasswordReset({ email: normalizedEmail, device: devicePayload() });
      setChallengeId(result.challengeId);
      setMasked(result.maskedIdentifier);
      setResendIn(result.resendAfterSec);
      setCode('');
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  async function completeCodeFlow(e: FormEvent) {
    e.preventDefault();
    const normalizedEmail = requireValidEmail();
    if (!normalizedEmail) return;
    if (!validateNewPassword()) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'register'
          ? await api.completeRegistration({
              challengeId,
              code: code.trim(),
              password,
              agreedToTerms: agreed,
              device: devicePayload(),
            })
          : await api.completePasswordReset({
              challengeId,
              code: code.trim(),
              password,
              device: devicePayload(),
            });
      setLoginMemory(rememberEmailLogin(normalizedEmail));
      onAuthed({ user: result.user, session: result.session });
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  const title =
    mode === 'login' ? '邮箱密码登录' : mode === 'register' ? (waitingForCode ? '设置登录密码' : '邮箱注册') : waitingForCode ? '设置新密码' : '找回密码';
  const intro =
    mode === 'login'
      ? '使用邮箱和密码进入效率清单。'
      : waitingForCode
        ? `验证码已发送至 ${masked}`
        : mode === 'register'
          ? '先验证邮箱，再设置你的登录密码。'
          : '验证邮箱后即可重设密码。';
  const emailValidation = validateEmailInput(email);
  const emailFormatError = email.trim() && !emailValidation.ok ? emailValidation.error : null;
  const canUseEmail = emailValidation.ok;
  const offlineNotice = authOfflineNotice(online);

  return (
    <main className="auth-page">
      <div className="auth-ambient">
        <div className="auth-ambient-brand">效率清单</div>
        <p>把今天整理清楚，再开始行动。</p>
      </div>
      <section className="auth-panel">
        <div className="auth-kicker">邮箱账号</div>
        <div className="auth-brand">效率清单</div>
        <h1>{title}</h1>
        <p>{intro}</p>
        {notice && (
          <div className="banner" role="status">
            {notice}
          </div>
        )}
        {offlineNotice && (
          <div className="banner" role="status">
            {offlineNotice}
          </div>
        )}

        <div className="auth-tabs" role="tablist" aria-label="认证方式">
          <button className={mode === 'login' ? 'active' : ''} type="button" onClick={() => switchMode('login', 'login_tab')}>
            登录
          </button>
          <button className={mode === 'register' ? 'active' : ''} type="button" onClick={() => switchMode('register', 'register_tab')}>
            注册
          </button>
          <button className={mode === 'reset' ? 'active' : ''} type="button" onClick={() => switchMode('reset', 'password_reset_tab')}>
            忘记密码
          </button>
        </div>

        {mode === 'login' ? (
          <form onSubmit={submitLogin} className="auth-form">
            <label>
              邮箱地址
              <input
                autoFocus
                type="email"
                autoComplete="email"
                value={email}
                placeholder="name@example.com"
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
              />
              {loginMemory.method === 'email_password' && loginMemory.maskedEmail && (
                <span className="auth-muted">上次使用邮箱账号：{loginMemory.maskedEmail}</span>
              )}
              {emailFormatError && <span className="auth-muted">{emailFormatError}</span>}
            </label>
            <PasswordField
              label="密码"
              value={password}
              placeholder="输入密码"
              autoComplete="current-password"
              onChange={setPassword}
              disabled={busy}
            />
            <button className="btn-primary" disabled={busy || !canUseEmail || !password}>
              {busy ? '登录中...' : '登录'}
            </button>
            <button type="button" className="auth-link" onClick={() => switchMode('reset', 'forgot_password_link')} disabled={busy}>
              忘记密码？
            </button>
          </form>
        ) : !waitingForCode ? (
          <form onSubmit={startCodeFlow} className="auth-form">
            <label>
              邮箱地址
              <input
                autoFocus
                type="email"
                autoComplete="email"
                value={email}
                placeholder="name@example.com"
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
              />
              {emailFormatError && <span className="auth-muted">{emailFormatError}</span>}
            </label>
            <button className="btn-primary" disabled={busy || !canUseEmail}>
              {busy ? '发送中...' : '获取邮箱验证码'}
            </button>
          </form>
        ) : (
          <form onSubmit={completeCodeFlow} className="auth-form">
            <label>
              验证码
              <input
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                placeholder="6 位验证码"
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                disabled={busy}
              />
            </label>
            <div className="auth-resend">
              {resendIn > 0 ? (
                <span className="auth-muted">{resendIn} 秒后可重新发送</span>
              ) : (
                <button type="button" className="auth-link" onClick={() => void resendCode()} disabled={busy}>
                  重新发送验证码
                </button>
              )}
              <button type="button" className="auth-link" onClick={resetCodeStep} disabled={busy}>
                更换邮箱
              </button>
            </div>
            <PasswordField
              label={mode === 'register' ? '登录密码' : '新密码'}
              value={password}
              placeholder="至少 8 个字符"
              autoComplete="new-password"
              onChange={setPassword}
              disabled={busy}
            />
            {password && (
              <div className={`auth-strength level-${strength.level}`}>
                <div className="auth-strength-bar">
                  <span />
                </div>
                <span className="auth-strength-label">密码强度：{strength.label}</span>
              </div>
            )}
            <PasswordField
              label="确认密码"
              value={passwordConfirm}
              placeholder="再次输入密码"
              autoComplete="new-password"
              onChange={setPasswordConfirm}
              disabled={busy}
            />
            {mode === 'register' && (
              <label className="auth-check">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => {
                    setAgreed(e.target.checked);
                    trackEvent('auth_agreement_check', authAgreementCheckProperties(e.target.checked));
                  }}
                />
                <span>
                  我已阅读并同意
                  <a
                    href={LEGAL_DOC_LINKS.terms.href}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => {
                      e.stopPropagation();
                      trackEvent('auth_agreement_click', authAgreementClickProperties('terms'));
                    }}
                  >
                    {LEGAL_DOC_LINKS.terms.label}
                  </a>
                  与
                  <a
                    href={LEGAL_DOC_LINKS.privacy.href}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => {
                      e.stopPropagation();
                      trackEvent('auth_agreement_click', authAgreementClickProperties('privacy'));
                    }}
                  >
                    {LEGAL_DOC_LINKS.privacy.label}
                  </a>
                </span>
              </label>
            )}
            <button className="btn-primary" disabled={busy || code.trim().length < 6 || password.length < 8 || (mode === 'register' && !agreed)}>
              {busy ? '提交中...' : mode === 'register' ? '完成注册' : '重置并登录'}
            </button>
          </form>
        )}

        {error && (
          <div className="banner banner-error" role="alert">
            {error}
            {isRiskRestricted && (
              <div className="auth-muted">
                <a className="auth-link" href="mailto:support@example.com">
                  联系客服
                </a>
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
  const scheduledText = user.deleteScheduledAt ? new Date(user.deleteScheduledAt).toLocaleString() : '删除时间待确认';

  async function cancelDeletion() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.cancelAccountDeletion();
      trackEvent('auth_delete_account_cancel', authDeleteAccountCancelProperties(user.deleteRequestedAt));
      onCancelled(result);
    } catch (err) {
      const reason = (err as Error).message;
      trackEvent('auth_delete_account_cancel', { ...authDeleteAccountCancelProperties(user.deleteRequestedAt), fail_reason: reason });
      setError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="auth-brand">效率清单</div>
        <h1>账号注销中</h1>
        <p>当前账号已进入注销冷静期，主功能暂不可用。撤销注销后可继续使用原账号数据。</p>
        <div className="auth-muted">预计删除时间：{scheduledText}</div>
        <div className="auth-form">
          <button className="btn-primary" type="button" onClick={() => void cancelDeletion()} disabled={busy}>
            {busy ? '撤销中...' : '撤销注销'}
          </button>
          <button type="button" className="auth-link" onClick={() => void onLogout()} disabled={busy}>
            退出登录
          </button>
        </div>
        {error && (
          <div className="banner banner-error" role="alert">
            {error}
          </div>
        )}
      </section>
    </main>
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ user: User; session: AuthSession } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function loadSession() {
      try {
        const session = await api.getSession();
        if (active) {
          setState(session);
          setSessionNotice(null);
        }
      } catch {
        try {
          const refreshed = await api.refreshSession();
          if (active) {
            setState(refreshed);
            setSessionNotice(null);
          }
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

  useEffect(() => {
    if (!state || typeof window === 'undefined') return;
    let active = true;
    let refreshing = false;
    async function handleSessionExpired(event: Event) {
      if (refreshing) return;
      refreshing = true;
      const detail = (event as CustomEvent<SessionExpiredEventDetail>).detail;
      try {
        const refreshed = await api.refreshSession();
        if (active) {
          setState(refreshed);
          setSessionNotice(null);
        }
      } catch {
        if (active) {
          setState(null);
          setSessionNotice(sessionExpiredMessage(detail?.code));
        }
      } finally {
        refreshing = false;
      }
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => {
      active = false;
      window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    };
  }, [state]);

  const value = useMemo<AuthCtx | null>(() => {
    if (!state) return null;
    return {
      user: state.user,
      session: state.session,
      updateUser: (user: User) => setState({ user, session: state.session }),
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
        setSessionNotice(null);
        setState(null);
      },
    };
  }, [state]);

  function handleAuthed(next: { user: User; session: AuthSession }) {
    setSessionNotice(null);
    setState(next);
  }

  if (!loaded) {
    return (
      <main className="auth-page">
        <div className="auth-loading">加载登录状态...</div>
      </main>
    );
  }
  if (!state || !value) return <PasswordAuthScreen onAuthed={handleAuthed} notice={sessionNotice} />;
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
