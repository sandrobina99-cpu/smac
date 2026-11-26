'use strict';

const $ = sel => document.querySelector(sel);

const state = {
  data: null,
  profileDirty: false,
  busy: false
};

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clock(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function toast(msg, kind = 'ok', ttl = 4200) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.kind = kind;
  el.textContent = msg;
  box.appendChild(el);
  while (box.children.length > 3) box.removeChild(box.firstElementChild);
  setTimeout(() => el.remove(), ttl);
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || data.message || ('请求失败 (' + res.status + ')'));
  }
  return data;
}

function post(url, body) {
  return api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
}

function render(data) {
  state.data = data;
  const m = data.machine || {};
  const hp = data.hostProfile || {};
  const zt = data.zerotier || {};
  const svcs = data.services || {};

  // Top chips
  const connChip = $('#chipHostConn');
  if (hp.connected && hp.keyAuthorized) {
    connChip.dataset.state = 'ok';
    $('#chipHostConnText').textContent = '已授权 · ' + (hp.hostName || '主机已连接');
  } else if (hp.lastDisconnectedAt && !hp.keyAuthorized) {
    connChip.dataset.state = 'bad';
    $('#chipHostConnText').textContent = '已主动断联';
  } else {
    connChip.dataset.state = 'warn';
    $('#chipHostConnText').textContent = '待连接';
  }

  const sshChip = $('#chipSsh');
  sshChip.dataset.state = m.sshOpen ? 'ok' : 'bad';
  $('#chipSshText').textContent = m.sshOpen ? ('运行中 · :' + (m.sshPort || 22)) : '未开启';

  const lanIp = (m.lanIps && m.lanIps[0]) || '';
  $('#chipLan').dataset.state = lanIp ? 'ok' : 'off';
  $('#chipLanText').textContent = lanIp || '未接入';

  const tsIp = (m.tailscaleIps && m.tailscaleIps[0]) || '';
  $('#chipTail').dataset.state = tsIp ? 'ok' : 'off';
  $('#chipTailText').textContent = tsIp || '未配置';

  const ztIp = zt.ip || (m.zerotierIps && m.zerotierIps[0]) || '';
  $('#chipZt').dataset.state = ztIp ? 'ok' : 'off';
  $('#chipZtText').textContent = ztIp || '未接入';

  // ZeroTier bar
  const ztBadge = $('#ztBadge');
  if (!zt.installed) {
    ztBadge.dataset.state = 'off';
    ztBadge.textContent = '未安装（可选）';
  } else if (zt.status === 'OK' && zt.ip) {
    ztBadge.dataset.state = 'ok';
    ztBadge.textContent = '已接入穿透' + (zt.networkName ? ' · ' + zt.networkName : '');
  } else if (zt.status === 'ACCESS_DENIED') {
    ztBadge.dataset.state = 'warn';
    ztBadge.textContent = '等待后台授权';
  } else {
    ztBadge.dataset.state = 'off';
    ztBadge.textContent = zt.networkId ? zt.status : '未配置组号';
  }
  const ztIpEl = $('#ztIpText');
  if (ztIpEl) { ztIpEl.hidden = !zt.ip; ztIpEl.textContent = zt.ip || ''; }
  const ztNodeEl = $('#ztNodeText');
  if (ztNodeEl) { ztNodeEl.hidden = !zt.nodeId; ztNodeEl.textContent = zt.nodeId ? ('节点 ' + zt.nodeId) : ''; }
  const ztInput = $('#ztNetworkInput');
  if (ztInput && document.activeElement !== ztInput && !state.profileDirty) {
    ztInput.value = hp.zerotierNetworkId || zt.networkId || '';
  }
  const ztCentral = $('#btnZtCentral');
  if (ztCentral) ztCentral.href = zt.centralUrl || 'https://my.zerotier.com/';

  // Connection hero box
  const heroBox = $('#connHeroBox');
  const connBadge = $('#connBadge');
  if (hp.connected && hp.keyAuthorized) {
    heroBox.dataset.state = 'ok';
    connBadge.dataset.state = 'ok';
    connBadge.textContent = '已连接 · 允许主机接入';
    $('#connTitle').textContent = '已连接并授权主机端 (' + (hp.hostName || '主机') + ')';
    $('#connSub').textContent = hp.lastHostResponse || '主机端 SSH 免密公钥已生效，主机可正常同步文件夹、剪贴板及无头调用本机 Agent。';
  } else if (hp.lastDisconnectedAt && !hp.keyAuthorized) {
    heroBox.dataset.state = 'bad';
    connBadge.dataset.state = 'bad';
    connBadge.textContent = '已主动断联 · 拒绝主机接入';
    $('#connTitle').textContent = '已主动断开与主机端的连接';
    $('#connSub').textContent = hp.lastHostResponse || '本机已从 authorized_keys 吊销主机 SSH 免密公钥并停止后台会话，主机端无法再通过 SSH 连接本机；点击下方「主动连接主机端」可随时恢复。';
  } else {
    heroBox.dataset.state = 'off';
    connBadge.dataset.state = 'warn';
    connBadge.textContent = hp.keyAuthorized ? '已授权 · 待回连主机' : '未连接主机';
    $('#connTitle').textContent = hp.keyAuthorized ? '本机 SSH 免密已就绪，点击「主动连接主机端」向主机注册' : '尚未连接主机端';
    $('#connSub').textContent = hp.lastHostResponse || '可在下方展开「主机连接参数配置」填入主机地址/公钥，或点击「主动连接主机端」自动握手。';
  }

  $('#metaHostName').textContent = hp.hostName || '未命名主机';
  $('#metaKeyState').textContent = hp.keyAuthorized ? '✓ 已授权 (authorized_keys)' : '✕ 已吊销 / 未写入';
  $('#metaActiveEp').textContent = hp.lastActiveEndpoint || ((hp.endpoints && hp.endpoints[0]) || '未配置');
  $('#metaLastTime').textContent = clock(hp.lastConnectedAt || hp.lastDisconnectedAt);

  if (!state.profileDirty) {
    if (document.activeElement !== $('#inputHostName')) $('#inputHostName').value = hp.hostName || '';
    if (document.activeElement !== $('#inputPairToken')) $('#inputPairToken').value = hp.pairToken || '';
    if (document.activeElement !== $('#inputEndpoints')) $('#inputEndpoints').value = (hp.endpoints || []).join(', ');
    if (document.activeElement !== $('#inputPublicKey')) $('#inputPublicKey').value = hp.publicKey || '';
  }

  // Machine info
  const metaRows = [
    ['计算机名', m.hostname || '—'],
    ['操作系统', (m.osLabel || '') + (m.arch ? ' · ' + m.arch : '')],
    ['登录用户', m.user || '—'],
    ['SSH 端口', (m.sshPort || 22) + (m.sshOpen ? ' (已开启)' : ' (未开启)')],
    ['局域网 IP (优先级 1)', (m.lanIps || []).join(', ') || '未接入'],
    ['Tailscale IP (优先级 2)', (m.tailscaleIps || []).join(', ') || '未接入'],
    ['ZeroTier IP (优先级 3)', (m.zerotierIps || []).join(', ') || '未接入']
  ];
  $('#machineMeta').innerHTML = metaRows.map(r => '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>').join('');

  // Background services
  const bgRunning = Boolean(svcs.agentRunning || svcs.clipBridgeRunning);
  const bgBadge = $('#bgSvcBadge');
  bgBadge.dataset.state = bgRunning ? 'ok' : 'off';
  bgBadge.textContent = bgRunning ? '运行中' : '空闲';
  const parts = [];
  if (svcs.agentRunning) parts.push('远程无头 Agent 服务运行中 (PID ' + svcs.agentPid + ' · 127.0.0.1:' + svcs.agentPort + ')');
  if (svcs.clipBridgeRunning) parts.push('剪贴板同步桥接运行中 (PID ' + svcs.clipPid + ')');
  $('#bgSvcText').textContent = parts.length ? parts.join('；') : '当前没有运行中的远程 Agent 或剪贴板桥接进程。';
  $('#btnStopBgServices').disabled = !bgRunning;

  // Pairing code
  const codeBox = $('#pairingCodeBox');
  if (codeBox && document.activeElement !== codeBox) {
    codeBox.value = data.pairingCode || '';
  }

  // CLI & Desktop grids
  const env = data.env || { cli: [], desktop: [] };
  $('#cliGrid').innerHTML = (env.cli || []).map(item => (
    '<div class="env-card' + (item.installed ? ' installed' : '') + '">' +
      '<div class="env-top"><b>' + esc(item.name) + '</b><span class="env-badge">' + esc(item.badge || (item.installed ? '已安装' : '未安装')) + '</span></div>' +
      '<div class="env-desc" title="' + esc(item.path || item.description || '') + '">' + esc(item.path || item.description || '') + '</div>' +
    '</div>'
  )).join('');

  $('#desktopGrid').innerHTML = (env.desktop || []).map(item => (
    '<div class="env-card' + (item.installed ? ' installed' : '') + '">' +
      '<div class="env-top"><b>' + esc(item.name) + '</b><span class="env-badge">' + esc(item.badge || (item.installed ? '已安装' : '未安装')) + '</span></div>' +
      '<div class="env-desc" title="' + esc(item.path || item.description || '') + '">' + esc(item.path || item.description || '') + '</div>' +
    '</div>'
  )).join('');

  // Activity log
  const logs = Array.isArray(data.logs) ? data.logs : [];
  const logEl = $('#logView');
  if (logEl) {
    logEl.textContent = logs.length ? logs.join('\n') : '暂无记录。点击「主动连接主机端」或「主动断联主机端」后将在此显示详细日志。';
    logEl.scrollTop = logEl.scrollHeight;
  }

  $('#footAddr').textContent = location.host || '127.0.0.1';
  $('#footStamp').textContent = '更新于 ' + clock(data.serverTime);
}

