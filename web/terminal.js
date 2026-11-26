'use strict';

// 远程设备与网页终端的前端控制器。
// 依赖：xterm.js、FitAddon；后端 /api/devices 与 /ws/ssh。

(function () {
  const RS = {
    devices: [],
    available: true,
    sessions: new Map(),
    active: '',
    seq: 0,
    editing: null,
    auth: 'key',
    pending: null,
    loaded: false,
    initialized: false,
    scrollLock: null
  };

  const TERM_THEME = {
    background: '#080b12',
    foreground: '#dde6f5',
    cursor: '#6ee7cf',
    cursorAccent: '#080b12',
    selectionBackground: 'rgba(106, 168, 255, 0.30)',
    black: '#1c2331',
    red: '#ff7088',
    green: '#3fd8a4',
    yellow: '#f2b64a',
    blue: '#6aa8ff',
    magenta: '#a78bfa',
    cyan: '#6ee7cf',
    white: '#dde6f5',
    brightBlack: '#6c7891',
    brightRed: '#ff92a6',
    brightGreen: '#7bf0cb',
    brightYellow: '#ffd27a',
    brightBlue: '#9cc6ff',
    brightMagenta: '#c3b2ff',
    brightCyan: '#9df3e3',
    brightWhite: '#f3f7ff'
  };

  const STATUS_TEXT = {
    idle: '未连接',
    'waiting-secret': '等待凭据',
    connecting: '连接中',
    fallback: '切换备用地址',
    authenticated: '认证成功',
    connected: '已连接',
    closed: '已断开',
    error: '连接失败'
  };

  const STATUS_DOT = {
    idle: 'off',
    'waiting-secret': 'warn',
    connecting: 'warn',
    fallback: 'warn',
    authenticated: 'warn',
    connected: 'ok',
    closed: 'off',
    error: 'error'
  };

  const $ = selector => document.querySelector(selector);
  const $$ = selector => Array.from(document.querySelectorAll(selector));

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function api(path, options) {
    const response = await fetch(path, options);
    let data = null;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      const error = new Error((data && (data.output || data.message)) || '请求失败 (' + response.status + ')');
      error.payload = data;
      throw error;
    }
    return data;
  }

  function post(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  function notify(message, kind, duration) {
    if (typeof window.toast === 'function') window.toast(message, kind, duration);
    else console.log('[' + (kind || 'info') + '] ' + message);
  }

  function relativeTime(value) {
    if (typeof window.relative === 'function') return window.relative(value);
    if (!value) return '';
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return '';
    const seconds = Math.round((Date.now() - time) / 1000);
    if (seconds < 60) return '刚刚';
    if (seconds < 3600) return Math.round(seconds / 60) + ' 分钟前';
    if (seconds < 86400) return Math.round(seconds / 3600) + ' 小时前';
    return Math.round(seconds / 86400) + ' 天前';
  }

  function ask(title, html, okLabel) {
    if (typeof window.confirmDialog === 'function') return window.confirmDialog(title, html, okLabel);
    return Promise.resolve(window.confirm(title));
  }

  // ---------- 设备列表 ----------

  async function loadDevices() {
    try {
      const data = await api('/api/devices');
      RS.devices = Array.isArray(data.devices) ? data.devices : [];
      RS.available = data.available !== false;
      RS.loaded = true;
      renderDevices();
    } catch (error) {
      notify(error.message, 'error');
      RS.available = false;
      renderDevices();
    }
  }

  function sessionFor(deviceId) {
    for (const session of RS.sessions.values()) {
      if (session.device.id === deviceId) return session;
    }
    return null;
  }

  function deviceStatus(device) {
    const session = sessionFor(device.id);
    if (session) return session.status;
    return 'idle';
  }

  function osTag(os) {
    if (!os) return '';
    return '<span class="tag os-tag" data-os="' + esc(os) + '">' + esc(os) + '</span>';
  }

  function cardHtml(device) {
    const status = deviceStatus(device);
    const connected = status === 'connected';
    const isGuestDisc = !connected && status === 'idle' && Boolean(device.guestDisconnected);
    const badgeState = connected ? 'ok' : (isGuestDisc ? 'bad' : (status === 'connecting' || status === 'fallback' || status === 'authenticated' || status === 'waiting-secret' ? 'warn' : (status === 'error' ? 'bad' : 'off')));
    const badgeText = isGuestDisc ? '客机已断联' : (status === 'idle' ? '未连接' : (STATUS_TEXT[status] || '未连接'));
    const avatar = (device.os === 'macOS' ? 'M' : (device.os === 'Windows' ? 'W' : (device.os === 'Linux' ? 'L' : esc((device.name || '?').slice(0, 1).toUpperCase()))));
    const fingerprint = device.hostFingerprint
      ? '<span class="tag fp-tag" title="' + esc(device.hostFingerprint) + '">指纹已固定</span>'
      : '<span class="tag fp-tag pending" title="首次连接成功后会记录">首次连接记录指纹</span>';
    const fallback = device.fallbackHost ? '<span class="tag">双地址</span>' : '';
    const ztTag = device.zerotierIp
      ? '<span class="tag zt-tag" title="ZeroTier 穿透 IP（节点 ' + esc(device.zerotierNodeId || '-') + '）">ZT · ' + esc(device.zerotierIp) + '</span>'
      : (device.zerotierStatus === 'ACCESS_DENIED'
        ? '<span class="tag zt-tag warn" title="请在 ZeroTier 后台勾选授权节点 ' + esc(device.zerotierNodeId || '') + '">ZT 待授权 · ' + esc(device.zerotierNodeId || '') + '</span>'
        : '');
    const savedPassword = device.auth === 'password' && device.hasPassword
      ? '<span class="tag" title="明文保存在本机，用于后台同步和发送">密码已保存</span>'
      : '';
    const accountTag = device.accountUsername
      ? '<span class="tag account-tag' + (device.accountEnabled === false ? ' bad' : '') + '" title="归属账号：' + esc((device.accountDisplayName || device.accountUsername) + ' (@' + device.accountUsername + ')') + '">' +
          '所属账号 · ' + esc(device.accountDisplayName || device.accountUsername) + ' (@' + esc(device.accountUsername) + ')' + (device.accountEnabled === false ? ' [已禁用]' : '') +
        '</span>'
      : '<span class="tag account-tag unbound" title="尚未绑定到任何用户账号，点击下方「绑定账号」进行分配">未绑定账号</span>';
    const last = device.lastConnectedAt
      ? '上次连接 ' + esc(relativeTime(device.lastConnectedAt))
      : (device.lastError ? esc(device.lastError) : '尚未连接');
    const env = device.guestEnv && typeof device.guestEnv === 'object' ? device.guestEnv : null;
    const cliNames = env && Array.isArray(env.cli)
      ? env.cli.filter(x => x && x.installed).map(x => x.name)
      : [];
    const desktopNames = env && Array.isArray(env.desktop)
      ? env.desktop.filter(x => x && x.installed).map(x => x.name)
      : [];
    const envHtml = env
      ? '<div class="device-env-box">' +
          '<div class="device-env-row"><span class="env-k">Desktop</span><span class="env-v">' +
            (desktopNames.length ? desktopNames.map(n => '<b>' + esc(n) + '</b>').join(' · ') : '<em>未检测到桌面端</em>') +
          '</span></div>' +
          '<div class="device-env-row"><span class="env-k">CLI</span><span class="env-v">' +
            (cliNames.length ? cliNames.map(n => '<b>' + esc(n) + '</b>').join(' · ') : '<em>可自动安装</em>') +
          '</span></div>' +
        '</div>'
      : '<div class="device-env-box empty"><span>尚未探测客机 CLI / Desktop 环境</span><button class="link-inline" type="button" data-action="detect-env">立即探测</button></div>';

    return '' +
      '<article class="device-card" data-id="' + esc(device.id) + '" data-connected="' + (connected ? 'true' : 'false') + '">' +
        '<div class="device-top">' +
          '<div class="device-avatar" data-os="' + esc(device.os || '') + '">' + avatar + '</div>' +
          '<div class="device-title">' +
            '<h3>' + esc(device.name) + '</h3>' +
            '<div class="device-sub"><code>' + esc(device.user) + '@' + esc(device.host) + ':' + esc(device.port) + '</code></div>' +
          '</div>' +
          '<span class="badge" data-state="' + badgeState + '">' + badgeText + '</span>' +
        '</div>' +
        '<div class="device-tags">' +
          accountTag +
          osTag(device.os) +
          '<span class="tag"><svg><use href="#i-' + (device.auth === 'password' ? 'shield' : 'key') + '"/></svg>' + (device.auth === 'password' ? '密码' : '私钥') + '</span>' +
          savedPassword +
          ztTag +
          fallback + fingerprint +
        '</div>' +
        envHtml +
        '<div class="device-note' + (device.lastError && !device.lastConnectedAt ? ' bad' : '') + '">' + last + '</div>' +
        '<div class="device-quick-row">' +
          '<button class="btn ghost tiny" data-action="bind-account" title="为该客机分配或切换归属账号（支持同一账号下绑定多台客机）"><svg><use href="#i-shield"/></svg>' + (device.accountUsername ? '换绑账号' : '绑定账号') + '</button>' +
          '<button class="btn ghost tiny" data-action="sync-add" title="由本机确定与该客机同步的文件夹"><svg><use href="#i-folder"/></svg>定同步目录</button>' +
          '<button class="btn ghost tiny" data-action="send-desktop" title="发送文件或文件夹到该客机桌面"><svg><use href="#i-send"/></svg>发到客机桌面</button>' +
          '<button class="btn ghost tiny" data-action="open-agent" title="后台无头复用该客机的 CLI 或桌面端订阅操作同步文件夹"><svg><use href="#i-server"/></svg>无头 Agent</button>' +
          '<button class="btn ghost tiny" data-action="zt-join" title="远程检查/安装 ZeroTier 并加入当前穿透组，自动回填外网 IP"><svg><use href="#i-link"/></svg>同组 ZeroTier</button>' +
        '</div>' +
        '<div class="device-actions">' +
          '<button class="btn primary small" data-action="connect"><svg><use href="#i-terminal"/></svg>' + (connected ? '打开终端' : 'SSH 终端') + '</button>' +
          '<button class="btn ghost small" data-action="install-tools" title="选择并远程给该客机安装 CLI 与 Desktop（官方默认目录）">装软件</button>' +
          '<button class="btn ghost small" data-action="detect-env" title="检测客机本地 CLI 与 Desktop 环境">探环境</button>' +
          '<button class="btn ghost small" data-action="test">测试</button>' +
          '<button class="btn ghost small" data-action="edit">编辑</button>' +
          '<button class="btn ghost small icon" data-action="delete" title="删除设备"><svg><use href="#i-trash"/></svg></button>' +
        '</div>' +
      '</article>';
  }

  function renderDevices() {
    const grid = $('#deviceGrid');
    const empty = $('#deviceEmpty');
    const notice = $('#remoteUnavailable');
    if (!grid || !empty) return;
    if (notice) notice.hidden = RS.available;
    grid.innerHTML = RS.devices.map(cardHtml).join('');
    grid.hidden = RS.devices.length === 0;
    empty.hidden = RS.devices.length > 0;
  }

  // ---------- 会话与终端 ----------

  function createSession(device) {
    if (typeof Terminal !== 'function' || typeof FitAddon === 'undefined') {
      notify('终端组件加载失败，请刷新页面后重试', 'error');
      return null;
    }
    const id = 's' + (++RS.seq);
    const tabs = $('#termTabs');
    const stage = $('#termStage');

    const tab = document.createElement('div');
    tab.className = 'term-tab';
    tab.dataset.session = id;
    tab.setAttribute('role', 'tab');
    tab.tabIndex = 0;
    tab.innerHTML = '<span class="term-tab-dot" data-state="off"></span>' +
      '<span class="term-tab-name">' + esc(device.name) + '</span>' +
      '<span class="term-tab-close" role="button" title="关闭会话">×</span>';
    tabs.appendChild(tab);

    const pane = document.createElement('div');
    pane.className = 'term-pane';
    pane.dataset.session = id;
    stage.appendChild(pane);

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Consolas, "Microsoft YaHei UI", monospace',
      fontSize: 14,
      lineHeight: 1.28,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 12000,
      tabStopWidth: 4,
      theme: TERM_THEME
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(pane);
    term.write('\x1b[38;5;244m[smac] 正在建立 SSH 会话 · ' + device.user + '@' + device.host + '\x1b[0m\r\n');

    const session = {
      id,
      device,
      term,
      fit,
      pane,
      tab,
      ws: null,
      status: 'idle',
      credentials: {},
      intentional: false,
      everConnected: false,
      resizeTimer: null
    };
    RS.sessions.set(id, session);

    tab.addEventListener('click', event => {
      if (event.target.closest('.term-tab-close')) {
        event.stopPropagation();
        closeSession(session);
        return;
      }
      activateTab(id);
    });
    tab.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateTab(id);
      }
    });

    term.onData(data => {
      if (session.ws && session.ws.readyState === 1) {
        session.ws.send(JSON.stringify({ type: 'input', data }));
      }
    });
    term.onResize(size => {
      if (!session.ws || session.ws.readyState !== 1) return;
      clearTimeout(session.resizeTimer);
      session.resizeTimer = setTimeout(() => {
        if (session.ws && session.ws.readyState === 1) {
          session.ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
        }
      }, 120);
    });
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true;
      if (event.code === 'KeyC' && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => { });
        return false;
      }
      if (event.code === 'KeyV') {
        navigator.clipboard.readText().then(text => { if (text) term.paste(text); }).catch(() => { });
        return false;
      }
      return true;
    });

    activateTab(id);
    updateSessionCount();
    return session;
  }

  function activateTab(id) {
    const session = RS.sessions.get(id);
    if (!session) return;
    RS.active = id;
    $$('.term-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.session === id));
    $$('.term-pane').forEach(pane => pane.classList.toggle('active', pane.dataset.session === id));
    updateHeaderStatus(session);
    requestAnimationFrame(() => {
      if ($('#termOverlay').hidden) return;
      fitSession(session);
      session.term.focus();
    });
  }

  function activeSession() {
    return RS.sessions.get(RS.active) || null;
  }

  function fitSession(session) {
    if (!session) return;
    try { session.fit.fit(); } catch { }
  }

  function fitActive() {
    const session = activeSession();
    if (session) fitSession(session);
  }

  function setStatus(session, status, text) {
    session.status = status;
    updateHeaderStatus(session, text);
    const dot = session.tab.querySelector('.term-tab-dot');
    if (dot) dot.dataset.state = STATUS_DOT[status] || 'off';
    const connected = status === 'connected';
    const card = $('#deviceGrid').querySelector('.device-card[data-id="' + session.device.id + '"]');
    if (card) card.dataset.connected = connected ? 'true' : 'false';
    updateSessionCount();
    renderDevices();
  }

  function updateHeaderStatus(session, text) {
    if (!session || session.id !== RS.active) return;
    const statusEl = $('#termStatus');
    const textEl = $('#termStatusText');
    if (!statusEl || !textEl) return;
    statusEl.dataset.state = STATUS_DOT[session.status] || 'off';
    textEl.textContent = text || STATUS_TEXT[session.status] || session.status;
  }

  function updateSessionCount() {
    const count = RS.sessions.size;
    const badge = $('#remoteCount');
    if (badge) {
      badge.textContent = String(count);
      badge.hidden = count === 0;
    }
    const dock = $('#termDock');
    const dockText = $('#termDockText');
    if (dock && dockText) {
      dockText.textContent = count === 1 ? '终端会话' : '终端 · ' + count;
      dock.hidden = !(count > 0 && $('#termOverlay').hidden);
    }
  }

  function lockScroll() {
    if (RS.scrollLock !== null) return;
    RS.scrollLock = window.scrollY || 0;
    const body = document.body;
    body.style.position = 'fixed';
    body.style.top = '-' + RS.scrollLock + 'px';
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
  }

  function unlockScroll() {
    if (RS.scrollLock === null) return;
    const y = RS.scrollLock;
    RS.scrollLock = null;
    const body = document.body;
    body.style.position = '';
    body.style.top = '';
    body.style.left = '';
    body.style.right = '';
    body.style.width = '';
    window.scrollTo(0, y);
  }

  function openOverlay() {
    lockScroll();
    const overlay = $('#termOverlay');
    if (overlay.hidden) {
      overlay.hidden = false;
      document.body.classList.add('term-open');
    }
    const dock = $('#termDock');
    if (dock) dock.hidden = true;
    requestAnimationFrame(() => {
      fitActive();
      const session = activeSession();
      if (session) session.term.focus();
    });
  }

  function minimizeOverlay() {
    const overlay = $('#termOverlay');
    overlay.hidden = true;
    document.body.classList.remove('term-open');
    unlockScroll();
    updateSessionCount();
  }

  function closeSocket(session) {
    session.intentional = true;
    const ws = session.ws;
    session.ws = null;
    if (ws) {
      try { ws.send(JSON.stringify({ type: 'disconnect' })); } catch { }
      try { ws.close(); } catch { }
    }
  }

  function connectDevice(device) {
    const existing = sessionFor(device.id);
    if (existing) {
      openOverlay();
      activateTab(existing.id);
      if (existing.status === 'closed' || existing.status === 'error') {
        existing.credentials = existing.credentials || {};
        if (existing.device.auth === 'password' && !existing.credentials.password) requestSecret(existing, 'password');
        else startSocket(existing, existing.credentials);
      }
      return;
    }
    const session = createSession(device);
    if (!session) return;
    openOverlay();
    requestAnimationFrame(() => {
      fitSession(session);
      if (device.auth === 'password' && !session.credentials.password) {
        setStatus(session, 'waiting-secret', '等待密码');
        requestSecret(session, 'password');
      } else {
        startSocket(session, {});
      }
    });
  }

  function startSocket(session, credentials) {
    session.credentials = Object.assign({}, session.credentials, credentials || {});
    closeSocket(session);
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host +
      '/ws/ssh?id=' + encodeURIComponent(session.device.id));
    session.ws = ws;
    session.intentional = false;
    setStatus(session, 'connecting', '正在连接 ' + session.device.host);

    ws.onopen = () => {
      if (session.ws !== ws) return;
      const cols = session.term.cols || 100;
      const rows = session.term.rows || 30;
      ws.send(JSON.stringify({
        type: 'connect',
        cols,
        rows,
        password: session.credentials.password || '',
        passphrase: session.credentials.passphrase || ''
      }));
    };
    ws.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      handleMessage(session, message);
    };
    ws.onerror = () => {
      if (session.ws !== ws || session.intentional) return;
      setStatus(session, 'error', '连接出错');
    };
    ws.onclose = () => {
      if (session.ws !== ws) return;
      session.ws = null;
      if (session.intentional) return;
      if (session.status === 'waiting-secret') return;
      if (session.status !== 'closed' && session.status !== 'error') {
        setStatus(session, 'closed', '连接已断开');
      }
    };
  }

  function banner(session, text, kind) {
    const color = kind === 'error' ? '31' : (kind === 'warn' ? '33' : '36');
    const lines = String(text).replace(/\r/g, '').split('\n').map(line => '\x1b[' + color + 'm' + line + '\x1b[0m').join('\r\n');
    session.term.write('\r\n' + lines + '\r\n');
  }

  function handleMessage(session, message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'hello') {
      if (message.device) {
        session.device.name = message.device.name || session.device.name;
        session.device.os = message.device.os || session.device.os;
        const nameEl = session.tab.querySelector('.term-tab-name');
        if (nameEl) nameEl.textContent = session.device.name;
      }
      return;
    }
    if (message.type === 'status') {
      const status = message.status;
      if (status === 'connected') {
        session.everConnected = true;
        const device = RS.devices.find(item => item.id === session.device.id);
        if (device) {
          device.lastConnectedAt = new Date(Date.now() - 2000).toISOString();
          device.lastError = '';
        }
        setStatus(session, 'connected', message.host ? '已连接 · ' + message.host : '已连接');
        requestAnimationFrame(() => fitSession(session));
        if (RS.pending && RS.pending.session === session) hidePrompt();
      } else if (status === 'closed') {
        setStatus(session, 'closed', message.message || '会话已结束');
      } else if (status === 'error') {
        if (session.status !== 'waiting-secret') setStatus(session, 'error', '连接失败');
      } else if (status === 'fallback') {
        setStatus(session, 'fallback', message.message || '切换备用地址');
      } else if (status === 'authenticated') {
        if (!session.everConnected) session.term.write('\x1b[2J\x1b[H');
        setStatus(session, 'authenticated', message.message || '认证成功');
      } else if (status === 'connecting') {
        setStatus(session, 'connecting', message.message || '连接中');
      }
      return;
    }
    if (message.type === 'data') {
      if (typeof message.data === 'string') session.term.write(message.data);
      return;
    }
    if (message.type === 'exit') {
      banner(session, '[进程已退出' + (message.code != null ? '，代码 ' + message.code : '') +
        (message.signal ? '，信号 ' + message.signal : '') + ']', 'muted');
      return;
    }
    if (message.type === 'fingerprint') {
      const device = RS.devices.find(item => item.id === session.device.id);
      if (device && message.fingerprint) {
        device.hostFingerprint = message.fingerprint;
        session.device.hostFingerprint = message.fingerprint;
        renderDevices();
      }
      return;
    }
    if (message.type === 'device') {
      if (message.os) {
        session.device.os = message.os;
        const device = RS.devices.find(item => item.id === session.device.id);
        if (device) device.os = message.os;
        renderDevices();
      }
      return;
    }
    if (message.type === 'error') {
      handleError(session, message);
    }
  }

  function handleError(session, message) {
    const code = message.code || '';
    if (code === 'passphrase-required' || code === 'passphrase-invalid') {
      banner(session, code === 'passphrase-invalid' ? '私钥口令不正确，请重试。' : '私钥已加密，需要输入口令。', 'warn');
      setStatus(session, 'waiting-secret', '等待私钥口令');
      requestSecret(session, 'passphrase');
      return;
    }
    if (code === 'hostkey-mismatch') {
      banner(session,
        '主机密钥与上次记录不一致，已阻止连接。\n' +
        '已记录: ' + (message.expected || '—') + '\n' +
        '本次收到: ' + (message.actual || '—') + '\n' +
        '如果确认服务器重装或更换过密钥，请在「编辑设备 → 主机指纹」中重置后再连接。', 'error');
      setStatus(session, 'error', '主机指纹不一致');
      notify('主机密钥已变化，已阻止连接', 'error', 9000);
      return;
    }
    banner(session, message.message || '连接失败', 'error');
    setStatus(session, 'error', '连接失败');
    notify(message.message || '连接失败', 'error');
  }

  function requestSecret(session, kind) {
    RS.pending = { session, kind };
    activateTab(session.id);
    const prompt = $('#termPrompt');
    const title = $('#termPromptTitle');
    const sub = $('#termPromptSub');
    const input = $('#termSecret');
    title.textContent = kind === 'password' ? '输入 SSH 密码' : '输入私钥口令';
    sub.textContent = kind === 'password'
      ? '密码仅用于本次连接，不会保存'
      : '口令仅用于本次连接，不会保存';
    input.value = '';
    input.placeholder = kind === 'password' ? 'SSH 密码' : '私钥口令';
    prompt.hidden = false;
    setTimeout(() => input.focus(), 30);
  }

  function hidePrompt() {
    const prompt = $('#termPrompt');
    prompt.hidden = true;
    $('#termSecret').value = '';
    RS.pending = null;
  }

  function submitSecret() {
    const pending = RS.pending;
    if (!pending) return;
    const input = $('#termSecret');
    const value = input.value;
    if (!value) { input.focus(); return; }
    const { session, kind } = pending;
    hidePrompt();
    if (kind === 'password') session.credentials.password = value;
    else session.credentials.passphrase = value;
    startSocket(session, session.credentials);
  }

  function cancelSecret() {
    const pending = RS.pending;
    hidePrompt();
    if (!pending) return;
    const session = pending.session;
    if (!session.everConnected) {
      closeSession(session);
      return;
    }
    setStatus(session, 'closed', '已取消输入');
  }

  function closeSession(session) {
    if (!session) return;
    closeSocket(session);
    try { session.term.dispose(); } catch { }
    session.pane.remove();
    session.tab.remove();
    RS.sessions.delete(session.id);
    if (RS.pending && RS.pending.session === session) hidePrompt();
    if (RS.active === session.id) {
      const next = Array.from(RS.sessions.keys()).pop() || '';
      RS.active = next;
      if (next) activateTab(next);
    }
    if (RS.sessions.size === 0) {
      $('#termOverlay').hidden = true;
      document.body.classList.remove('term-open');
      unlockScroll();
    }
    updateSessionCount();
    renderDevices();
  }

  async function closeAllSessions() {
    if (RS.sessions.size === 0) { minimizeOverlay(); return; }
    const ok = await ask('断开全部终端', '将断开 <b>' + RS.sessions.size + '</b> 个 SSH 会话，确定继续？', '断开全部');
    if (!ok) return;
    Array.from(RS.sessions.values()).forEach(session => closeSession(session));
    minimizeOverlay();
  }

  function reconnectActive() {
    const session = activeSession();
    if (!session) return;
    if (session.device.auth === 'password' && !session.credentials.password) {
      requestSecret(session, 'password');
      return;
    }
    banner(session, '[正在重新连接]', 'muted');
    startSocket(session, session.credentials);
  }

  // ---------- 设备编辑 ----------

  function setAuth(auth) {
    RS.auth = auth === 'password' ? 'password' : 'key';
    $$('#authSwitch .seg').forEach(button => button.classList.toggle('active', button.dataset.auth === RS.auth));
    $('#keyField').hidden = RS.auth !== 'key';
    const pwdField = $('#pwdField');
    if (pwdField) pwdField.hidden = RS.auth !== 'password';
    $('#pwdNotice').hidden = RS.auth !== 'password';
  }

  function openDeviceModal(device) {
    RS.editing = device || null;
    $('#deviceTitle').textContent = device ? '编辑远程设备' : '添加远程设备';
    $('#deviceId').value = device ? device.id : '';
    $('#devName').value = device ? device.name : '';
    $('#devHost').value = device ? device.host : '';
    $('#devFallback').value = device ? device.fallbackHost : '';
    if ($('#devZerotierIp')) $('#devZerotierIp').value = device ? (device.zerotierIp || '') : '';
    $('#devPort').value = device ? device.port : 22;
    $('#devUser').value = device ? device.user : '';
    $('#devKeyPath').value = device ? device.keyPath : (RS.devices[0] && RS.devices[0].keyPath) || '';
    const passwordInput = $('#devPassword');
    if (passwordInput) {
      passwordInput.value = '';
      passwordInput.placeholder = device && device.hasPassword ? '已保存密码，留空保持不变' : '输入登录密码';
    }
    const saveCheckbox = $('#devSavePassword');
    if (saveCheckbox) saveCheckbox.checked = true;
    const pwdHint = $('#pwdStateHint');
    if (pwdHint) {
      pwdHint.textContent = device && device.hasPassword
        ? '已有保存的密码（明文），留空则继续沿用。'
        : '密码不会通过网页接口返回。';
    }
    $('#deviceError').hidden = true;
    setAuth(device ? device.auth : 'key');
    const row = $('#fingerprintRow');
    if (device && device.hostFingerprint) {
      row.hidden = false;
      $('#fingerprintText').textContent = device.hostFingerprint;
    } else {
      row.hidden = true;
      $('#fingerprintText').textContent = '';
    }
    if (typeof window.openModal === 'function') window.openModal('deviceModal');
    setTimeout(() => $('#devName').focus(), 60);
  }

  async function saveDevice() {
    const button = $('#btnSaveDevice');
    const errorBox = $('#deviceError');
    errorBox.hidden = true;
    const payload = {
      id: $('#deviceId').value || undefined,
      name: $('#devName').value.trim(),
      host: $('#devHost').value.trim(),
      fallbackHost: $('#devFallback').value.trim(),
      zerotierIp: $('#devZerotierIp') ? $('#devZerotierIp').value.trim() : undefined,
      port: $('#devPort').value,
      user: $('#devUser').value.trim(),
      auth: RS.auth,
      keyPath: $('#devKeyPath').value.trim()
    };
    if (RS.auth === 'password') {
      payload.password = $('#devPassword').value;
      payload.savePassword = $('#devSavePassword').checked;
    }
    button.disabled = true;
    const original = button.textContent;
    button.textContent = '保存中…';
    try {
      await post('/api/devices/save', payload);
      if (typeof window.closeModal === 'function') window.closeModal('deviceModal');
      notify('设备已保存', 'ok');
      await loadDevices();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  async function pickKey() {
    try {
      const result = await post('/api/devices/pick-key', {});
      if (result.path) $('#devKeyPath').value = result.path;
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  async function resetFingerprint() {
    const device = RS.editing;
    if (!device) return;
    const ok = await ask('重置主机指纹', '仅在你确认服务器重装、更换了 SSH 主机密钥时执行。重置后下次连接会重新记录指纹。', '重置');
    if (!ok) return;
    try {
      const result = await post('/api/devices/reset-hostkey', { id: device.id });
      RS.editing = result.device;
      $('#fingerprintRow').hidden = true;
      notify('主机指纹已重置，下次连接会重新记录', 'ok');
      await loadDevices();
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  async function testDevice(device) {
    notify('正在测试 ' + device.name + '…', 'info', 2000);
    try {
      const result = await post('/api/devices/test', { id: device.id });
      if (result.tcpOnly) notify(result.message, 'info');
      else {
        notify('连接成功 · ' + result.latencyMs + ' ms' +
          (result.os ? ' · ' + result.os : '') +
          (result.routeLabel ? ' · ' + result.routeLabel : '') +
          (result.host ? ' · ' + result.host : ''), 'ok');
      }
      await loadDevices();
    } catch (error) {
      const payload = error.payload || {};
      if (payload.code === 'passphrase-required' || payload.code === 'passphrase-invalid') {
        notify('私钥已加密，请直接连接，并在终端上方输入口令', 'warn');
      } else if (payload.code === 'hostkey-mismatch') {
        notify('主机密钥已变化，已阻止连接。确认后请在编辑设备中重置指纹。', 'error', 9000);
      } else {
        notify(payload.message || error.message, 'error');
      }
      await loadDevices();
    }
  }

  async function deleteDevice(device) {
    const ok = await ask('删除远程设备', '确定删除 <b>' + esc(device.name) + '</b>？<br>只会移除本机保存的连接配置，不会影响远端服务器。', '删除');
    if (!ok) return;
    try {
      await post('/api/devices/delete', { id: device.id });
      const session = sessionFor(device.id);
      if (session) closeSession(session);
      notify('设备已删除', 'ok');
      await loadDevices();
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  // ---------- ZeroTier 内网穿透 ----------

  function renderZeroTier(info) {
    const badge = $('#ztBadge');
    const ipEl = $('#ztIpText');
    const nodeEl = $('#ztNodeText');
    const desc = $('#ztDesc');
    const input = $('#ztNetworkInput');
    const central = $('#btnZtCentral');
    const dl = $('#btnZtDownload');
    if (!badge) return;

    const nwid = (info && info.networkId) || '';
    if (input && document.activeElement !== input) input.value = nwid;
    if (central) {
      central.href = (info && info.centralUrl) || (nwid ? ('https://my.zerotier.com/network/' + nwid) : 'https://my.zerotier.com/');
      central.textContent = nwid ? '授权后台' : 'ZeroTier 后台';
    }
    if (dl) dl.hidden = !info || info.installed !== false;

    const status = (info && info.status) || 'UNKNOWN';
    if (!info || !info.installed) {
      badge.dataset.state = nwid ? 'warn' : 'off';
      badge.textContent = nwid ? '未安装 ZeroTier' : '未安装（可选）';
      if (ipEl) ipEl.hidden = true;
      if (nodeEl) nodeEl.hidden = true;
      if (desc) {
        desc.textContent = nwid
          ? ('本机尚未安装 ZeroTier One，点击右侧「下载客户端」安装后再一键入组 ' + nwid + '。')
          : '可自由使用局域网、Tailscale 或 ZeroTier 组网；如需 ZeroTier 外网穿透，点击「下载客户端」安装并填入你的 16 位组号即可。';
      }
    } else if (!nwid || status === 'UNCONFIGURED') {
      const existingNets = Array.isArray(info.networks) ? info.networks.filter(n => n && n.nwid) : [];
      const firstNet = existingNets.find(n => n.status === 'OK') || existingNets[0] || null;
      badge.dataset.state = 'off';
      badge.textContent = '未配置组号';
      if (ipEl) ipEl.hidden = true;
      if (nodeEl) { nodeEl.hidden = !info.nodeId; nodeEl.textContent = '节点 ' + info.nodeId; }
      if (desc) {
        desc.textContent = firstNet
          ? ('检测到本机已加入 ZeroTier 组 ' + firstNet.nwid + (firstNet.ipv4 ? ' (' + firstNet.ipv4 + ')' : '') + '，可在右侧填入并点「保存并入组」启用；也可输入你的其他 16 位组号。')
          : '在右侧输入你自己的 16 位 ZeroTier 组号（可在 my.zerotier.com 免费创建）并点击「保存并入组」；不填也可正常使用局域网和 Tailscale。';
      }
    } else if (status === 'OK' && info.ip) {
      badge.dataset.state = 'ok';
      badge.textContent = '已接入外网穿透' + (info.networkName ? ' · ' + info.networkName : '');
      if (ipEl) { ipEl.hidden = false; ipEl.textContent = info.ip; }
      if (nodeEl) { nodeEl.hidden = !info.nodeId; nodeEl.textContent = '节点 ' + info.nodeId; }
      if (desc) desc.textContent = '本机已接入 ZeroTier 组 ' + nwid + '；导出的客机安装包会自动内置该组号，客机安装即自动加入同组直连。';
    } else if (status === 'ACCESS_DENIED') {
      badge.dataset.state = 'warn';
      badge.textContent = '等待后台授权';
      if (ipEl) ipEl.hidden = true;
      if (nodeEl) { nodeEl.hidden = !info.nodeId; nodeEl.textContent = '本机节点 ' + info.nodeId; }
      if (desc) desc.textContent = '本机节点 ' + (info.nodeId || '') + ' 已申请加入组 ' + nwid + '，请点右侧「授权后台」在 ZeroTier 网页勾选 Auth 后点刷新。';
    } else if (status === 'NEED_PERMISSION') {
      badge.dataset.state = 'warn';
      badge.textContent = '需要服务权限';
      if (ipEl) ipEl.hidden = true;
      if (nodeEl) nodeEl.hidden = true;
      if (desc) desc.textContent = info.permissionHint || '请以管理员权限启动控制台以读取/加入 ZeroTier 网络。';
    } else {
      badge.dataset.state = 'off';
      badge.textContent = status === 'NOT_JOINED' ? '未加入该组' : status;
      if (ipEl) ipEl.hidden = true;
      if (nodeEl) { nodeEl.hidden = !info.nodeId; nodeEl.textContent = '节点 ' + info.nodeId; }
      if (desc) desc.textContent = '点击「保存并入组」即可让本机加入 ZeroTier 组 ' + nwid + '，并作为导出客机包的默认穿透组号。';
    }
  }

  async function loadZeroTier(silent) {
    try {
      const data = await api('/api/zerotier/status');
      renderZeroTier(data);
      if (!silent) notify('ZeroTier 状态已刷新', 'ok', 1600);
    } catch (error) {
      if (!silent) notify(error.message, 'error');
    }
  }

  async function joinZeroTierLocal() {
    const input = $('#ztNetworkInput');
    const btn = $('#btnZtJoin');
    const nwid = input ? input.value.trim() : '';
    if (!/^[0-9a-fA-F]{16}$/.test(nwid)) {
      notify('请输入正确的 16 位十六进制 ZeroTier 组号（可在 my.zerotier.com 创建网络获取）', 'warn');
      if (input) input.focus();
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '入组中…'; }
    try {
      const data = await post('/api/zerotier/join', { networkId: nwid });
      renderZeroTier(data);
      notify(data.message || 'ZeroTier 入组完成', data.status === 'OK' ? 'ok' : 'info', 6000);
    } catch (error) {
      if (error.payload) renderZeroTier(error.payload);
      notify(error.message, 'error', 6000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '保存并入组'; }
    }
  }

  async function remoteJoinZeroTier(device) {
    const input = $('#ztNetworkInput');
    const nwid = (input && input.value.trim()) || '';
    if (!/^[0-9a-fA-F]{16}$/.test(nwid)) {
      notify('请先在上方 ZeroTier 栏输入并保存你自己的 16 位 ZeroTier 组号', 'warn', 5000);
      if (input) input.focus();
      return;
    }
    notify('正在远程检查/安装并把 ' + device.name + ' 加入 ZeroTier 组 ' + nwid + '…', 'info', 4000);
    try {
      const data = await post('/api/zerotier/remote-join', {
        deviceId: device.id,
        networkId: nwid,
        autoInstall: true
      });
      notify(data.message || '客机 ZeroTier 入组完成', data.status === 'OK' ? 'ok' : 'warn', 7000);
      await loadDevices();
    } catch (error) {
      notify(device.name + ' ZeroTier 入组失败：' + error.message, 'error', 7000);
    }
  }

  // ---------- 初始化 ----------

  function bind() {
    $('#btnAddDevice').addEventListener('click', () => openDeviceModal(null));
    $('#btnEmptyAddDevice').addEventListener('click', () => openDeviceModal(null));
    $('#btnRefreshDevices').addEventListener('click', async () => {
      await Promise.all([loadDevices(), loadZeroTier(true)]);
      notify('设备列表与穿透状态已刷新', 'ok', 1800);
    });
    if ($('#btnZtJoin')) $('#btnZtJoin').addEventListener('click', joinZeroTierLocal);
    if ($('#btnZtRefresh')) $('#btnZtRefresh').addEventListener('click', () => loadZeroTier(false));
    if ($('#ztNetworkInput')) {
      $('#ztNetworkInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); joinZeroTierLocal(); }
      });
    }

    $('#deviceGrid').addEventListener('click', event => {
      const actionEl = event.target.closest('[data-action]');
      if (!actionEl) return;
      const card = event.target.closest('.device-card');
      if (!card) return;
      const device = RS.devices.find(item => item.id === card.dataset.id);
      if (!device) return;
      const action = actionEl.dataset.action;
      if (action === 'connect') connectDevice(device);
      else if (action === 'test') testDevice(device);
      else if (action === 'edit') openDeviceModal(device);
      else if (action === 'delete') deleteDevice(device);
      else if (action === 'detect-env') {
        notify('正在检测 ' + device.name + ' 的 CLI 与 Desktop 环境…', 'info', 2500);
        api('/api/agent/env?deviceId=' + encodeURIComponent(device.id) + '&force=1')
          .then(res => {
            const dCount = (res.env && res.env.desktop || []).filter(x => x.installed).length;
            const cCount = (res.env && res.env.cli || []).filter(x => x.installed).length;
            notify(device.name + ' 环境检测完成：' + dCount + ' 个 Desktop，' + cCount + ' 个 CLI', 'ok');
            loadDevices();
          })
          .catch(err => notify(err.message, 'error'));
      } else if (action === 'bind-account' && typeof window.SmacHub === 'object') {
        window.SmacHub.openBindDeviceModal(device);
      } else if (action === 'sync-add' && typeof window.SmacHostActions === 'object') {
        window.SmacHostActions.openAddSyncForDevice(device.id);
      } else if (action === 'send-desktop' && typeof window.SmacHostActions === 'object') {
        window.SmacHostActions.openSendToDeviceDesktop(device.id);
      } else if (action === 'open-agent' && typeof window.SmacHostActions === 'object') {
        window.SmacHostActions.openAgentForDevice(device.id);
      } else if (action === 'install-tools' && typeof window.SmacHostActions === 'object') {
        window.SmacHostActions.openInstallToolsForDevice(device.id);
      } else if (action === 'zt-join') {
        remoteJoinZeroTier(device);
      }
    });

    $('#btnSaveDevice').addEventListener('click', saveDevice);
    $('#btnPickKey').addEventListener('click', pickKey);
    $('#btnResetFingerprint').addEventListener('click', resetFingerprint);
    $('#authSwitch').addEventListener('click', event => {
      const button = event.target.closest('[data-auth]');
      if (button) setAuth(button.dataset.auth);
    });

    $('#btnTermMinimize').addEventListener('click', minimizeOverlay);
    $('#btnTermCloseAll').addEventListener('click', closeAllSessions);
    $('#btnTermReconnect').addEventListener('click', reconnectActive);
    $('#termDock').addEventListener('click', () => {
      openOverlay();
      const session = activeSession();
      if (session) activateTab(session.id);
    });
    $('#btnTermSecretOk').addEventListener('click', submitSecret);
    $('#btnTermSecretCancel').addEventListener('click', cancelSecret);
    $('#termSecret').addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); submitSecret(); }
      if (event.key === 'Escape') { event.preventDefault(); cancelSecret(); }
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !$('#termOverlay').hidden && $('#termPrompt').hidden) {
        minimizeOverlay();
      }
    });

    if (window.ResizeObserver) {
      const observer = new ResizeObserver(() => {
        if (!$('#termOverlay').hidden) fitActive();
      });
      observer.observe($('#termStage'));
    }
    window.addEventListener('resize', () => {
      if (!$('#termOverlay').hidden) fitActive();
    });
  }

  function init() {
    if (RS.initialized) return;
    RS.initialized = true;
    bind();
  }

  function activate() {
    loadDevices();
    loadZeroTier(true);
  }

  window.SmacRemote = {
    init,
    activate,
    loadDevices,
    loadZeroTier,
    sessionCount: () => RS.sessions.size
  };
})();
