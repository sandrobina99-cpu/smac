import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { flushSync } from 'react-dom';
import {
  formatCompactTokens,
  formatDateTime,
  formatMultiplier,
  formatRelativeTime,
  formatTokens,
  normalizeServerUrl,
  type ClientProfile,
} from '@sandrobina/shared';
import { ClientApiClient, type StreamConnectionState } from './api';
import { AgentImporter } from './components/AgentImporter';
import { ChatPlayground } from './components/ChatPlayground';
import { CopyButton } from './components/CopyButton';
import { GuestHostPanel } from './components/GuestHostPanel';
import { ModalDialog } from './components/ModalDialog';
import { ToastRegion, type ToastItem } from './components/ToastRegion';
import { UpdateCenter } from './components/UpdateCenter';

type ThemeMode = 'system' | 'light' | 'dark';
type LowerTab = 'chat' | 'guest' | 'agents' | 'models' | 'usage';
type SnippetKind = 'curl' | 'python' | 'codex';

const STORAGE_TOKEN_KEY = 'sb_client_token';
const STORAGE_URL_KEY = 'sb_client_server_url';
const STORAGE_THEME_KEY = 'sb_client_theme';

function applyThemeAttribute(theme: ThemeMode): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 14) return `${key.slice(0, 4)}••••••••`;
  return `${key.slice(0, 10)}••••••••••••••••${key.slice(-6)}`;
}

