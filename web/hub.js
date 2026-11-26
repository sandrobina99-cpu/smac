'use strict';

// smac 主机管理端 · API 分发与账号客机绑定控制器
// 唯一管理员最高权限：管理用户账号、分发 API Key、7x24h 滚动额度、模型倍率与 ACL、
// 以及“一个账号绑定多台客机”的统一绑定控制面。

(function () {
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  const HS = {
    initialized: false,
    loggedIn: false,
    serverUrl: 'https://hub.sandrobina.me',
    adminUsername: '',
    subTab: 'accounts',
    overview: null,
    users: [],
    devices: [],
    models: [],
    usageLogs: [],
    usageTotal: 0,
    settings: null,
    hostBinding: null,
    userSearch: '',
    modelSearch: '',
    usageUserFilter: '',
    editingUserId: 0,
    aclUserId: 0,
    aclMode: 'all_except_denied',
    aclAllowedSet: new Set(),
    bindTargetLocalDevice: null
  };

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtNum(v) {
    return Math.max(0, Math.round(Number(v) || 0)).toLocaleString('en-US');
  }

  function fmtCompact(v) {
    const n = Math.max(0, Number(v) || 0);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e4) return (n / 1e3).toFixed(1) + 'K';
    return Math.round(n).toLocaleString('en-US');
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function notify(msg, kind, duration) {
    if (typeof window.toast === 'function') window.toast(msg, kind || 'info', duration);
  }

  async function api(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error((data && (data.error || data.output || data.message)) || ('请求失败 (' + res.status + ')'));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function reqJson(method, url, body) {
    return api(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  }

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(String(text || ''));
      notify('已复制 ' + (label || '内容'), 'ok', 1800);
    } catch {
      notify('复制失败，请手动复制', 'warn');
    }
  }

  function setSubTab(next) {
    HS.subTab = next;
    $$('#hubSubTabs .seg').forEach(btn => btn.classList.toggle('active', btn.dataset.hubTab === next));
    $$('.hub-pane').forEach(pane => { pane.hidden = pane.dataset.hubPane !== next; });
    if (next === 'usage' && HS.loggedIn) loadUsage();
  }

  function renderAuthVisibility() {
    const loginCard = $('#hubLoginCard');
    const dash = $('#hubDash');
    const adminPill = $('#hubAdminPill');
    if (loginCard) loginCard.hidden = HS.loggedIn;
    if (dash) dash.hidden = !HS.loggedIn;
    if (adminPill) {
      adminPill.hidden = !HS.loggedIn;
      const nameEl = $('#hubAdminName');
      if (nameEl) nameEl.textContent = (HS.adminUsername || 'admin') + ' · 唯一超级管理员';
    }
    const urlInput = $('#hubGatewayUrl');
    if (urlInput && !urlInput.value) urlInput.value = HS.serverUrl;
    const urlLabel = $('#hubActiveGatewayText');
    if (urlLabel) urlLabel.textContent = HS.serverUrl;
  }

  async function loadHubState() {
    try {
      const st = await api('/api/hub/state');
      HS.serverUrl = st.serverUrl || 'https://hub.sandrobina.me';
      HS.loggedIn = Boolean(st.loggedIn);
      HS.adminUsername = st.adminUsername || '';
      if ($('#hubGatewayUrl')) $('#hubGatewayUrl').value = HS.serverUrl;
      renderAuthVisibility();
      if (HS.loggedIn) {
        await refreshDashboard();
      } else {
        checkHealthQuiet();
      }
    } catch { }
  }

  async function checkHealthQuiet() {
    const el = $('#hubHealthBadge');
    if (!el) return;
    const url = ($('#hubGatewayUrl') && $('#hubGatewayUrl').value.trim()) || HS.serverUrl;
    try {
      const r = await api('/api/hub/health?url=' + encodeURIComponent(url));
      el.dataset.state = r.ok ? 'ok' : 'off';
      el.textContent = r.ok ? '网关在线' : '网关不可达';
    } catch {
      el.dataset.state = 'off';
      el.textContent = '网关不可达';
    }
  }

  async function refreshDashboard() {
    if (!HS.loggedIn) return;
    try {
      const [ov, usrRes, devRes, modRes, setRes, hbRes] = await Promise.all([
        api('/api/hub/admin/overview'),
        api('/api/hub/admin/users'),
        api('/api/hub/admin/devices'),
        api('/api/hub/admin/models'),
        api('/api/hub/admin/settings'),
        api('/api/hub/admin/host-binding').catch(() => ({ hostBinding: null }))
      ]);
      HS.overview = ov;
      HS.users = Array.isArray(usrRes.users) ? usrRes.users : [];
      HS.devices = Array.isArray(devRes.devices) ? devRes.devices : [];
      HS.models = Array.isArray(modRes.models) ? modRes.models : [];
      HS.settings = setRes || null;
      HS.hostBinding = hbRes && hbRes.hostBinding ? hbRes.hostBinding : null;

      renderOverview();
      renderUsers();
      renderModels();
      renderSettings();
      if (HS.subTab === 'usage') loadUsage();
    } catch (err) {
      if (err && err.status === 401) {
        HS.loggedIn = false;
        renderAuthVisibility();
        notify('管理员登录已过期，请重新登录', 'warn');
      } else {
        notify(err.message || '加载 API 分发数据失败', 'error');
      }
    }
  }

  function renderOverview() {
    const ov = HS.overview;
    if (!ov) return;
    if ($('#hubStUsers')) $('#hubStUsers').textContent = (ov.activeUsers || 0) + ' / ' + (ov.totalUsers || 0);
    if ($('#hubStDevices')) $('#hubStDevices').textContent = (ov.connectedDevices || 0) + ' / ' + (ov.totalBoundDevices || HS.devices.length || 0);
    if ($('#hubStModels')) $('#hubStModels').textContent = (ov.enabledModels || 0) + ' / ' + (ov.totalModels || 0);
    if ($('#hubStTokens')) $('#hubStTokens').textContent = fmtCompact(ov.usedWeighted7d || 0);
    if ($('#hubStRequests')) $('#hubStRequests').textContent = fmtNum(ov.requests7d || 0);

    const topUsersBox = $('#hubTopUsers');
    if (topUsersBox) {
      const list = Array.isArray(ov.topUsers) ? ov.topUsers : [];
      topUsersBox.innerHTML = list.length
        ? list.map(u => {
            const pct = Math.min(100, Math.round(Number(u.usagePercent) || 0));
            return '<div class="hub-bar-row">' +
              '<div class="hub-bar-meta"><b>' + esc(u.displayName || u.username) + '</b><code>@' + esc(u.username) + '</code><span>' + fmtCompact(u.usedWeighted) + ' / ' + fmtCompact(u.weeklyLimit) + ' (' + pct + '%)</span></div>' +
              '<div class="hub-bar-track"><div class="hub-bar-fill" style="width:' + pct + '%"></div></div>' +
            '</div>';
          }).join('')
        : '<div class="hub-empty">近 7 天暂无账号消耗记录</div>';
    }

    const topModelsBox = $('#hubTopModels');
    if (topModelsBox) {
      const list = Array.isArray(ov.topModels) ? ov.topModels : [];
      topModelsBox.innerHTML = list.length
        ? list.map(m =>
            '<div class="hub-mini-row"><div><b>' + esc(m.displayName || m.modelId) + '</b><code>' + esc(m.modelId) + '</code></div>' +
            '<span>' + esc(m.multiplier) + 'x · ' + fmtCompact(m.weightedTokens) + ' · ' + fmtNum(m.requests) + ' 次</span></div>'
          ).join('')
        : '<div class="hub-empty">近 7 天暂无模型调用记录</div>';
    }
  }

  function renderUsers() {
    const grid = $('#hubUserGrid');
    if (!grid) return;
    const q = (HS.userSearch || '').trim().toLowerCase();
    const list = HS.users.filter(u => {
      if (!q) return true;
      const devMatch = (u.boundDevices || []).some(d =>
        String(d.deviceName || '').toLowerCase().includes(q) || String(d.primaryIp || '').includes(q)
      );
      return String(u.username || '').toLowerCase().includes(q)
        || String(u.displayName || '').toLowerCase().includes(q)
        || String(u.notes || '').toLowerCase().includes(q)
        || devMatch;
    });

    if (!list.length) {
      grid.innerHTML = '<div class="hub-empty-card">暂无匹配的账号。点击右上角「新建账号」即可创建并自动分发 API Key，且支持在该账号下绑定多台客机设备。</div>';
      return;
    }

    grid.innerHTML = list.map(u => {
      const quota = u.quota || { usedWeighted: 0, weeklyLimit: u.weeklyTokenLimit || 0, usagePercent: 0, remainingWeighted: 0 };
      const pct = Math.min(100, Math.round(Number(quota.usagePercent) || 0));
      const barState = pct >= 95 ? 'bad' : (pct >= 75 ? 'warn' : 'ok');
      const bound = Array.isArray(u.boundDevices) ? u.boundDevices : [];
      const devChips = bound.length
        ? bound.map(d =>
            '<div class="hub-bound-chip ' + (d.connected ? 'on' : 'off') + '">' +
              '<span class="dot"></span>' +
              '<b>' + esc(d.deviceName) + '</b>' +
              '<em>' + esc(d.os || 'Guest') + (d.primaryIp ? (' · ' + esc(d.primaryIp)) : '') + '</em>' +
              '<button type="button" class="chip-x" data-hub-act="unbind-device" data-dev-id="' + esc(d.id) + '" title="解绑该客机">×</button>' +
            '</div>'
          ).join('')
        : '<span class="hub-no-dev">尚未绑定客机（客机端使用此账号登录后将自动归属到此处，或在「远程设备」手动绑定）</span>';

      return '<article class="hub-user-card' + (u.enabled ? '' : ' disabled') + '" data-uid="' + u.id + '">' +
        '<div class="hub-user-top">' +
          '<div>' +
            '<div class="hub-user-title"><h3>' + esc(u.displayName || u.username) + '</h3><code>@' + esc(u.username) + '</code>' +
              '<span class="badge" data-state="' + (u.enabled ? 'ok' : 'bad') + '">' + (u.enabled ? '已启用' : '已禁用') + '</span>' +
              '<span class="hub-dev-count-pill">绑定客机 ' + bound.length + ' 台</span>' +
            '</div>' +
            (u.notes ? '<div class="hub-user-note">' + esc(u.notes) + '</div>' : '') +
          '</div>' +
          '<div class="hub-key-box">' +
            '<code title="个人专属 API Key">' + esc(u.apiKeyPrefix || (u.apiKey ? u.apiKey.slice(0, 14) + '…' : '—')) + '</code>' +
            '<button class="btn ghost tiny" type="button" data-hub-act="copy-key">复制 Key</button>' +
            '<button class="btn ghost tiny" type="button" data-hub-act="rotate-key">轮换 Key</button>' +
          '</div>' +
        '</div>' +
        '<div class="hub-quota-row">' +
          '<div class="hub-bar-meta"><span>7×24h 滚动额度：<b>' + fmtCompact(quota.usedWeighted) + '</b> / ' + fmtCompact(quota.weeklyLimit) + '</span><span>剩余 ' + fmtCompact(quota.remainingWeighted) + ' · 模型权限 ' + (u.allowedModelCount || 0) + '/' + (u.totalActiveModelCount || 0) + ' (' + (u.modelAccessMode === 'allow_list' ? '白名单' : '黑名单') + ')</span></div>' +
          '<div class="hub-bar-track"><div class="hub-bar-fill ' + barState + '" style="width:' + pct + '%"></div></div>' +
        '</div>' +
        '<div class="hub-bound-section">' +
          '<div class="hub-bound-label">归属该账号的客机设备（支持 1 账号多客机）：</div>' +
          '<div class="hub-bound-list">' + devChips + '</div>' +
        '</div>' +
        '<div class="hub-user-actions">' +
          '<button class="btn ghost tiny" type="button" data-hub-act="edit-user">编辑账号/限额</button>' +
          '<button class="btn ghost tiny" type="button" data-hub-act="edit-acl">模型权限</button>' +
          '<button class="btn ghost tiny" type="button" data-hub-act="reset-pw">重置密码</button>' +
          '<button class="btn ghost tiny" type="button" data-hub-act="reset-quota">清空本周用量</button>' +
          '<button class="btn ghost tiny" type="button" data-hub-act="toggle-user">' + (u.enabled ? '禁用账号' : '启用账号') + '</button>' +
          '<button class="btn ghost tiny danger" type="button" data-hub-act="delete-user">删除</button>' +
        '</div>' +
      '</article>';
    }).join('');

    // Refresh usage filter user dropdown
    const sel = $('#hubUsageUserFilter');
    if (sel) {
      const cur = sel.value;
      sel.innerHTML = '<option value="">全部账号</option>' +
        HS.users.map(u => '<option value="' + u.id + '">' + esc((u.displayName || u.username) + ' (@' + u.username + ')') + '</option>').join('');
      sel.value = cur;
    }
  }

  function renderModels() {
    const body = $('#hubModelsBody');
    if (!body) return;
    const q = (HS.modelSearch || '').trim().toLowerCase();
    const list = HS.models.filter(m => !q || String(m.id || '').toLowerCase().includes(q) || String(m.displayName || '').toLowerCase().includes(q));
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="6" class="hub-empty">暂无模型，点击「同步上游模型」拉取</td></tr>';
      return;
    }
    body.innerHTML = list.map(m => {
      const efforts = Array.isArray(m.supportedReasoningEfforts) && m.supportedReasoningEfforts.length
        ? m.supportedReasoningEfforts.join('/')
        : '默认';
      return '<tr data-mid="' + esc(m.id) + '">' +
        '<td><b>' + esc(m.displayName || m.id) + '</b><br><code class="hub-sub-code">' + esc(m.id) + '</code></td>' +
        '<td>' + esc(m.ownedBy || '—') + '</td>' +
        '<td><span class="hub-effort-tag">' + esc(efforts) + '</span></td>' +
        '<td><div class="hub-mult-edit"><input type="number" step="0.1" min="0" value="' + esc(m.multiplier) + '" class="input tiny-num" data-mult-input><button class="btn ghost tiny" type="button" data-hub-act="save-mult">保存</button></div></td>' +
        '<td>' + fmtCompact(m.usedWeighted7d || 0) + ' / ' + fmtNum(m.requests7d || 0) + '次</td>' +
        '<td><button class="btn ' + (m.globalEnabled ? 'primary' : 'ghost') + ' tiny" type="button" data-hub-act="toggle-model">' + (m.globalEnabled ? '已启用' : '已禁用') + '</button></td>' +
      '</tr>';
    }).join('');
  }

  async function loadUsage() {
    const body = $('#hubUsageBody');
    if (!body) return;
    try {
      const qs = new URLSearchParams({ limit: '100' });
      if (HS.usageUserFilter) qs.set('userId', HS.usageUserFilter);
      const res = await api('/api/hub/admin/usage?' + qs.toString());
      HS.usageLogs = Array.isArray(res.logs) ? res.logs : [];
      HS.usageTotal = Number(res.total) || 0;
      if (!HS.usageLogs.length) {
        body.innerHTML = '<tr><td colspan="6" class="hub-empty">暂无调用流水</td></tr>';
        return;
      }
      body.innerHTML = HS.usageLogs.map(l =>
        '<tr>' +
          '<td>' + esc(fmtTime(l.createdAt)) + '</td>' +
          '<td><b>' + esc(l.displayName || l.username || ('#' + l.userId)) + '</b></td>' +
          '<td><code>' + esc(l.modelId) + '</code></td>' +
          '<td>' + fmtNum(l.totalTokens) + ' × ' + esc(l.multiplier) + 'x = <b>' + fmtNum(l.weightedTokens) + '</b></td>' +
          '<td><span class="badge" data-state="' + (l.statusCode < 400 ? 'ok' : 'bad') + '">' + esc(l.statusCode) + '</span></td>' +
          '<td>' + esc(l.latencyMs) + ' ms</td>' +
        '</tr>'
      ).join('');
    } catch (err) {
      body.innerHTML = '<tr><td colspan="6" class="hub-empty">' + esc(err.message) + '</td></tr>';
    }
  }

  function renderSettings() {
    const s = HS.settings;
    if (s) {
      if ($('#hubSetUpstreamUrl')) $('#hubSetUpstreamUrl').value = s.upstreamBaseUrl || '';
      if ($('#hubSetPublicUrl')) $('#hubSetPublicUrl').value = s.publicBaseUrl || '';
      if ($('#hubSetDefaultLimit')) $('#hubSetDefaultLimit').value = String(s.defaultWeeklyTokenLimit || 1000000);
      if ($('#hubSetKeyMask')) $('#hubSetKeyMask').textContent = s.hasUpstreamApiKey ? ('当前已配置：' + s.upstreamApiKeyMasked) : '尚未配置上游 API Key';
    }
    const hb = HS.hostBinding;
    const hbSummary = $('#hubHostBindingSummary');
    if (hbSummary) {
      if (hb && hb.publicKey) {
        hbSummary.textContent = '已同步主机：' + (hb.hostName || '本机') + ' · 通道数 ' + ((hb.endpoints || []).length) + (hb.zerotierNetworkId ? (' · ZeroTier ' + hb.zerotierNetworkId) : '') + ' · 更新于 ' + fmtTime(hb.updatedAt);
      } else {
        hbSummary.textContent = '尚未将本机主机 SSH 公钥与连接地址同步到网关；点击「同步主机配对信息到网关」后，客机端登录账号即可自动接入本机。';
      }
    }
  }

  // ---------- Modals ----------

  function openUserModal(user) {
    HS.editingUserId = user ? user.id : 0;
    $('#hubUserModalTitle').textContent = user ? ('编辑账号：' + user.username) : '新建账号并分发 API Key';
    $('#huUsername').value = user ? user.username : '';
    $('#huDisplayName').value = user ? (user.displayName || '') : '';
    $('#huPassword').value = '';
    $('#huPasswordRow').hidden = Boolean(user);
    $('#huLimit').value = String(user ? user.weeklyTokenLimit : (HS.settings ? HS.settings.defaultWeeklyTokenLimit : 1000000));
    $('#huNotes').value = user ? (user.notes || '') : '';
    $('#huError').hidden = true;
    $('#hubUserModal').hidden = false;
    document.body.classList.add('modal-open');
  }

  async function saveUserModal() {
    const errEl = $('#huError');
    errEl.hidden = true;
    const username = $('#huUsername').value.trim();
    const displayName = $('#huDisplayName').value.trim();
    const password = $('#huPassword').value;
    const weeklyTokenLimit = Number($('#huLimit').value);
    const notes = $('#huNotes').value.trim();

    try {
      if (HS.editingUserId) {
        await reqJson('PATCH', '/api/hub/admin/users/' + HS.editingUserId, { username, displayName, weeklyTokenLimit, notes });
        notify('账号已更新', 'ok');
      } else {
        const res = await reqJson('POST', '/api/hub/admin/users', { username, displayName, password, weeklyTokenLimit, notes, enabled: true, modelAccessMode: 'all_except_denied' });
        notify('账号已创建并生成专属 API Key：' + (res.user && res.user.apiKeyPrefix || ''), 'ok', 4500);
      }
      if (typeof window.closeModal === 'function') window.closeModal('hubUserModal');
      else $('#hubUserModal').hidden = true;
      await refreshDashboard();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  }

  function openAclModal(user) {
    HS.aclUserId = user.id;
    HS.aclMode = user.modelAccessMode || 'all_except_denied';
    $('#hubAclTitle').textContent = '配置模型权限：' + (user.displayName || user.username);
    $('#hubAclMode').value = HS.aclMode;
    const overrides = user.modelOverrides || {};
    const set = new Set();
    for (const m of HS.models) {
      if (!m.globalEnabled) continue;
      const ov = overrides[m.id];
      const allowed = HS.aclMode === 'allow_list' ? ov === true : ov !== false;
      if (allowed) set.add(m.id);
    }
    HS.aclAllowedSet = set;
    renderAclList();
    $('#hubAclModal').hidden = false;
    document.body.classList.add('modal-open');
  }

  function renderAclList() {
    const box = $('#hubAclList');
    if (!box) return;
    const enabledModels = HS.models.filter(m => m.globalEnabled);
    box.innerHTML = enabledModels.map(m => {
      const checked = HS.aclAllowedSet.has(m.id) ? ' checked' : '';
      return '<label class="agent-check"><input type="checkbox" value="' + esc(m.id) + '"' + checked + '>' +
        '<span><b>' + esc(m.displayName || m.id) + '</b><em>' + esc(m.id) + ' · ' + esc(m.multiplier) + 'x</em></span></label>';
    }).join('') || '<div class="hub-empty">暂无全局启用的模型</div>';
  }

  async function saveAclModal() {
    const mode = $('#hubAclMode').value === 'allow_list' ? 'allow_list' : 'all_except_denied';
    const checked = new Set($$('#hubAclList input[type="checkbox"]:checked').map(el => el.value));
    const overrides = {};
    for (const m of HS.models) {
      if (!m.globalEnabled) continue;
      if (mode === 'allow_list') {
        if (checked.has(m.id)) overrides[m.id] = true;
      } else {
        if (!checked.has(m.id)) overrides[m.id] = false;
      }
    }
    try {
      await reqJson('PUT', '/api/hub/admin/users/' + HS.aclUserId + '/models', { modelAccessMode: mode, overrides });
      notify('模型权限已更新并实时推送至客户端', 'ok');
      if (typeof window.closeModal === 'function') window.closeModal('hubAclModal');
      else $('#hubAclModal').hidden = true;
      await refreshDashboard();
    } catch (err) {
      notify(err.message, 'error');
    }
  }

  // Open Bind-Account modal from 「远程设备 · 客机」 device card!
  async function openBindDeviceModal(localDevice) {
    HS.bindTargetLocalDevice = localDevice;
    $('#hubBindDevTitle').textContent = '绑定客机所属账号：' + (localDevice.name || localDevice.host);
    $('#hubBindError').hidden = true;
    if (!HS.loggedIn) {
      await loadHubState();
    }
    if (!HS.loggedIn) {
      notify('请先在「API 分发与账号」页登录唯一管理员账号，再为客机绑定归属账号', 'warn', 4500);
      if (typeof window.setView === 'function') window.setView('hub');
      return;
    }
    if (!HS.users.length) {
      try {
        const res = await api('/api/hub/admin/users');
        HS.users = Array.isArray(res.users) ? res.users : [];
      } catch { }
    }
    const sel = $('#hubBindAccountSelect');
    sel.innerHTML = '<option value="">— 暂不绑定 / 解除账号归属 —</option>' +
      HS.users.map(u => {
        const count = (u.boundDevices || []).length;
        return '<option value="' + u.id + '">' + esc((u.displayName || u.username) + ' (@' + u.username + ') · 已绑定 ' + count + ' 台客机' + (u.enabled ? '' : ' [已禁用]')) + '</option>';
      }).join('');
    sel.value = localDevice.accountId ? String(localDevice.accountId) : '';
    $('#hubBindDevModal').hidden = false;
    document.body.classList.add('modal-open');
  }

  async function saveBindDeviceModal() {
    const dev = HS.bindTargetLocalDevice;
    if (!dev) return;
    const errEl = $('#hubBindError');
    errEl.hidden = true;
    const userIdVal = $('#hubBindAccountSelect').value;
    try {
      await reqJson('POST', '/api/devices/bind-account', {
        deviceId: dev.id,
        userId: userIdVal ? Number(userIdVal) : 0
      });
      notify(userIdVal ? '客机已成功绑定到目标账号' : '已解除客机的账号绑定', 'ok');
      if (typeof window.closeModal === 'function') window.closeModal('hubBindDevModal');
      else $('#hubBindDevModal').hidden = true;
      if (window.SmacRemote) window.SmacRemote.loadDevices();
      if (HS.loggedIn) refreshDashboard();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  }

  function wire() {
    if (HS.initialized) return;
    HS.initialized = true;

    const form = $('#hubLoginForm');
    if (form) {
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const errBox = $('#hubLoginError');
        if (errBox) errBox.hidden = true;
        const serverUrl = $('#hubGatewayUrl').value.trim();
        const username = $('#hubAdminUserInput').value.trim();
        const password = $('#hubAdminPassInput').value;
        const btn = $('#btnHubLogin');
        btn.disabled = true;
        btn.textContent = '登录中…';
        try {
          const res = await reqJson('POST', '/api/hub/login', { serverUrl, username, password });
          HS.loggedIn = true;
          HS.serverUrl = res.serverUrl || serverUrl;
          HS.adminUsername = (res.admin && res.admin.username) || username;
          $('#hubAdminPassInput').value = '';
          renderAuthVisibility();
          notify('唯一管理员登录成功，已自动同步主机配对配置与账号客机列表', 'ok', 3600);
          await refreshDashboard();
          if (window.SmacRemote) window.SmacRemote.loadDevices();
        } catch (err) {
          if (errBox) {
            errBox.textContent = err.message;
            errBox.hidden = false;
          }
        } finally {
          btn.disabled = false;
          btn.textContent = '登录唯一管理员控制台';
        }
      });
    }

    if ($('#hubGatewayUrl')) {
      $('#hubGatewayUrl').addEventListener('change', checkHealthQuiet);
    }

    if ($('#btnHubLogout')) {
      $('#btnHubLogout').addEventListener('click', async () => {
        await reqJson('POST', '/api/hub/logout', {}).catch(() => {});
        HS.loggedIn = false;
        renderAuthVisibility();
        notify('已退出管理员会话', 'info');
      });
    }

    if ($('#btnHubRefresh')) {
      $('#btnHubRefresh').addEventListener('click', async () => {
        await reqJson('POST', '/api/hub/sync-devices', {}).catch(() => {});
        await refreshDashboard();
        if (window.SmacRemote) window.SmacRemote.loadDevices();
        notify('已刷新 API 分发状态与账号客机绑定', 'ok', 1800);
      });
    }

    if ($('#btnHubSyncHostBinding')) {
      $('#btnHubSyncHostBinding').addEventListener('click', async () => {
        try {
          await reqJson('POST', '/api/hub/sync-host-binding', {});
          notify('已将本机主机 SSH 公钥、多网卡地址与 ZeroTier 组号发布到网关', 'ok', 3500);
          await refreshDashboard();
        } catch (err) {
          notify(err.message, 'error');
        }
      });
    }

    if ($('#hubSubTabs')) {
      $('#hubSubTabs').addEventListener('click', e => {
        const btn = e.target.closest('.seg');
        if (btn && btn.dataset.hubTab) setSubTab(btn.dataset.hubTab);
      });
    }

    if ($('#btnHubNewUser')) $('#btnHubNewUser').addEventListener('click', () => openUserModal(null));
    if ($('#btnHubUserSave')) $('#btnHubUserSave').addEventListener('click', saveUserModal);
    if ($('#btnHubAclSave')) $('#btnHubAclSave').addEventListener('click', saveAclModal);
    if ($('#btnHubBindSave')) $('#btnHubBindSave').addEventListener('click', saveBindDeviceModal);

    if ($('#hubUserSearch')) {
      $('#hubUserSearch').addEventListener('input', e => {
        HS.userSearch = e.target.value;
        renderUsers();
      });
    }
    if ($('#hubModelSearch')) {
      $('#hubModelSearch').addEventListener('input', e => {
        HS.modelSearch = e.target.value;
        renderModels();
      });
    }
    if ($('#hubUsageUserFilter')) {
      $('#hubUsageUserFilter').addEventListener('change', e => {
        HS.usageUserFilter = e.target.value;
        loadUsage();
      });
    }

    if ($('#hubUserGrid')) {
      $('#hubUserGrid').addEventListener('click', async e => {
        const btn = e.target.closest('[data-hub-act]');
        if (!btn) return;
        const act = btn.dataset.hubAct;
        const card = e.target.closest('.hub-user-card');
        const uid = card ? Number(card.dataset.uid) : 0;
        const user = HS.users.find(u => u.id === uid);

        if (act === 'unbind-device') {
          const devId = btn.dataset.devId;
          if (!devId) return;
          try {
            await reqJson('DELETE', '/api/hub/admin/devices/' + encodeURIComponent(devId));
            notify('已解绑客机设备', 'ok');
            await reqJson('POST', '/api/hub/sync-devices', {}).catch(() => {});
            await refreshDashboard();
            if (window.SmacRemote) window.SmacRemote.loadDevices();
          } catch (err) {
            notify(err.message, 'error');
          }
          return;
        }
        if (!user) return;
        if (act === 'copy-key') {
          copyText(user.apiKey, user.username + ' 的 API Key');
        } else if (act === 'rotate-key') {
          const ok = window.confirmDialog ? await window.confirmDialog('轮换 API Key', '确定为 <b>' + esc(user.username) + '</b> 生成新的 API Key 吗？旧 Key 将立即失效。', '轮换') : true;
          if (!ok) return;
          try {
            const r = await reqJson('POST', '/api/hub/admin/users/' + user.id + '/rotate-key', {});
            copyText(r.apiKey, '新 API Key');
            await refreshDashboard();
          } catch (err) { notify(err.message, 'error'); }
        } else if (act === 'edit-user') {
          openUserModal(user);
        } else if (act === 'edit-acl') {
          openAclModal(user);
        } else if (act === 'reset-pw') {
          const pw = window.prompt('为账号 ' + user.username + ' 设置新密码（至少 4 位）：');
          if (!pw) return;
          try {
            await reqJson('POST', '/api/hub/admin/users/' + user.id + '/reset-password', { password: pw });
            notify('密码已重置', 'ok');
          } catch (err) { notify(err.message, 'error'); }
        } else if (act === 'reset-quota') {
          const ok = window.confirmDialog ? await window.confirmDialog('清空本周用量', '确定清空 <b>' + esc(user.username) + '</b> 近 7 天的加权消耗记录吗？', '清空') : true;
          if (!ok) return;
          try {
            await reqJson('POST', '/api/hub/admin/users/' + user.id + '/reset-quota', {});
            notify('已清空本周滚动用量', 'ok');
            await refreshDashboard();
          } catch (err) { notify(err.message, 'error'); }
        } else if (act === 'toggle-user') {
          try {
            await reqJson('PATCH', '/api/hub/admin/users/' + user.id, { enabled: !user.enabled });
            notify(user.enabled ? '账号已禁用，其名下客户端会话已立即失效' : '账号已重新启用', 'ok');
            await refreshDashboard();
            if (window.SmacRemote) window.SmacRemote.loadDevices();
          } catch (err) { notify(err.message, 'error'); }
        } else if (act === 'delete-user') {
          const ok = window.confirmDialog ? await window.confirmDialog('删除账号', '确定永久删除账号 <b>' + esc(user.username) + '</b> 及其全部客机绑定和流水记录吗？', '删除') : true;
          if (!ok) return;
          try {
            await reqJson('DELETE', '/api/hub/admin/users/' + user.id);
            notify('账号已删除', 'ok');
            await refreshDashboard();
            if (window.SmacRemote) window.SmacRemote.loadDevices();
          } catch (err) { notify(err.message, 'error'); }
        }
      });
    }

    if ($('#btnHubSyncModels')) {
      $('#btnHubSyncModels').addEventListener('click', async () => {
        const btn = $('#btnHubSyncModels');
        btn.disabled = true;
        btn.textContent = '同步中…';
        try {
          const r = await reqJson('POST', '/api/hub/admin/models/sync', {});
          notify('上游模型同步完成：共 ' + (r.syncedCount || 0) + ' 个，新增 ' + (r.addedCount || 0) + ' 个', 'ok');
          await refreshDashboard();
        } catch (err) {
          notify(err.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = '同步上游模型';
        }
      });
    }

    if ($('#hubModelsBody')) {
      $('#hubModelsBody').addEventListener('click', async e => {
        const btn = e.target.closest('[data-hub-act]');
        if (!btn) return;
        const tr = e.target.closest('tr[data-mid]');
        if (!tr) return;
        const mid = tr.dataset.mid;
        const model = HS.models.find(m => m.id === mid);
        if (!model) return;
        if (btn.dataset.hubAct === 'save-mult') {
          const val = Number(tr.querySelector('[data-mult-input]').value);
          try {
            await reqJson('PATCH', '/api/hub/admin/models/' + encodeURIComponent(mid), { multiplier: val });
            notify(mid + ' 倍率已设为 ' + val + 'x', 'ok');
            await refreshDashboard();
          } catch (err) { notify(err.message, 'error'); }
        } else if (btn.dataset.hubAct === 'toggle-model') {
          try {
            await reqJson('PATCH', '/api/hub/admin/models/' + encodeURIComponent(mid), { globalEnabled: !model.globalEnabled });
            notify(mid + (model.globalEnabled ? ' 已全局禁用' : ' 已全局启用'), 'ok');
            await refreshDashboard();
          } catch (err) { notify(err.message, 'error'); }
        }
      });
    }

    if ($('#btnHubSaveSettings')) {
      $('#btnHubSaveSettings').addEventListener('click', async () => {
        try {
          const payload = {
            upstreamBaseUrl: $('#hubSetUpstreamUrl').value.trim(),
            publicBaseUrl: $('#hubSetPublicUrl').value.trim(),
            defaultWeeklyTokenLimit: Number($('#hubSetDefaultLimit').value)
          };
          const newKey = $('#hubSetUpstreamKey').value.trim();
          if (newKey) payload.upstreamApiKey = newKey;
          await reqJson('PUT', '/api/hub/admin/settings', payload);
          $('#hubSetUpstreamKey').value = '';
          notify('网关配置已保存', 'ok');
          await refreshDashboard();
        } catch (err) {
          notify(err.message, 'error');
        }
      });
    }

    if ($('#btnHubChangeAdminPw')) {
      $('#btnHubChangeAdminPw').addEventListener('click', async () => {
        const cur = $('#hubCurAdminPw').value;
        const next = $('#hubNewAdminPw').value;
        if (!cur || !next) { notify('请输入当前密码和新密码', 'warn'); return; }
        try {
          await reqJson('POST', '/api/hub/admin/password', { currentPassword: cur, newPassword: next });
          $('#hubCurAdminPw').value = '';
          $('#hubNewAdminPw').value = '';
          notify('唯一管理员密码已修改，旧会话已自动失效', 'ok');
        } catch (err) {
          notify(err.message, 'error');
        }
      });
    }
  }

  function activate() {
    wire();
    loadHubState();
  }

  window.SmacHub = {
    init: wire,
    activate,
    openBindDeviceModal,
    refreshDashboard
  };
})();