async function refresh() {
  try {
    const data = await api('/api/state');
    render(data);
  } catch (err) {
    $('#footStamp').textContent = '客机控制台连接中断';
  }
}

function collectProfileInputs() {
  return {
    hostName: $('#inputHostName').value.trim(),
    pairToken: $('#inputPairToken').value.trim(),
    endpoints: $('#inputEndpoints').value.trim(),
    publicKey: $('#inputPublicKey').value.trim(),
    zerotierNetworkId: $('#ztNetworkInput').value.trim()
  };
}

async function doConnectHost(withProfileInputs) {
  if (state.busy) return;
  state.busy = true;
  const btn = $('#btnConnectHost');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = '正在连接主机端…';
  try {
    const body = withProfileInputs ? collectProfileInputs() : {};
    const res = await post('/api/connect', body);
    state.profileDirty = false;
    toast(res.message || '已主动连接主机端', res.hostNotified ? 'ok' : 'warn', 5500);
    await refresh();
  } catch (err) {
    toast(err.message, 'error', 6000);
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

async function doDisconnectHost() {
  if (state.busy) return;
  state.busy = true;
  const btn = $('#btnDisconnectHost');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = '正在断开连接…';
  try {
    const res = await post('/api/disconnect', {});
    toast(res.message || '已主动断开与主机端的连接', 'warn', 5500);
    await refresh();
  } catch (err) {
    toast(err.message, 'error', 6000);
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

function wire() {
  ['#inputHostName', '#inputPairToken', '#inputEndpoints', '#inputPublicKey'].forEach(sel => {
    const el = $(sel);
    if (el) el.addEventListener('input', () => { state.profileDirty = true; });
  });

  $('#btnConnectHost').addEventListener('click', () => doConnectHost(false));
  $('#btnDisconnectHost').addEventListener('click', doDisconnectHost);
  $('#btnSaveAndConnect').addEventListener('click', () => doConnectHost(true));

  $('#btnSaveProfile').addEventListener('click', async () => {
    try {
      await post('/api/profile', collectProfileInputs());
      state.profileDirty = false;
      toast('主机连接配置已保存', 'ok');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  const refreshEnvHandler = async () => {
    toast('正在重新扫描本机 CLI 与 Desktop 环境…', 'ok', 2200);
    try {
      const res = await post('/api/env/refresh', {});
      toast(res.message || '本机环境已刷新', 'ok', 4000);
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  $('#btnRefreshAll').addEventListener('click', refreshEnvHandler);
  $('#btnRescanEnv').addEventListener('click', refreshEnvHandler);

  $('#btnZtJoin').addEventListener('click', async () => {
    const nwid = $('#ztNetworkInput').value.trim();
    if (!/^[0-9a-fA-F]{16}$/.test(nwid)) {
      toast('请输入 16 位十六进制 ZeroTier 组号', 'warn');
      return;
    }
    const btn = $('#btnZtJoin');
    btn.disabled = true;
    btn.textContent = '入组中…';
    try {
      const res = await post('/api/zerotier/join', { networkId: nwid });
      toast(res.message || '已加入 ZeroTier 组', 'ok');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '保存并入组';
    }
  });

  $('#btnStopBgServices').addEventListener('click', async () => {
    try {
      const res = await post('/api/services/stop', {});
      toast(res.message || '后台会话已停止', 'ok');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btnCopyPairingCode').addEventListener('click', async () => {
    const code = $('#pairingCodeBox').value.trim();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast('本机配对码已复制到剪贴板', 'ok', 2500);
    } catch {
      $('#pairingCodeBox').select();
      document.execCommand('copy');
      toast('本机配对码已复制', 'ok', 2500);
    }
  });
}

wire();
refresh();
setInterval(refresh, 3000);
