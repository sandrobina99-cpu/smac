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
  type AdminOverview,
  type AdminUserRow,
  type GatewaySettings,
  type GuestDeviceBinding,
  type ModelAccessMode,
  type ModelEntry,
  type UsageLogRow,
} from '@sandrobina/shared';
import { AdminApiClient, ApiError } from './api';
import { BoundDevicesPanel } from './components/BoundDevicesPanel';
import { CopyButton } from './components/CopyButton';
import { ModalDialog } from './components/ModalDialog';
import { UpdateCenter } from './components/UpdateCenter';
import { ToastRegion, type ToastItem } from './components/ToastRegion';

type TabKey = 'overview' | 'users' | 'devices' | 'models' | 'usage' | 'settings';
type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_TOKEN_KEY = 'sb_admin_token';
const STORAGE_URL_KEY = 'sb_admin_server_url';
const STORAGE_THEME_KEY = 'sb_admin_theme';

const LIMIT_PRESETS = [
  { label: '10 万', value: 100_000 },
  { label: '50 万', value: 500_000 },
  { label: '100 万', value: 1_000_000 },
  { label: '500 万', value: 5_000_000 },
  { label: '1,000 万', value: 10_000_000 },
];

function applyThemeAttribute(theme: ThemeMode): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

export default function App() {
  const [serverUrl, setServerUrl] = useState(
    () => localStorage.getItem(STORAGE_URL_KEY) || 'https://hub.sandrobina.me',
  );
  const [token, setToken] = useState(() => localStorage.getItem(STORAGE_TOKEN_KEY) || '');
  const [theme, setTheme] = useState<ThemeMode>(
    () => (localStorage.getItem(STORAGE_THEME_KEY) as ThemeMode) || 'system',
  );
  const [adminUser, setAdminUser] = useState<{ id: number; username: string } | null>(null);
  const [booting, setBooting] = useState(true);

  const [tab, setTab] = useState<TabKey>('overview');
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // Login states
  const [loginUsername, setLoginUsername] = useState('admin');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPw, setShowLoginPw] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);

  // Domain data states
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [devices, setDevices] = useState<GuestDeviceBinding[]>([]);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [usageLogs, setUsageLogs] = useState<UsageLogRow[]>([]);
  const [usageTotal, setUsageTotal] = useState(0);
  const [settings, setSettings] = useState<GatewaySettings | null>(null);
  const [loadingData, setLoadingData] = useState(false);

  // Filters
  const [userSearch, setUserSearch] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [usageUserFilter, setUsageUserFilter] = useState<string>('');
  const [usageModelFilter, setUsageModelFilter] = useState<string>('');

  // Inline model multiplier edits
  const [multDrafts, setMultDrafts] = useState<Record<string, string>>({});

  // Settings form drafts
  const [upstreamUrlDraft, setUpstreamUrlDraft] = useState('');
  const [upstreamKeyDraft, setUpstreamKeyDraft] = useState('');
  const [publicUrlDraft, setPublicUrlDraft] = useState('');
  const [defaultLimitDraft, setDefaultLimitDraft] = useState('1000000');
  const [savingSettings, setSavingSettings] = useState(false);
  const [testingUpstream, setTestingUpstream] = useState(false);
  const [curAdminPw, setCurAdminPw] = useState('');
  const [newAdminPw, setNewAdminPw] = useState('');

  // Modals state
  const [userFormModal, setUserFormModal] = useState<{
    open: boolean;
    editing: AdminUserRow | null;
  }>({ open: false, editing: null });
  const [uUsername, setUUsername] = useState('');
  const [uDisplayName, setUDisplayName] = useState('');
  const [uPassword, setUPassword] = useState('');
  const [uWeeklyLimit, setUWeeklyLimit] = useState('1000000');
  const [uEnabled, setUEnabled] = useState(true);
  const [uNotes, setUNotes] = useState('');

  const [aclModalUser, setAclModalUser] = useState<AdminUserRow | null>(null);
  const [aclMode, setAclMode] = useState<ModelAccessMode>('all_except_denied');
  const [aclAllowedSet, setAclAllowedSet] = useState<Set<string>>(new Set());
  const [aclSearch, setAclSearch] = useState('');

  const [resetPwUser, setResetPwUser] = useState<AdminUserRow | null>(null);
  const [resetPwValue, setResetPwValue] = useState('');

  const [rotateKeyResult, setRotateKeyResult] = useState<{
    user: AdminUserRow;
    newKey?: string;
  } | null>(null);

  const [deleteUserTarget, setDeleteUserTarget] = useState<AdminUserRow | null>(null);
  const [resetQuotaTarget, setResetQuotaTarget] = useState<AdminUserRow | null>(null);

  const [newModelModalOpen, setNewModelModalOpen] = useState(false);
  const [mId, setMId] = useState('');
  const [mDisplayName, setMDisplayName] = useState('');
  const [mContextLen, setMContextLen] = useState('');
  const [mMultiplier, setMMultiplier] = useState('1.0');

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

  const handleLogout = useCallback(() => {
    setToken('');
    setAdminUser(null);
    localStorage.removeItem(STORAGE_TOKEN_KEY);
  }, []);

  const apiRef = useRef<AdminApiClient | null>(null);
  if (!apiRef.current) {
    apiRef.current = new AdminApiClient(serverUrl, token, handleLogout);
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

  // Initial config restore from Electron main process
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
          if (cfg.theme) {
            setTheme(cfg.theme);
          }
          if (cfg.lastUsername) {
            setLoginUsername(cfg.lastUsername);
          }
        }
      } finally {
        if (active) setBooting(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Verify existing session token once booted
  useEffect(() => {
    if (booting) return;
    if (!token) {
      setAdminUser(null);
      return;
    }
    api
      .me()
      .then((me) => setAdminUser(me))
      .catch(() => {
        setToken('');
        localStorage.removeItem(STORAGE_TOKEN_KEY);
      });
  }, [api, booting, token]);

  // Health check on login screen
  useEffect(() => {
    if (adminUser) return;
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
  }, [adminUser, api, serverUrl]);

  const refreshAll = useCallback(async () => {
    if (!token) return;
    setLoadingData(true);
    try {
      const [ov, usrRes, devRes, modRes, setRes] = await Promise.all([
        api.overview(),
        api.listUsers(),
        api.listDevices().catch(() => ({ devices: [] as GuestDeviceBinding[] })),
        api.listModels(),
        api.getSettings(),
      ]);
      setOverview(ov);
      setUsers(usrRes.users);
      setDevices(devRes.devices);
      setModels(modRes.models);
      setSettings(setRes);
      setUpstreamUrlDraft(setRes.upstreamBaseUrl);
      setPublicUrlDraft(setRes.publicBaseUrl);
      setDefaultLimitDraft(String(setRes.defaultWeeklyTokenLimit));
      const drafts: Record<string, string> = {};
      for (const m of modRes.models) {
        drafts[m.id] = String(m.multiplier);
      }
      setMultDrafts(drafts);
    } catch (err) {
      if (err instanceof ApiError && err.status !== 401) {
        notify(err.message, 'error');
      }
    } finally {
      setLoadingData(false);
    }
  }, [api, notify, token]);

  const handleBindDevice = useCallback(
    async (deviceId: string, userId: number) => {
      try {
        const res = await api.bindDevice(deviceId, { userId });
        notify(
          `已将客机「${res.device.deviceName}」归属调整至 ${res.device.accountDisplayName} (@${res.device.accountUsername})`,
          'success',
        );
        await refreshAll();
      } catch (err) {
        notify(err instanceof Error ? err.message : '修改客机归属失败', 'error');
      }
    },
    [api, notify, refreshAll],
  );

  const handleDeleteDevice = useCallback(
    async (deviceId: string) => {
      try {
        await api.deleteDevice(deviceId);
        notify('已从网关移除该客机设备记录', 'success');
        await refreshAll();
      } catch (err) {
        notify(err instanceof Error ? err.message : '移除客机失败', 'error');
      }
    },
    [api, notify, refreshAll],
  );

  const refreshUsage = useCallback(async () => {
    if (!token) return;
    try {
      const res = await api.listUsage({
        userId: usageUserFilter ? Number(usageUserFilter) : undefined,
        modelId: usageModelFilter || undefined,
        limit: 120,
      });
      setUsageLogs(res.logs);
      setUsageTotal(res.total);
    } catch (err) {
      if (err instanceof ApiError && err.status !== 401) {
        notify(err.message, 'error');
      }
    }
  }, [api, notify, token, usageModelFilter, usageUserFilter]);

  useEffect(() => {
    if (adminUser) {
      void refreshAll();
    }
  }, [adminUser, refreshAll]);

  useEffect(() => {
    if (adminUser && tab === 'usage') {
      void refreshUsage();
    }
  }, [adminUser, refreshUsage, tab]);

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
      const res = await api.login(loginUsername.trim(), loginPassword);
      setServerUrl(normalized);
      setToken(res.token);
      setAdminUser(res.admin);
      setLoginPassword('');
      localStorage.setItem(STORAGE_URL_KEY, normalized);
      localStorage.setItem(STORAGE_TOKEN_KEY, res.token);
      await window.desktopBridge?.setConfig({
        serverUrl: normalized,
        lastUsername: loginUsername.trim(),
      });
      notify('管理员登录成功', 'success');
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoginBusy(false);
    }
  }

  function openCreateUserModal() {
    setUUsername('');
    setUDisplayName('');
    setUPassword('');
    setUWeeklyLimit(String(settings?.defaultWeeklyTokenLimit ?? 1_000_000));
    setUEnabled(true);
    setUNotes('');
    setUserFormModal({ open: true, editing: null });
  }

  function openEditUserModal(u: AdminUserRow) {
    setUUsername(u.username);
    setUDisplayName(u.displayName);
    setUPassword('');
    setUWeeklyLimit(String(u.weeklyTokenLimit));
    setUEnabled(u.enabled);
    setUNotes(u.notes);
    setUserFormModal({ open: true, editing: u });
  }

  async function handleSaveUserForm(e: FormEvent) {
    e.preventDefault();
    const limitNum = Number(uWeeklyLimit);
    if (!Number.isFinite(limitNum) || limitNum < 0) {
      notify('每周限额必须是非负整数', 'error');
      return;
    }
    try {
      if (userFormModal.editing) {
        await api.updateUser(userFormModal.editing.id, {
          username: uUsername.trim(),
          displayName: uDisplayName.trim(),
          weeklyTokenLimit: Math.round(limitNum),
          enabled: uEnabled,
          notes: uNotes.trim(),
        });
        notify(`已更新用户 ${uUsername.trim()}`, 'success');
      } else {
        await api.createUser({
          username: uUsername.trim(),
          displayName: uDisplayName.trim() || uUsername.trim(),
          password: uPassword,
          weeklyTokenLimit: Math.round(limitNum),
          enabled: uEnabled,
          modelAccessMode: 'all_except_denied',
          notes: uNotes.trim(),
        });
        notify(`已创建用户 ${uUsername.trim()} 并生成 API Key`, 'success');
      }
      setUserFormModal({ open: false, editing: null });
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : '保存失败', 'error');
    }
  }

  function openAclModal(u: AdminUserRow) {
    setAclModalUser(u);
    setAclMode(u.modelAccessMode);
    setAclSearch('');
    const allowed = new Set<string>();
    for (const m of models) {
      const ov = u.modelOverrides[m.id];
      const ok = u.modelAccessMode === 'allow_list' ? ov === true : ov !== false;
      if (ok) allowed.add(m.id);
    }
    setAclAllowedSet(allowed);
  }

  function toggleAclModel(modelId: string) {
    setAclAllowedSet((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  }

  async function handleSaveAcl(e: FormEvent) {
    e.preventDefault();
    if (!aclModalUser) return;
    const overrides: Record<string, boolean> = {};
    if (aclMode === 'allow_list') {
      for (const id of aclAllowedSet) {
        overrides[id] = true;
      }
    } else {
      for (const m of models) {
        if (!aclAllowedSet.has(m.id)) {
          overrides[m.id] = false;
        }
      }
    }
    try {
      await api.updateUserModels(aclModalUser.id, {
        modelAccessMode: aclMode,
        overrides,
      });
      notify(`已更新 ${aclModalUser.username} 的可用模型权限`, 'success');
      setAclModalUser(null);
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : '更新模型权限失败', 'error');
    }
  }

  async function handleToggleUserEnabled(u: AdminUserRow) {
    try {
      await api.updateUser(u.id, { enabled: !u.enabled });
      notify(`已${u.enabled ? '停用' : '启用'}用户 ${u.username}`, 'success');
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : '操作失败', 'error');
    }
  }

  async function handleResetPassword(e: FormEvent) {
    e.preventDefault();
    if (!resetPwUser) return;
    try {
      await api.resetUserPassword(resetPwUser.id, resetPwValue);
      notify(`已重置 ${resetPwUser.username} 的登录密码`, 'success');
      setResetPwUser(null);
      setResetPwValue('');
    } catch (err) {
      notify(err instanceof Error ? err.message : '重置失败', 'error');
    }
  }

  async function handleConfirmRotateKey() {
    if (!rotateKeyResult) return;
    try {
      const res = await api.rotateUserKey(rotateKeyResult.user.id);
      setRotateKeyResult({ user: res.user, newKey: res.apiKey });
      notify(`已为 ${res.user.username} 轮换 API Key`, 'success');
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : '轮换失败', 'error');
    }
  }

  async function handleDeleteUser() {
    if (!deleteUserTarget) return;
    try {
      await api.deleteUser(deleteUserTarget.id);
      notify(`已删除用户 ${deleteUserTarget.username}`, 'success');
      setDeleteUserTarget(null);
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : '删除失败', 'error');
    }
  }

  async function handleConfirmResetQuota() {
    if (!resetQuotaTarget) return;
    try {
      const res = await api.resetUserQuota(resetQuotaTarget.id);
      notify(
        `已清零 ${resetQuotaTarget.username} 近 7 天消耗（共清理 ${res.clearedRecords} 条记录）`,
        'success',
      );
      setResetQuotaTarget(null);
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : '清零失败', 'error');
    }
  }

  function transitionTab(nextTab: TabKey) {
    if (nextTab === tab) return;
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => { finished: Promise<void> };
    };
    const focusHeading = () => {
      document.getElementById('admin-page-heading')?.focus();
    };
    if (!doc.startViewTransition) {
      setTab(nextTab);
      requestAnimationFrame(focusHeading);
      return;
    }
    const transition = doc.startViewTransition(() => {
      flushSync(() => {
        setTab(nextTab);
      });
    });
    transition.finished.finally(focusHeading);
  }

  async function handleSyncModels() {
    try {
      const res = await api.syncModels();
      notify(`同步成功：共 ${res.syncedCount} 个模型（新增 ${res.addedCount} 个）`, 'success');
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : '同步失败', 'error');
    }
  }

  async function handleSaveMultiplier(modelId: string) {
    const val = Number(multDrafts[modelId]);
    if (!Number.isFinite(val) || val < 0) {
      notify('倍率必须是非负数字', 'error');
      return;
    }
    try {
      await api.updateModel(modelId, { multiplier: val });
      notify(`已保存 ${modelId} 倍率为 ${formatMultiplier(val)}`, 'success');
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : '保存倍率失败', 'error');
    }
  }

  async function handleToggleGlobalModel(m: ModelEntry) {
    try {
      await api.updateModel(m.id, { globalEnabled: !m.globalEnabled });
      notify(`模型 ${m.id} 已全局${m.globalEnabled ? '禁用' : '启用'}`, 'success');
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : '操作失败', 'error');
    }
  }

  async function handleAddCustomModel(e: FormEvent) {
    e.preventDefault();
    const mult = Number(mMultiplier);
    if (!Number.isFinite(mult) || mult < 0) {
      notify('倍率必须是非负数字', 'error');
      return;
    }
    try {
      await api.createModel({
        id: mId.trim(),
        displayName: mDisplayName.trim() || mId.trim(),
        contextLength: mContextLen.trim() ? Number(mContextLen.trim()) : null,
        multiplier: mult,
        globalEnabled: true,
      });
      notify(`已添加模型 ${mId.trim()}`, 'success');
      setNewModelModalOpen(false);
      setMId('');
      setMDisplayName('');
      setMContextLen('');
      setMMultiplier('1.0');
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : '添加失败', 'error');
    }
  }

  async function handleSaveSettings(e: FormEvent) {
    e.preventDefault();
    const limitNum = Number(defaultLimitDraft);
    if (!Number.isFinite(limitNum) || limitNum < 0) {
      notify('默认每周限额必须是非负数字', 'error');
      return;
    }
    setSavingSettings(true);
    try {
      const updated = await api.updateSettings({
        upstreamBaseUrl: upstreamUrlDraft.trim(),
        upstreamApiKey: upstreamKeyDraft.trim() || undefined,
        publicBaseUrl: publicUrlDraft.trim(),
        defaultWeeklyTokenLimit: Math.round(limitNum),
      });
      setSettings(updated);
      setUpstreamKeyDraft('');
      notify('系统设置已保存', 'success');
      await refreshAll();
    } catch (err) {
      notify(err instanceof Error ? err.message : '保存设置失败', 'error');
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleTestUpstream() {
    setTestingUpstream(true);
    try {
      const res = await api.testUpstream({
        upstreamBaseUrl: upstreamUrlDraft.trim() || undefined,
        upstreamApiKey: upstreamKeyDraft.trim() || undefined,
      });
      notify(
        `上游连接正常（${res.modelCount} 个模型，延迟 ${res.latencyMs}ms）`,
        'success',
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : '上游连接测试失败', 'error');
    } finally {
      setTestingUpstream(false);
    }
  }

  async function handleChangeAdminPassword(e: FormEvent) {
    e.preventDefault();
    try {
      const res = await api.changePassword(curAdminPw, newAdminPw);
      setToken(res.token);
      localStorage.setItem(STORAGE_TOKEN_KEY, res.token);
      setCurAdminPw('');
      setNewAdminPw('');
      notify('管理员密码已更新', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : '修改密码失败', 'error');
    }
  }

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        u.displayName.toLowerCase().includes(q) ||
        u.notes.toLowerCase().includes(q),
    );
  }, [userSearch, users]);

  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.displayName.toLowerCase().includes(q) ||
        m.ownedBy.toLowerCase().includes(q),
    );
  }, [modelSearch, models]);

  const filteredAclModels = useMemo(() => {
    const q = aclSearch.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q),
    );
  }, [aclSearch, models]);

  const maxDailyWeighted = useMemo(() => {
    const list = overview?.dailyBreakdown ?? [];
    return Math.max(1, ...list.map((d) => d.weightedTokens));
  }, [overview]);

  if (booting) {
    return (
      <div className="login-shell">
        <p>正在初始化管理端...</p>
      </div>
    );
  }

  if (!adminUser) {
    return (
      <main className="login-shell">
        <section className="login-card" aria-labelledby="admin-login-heading">
          <div className="brand-header">
            <div>
              <h1 id="admin-login-heading" className="brand-title">
                smac 管理端
              </h1>
              <p className="brand-sub">唯一管理员最高权限 · 主机设备归属、API Key 分发与模型配额控制中心</p>
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

          <form onSubmit={handleLoginSubmit} aria-labelledby="admin-login-heading">
            {loginError && (
              <div className="form-error" role="alert">
                {loginError}
              </div>
            )}

            <div className="field">
              <label htmlFor="gateway-url">网关服务器地址</label>
              <input
                id="gateway-url"
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
              <label htmlFor="admin-username">管理员账号</label>
              <input
                id="admin-username"
                name="username"
                type="text"
                className="input"
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
                autoComplete="username"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="next"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="admin-password">管理员密码</label>
              <div className="password-wrap">
                <input
                  id="admin-password"
                  name="password"
                  type={showLoginPw ? 'text' : 'password'}
                  className="input"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  autoComplete="current-password"
                  enterKeyHint="done"
                  required
                />
                <button
                  type="button"
                  className="password-toggle"
                  aria-pressed={showLoginPw}
                  onClick={() => setShowLoginPw((v) => !v)}
                >
                  {showLoginPw ? '隐藏' : '显示'}
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
                {loginBusy ? '登录中...' : '登录管理端'}
              </button>
            </div>
          </form>
        </section>
        <ToastRegion toasts={toasts} onDismiss={dismissToast} />
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <h1>smac 管理端</h1>
          <p className="mono">{serverUrl}</p>
          <span className="badge badge--accent" style={{ marginTop: '0.35rem', display: 'inline-block' }}>
            唯一管理员 · 最高权限
          </span>
        </div>

        <nav className="nav-list" aria-label="主导航">
          {(
            [
              ['overview', '总览仪表盘'],
              ['users', '用户与 Key 分发'],
              ['devices', `客机设备归属 (${devices.length})`],
              ['models', '模型与倍率'],
              ['usage', '调用流水日志'],
              ['settings', '网关与上游设置'],
            ] as Array<[TabKey, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="nav-btn"
              aria-current={tab === key ? 'page' : undefined}
              onClick={() => transitionTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div>
            <span className="field-hint" style={{ display: 'block', marginBottom: '0.35rem' }}>
              外观主题
            </span>
            <div className="segmented-control" role="group" aria-label="界面主题" style={{ width: '100%' }}>
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
                  style={{ flex: 1 }}
                  aria-pressed={theme === mode}
                  onClick={() => setTheme(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <UpdateCenter notify={notify} />
          <button type="button" className="btn" onClick={handleLogout}>
            退出 ({adminUser.username})
          </button>
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <h2 id="admin-page-heading" tabIndex={-1}>
            {tab === 'overview' && '运行总览（近 7×24h 滚动窗口）'}
            {tab === 'users' && '用户账号、API Key 与模型权限管理'}
            {tab === 'devices' && '客机设备归属管理（1 账号 → 多台客机）'}
            {tab === 'models' && '模型目录与扣费倍率配置'}
            {tab === 'usage' && 'API 调用与 Token 扣减流水'}
            {tab === 'settings' && '上游网关配置与管理员安全'}
          </h2>
          <div className="topbar-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={loadingData}
              onClick={() => {
                void refreshAll();
                if (tab === 'usage') void refreshUsage();
              }}
            >
              {loadingData ? '刷新中...' : '刷新数据'}
            </button>
          </div>
        </header>

        <main className="content">
          {tab === 'overview' && overview && (
            <>
              <div className="kpi-grid stagger-list">
                <article className="card kpi-card stagger-item">
                  <div className="kpi-label">用户总数 / 启用中</div>
                  <div className="kpi-value">
                    {overview.activeUsers} / {overview.totalUsers}
                  </div>
                  <div className="kpi-sub">
                    已绑定客机 {overview.totalBoundDevices ?? devices.length} 台（在线{' '}
                    {overview.connectedDevices ?? devices.filter((d) => d.connected).length}）
                  </div>
                </article>
                <article className="card kpi-card stagger-item">
                  <div className="kpi-label">全局启用模型</div>
                  <div className="kpi-value">
                    {overview.enabledModels} / {overview.totalModels}
                  </div>
                  <div className="kpi-sub">
                    上次同步：{formatDateTime(overview.lastModelSyncAt)}
                  </div>
                </article>
                <article className="card kpi-card stagger-item">
                  <div className="kpi-label">7 日滚动加权消耗</div>
                  <div className="kpi-value">{formatCompactTokens(overview.usedWeighted7d)}</div>
                  <div className="kpi-sub">
                    原始 Token：{formatTokens(overview.usedRaw7d)}
                  </div>
                </article>
                <article className="card kpi-card stagger-item">
                  <div className="kpi-label">7 日滚动请求数</div>
                  <div className="kpi-value">{formatTokens(overview.requests7d)}</div>
                  <div className="kpi-sub">
                    上游状态：{overview.upstreamConfigured ? '已配置' : '待配置'}
                  </div>
                </article>
              </div>

              <div className="toolbar">
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={openCreateUserModal}
                  >
                    + 新建用户并分发 Key
                  </button>
                  <button type="button" className="btn" onClick={handleSyncModels}>
                    同步上游模型目录
                  </button>
                </div>
              </div>

              <div className="split-grid">
                <section className="card">
                  <h3 className="card-title">近 7 天加权 Token 趋势</h3>
                  <div className="bar-chart">
                    {overview.dailyBreakdown.map((b) => {
                      const pct = Math.round((b.weightedTokens / maxDailyWeighted) * 100);
                      return (
                        <div key={b.date} className="bar-col" title={`${b.date}: ${formatTokens(b.weightedTokens)} weighted`}>
                          <div className="bar-track">
                            <div
                              className="bar-fill"
                              style={{ height: `${b.weightedTokens > 0 ? Math.max(4, pct) : 0}%` }}
                            />
                          </div>
                          <span className="bar-label">{b.date.slice(5)}</span>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="card">
                  <h3 className="card-title">近 7 天热门模型消耗</h3>
                  {overview.topModels.length === 0 ? (
                    <p className="field-hint">暂无调用记录</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                      {overview.topModels.map((m) => (
                        <div
                          key={m.modelId}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: '0.5rem',
                          }}
                        >
                          <div>
                            <strong className="mono">{m.modelId}</strong>{' '}
                            <span className="badge badge--accent">
                              {formatMultiplier(m.multiplier)}
                            </span>
                          </div>
                          <span className="mono">
                            {formatTokens(m.weightedTokens)} ({m.requests} 次)
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            </>
          )}

          {tab === 'users' && (
            <>
              <div className="toolbar">
                <search>
                  <label htmlFor="user-search" className="visually-hidden">
                    搜索用户
                  </label>
                  <input
                    id="user-search"
                    type="search"
                    className="input"
                    placeholder="搜索用户名、显示名或备注..."
                    value={userSearch}
                    onChange={(e) => setUserSearch(e.target.value)}
                  />
                </search>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={openCreateUserModal}
                >
                  + 新建用户
                </button>
              </div>

              <div
                tabIndex={0}
                role="region"
                aria-labelledby="users-table-caption"
                className="table-wrapper"
              >
                <table
                  style={
                    {
                      '--label-1': '"用户"',
                      '--label-2': '"状态"',
                      '--label-3': '"7×24h 滚动额度"',
                      '--label-4': '"模型权限"',
                      '--label-5': '"分发 API Key"',
                      '--label-6': '"操作"',
                    } as CSSProperties
                  }
                >
                  <caption id="users-table-caption">
                    共 {filteredUsers.length} 位用户；禁用某模型后，该用户通过 API Key 查询 /v1/models 时不会看到被禁用的模型。
                  </caption>
                  <thead>
                    <tr>
                      <th>用户</th>
                      <th>状态</th>
                      <th>7×24h 滚动额度</th>
                      <th>模型权限</th>
                      <th>分发 API Key</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map((u) => {
                      const pct = u.quota.usagePercent;
                      const fillClass = u.quota.isExhausted
                        ? 'progress-fill progress-fill--danger'
                        : pct >= 75
                          ? 'progress-fill progress-fill--warn'
                          : 'progress-fill';
                      const keyDomId = `user-key-${u.id}`;
                      return (
                        <tr key={u.id}>
                          <th>
                            <div>{u.displayName}</div>
                            <div className="field-hint mono">@{u.username}</div>
                            {u.notes && <div className="field-hint">{u.notes}</div>}
                            {(u.boundDevices?.length ?? 0) > 0 && (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.35rem' }}>
                                {u.boundDevices!.map((dev) => (
                                  <span
                                    key={dev.id}
                                    className={`badge ${dev.connected ? 'badge--ok' : ''}`}
                                    style={{ fontSize: '0.7rem' }}
                                    title={`${dev.os} · ${dev.primaryIp || dev.hostname}`}
                                  >
                                    {dev.deviceName || dev.hostname}
                                  </span>
                                ))}
                              </div>
                            )}
                          </th>
                          <td>
                            <label className="switch-label">
                              <input
                                type="checkbox"
                                role="switch"
                                className="apple-switch"
                                checked={u.enabled}
                                onChange={() => handleToggleUserEnabled(u)}
                                {...({ switch: '' } as Record<string, string>)}
                              />
                              <span>{u.enabled ? '启用' : '停用'}</span>
                            </label>
                          </td>
                          <td style={{ minWidth: 220 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                              <span>
                                已用 <strong>{formatCompactTokens(u.quota.usedWeighted)}</strong> /{' '}
                                {formatCompactTokens(u.weeklyTokenLimit)}
                              </span>
                              <span>剩余 {formatCompactTokens(u.quota.remainingWeighted)}</span>
                            </div>
                            <div className="progress-bar">
                              <div className={fillClass} style={{ width: `${pct}%` }} />
                            </div>
                            <div className="field-hint">
                              {u.quota.nextReleaseAt
                                ? `最早释放：${formatRelativeTime(u.quota.nextReleaseAt)} (+${formatCompactTokens(u.quota.nextReleaseAmount)})`
                                : '近 7 天暂无扣费记录'}
                            </div>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => openAclModal(u)}
                            >
                              {u.allowedModelCount} / {u.totalActiveModelCount} 个可用
                            </button>
                            <div className="field-hint">
                              {u.modelAccessMode === 'allow_list' ? '白名单模式' : '默认全开(黑名单剔除)'}
                            </div>
                          </td>
                          <td>
                            <div className="input-row">
                              <code id={keyDomId} className="mono">
                                {u.apiKeyPrefix}
                              </code>
                              <CopyButton
                                targetId={keyDomId}
                                textOverride={u.apiKey}
                                label={`复制 ${u.username} 的 API Key`}
                                compact
                              />
                            </div>
                          </td>
                          <td>
                            <div className="row-actions">
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => openEditUserModal(u)}
                              >
                                编辑
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => {
                                  setResetPwUser(u);
                                  setResetPwValue('');
                                }}
                              >
                                改密
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => setRotateKeyResult({ user: u })}
                              >
                                换 Key
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => setResetQuotaTarget(u)}
                              >
                                清零
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-danger"
                                onClick={() => setDeleteUserTarget(u)}
                              >
                                删除
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {filteredUsers.length === 0 && (
                      <tr>
                        <td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                          暂无符合条件的用户
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {tab === 'devices' && (
            <BoundDevicesPanel
              devices={devices}
              users={users}
              onBindDevice={handleBindDevice}
              onDeleteDevice={handleDeleteDevice}
            />
          )}

          {tab === 'models' && (
            <>
              <div className="toolbar">
                <search>
                  <label htmlFor="model-search" className="visually-hidden">
                    搜索模型
                  </label>
                  <input
                    id="model-search"
                    type="search"
                    className="input"
                    placeholder="按模型 ID 或名称搜索..."
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                  />
                </search>
                <div className="row-actions">
                  <button type="button" className="btn" onClick={() => setNewModelModalOpen(true)}>
                    + 手动添加模型
                  </button>
                  <button type="button" className="btn btn-primary" onClick={handleSyncModels}>
                    从上游同步模型
                  </button>
                </div>
              </div>

              <div
                tabIndex={0}
                role="region"
                aria-labelledby="models-table-caption"
                className="table-wrapper"
              >
                <table
                  style={
                    {
                      '--label-1': '"模型 ID"',
                      '--label-2': '"显示名称"',
                      '--label-3': '"上下文"',
                      '--label-4': '"扣费倍率"',
                      '--label-5': '"全局状态"',
                      '--label-6': '"近 7 天消耗"',
                    } as CSSProperties
                  }
                >
                  <caption id="models-table-caption">
                    扣减公式：加权消耗 Token = ceil(总 Token × 模型倍率)。设为 0 表示免费不计费。
                  </caption>
                  <thead>
                    <tr>
                      <th>模型 ID</th>
                      <th>显示名称 / 来源</th>
                      <th>上下文窗口</th>
                      <th>扣费倍率</th>
                      <th>全局状态</th>
                      <th>近 7 天消耗</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredModels.map((m) => (
                      <tr key={m.id}>
                        <th className="mono">{m.id}</th>
                        <td>
                          <div>{m.displayName}</div>
                          <div className="field-hint">
                            {m.ownedBy}{' '}
                            {!m.isUpstreamPresent && (
                              <span className="badge badge--warn">上游未列出</span>
                            )}
                          </div>
                        </td>
                        <td className="mono">
                          {m.contextLength ? formatCompactTokens(m.contextLength) : '—'}
                        </td>
                        <td>
                          <div className="input-row">
                            <input
                              type="number"
                              step="0.1"
                              min="0"
                              aria-label={`${m.id} 倍率`}
                              className="input mono"
                              style={{ width: 96, minHeight: 32 }}
                              value={multDrafts[m.id] ?? String(m.multiplier)}
                              onChange={(e) =>
                                setMultDrafts((prev) => ({ ...prev, [m.id]: e.target.value }))
                              }
                            />
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => handleSaveMultiplier(m.id)}
                            >
                              保存
                            </button>
                          </div>
                        </td>
                        <td>
                          <label className="switch-label">
                            <input
                              type="checkbox"
                              role="switch"
                              className="apple-switch"
                              checked={m.globalEnabled}
                              onChange={() => handleToggleGlobalModel(m)}
                              {...({ switch: '' } as Record<string, string>)}
                            />
                            <span>{m.globalEnabled ? '启用' : '禁用'}</span>
                          </label>
                        </td>
                        <td className="mono">
                          <div>{formatTokens(m.usedWeighted7d ?? 0)} 加权</div>
                          <div className="field-hint">
                            {formatTokens(m.usedRaw7d ?? 0)} 原始 / {m.requests7d ?? 0} 次
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {tab === 'usage' && (
            <>
              <div className="toolbar">
                <search>
                  <select
                    aria-label="按用户筛选"
                    className="select"
                    value={usageUserFilter}
                    onChange={(e) => setUsageUserFilter(e.target.value)}
                  >
                    <option value="">全部用户</option>
                    {users.map((u) => (
                      <option key={u.id} value={String(u.id)}>
                        {u.displayName} (@{u.username})
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="按模型筛选"
                    className="select"
                    value={usageModelFilter}
                    onChange={(e) => setUsageModelFilter(e.target.value)}
                  >
                    <option value="">全部模型</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn btn-sm" onClick={() => void refreshUsage()}>
                    查询
                  </button>
                </search>
                <span className="field-hint">共 {usageTotal} 条记录（显示最新 120 条）</span>
              </div>

              <div
                tabIndex={0}
                role="region"
                aria-labelledby="usage-table-caption"
                className="table-wrapper"
              >
                <table
                  style={
                    {
                      '--label-1': '"时间"',
                      '--label-2': '"用户"',
                      '--label-3': '"模型"',
                      '--label-4': '"接口"',
                      '--label-5': '"原始 Token"',
                      '--label-6': '"倍率 / 扣费"',
                      '--label-7': '"状态 / 耗时"',
                    } as CSSProperties
                  }
                >
                  <caption id="usage-table-caption">实时 API 代理调用与 Token 计费明细</caption>
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>用户</th>
                      <th>模型</th>
                      <th>接口</th>
                      <th>原始 Token (输入 / 输出 / 总)</th>
                      <th>倍率 / 扣减加权</th>
                      <th>状态 / 耗时</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usageLogs.map((log) => (
                      <tr key={log.id}>
                        <th className="mono">{formatDateTime(log.createdAt)}</th>
                        <td>{log.displayName || log.username || `#${log.userId}`}</td>
                        <td className="mono">{log.modelId}</td>
                        <td className="mono">
                          {log.endpoint} {log.isStream ? '(stream)' : ''}
                        </td>
                        <td className="mono">
                          {formatTokens(log.promptTokens)} / {formatTokens(log.completionTokens)} /{' '}
                          <strong>{formatTokens(log.totalTokens)}</strong>
                        </td>
                        <td className="mono">
                          <span className="badge badge--accent">
                            {formatMultiplier(log.multiplier)}
                          </span>{' '}
                          → <strong>{formatTokens(log.weightedTokens)}</strong>
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
                    {usageLogs.length === 0 && (
                      <tr>
                        <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                          暂无调用记录
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {tab === 'settings' && (
            <div className="split-grid">
              <section className="card">
                <h3 className="card-title">上游 API 与默认限额配置</h3>
                <form onSubmit={handleSaveSettings}>
                  <div className="field">
                    <label htmlFor="s-upstream-url">上游 API 分发地址</label>
                    <input
                      id="s-upstream-url"
                      type="url"
                      className="input mono"
                      value={upstreamUrlDraft}
                      onChange={(e) => setUpstreamUrlDraft(e.target.value)}
                      placeholder="https://api.sandrobina.me/v1"
                      required
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="s-upstream-key">
                      上游 Master API Key{' '}
                      {settings?.hasUpstreamApiKey && (
                        <span className="field-hint mono">
                          （当前已保存：{settings.upstreamApiKeyMasked}）
                        </span>
                      )}
                    </label>
                    <input
                      id="s-upstream-key"
                      type="password"
                      className="input mono"
                      value={upstreamKeyDraft}
                      onChange={(e) => setUpstreamKeyDraft(e.target.value)}
                      placeholder={
                        settings?.hasUpstreamApiKey
                          ? '留空表示保持当前密钥不变'
                          : '请输入上游 API Key'
                      }
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="s-public-url">客户端展示的网关 API 地址</label>
                    <input
                      id="s-public-url"
                      type="url"
                      className="input mono"
                      value={publicUrlDraft}
                      onChange={(e) => setPublicUrlDraft(e.target.value)}
                      placeholder="https://your-gateway.example.com/v1"
                    />
                    <span className="field-hint">
                      用户在客户端软件中看到的 API Base URL，应指向当前自托管网关的 /v1 路径。
                    </span>
                  </div>

                  <div className="field">
                    <label htmlFor="s-default-limit">新建用户默认每周限额（加权 Token）</label>
                    <input
                      id="s-default-limit"
                      type="number"
                      min="0"
                      className="input mono"
                      value={defaultLimitDraft}
                      onChange={(e) => setDefaultLimitDraft(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={testingUpstream}
                      onClick={handleTestUpstream}
                    >
                      {testingUpstream ? '测试中...' : '测试上游连接'}
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={savingSettings}>
                      {savingSettings ? '保存中...' : '保存设置'}
                    </button>
                  </div>
                </form>
              </section>

              <section className="card">
                <h3 className="card-title">修改管理员密码</h3>
                <form onSubmit={handleChangeAdminPassword}>
                  <div className="field">
                    <label htmlFor="cur-admin-pw">当前密码</label>
                    <input
                      id="cur-admin-pw"
                      type="password"
                      className="input"
                      autoComplete="current-password"
                      value={curAdminPw}
                      onChange={(e) => setCurAdminPw(e.target.value)}
                      required
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="new-admin-pw">新密码（至少 6 位）</label>
                    <input
                      id="new-admin-pw"
                      type="password"
                      className="input"
                      autoComplete="new-password"
                      minLength={6}
                      value={newAdminPw}
                      onChange={(e) => setNewAdminPw(e.target.value)}
                      required
                    />
                  </div>
                  <div className="form-actions">
                    <button type="submit" className="btn btn-primary">
                      更新管理员密码
                    </button>
                  </div>
                </form>
              </section>
            </div>
          )}
        </main>
      </div>

      {/* Create / Edit User Dialog */}
      <ModalDialog
        open={userFormModal.open}
        titleId="user-form-dialog-title"
        title={userFormModal.editing ? `编辑用户：${userFormModal.editing.username}` : '新建用户并分发 API Key'}
        onClose={() => setUserFormModal({ open: false, editing: null })}
      >
        <form onSubmit={handleSaveUserForm}>
          <div className="field">
            <label htmlFor="uf-username">登录账号（客户端登录用户名）</label>
            <input
              id="uf-username"
              type="text"
              className="input mono"
              value={uUsername}
              onChange={(e) => setUUsername(e.target.value)}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              minLength={2}
              required
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="uf-display">显示名称</label>
            <input
              id="uf-display"
              type="text"
              className="input"
              value={uDisplayName}
              onChange={(e) => setUDisplayName(e.target.value)}
              placeholder="例如：张三 / 前端团队"
            />
          </div>
          {!userFormModal.editing && (
            <div className="field">
              <label htmlFor="uf-password">客户端初始密码（至少 4 位）</label>
              <input
                id="uf-password"
                type="password"
                className="input"
                autoComplete="new-password"
                minLength={4}
                value={uPassword}
                onChange={(e) => setUPassword(e.target.value)}
                required
              />
            </div>
          )}
          <div className="field">
            <label htmlFor="uf-limit">每周滚动限额（加权 Token）</label>
            <input
              id="uf-limit"
              type="number"
              min="0"
              className="input mono"
              value={uWeeklyLimit}
              onChange={(e) => setUWeeklyLimit(e.target.value)}
              required
            />
            <div className="preset-row">
              {LIMIT_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setUWeeklyLimit(String(p.value))}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="checkbox"
                checked={uEnabled}
                onChange={(e) => setUEnabled(e.target.checked)}
              />
              <span>账号启用中（停用后无法登录客户端且 API Key 失效）</span>
            </label>
          </div>
          <div className="field">
            <label htmlFor="uf-notes">备注</label>
            <textarea
              id="uf-notes"
              className="textarea"
              value={uNotes}
              onChange={(e) => setUNotes(e.target.value)}
              placeholder="可选备注信息..."
            />
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="btn"
              onClick={() => setUserFormModal({ open: false, editing: null })}
            >
              取消
            </button>
            <button type="submit" className="btn btn-primary">
              {userFormModal.editing ? '保存修改' : '创建并生成 Key'}
            </button>
          </div>
        </form>
      </ModalDialog>

      {/* Per-User Model ACL Dialog */}
      <ModalDialog
        open={aclModalUser !== null}
        titleId="acl-dialog-title"
        title={aclModalUser ? `模型访问权限：${aclModalUser.displayName} (@${aclModalUser.username})` : '模型访问权限'}
        onClose={() => setAclModalUser(null)}
        wide
      >
        <form onSubmit={handleSaveAcl}>
          <fieldset className="acl-mode-group">
            <legend>权限策略</legend>
            <label className="acl-mode-option">
              <input
                type="radio"
                name="acl-mode"
                checked={aclMode === 'all_except_denied'}
                onChange={() => setAclMode('all_except_denied')}
              />
              <div>
                <strong>默认允许全部已启用模型</strong>
                <div className="field-hint">
                  新增上游模型自动可用，仅取消勾选被禁用的模型。
                </div>
              </div>
            </label>
            <label className="acl-mode-option">
              <input
                type="radio"
                name="acl-mode"
                checked={aclMode === 'allow_list'}
                onChange={() => setAclMode('allow_list')}
              />
              <div>
                <strong>白名单模式（严格授权）</strong>
                <div className="field-hint">
                  仅允许当前勾选的模型，新模型默认不开放。
                </div>
              </div>
            </label>
          </fieldset>

          <div className="toolbar" style={{ marginBlockEnd: '0.75rem' }}>
            <input
              type="search"
              aria-label="筛选模型"
              className="input"
              placeholder="筛选模型 ID..."
              value={aclSearch}
              onChange={(e) => setAclSearch(e.target.value)}
            />
            <div className="row-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setAclAllowedSet(new Set(models.map((m) => m.id)))}
              >
                全部允许
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setAclAllowedSet(new Set())}
              >
                全部禁用
              </button>
            </div>
          </div>

          <div className="acl-list">
            {filteredAclModels.map((m) => {
              const checked = aclAllowedSet.has(m.id);
              return (
                <div key={m.id} className="acl-item">
                  <label>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleAclModel(m.id)}
                    />
                    <span>
                      <strong className="mono">{m.id}</strong>{' '}
                      <span className="field-hint">({m.displayName})</span>
                    </span>
                  </label>
                  <div className="row-actions">
                    <span className="badge badge--accent">
                      {formatMultiplier(m.multiplier)}
                    </span>
                    {!m.globalEnabled && <span className="badge badge--danger">全局已禁用</span>}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="form-actions">
            <span className="field-hint" style={{ marginInlineEnd: 'auto', alignSelf: 'center' }}>
              已允许 {aclAllowedSet.size} / {models.length} 个模型（禁用模型在 /v1/models 中不可见）
            </span>
            <button type="button" className="btn" onClick={() => setAclModalUser(null)}>
              取消
            </button>
            <button type="submit" className="btn btn-primary">
              保存模型权限
            </button>
          </div>
        </form>
      </ModalDialog>

      {/* Reset User Password Dialog */}
      <ModalDialog
        open={resetPwUser !== null}
        titleId="reset-pw-dialog-title"
        title={resetPwUser ? `重置登录密码：${resetPwUser.username}` : '重置密码'}
        onClose={() => setResetPwUser(null)}
      >
        <form onSubmit={handleResetPassword}>
          <div className="field">
            <label htmlFor="reset-pw-input">新密码（至少 4 位，重置后原客户端需重新登录）</label>
            <input
              id="reset-pw-input"
              type="password"
              className="input"
              autoComplete="new-password"
              minLength={4}
              value={resetPwValue}
              onChange={(e) => setResetPwValue(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setResetPwUser(null)}>
              取消
            </button>
            <button type="submit" className="btn btn-primary">
              确认重置密码
            </button>
          </div>
        </form>
      </ModalDialog>

      {/* Rotate API Key Dialog */}
      <ModalDialog
        open={rotateKeyResult !== null}
        titleId="rotate-key-dialog-title"
        title={
          rotateKeyResult?.newKey
            ? `已生成新 API Key：${rotateKeyResult.user.username}`
            : `轮换 API Key：${rotateKeyResult?.user.username ?? ''}`
        }
        onClose={() => setRotateKeyResult(null)}
      >
        {rotateKeyResult && !rotateKeyResult.newKey && (
          <div>
            <p>
              确定要轮换 <strong>{rotateKeyResult.user.username}</strong> 的 API Key 吗？旧密钥会立即失效，客户端软件将实时同步新密钥。
            </p>
            <div className="form-actions">
              <button
                type="button"
                className="btn"
                autoFocus
                onClick={() => setRotateKeyResult(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleConfirmRotateKey}
              >
                确认轮换 Key
              </button>
            </div>
          </div>
        )}
        {rotateKeyResult?.newKey && (
          <div>
            <p>新 API Key 已生效并已同步到客户端：</p>
            <div className="input-row" style={{ marginBlock: '0.75rem' }}>
              <code
                id="rotated-new-key"
                className="input mono"
                style={{ display: 'flex', alignItems: 'center', wordBreak: 'break-all' }}
              >
                {rotateKeyResult.newKey}
              </code>
              <CopyButton targetId="rotated-new-key" label="复制新 API Key" />
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setRotateKeyResult(null)}
              >
                完成
              </button>
            </div>
          </div>
        )}
      </ModalDialog>

      {/* Reset Rolling Quota Confirmation Dialog */}
      <ModalDialog
        open={resetQuotaTarget !== null}
        titleId="reset-quota-dialog-title"
        title="确认清零滚动额度"
        onClose={() => setResetQuotaTarget(null)}
      >
        {resetQuotaTarget && (
          <div>
            <p>
              确定要清零 <strong>{resetQuotaTarget.displayName}</strong>（
              <code className="mono">@{resetQuotaTarget.username}</code>
              ）近 7×24h 内的已用额度吗？操作后该用户剩余额度将立即恢复为 100%。
            </p>
            <div className="form-actions">
              <button
                type="button"
                className="btn"
                autoFocus
                onClick={() => setResetQuotaTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleConfirmResetQuota}
              >
                确认清零
              </button>
            </div>
          </div>
        )}
      </ModalDialog>

      {/* Delete User Confirmation Dialog */}
      <ModalDialog
        open={deleteUserTarget !== null}
        titleId="delete-user-dialog-title"
        title="确认删除用户"
        onClose={() => setDeleteUserTarget(null)}
      >
        {deleteUserTarget && (
          <div>
            <p>
              确定要永久删除用户 <strong>{deleteUserTarget.displayName}</strong>（
              <code className="mono">@{deleteUserTarget.username}</code>
              ）吗？该操作将同时删除其 API Key、模型权限与历史调用记录，且无法撤销。
            </p>
            <div className="form-actions">
              <button
                type="button"
                className="btn"
                autoFocus
                onClick={() => setDeleteUserTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleDeleteUser}
              >
                永久删除
              </button>
            </div>
          </div>
        )}
      </ModalDialog>

      {/* Add Custom Model Dialog */}
      <ModalDialog
        open={newModelModalOpen}
        titleId="new-model-dialog-title"
        title="手动新增模型"
        onClose={() => setNewModelModalOpen(false)}
      >
        <form onSubmit={handleAddCustomModel}>
          <div className="field">
            <label htmlFor="nm-id">模型 ID</label>
            <input
              id="nm-id"
              type="text"
              className="input mono"
              value={mId}
              onChange={(e) => setMId(e.target.value)}
              placeholder="例如：gpt-6.2-sol"
              required
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="nm-display">显示名称</label>
            <input
              id="nm-display"
              type="text"
              className="input"
              value={mDisplayName}
              onChange={(e) => setMDisplayName(e.target.value)}
              placeholder="例如：GPT-6.2-Sol"
            />
          </div>
          <div className="field">
            <label htmlFor="nm-ctx">上下文长度（可选）</label>
            <input
              id="nm-ctx"
              type="number"
              min="1"
              className="input mono"
              value={mContextLen}
              onChange={(e) => setMContextLen(e.target.value)}
              placeholder="272000"
            />
          </div>
          <div className="field">
            <label htmlFor="nm-mult">扣费倍率</label>
            <input
              id="nm-mult"
              type="number"
              step="0.1"
              min="0"
              className="input mono"
              value={mMultiplier}
              onChange={(e) => setMMultiplier(e.target.value)}
              required
            />
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="btn"
              onClick={() => setNewModelModalOpen(false)}
            >
              取消
            </button>
            <button type="submit" className="btn btn-primary">
              保存模型
            </button>
          </div>
        </form>
      </ModalDialog>

      <ToastRegion toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