export default function App() {
  const [serverUrl, setServerUrl] = useState(
    () => localStorage.getItem(STORAGE_URL_KEY) || 'https://hub.sandrobina.me',
  );
  const [token, setToken] = useState(() => localStorage.getItem(STORAGE_TOKEN_KEY) || '');
  const [theme, setTheme] = useState<ThemeMode>(
    () => (localStorage.getItem(STORAGE_THEME_KEY) as ThemeMode) || 'system',
  );
  const [profile, setProfile] = useState<ClientProfile | null>(null);
  const [booting, setBooting] = useState(true);

  // Login form state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);

  // Dashboard state
  const [streamState, setStreamState] = useState<StreamConnectionState>('disconnected');
  const [revealKey, setRevealKey] = useState(false);
  const [lowerTab, setLowerTab] = useState<LowerTab>('chat');
  const [chatModelId, setChatModelId] = useState<string>('');
  const [snippetKind, setSnippetKind] = useState<SnippetKind>('curl');
  const [refreshing, setRefreshing] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // Connectivity test & self-service password modal
  const [testingKey, setTestingKey] = useState(false);
  const [keyTestStatus, setKeyTestStatus] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [pwModalOpen, setPwModalOpen] = useState(false);
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [savingPw, setSavingPw] = useState(false);

  const notify = useCallback(
    (message: string, tone: ToastItem['tone'] = 'info') => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev.slice(-3), { id, tone, message }]);
    },
    [],
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const handleLogout = useCallback(
    (reason?: string) => {
      setToken('');
      setProfile(null);
      setStreamState('disconnected');
      localStorage.removeItem(STORAGE_TOKEN_KEY);
      if (reason) {
        setLoginError(reason);
      }
    },
    [],
  );

  const apiRef = useRef<ClientApiClient | null>(null);
  if (!apiRef.current) {
    apiRef.current = new ClientApiClient(serverUrl, token, handleLogout);
  }
  const api = apiRef.current;

  useEffect(() => {
    api.setAuth(serverUrl, token);
  }, [api, serverUrl, token]);

  useEffect(() => {
    applyThemeAttribute(theme);
    localStorage.setItem(STORAGE_THEME_KEY, theme);
    window.desktopBridge?.setConfig({ theme }).catch(() => {});
  }, [theme]);

  // Restore saved Electron desktop config
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const cfg = await window.desktopBridge?.getConfig();
        if (cfg && active) {
          if (cfg.serverUrl) {
            setServerUrl(cfg.serverUrl);
            localStorage.setItem(STORAGE_URL_KEY, cfg.serverUrl);
          }
          if (cfg.theme) setTheme(cfg.theme);
          if (cfg.lastUsername) setUsername(cfg.lastUsername);
        }
      } finally {
        if (active) setBooting(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Load initial profile and open real-time SSE subscription
  useEffect(() => {
    if (booting || !token) return;
    let active = true;
    api
      .me()
      .then((data) => {
        if (active) setProfile(data);
      })
      .catch(() => {
        // Unauthorized handled inside api client
      });

    const unsubscribe = api.subscribeProfileStream(
      (nextProfile) => {
        if (active) setProfile(nextProfile);
      },
      (status) => {
        if (active) setStreamState(status);
      },
      (reason) => {
        if (active) handleLogout(reason);
      },
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, booting, handleLogout, token]);

  // Health indicator on login form
  useEffect(() => {
    if (profile) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api.checkHealth(serverUrl).then((ok) => {
        if (!cancelled) setServerOnline(ok);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, profile, serverUrl]);

  async function handleLoginSubmit(e: FormEvent) {
    e.preventDefault();
    setLoginError('');
    const normalized = normalizeServerUrl(serverUrl);
    if (!normalized) {
      setLoginError('请输入网关服务器地址');
      return;
    }
    setLoginBusy(true);
    try {
      api.setAuth(normalized, '');
      const res = await api.login(username.trim(), password);
      setServerUrl(normalized);
      setToken(res.token);
      setProfile(res.profile);
      setPassword('');
      localStorage.setItem(STORAGE_URL_KEY, normalized);
      localStorage.setItem(STORAGE_TOKEN_KEY, res.token);
      await window.desktopBridge?.setConfig({
        serverUrl: normalized,
        lastUsername: username.trim(),
      });
      notify('登录成功，正在实时同步配额', 'success');
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleManualRefresh() {
    setRefreshing(true);
    try {
      const next = await api.me();
      setProfile(next);
      notify('已刷新最新额度与模型列表', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : '刷新失败', 'error');
    } finally {
      setRefreshing(false);
    }
  }

  async function handleTestApiKey() {
    setTestingKey(true);
    try {
      const res = await api.testApiKey();
      const msg = `连通正常 · 延迟 ${res.latencyMs}ms · 可用模型 ${res.allowedModelCount} 个`;
      setKeyTestStatus({ ok: true, message: msg });
      notify(msg, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '连通验证失败';
      setKeyTestStatus({ ok: false, message: msg });
      notify(msg, 'error');
    } finally {
      setTestingKey(false);
    }
  }

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    setSavingPw(true);
    try {
      const res = await api.changePassword(curPw, newPw);
      setToken(res.token);
      localStorage.setItem(STORAGE_TOKEN_KEY, res.token);
      setCurPw('');
      setNewPw('');
      setPwModalOpen(false);
      notify('登录密码已更新，实时连接已自动保持', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : '修改密码失败', 'error');
    } finally {
      setSavingPw(false);
    }
  }

  function transitionLowerTab(nextTab: LowerTab) {
    if (nextTab === lowerTab) return;
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => { finished: Promise<void> };
    };
    const focusLower = () => {
      document.getElementById('client-lower-heading')?.focus();
    };
    if (!doc.startViewTransition) {
      setLowerTab(nextTab);
      requestAnimationFrame(focusLower);
      return;
    }
    const transition = doc.startViewTransition(() => {
      flushSync(() => {
        setLowerTab(nextTab);
      });
    });
    transition.finished.finally(focusLower);
  }

  function openChatWithModel(modelId?: string) {
    if (modelId) {
      setChatModelId(modelId);
    }
    if (lowerTab !== 'chat') {
      transitionLowerTab('chat');
    }
    requestAnimationFrame(() => {
      document.getElementById('client-lower-heading')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  }

  const firstModelId = profile?.models[0]?.id || 'gpt-6.2-sol';

  const snippetText = useMemo(() => {
    if (!profile) return '';
    const baseUrl = profile.api.baseUrl;
    const apiKey = profile.api.apiKey;
    if (snippetKind === 'curl') {
      return `curl ${baseUrl}/chat/completions \\\n  -H "Authorization: Bearer ${apiKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${firstModelId}","messages":[{"role":"user","content":"Hello"}]}'`;
    }
    if (snippetKind === 'python') {
      return `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${baseUrl}",\n    api_key="${apiKey}",\n)\n\nresp = client.chat.completions.create(\n    model="${firstModelId}",\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(resp.choices[0].message.content)`;
    }
    return `export OPENAI_BASE_URL="${baseUrl}"\nexport OPENAI_API_KEY="${apiKey}"\n\n# 或在 ~/.codex/config.toml 中配置 base_url 与 API Key\ncodex -m ${firstModelId} "Inspect repository"`;
  }, [firstModelId, profile, snippetKind]);

  const maxDailyWeighted = useMemo(() => {
    const list = profile?.quota.dailyBreakdown ?? [];
    return Math.max(1, ...list.map((d) => d.weightedTokens));
  }, [profile]);

  if (booting) {
    return (
      <div className="login-shell">
        <p>正在启动客户端...</p>
      </div>
    );
  }

  if (!profile) {
    return (
      <main className="login-shell">
        <section className="login-card" aria-labelledby="client-login-heading">
          <div className="brand-header">
            <div>
              <h1 id="client-login-heading" className="brand-title">
                smac 客户端
              </h1>
              <p className="brand-sub">账号与密码由主机管理端统一分配，登录后接入主机并查看实时 API 额度</p>
            </div>
            <span
              className={`badge ${
                serverOnline === true
                  ? 'badge--ok'
                  : serverOnline === false
                    ? 'badge--danger'
                    : ''
              }`}
            >
              {serverOnline === true
                ? '网关在线'
                : serverOnline === false
                  ? '无法连接'
                  : '检测中'}
            </span>
          </div>

          <form onSubmit={handleLoginSubmit} aria-labelledby="client-login-heading">
            {loginError && (
              <div className="form-error" role="alert">
                {loginError}
              </div>
            )}

            <div className="field">
              <label htmlFor="client-server-url">网关服务器地址</label>
              <input
                id="client-server-url"
                name="serverUrl"
                type="url"
                className="input mono"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://hub.sandrobina.me"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                required
              />
            </div>

            <div className="field">
              <label htmlFor="client-username">用户账号</label>
              <input
                id="client-username"
                name="username"
                type="text"
                className="input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="next"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="client-password">登录密码</label>
              <div className="password-wrap">
                <input
                  id="client-password"
                  name="password"
                  type={showPw ? 'text' : 'password'}
                  className="input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  enterKeyHint="done"
                  required
                />
                <button
                  type="button"
                  className="password-toggle"
                  aria-pressed={showPw}
                  onClick={() => setShowPw((v) => !v)}
                >
                  {showPw ? '隐藏' : '显示'}
                </button>
              </div>
            </div>

            <div className="form-actions" style={{ justifyContent: 'space-between' }}>
              <div className="segmented-control" role="group" aria-label="界面主题">
                {(
                  [
                    ['system', '自动'],
                    ['light', '浅色'],
                    ['dark', '深色'],
                  ] as Array<[ThemeMode, string]>
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    className="segment-btn"
                    aria-pressed={theme === mode}
                    onClick={() => setTheme(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button type="submit" className="btn btn-primary" disabled={loginBusy}>
                {loginBusy ? '登录中...' : '登录客户端'}
              </button>
            </div>
          </form>
        </section>
        <ToastRegion toasts={toasts} onDismiss={dismissToast} />
      </main>
    );
  }

  const q = profile.quota;
  const progressClass = q.isExhausted
    ? 'progress-fill progress-fill--danger'
    : q.usagePercent >= 75
      ? 'progress-fill progress-fill--warn'
      : 'progress-fill';

  const ringRadius = 33;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const remainingPct = q.weeklyLimit > 0 ? Math.max(0, Math.min(100, 100 - q.usagePercent)) : 0;
  const ringOffset = ringCircumference * (1 - remainingPct / 100);
  const ringClass = q.isExhausted
    ? 'ring-progress ring-progress--danger'
    : q.usagePercent >= 75
      ? 'ring-progress ring-progress--warn'
      : 'ring-progress';

  return (
    <div className="client-shell">
      <header className="client-header">
        <div className="header-identity">
          <h1>
            {profile.user.displayName}{' '}
            <span className="field-hint mono">@{profile.user.username}</span>
            <span className="badge badge--accent" style={{ marginLeft: '0.5rem', fontSize: '0.74rem' }}>
              smac 客户端 · {profile.boundDevices?.length ?? 0} 台客机
            </span>
          </h1>
          <p>
            API 网关：<span className="mono">{serverUrl}</span> · 可用模型 {profile.models.length} 个
          </p>
        </div>

        <div className="header-controls">
          <span
            className={`badge ${
              streamState === 'connected'
                ? 'badge--ok'
                : streamState === 'connecting'
                  ? 'badge--warn'
                  : 'badge--danger'
            }`}
          >
            {streamState === 'connected'
              ? '实时同步中'
              : streamState === 'connecting'
                ? '正在重连...'
                : '实时通道断开'}
          </span>

          <button
            type="button"
            className="btn btn-sm"
            disabled={refreshing}
            onClick={handleManualRefresh}
          >
            {refreshing ? '刷新中...' : '刷新'}
          </button>

          <UpdateCenter notify={notify} />

          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setCurPw('');
              setNewPw('');
              setPwModalOpen(true);
            }}
          >
            修改密码
          </button>

          <div className="segmented-control" role="group" aria-label="界面主题">
            {(
              [
                ['system', '自动'],
                ['light', '浅色'],
                ['dark', '深色'],
              ] as Array<[ThemeMode, string]>
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className="segment-btn"
                aria-pressed={theme === mode}
                onClick={() => setTheme(mode)}
              >
                {label}
              </button>
            ))}
          </div>

          <button type="button" className="btn btn-sm" onClick={() => handleLogout()}>
            退出
          </button>
        </div>
      </header>

      {q.isExhausted && (
        <div className="alert-banner" role="alert">
          本周 7×24h 滚动额度已用尽，API 调用服务已自动暂停。
          {q.nextReleaseAt
            ? ` 最早将在 ${formatDateTime(q.nextReleaseAt)}（${formatRelativeTime(
                q.nextReleaseAt,
              )}）自动滚动释放约 ${formatTokens(q.nextReleaseAmount)} 加权 Token。`
            : ' 请联系管理员上调每周限额。'}
        </div>
      )}

      <div className="hero-grid stagger-list">
        {/* Card 1: API URL & API Key */}
        <section className="card stagger-item" aria-labelledby="cred-card-title">
          <div className="card-head">
            <h2 id="cred-card-title" className="card-title">
              我的 API 接入凭证
            </h2>
            <span className="badge badge--accent">OpenAI 兼容接口</span>
          </div>

          <div className="credential-block">
            <div className="credential-label">API Base URL</div>
            <div className="credential-box">
              <code id="client-api-url" className="credential-value mono">
                {profile.api.baseUrl}
              </code>
              <div className="credential-actions">
                <CopyButton targetId="client-api-url" label="复制 API Base URL" />
              </div>
            </div>
          </div>

          <div className="credential-block">
            <div className="credential-label">个人 API Key（实时同步管理员分发/轮换结果）</div>
            <div className="credential-box">
              <code id="client-api-key" className="credential-value mono">
                {revealKey ? profile.api.apiKey : maskApiKey(profile.api.apiKey)}
              </code>
              <div className="credential-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-pressed={revealKey}
                  onClick={() => setRevealKey((v) => !v)}
                >
                  {revealKey ? '隐藏' : '显示'}
                </button>
                <CopyButton
                  targetId="client-api-key"
                  textOverride={profile.api.apiKey}
                  label="复制个人 API Key"
                />
              </div>
            </div>
          </div>

          <div className="connectivity-row">
            <button
              type="button"
              className="btn btn-sm"
              disabled={testingKey}
              onClick={handleTestApiKey}
            >
              {testingKey ? '检测中...' : '测试 API 连通性'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => openChatWithModel()}
            >
              打开 AI 对话测试
            </button>
            {keyTestStatus && (
              <span
                className={`badge ${keyTestStatus.ok ? 'badge--ok' : 'badge--danger'}`}
                role="status"
              >
                {keyTestStatus.message}
              </span>
            )}
          </div>

          <div style={{ marginTop: '0.75rem' }}>
            <div className="card-head" style={{ marginBlockEnd: '0.5rem' }}>
              <span className="credential-label" style={{ marginBlockEnd: 0 }}>
                快速调用示例
              </span>
              <CopyButton
                targetId="client-snippet-code"
                textOverride={snippetText}
                label="复制调用示例"
              />
            </div>
            <div className="segmented-control" role="tablist" aria-label="代码示例语言">
              {(
                [
                  ['curl', 'cURL'],
                  ['python', 'OpenAI Python'],
                  ['codex', 'Codex CLI'],
                ] as Array<[SnippetKind, string]>
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  role="tab"
                  className="segment-btn"
                  aria-selected={snippetKind === kind}
                  onClick={() => setSnippetKind(kind)}
                >
                  {label}
                </button>
              ))}
            </div>
            <pre className="code-block">
              <code id="client-snippet-code" className="mono">
                {snippetText}
              </code>
            </pre>
          </div>
        </section>

        {/* Card 2: Weekly Rolling Quota */}
        <section className="card stagger-item" aria-labelledby="quota-card-title">
          <div className="card-head">
            <h2 id="quota-card-title" className="card-title">
              周额度滚动状态（过去 168 小时）
            </h2>
            <span
              className={`badge ${
                q.isExhausted
                  ? 'badge--danger'
                  : q.usagePercent >= 75
                    ? 'badge--warn'
                    : 'badge--ok'
              }`}
            >
              {q.isExhausted ? '已用尽暂停' : q.usagePercent >= 75 ? '即将达限' : '正常供应中'}
            </span>
          </div>

          <div className="quota-hero-row">
            <div>
              <div className="field-hint">当前剩余可用额度（加权 Token）</div>
              <div className="quota-big mono">{formatTokens(q.remainingWeighted)}</div>
            </div>
            <div className="ring-wrap" aria-label={`剩余额度占比 ${Math.round(remainingPct)}%`}>
              <svg className="ring-svg" width="82" height="82" viewBox="0 0 82 82">
                <circle className="ring-track" cx="41" cy="41" r={ringRadius} />
                <circle
                  className={ringClass}
                  cx="41"
                  cy="41"
                  r={ringRadius}
                  strokeDasharray={ringCircumference}
                  strokeDashoffset={ringOffset}
                />
              </svg>
              <span className="ring-center mono">{Math.round(remainingPct)}%</span>
            </div>
          </div>

          <div className="progress-bar" aria-label={`本周额度已使用 ${q.usagePercent}%`}>
            <div className={progressClass} style={{ width: `${q.usagePercent}%` }} />
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '0.8rem',
              color: 'var(--text-muted)',
            }}
          >
            <span>已消耗 {q.usagePercent}%</span>
            <span>总限额 {formatTokens(q.weeklyLimit)}</span>
          </div>

          <div className="quota-sub-grid">
            <div className="quota-stat">
              <div className="quota-stat-label">7 日已用（加权）</div>
              <div className="quota-stat-val mono">{formatTokens(q.usedWeighted)}</div>
            </div>
            <div className="quota-stat">
              <div className="quota-stat-label">7 日原始 Token</div>
              <div className="quota-stat-val mono">{formatTokens(q.usedRaw)}</div>
            </div>
            <div className="quota-stat">
              <div className="quota-stat-label">7 日请求次数</div>
              <div className="quota-stat-val mono">{formatTokens(q.requestCount)} 次</div>
            </div>
            <div className="quota-stat">
              <div className="quota-stat-label">未来 24h 将释放</div>
              <div className="quota-stat-val mono">+{formatCompactTokens(q.releasingIn24h)}</div>
            </div>
          </div>

          <div className="field-hint">
            {q.nextReleaseAt
              ? `滚动窗口自动回滚：最早将在 ${formatDateTime(q.nextReleaseAt)}（${formatRelativeTime(
                  q.nextReleaseAt,
                )}）释放 ${formatTokens(q.nextReleaseAmount)} 加权 Token。`
              : '滚动模式说明：任意单次调用消耗会在 7×24 小时后自动释放回可用额度。'}
          </div>

          <div className="mini-chart" aria-label="近 7 天每日加权 Token 消耗分布">
            {q.dailyBreakdown.map((b) => {
              const pct = Math.round((b.weightedTokens / maxDailyWeighted) * 100);
              return (
                <div
                  key={b.date}
                  className="mini-col"
                  title={`${b.date}: ${formatTokens(b.weightedTokens)} 加权 Token`}
                >
                  <div className="mini-track">
                    <div
                      className="mini-fill"
                      style={{ height: `${b.weightedTokens > 0 ? Math.max(6, pct) : 0}%` }}
                    />
                  </div>
                  <span className="mini-label">{b.date.slice(5)}</span>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* Lower Section: AI Chat Playground / Allowed Models / Usage Logs */}
      <section className="card">
        <div className="card-head" style={{ marginBlockEnd: '0.75rem' }}>
          <h2 id="client-lower-heading" tabIndex={-1} className="card-title">
            {lowerTab === 'chat'
              ? 'AI 对话测试（模型与思考强度调试）'
              : lowerTab === 'guest'
                ? '客机主机接入与本账号绑定设备（支持多台客机）'
                : lowerTab === 'agents'
                  ? 'AI 工具一键接入（Codex / Claude / OpenCode 等）'
                  : lowerTab === 'models'
                    ? '授权可用模型与倍率'
                    : '近期调用流水记录'}
          </h2>
          <div className="segmented-control" role="tablist" aria-label="详细视图">
            <button
              type="button"
              role="tab"
              className="segment-btn"
              aria-selected={lowerTab === 'chat'}
              onClick={() => transitionLowerTab('chat')}
            >
              AI 对话测试
            </button>
            <button
              type="button"
              role="tab"
              className="segment-btn"
              aria-selected={lowerTab === 'guest'}
              onClick={() => transitionLowerTab('guest')}
            >
              客机主机接入 ({profile.boundDevices?.length ?? 0})
            </button>
            <button
              type="button"
              role="tab"
              className="segment-btn"
              aria-selected={lowerTab === 'agents'}
              onClick={() => transitionLowerTab('agents')}
            >
              工具接入
            </button>
            <button
              type="button"
              role="tab"
              className="segment-btn"
              aria-selected={lowerTab === 'models'}
              onClick={() => transitionLowerTab('models')}
            >
              可用模型 ({profile.models.length})
            </button>
            <button
              type="button"
              role="tab"
              className="segment-btn"
              aria-selected={lowerTab === 'usage'}
              onClick={() => transitionLowerTab('usage')}
            >
              调用流水 ({profile.recentUsage.length})
            </button>
          </div>
        </div>

        <div className="lower-panel-content">

        {lowerTab === 'chat' && (
          <ChatPlayground
            serverUrl={serverUrl}
            apiKey={profile.api.apiKey}
            models={profile.models}
            isQuotaExhausted={q.isExhausted}
            initialModelId={chatModelId}
            onNotify={notify}
          />
        )}

        {lowerTab === 'guest' && (
          <GuestHostPanel
            profile={profile}
            api={api}
            notify={notify}
            onRefreshProfile={async () => {
              const next = await api.me();
              setProfile(next);
            }}
          />
        )}

        {lowerTab === 'agents' && (
          <AgentImporter
            serverUrl={serverUrl}
            apiKey={profile.api.apiKey}
            models={profile.models}
            notify={notify}
          />
        )}

        {lowerTab === 'models' && (
          <div
            tabIndex={0}
            role="region"
            aria-labelledby="client-models-caption"
            className="table-wrapper"
          >
            <table
              style={
                {
                  '--label-1': '"模型 ID"',
                  '--label-2': '"名称"',
                  '--label-3': '"上下文长度"',
                  '--label-4': '"扣费倍率"',
                  '--label-5': '"思考强度"',
                  '--label-6': '"操作"',
                } as CSSProperties
              }
            >
              <caption id="client-models-caption">
                仅展示管理员对您开放的模型；被禁用的模型不会在 API /v1/models 查询结果中出现。
              </caption>
              <thead>
                <tr>
                  <th>模型 ID</th>
                  <th>显示名称</th>
                  <th>上下文窗口</th>
                  <th>扣费倍率</th>
                  <th>支持思考强度</th>
                  <th>快速测试</th>
                </tr>
              </thead>
              <tbody>
                {profile.models.map((m) => {
                  const idDom = `client-model-${m.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                  const efforts = m.supportedReasoningEfforts;
                  const effortSummary =
                    efforts && efforts.length > 0
                      ? `${efforts[0]} ~ ${efforts[efforts.length - 1]}`
                      : efforts && efforts.length === 0
                        ? '不支持'
                        : 'low ~ max';
                  return (
                    <tr key={m.id}>
                      <th>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <code id={idDom} className="mono">
                            {m.id}
                          </code>
                          <CopyButton
                            targetId={idDom}
                            label={`复制模型 ID ${m.id}`}
                            compact
                          />
                        </div>
                      </th>
                      <td>{m.displayName}</td>
                      <td className="mono">
                        {m.contextLength ? formatCompactTokens(m.contextLength) : '—'}
                      </td>
                      <td>
                        <span className="badge badge--accent">
                          {formatMultiplier(m.multiplier)}
                        </span>
                      </td>
                      <td className="mono">
                        <span className="badge">{effortSummary}</span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => openChatWithModel(m.id)}
                        >
                          对话测试
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {profile.models.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                      当前账号暂无可用的模型，请联系管理员授权。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {lowerTab === 'usage' && (
          <div
            tabIndex={0}
            role="region"
            aria-labelledby="client-usage-caption"
            className="table-wrapper"
          >
            <table
              style={
                {
                  '--label-1': '"时间"',
                  '--label-2': '"模型"',
                  '--label-3': '"原始 Token"',
                  '--label-4': '"倍率"',
                  '--label-5': '"扣减额度"',
                  '--label-6': '"状态"',
                } as CSSProperties
              }
            >
              <caption id="client-usage-caption">
                展示最近 50 次 API 调用记录，实时更新。
              </caption>
              <thead>
                <tr>
                  <th>调用时间</th>
                  <th>模型</th>
                  <th>原始 Token (输入 / 输出 / 总)</th>
                  <th>倍率</th>
                  <th>扣减加权 Token</th>
                  <th>状态 / 耗时</th>
                </tr>
              </thead>
              <tbody>
                {profile.recentUsage.map((log) => (
                  <tr key={log.id}>
                    <th className="mono">{formatDateTime(log.createdAt)}</th>
                    <td className="mono">{log.modelId}</td>
                    <td className="mono">
                      {formatTokens(log.promptTokens)} / {formatTokens(log.completionTokens)} /{' '}
                      <strong>{formatTokens(log.totalTokens)}</strong>
                    </td>
                    <td>
                      <span className="badge badge--accent">
                        {formatMultiplier(log.multiplier)}
                      </span>
                    </td>
                    <td className="mono">
                      <strong>{formatTokens(log.weightedTokens)}</strong>
                    </td>
                    <td className="mono">
                      <span
                        className={`badge ${
                          log.statusCode < 400 ? 'badge--ok' : 'badge--danger'
                        }`}
                      >
                        {log.statusCode}
                      </span>{' '}
                      {log.latencyMs}ms
                    </td>
                  </tr>
                ))}
                {profile.recentUsage.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                      暂无 API 调用记录
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        </div>
      </section>

      <ModalDialog
        open={pwModalOpen}
        titleId="client-pw-dialog-title"
        title="修改登录密码"
        onClose={() => setPwModalOpen(false)}
      >
        <form onSubmit={handleChangePassword}>
          <div className="field">
            <label htmlFor="client-cur-pw">当前密码</label>
            <input
              id="client-cur-pw"
              type="password"
              className="input"
              autoComplete="current-password"
              value={curPw}
              onChange={(e) => setCurPw(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="client-new-pw">新密码（至少 4 位）</label>
            <input
              id="client-new-pw"
              type="password"
              className="input"
              autoComplete="new-password"
              minLength={4}
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              required
            />
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="btn"
              onClick={() => setPwModalOpen(false)}
            >
              取消
            </button>
            <button type="submit" className="btn btn-primary" disabled={savingPw}>
              {savingPw ? '保存中...' : '确认修改'}
            </button>
          </div>
        </form>
      </ModalDialog>

      <ToastRegion toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
