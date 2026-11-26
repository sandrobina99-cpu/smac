'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

const state = {
  data: null,
  pairsSignature: '',
  logKind: 'sync',
  logWasAtBottom: true,
  lastJobRunning: false,
  lastJobKind: '',
  sendPaths: [],
  pendingConfirm: null,
  addRemoteAuto: true,
  sendDeviceId: '',
  addDeviceId: '',
  syncRemoteDirDirty: false,
  syncRemoteDirSaving: false,
  agentOptions: null,
  agentModels: null,
  agentLoadedFor: '',
  guestEnv: null,
  selectedDesktopApp: 'deepseek-harness',
  lastPairedAt: '',
  refreshSerial: 0,
  timer: null
};

// ---------- helpers ----------

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseTime(value) {
  if (!value) return null;
  const fixed = String(value).replace(/(\.\d{3})\d+/, '$1');
  const date = new Date(fixed);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clock(value) {
  const date = parseTime(value);
  if (!date) return '—';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function relative(value) {
  const date = parseTime(value);
  if (!date) return '';
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  if (seconds >= 0) {
    if (absolute < 5) return '即将';
    if (absolute < 60) return absolute + ' 秒后';
    if (absolute < 3600) return Math.round(absolute / 60) + ' 分钟后';
    if (absolute < 86400) return Math.round(absolute / 3600) + ' 小时后';
    return Math.round(absolute / 86400) + ' 天后';
  }
  if (absolute < 10) return '刚刚';
  if (absolute < 60) return absolute + ' 秒前';
  if (absolute < 3600) return Math.round(absolute / 60) + ' 分钟前';
  if (absolute < 86400) return Math.round(absolute / 3600) + ' 小时前';
  return Math.round(absolute / 86400) + ' 天前';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return Math.round(bytes) + ' B';
}

function basename(pathValue) {
  const parts = String(pathValue || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function isWindowsHost() {
  return !state.data || !state.data.platform || state.data.platform === 'win32';
}

function hasLegacyMacTarget() {
  return Boolean(state.data && state.data.hasLegacyMac);
}

function allDevices() {
  const list = state.data && Array.isArray(state.data.devices) ? state.data.devices : [];
  return list.filter(item => item && item.id);
}

function remoteDevices() {
  const list = allDevices();
  if (hasLegacyMacTarget()) {
    return list.filter(item => String(item.name || '').toLowerCase() !== 'mac');
  }
  return list;
}

function deviceById(id) {
  if (!id) return null;
  return allDevices().find(item => item.id === id) || null;
}

function deviceLabel(device) {
  if (device) return String(device.name || device.host || '设备');
  return (state.data && state.data.defaultPeerName) || (hasLegacyMacTarget() ? 'Mac' : '远程设备');
}

function deviceSendDirLabel(device) {
  if (!device) return String(state.data && state.data.config.remoteDir || '~/Desktop');
  const os = String(device.os || '').toLowerCase();
  if (os.indexOf('windows') >= 0) return '桌面 (C:\\Users\\<用户名>\\Desktop)';
  return '~/Desktop';
}

function fillDeviceSelect(select, selected) {
  if (!select) return '';
  const legacyMac = hasLegacyMacTarget();
  const devices = remoteDevices();
  const signature = JSON.stringify([legacyMac, devices.map(item => [item.id, item.name, item.os])]);
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    const prefix = legacyMac
      ? '<option value="">Mac（默认）</option>'
      : (devices.length ? '' : '<option value="">暂无远程设备（先去「远程设备」添加）</option>');
    select.innerHTML = prefix + devices.map(item => {
      const os = item.os ? ' · ' + item.os : '';
      return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name + os) + '</option>';
    }).join('');
  }
  const valid = devices.some(item => item.id === selected);
  const value = valid ? selected : (legacyMac ? '' : (devices[0] ? devices[0].id : ''));
  if (select.value !== value) select.value = value;
  return value;
}

function updateSendTarget() {
  const device = deviceById(state.sendDeviceId);
  const target = $('#sendTargetName');
  const dir = $('#remoteDirText');
  const hint = $('#sendHint');
  const label = $('#remoteListLabel');
  const select = $('#sendDevice');
  const dz = $('#sendDropZone');
  const targetName = deviceLabel(device);
  if (target) target.textContent = targetName;
  if (dir) dir.textContent = deviceSendDirLabel(device);
  if (hint && (!dz || (!dz.classList.contains('is-dragover') && !dz.classList.contains('is-busy')))) {
    if (device) {
      hint.textContent = '直接拖入文件、图片、压缩包或整个文件夹，松手即达 ' + targetName + ' 桌面';
    } else {
      hint.textContent = hasLegacyMacTarget()
        ? '直接拖入文件、图片、压缩包或整个文件夹，松手即达 Mac 桌面'
        : '请先在「远程设备 · 客机」添加设备后再拖拽发送';
    }
  }
  if (label) label.textContent = '查看 ' + targetName + ' 接收目录';
  if (select) select.classList.toggle('is-device', !!device);
}

function updateAddDeviceMode() {
  const device = deviceById(state.addDeviceId);
  const label = $('#addRemoteLabel');
  const hint = $('#addDeviceHint');
  if (label) label.textContent = deviceLabel(device) + ' 目标位置';
  if (hint) {
    if (!device) {
      hint.textContent = hasLegacyMacTarget()
        ? '默认同步到 Mac；也可选择已添加的 SSH 设备。'
        : '请先在「远程设备 · 客机」添加设备（支持局域网 / Tailscale / ZeroTier）。';
    } else {
      const passwordNote = device.auth === 'password' && !device.hasPassword
        ? ' 该设备未保存密码，后台同步无法自动连接，请先在“远程设备”里编辑并保存密码。'
        : '';
      hint.textContent = '将同步到 ' + deviceLabel(device) + '；~ 表示该设备的用户目录。' + passwordNote;
    }
  }
}

function getAddRemoteRoot() {
  return state.addDeviceId ? '~/Documents' : getSyncRemoteDir();
}

function renderDeviceSelects() {
  const sendSelect = $('#sendDevice');
  const addSelect = $('#addDevice');
  state.sendDeviceId = fillDeviceSelect(sendSelect, state.sendDeviceId || '');
  state.addDeviceId = fillDeviceSelect(addSelect, state.addDeviceId || '');
  updateSendTarget();
  updateAddDeviceMode();
  if (!$('#addModal').hidden) updateSuggestedRemote();
}

async function api(path, options) {
  const response = await fetch(path, options);
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    const error = new Error((data && (data.error || data.output)) || '请求失败 (' + response.status + ')');
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

// ---------- toast ----------

const ICONS = {
  ok: 'i-check',
  error: 'i-alert',
  warn: 'i-alert',
  info: 'i-shield'
};

function toast(message, kind = 'ok', duration) {
  const stack = $('#toasts');
  const element = document.createElement('div');
  element.className = 'toast';
  element.dataset.kind = kind;
  element.innerHTML =
    '<svg class="toast-icon"><use href="#' + (ICONS[kind] || ICONS.info) + '"/></svg>' +
    '<div class="toast-text">' + escapeHtml(message) + '</div>';
  stack.appendChild(element);
  while (stack.children.length > 3) stack.removeChild(stack.firstElementChild);
  const ttl = duration || (kind === 'error' ? 8000 : 4200);
  setTimeout(() => {
    element.classList.add('leaving');
    setTimeout(() => element.remove(), 220);
  }, ttl);
}

// ---------- modals ----------

function openModal(id) {
  $('#' + id).hidden = false;
  document.body.classList.add('modal-open');
}

function closeModal(id) {
  $('#' + id).hidden = true;
  if (!$('.modal-backdrop:not([hidden])')) {
    document.body.classList.remove('modal-open');
  }
}

function confirmDialog(title, html, okLabel) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').innerHTML = html;
  $('#confirmOk').textContent = okLabel || '确认';
  openModal('confirmModal');
  return new Promise(resolve => {
    state.pendingConfirm = resolve;
  });
}

function settleConfirm(result) {
  const resolve = state.pendingConfirm;
  state.pendingConfirm = null;
  closeModal('confirmModal');
  if (resolve) resolve(result);
}

// ---------- rendering ----------

function renderChips(data) {
  const lan = (data.connectivity && data.connectivity.lan) || { ok: false, host: '', ms: 0 };
  const tail = (data.connectivity && data.connectivity.tail) || { ok: false, host: '', ms: 0 };
  const zt = (data.connectivity && data.connectivity.zt) || { ok: false, host: '', ms: 0 };

  const lanChip = $('#chipLan');
  const tailChip = $('#chipTail');
  const ztChip = $('#chipZt');

  if (lan.ok) {
    lanChip.dataset.state = 'ok';
    $('#lanValue').textContent = lan.ms + ' ms';
    lanChip.title = '优先级 1 · 局域网 ' + lan.host + ' 直连';
  } else if (lan.host) {
    lanChip.dataset.state = 'off';
    $('#lanValue').textContent = '不可达';
    lanChip.title = '局域网 ' + lan.host + ' 不可达';
  } else {
    lanChip.dataset.state = 'off';
    $('#lanValue').textContent = '未记录';
    lanChip.title = '尚未记录局域网地址';
  }

  if (tail.ok) {
    tailChip.dataset.state = lan.ok ? 'ok' : 'warn';
    $('#tailValue').textContent = tail.ms + ' ms';
    tailChip.title = '优先级 2 · Tailscale ' + tail.host;
  } else if (tail.host) {
    tailChip.dataset.state = 'off';
    $('#tailValue').textContent = '不可达';
    tailChip.title = 'Tailscale ' + tail.host + ' 不可达';
  } else {
    tailChip.dataset.state = 'off';
    $('#tailValue').textContent = '未配置';
    tailChip.title = '未配置 Tailscale 地址';
  }

  if (ztChip) {
    if (zt.ok) {
      ztChip.dataset.state = (lan.ok || tail.ok) ? 'ok' : 'warn';
      $('#ztValue').textContent = zt.ms + ' ms';
      ztChip.title = '优先级 3 · ZeroTier ' + zt.host;
    } else if (zt.host) {
      ztChip.dataset.state = 'off';
      $('#ztValue').textContent = '不可达';
      ztChip.title = 'ZeroTier ' + zt.host + ' 不可达';
    } else {
      ztChip.dataset.state = 'off';
      $('#ztValue').textContent = '未接入';
      ztChip.title = '对端尚未记录 ZeroTier 穿透 IP（可在「远程设备」点击同组 ZeroTier 同步）';
    }
  }

  const daemonChip = $('#chipDaemon');
  if (data.daemon.running) {
    daemonChip.dataset.state = 'ok';
    $('#daemonChipText').textContent = '运行中 · PID ' + data.daemon.pid;
  } else {
    daemonChip.dataset.state = 'off';
    $('#daemonChipText').textContent = '守护未运行';
  }
}

function sumTraffic(statusPairs) {
  let uploaded = 0;
  let downloaded = 0;
  let conflicts = 0;
  let failed = 0;
  for (const pair of statusPairs) {
    if (!pair) continue;
    uploaded += Number(pair.uploaded) || 0;
    downloaded += Number(pair.downloaded) || 0;
    conflicts += Number(pair.conflicts) || 0;
    failed += Number(pair.failed) || 0;
  }
  return { uploaded, downloaded, conflicts, failed };
}

function renderStats(data) {
  const pairs = data.pairs || [];
  const statusPairs = data.status && Array.isArray(data.status.pairs) ? data.status.pairs : [];
  const traffic = sumTraffic(statusPairs);
  const tracked = pairs.reduce((sum, pair) => sum + (Number(pair.trackedFiles) || 0), 0);

  $('#stPairs').textContent = pairs.length;
  $('#stTracked').textContent = tracked.toLocaleString('zh-CN');
  $('#stTraffic').textContent = traffic.uploaded + traffic.downloaded;
  $('#stConflicts').textContent = traffic.conflicts + traffic.failed;
}

function pairLastResult(data, name) {
  const statusPairs = data.status && Array.isArray(data.status.pairs) ? data.status.pairs : [];
  return statusPairs.find(item => item && item.name === name) || null;
}

function renderPairs(data) {
  const pairs = data.pairs || [];
  const list = $('#pairList');
  const empty = $('#pairEmpty');

  if (pairs.length === 0) {
    list.innerHTML = '';
    list.hidden = true;
    empty.hidden = false;
    state.pairsSignature = '';
    return;
  }

  list.hidden = false;
  empty.hidden = true;

  const signature = JSON.stringify(pairs.map(pair => {
    const last = pairLastResult(data, pair.name);
    return [pair.name, pair.local, pair.remote, pair.enabled, pair.localExists, pair.fileCount,
      pair.deviceId, pair.deviceName,
      pair.trackedFiles, last && last.lastRun, last && last.error, last && last.failed];
  }));

  if (signature === state.pairsSignature) return;
  state.pairsSignature = signature;

  list.innerHTML = pairs.map(pair => {
    const last = pairLastResult(data, pair.name);
    let pillState = 'idle';
    let pillText = '等待同步';
    if (!pair.enabled) {
      pillText = '已暂停';
    } else if (!pair.localExists) {
      pillState = 'bad';
      pillText = '文件夹缺失';
    } else if (last && last.failed > 0) {
      pillState = 'bad';
      pillText = '有错误';
    } else if (pair.trackedFiles > 0 || last) {
      pillState = 'ok';
      pillText = '已同步';
    }

    const meta = [];
    meta.push('<span class="meta-item">' + (pair.fileCount >= 20000 ? '20000+' : pair.fileCount) + ' 个文件</span>');
    if (pair.sizeBytes > 0) meta.push('<span class="meta-item">' + formatBytes(pair.sizeBytes) + '</span>');
    if (last) {
      meta.push('<span class="meta-sep">·</span>');
      meta.push('<span class="meta-item meta-up">↑ <b>' + (Number(last.uploaded) || 0) + '</b></span>');
      meta.push('<span class="meta-item meta-down">↓ <b>' + (Number(last.downloaded) || 0) + '</b></span>');
      if (Number(last.deleted) > 0) meta.push('<span class="meta-item">删 <b>' + last.deleted + '</b></span>');
      if (Number(last.conflicts) > 0) meta.push('<span class="meta-item meta-warn">冲突 <b>' + last.conflicts + '</b></span>');
      meta.push('<span class="meta-sep">·</span>');
      meta.push('<span class="meta-item">上次 ' + clock(last.lastRun) + '</span>');
    }

    const errorHtml = last && last.error
      ? '<div class="meta-error" title="' + escapeHtml(last.error) + '">' + escapeHtml(last.error) + '</div>'
      : '';
    const remoteLabel = pair.deviceId ? (pair.deviceName || '设备') : 'MAC';
    const remoteClass = pair.deviceId ? 'dev' : 'mac';

    return '' +
      '<div class="pair" data-name="' + escapeHtml(pair.name) + '" data-disabled="' + (!pair.enabled) + '" data-missing="' + (!pair.localExists) + '">' +
        '<div class="pair-icon"><svg><use href="#i-swap"/></svg></div>' +
        '<div class="pair-main">' +
          '<div class="pair-head">' +
            '<span class="pair-name" title="' + escapeHtml(pair.name) + '">' + escapeHtml(pair.name) + '</span>' +
            '<span class="pill" data-state="' + pillState + '">' + pillText + '</span>' +
            '<span class="pair-spacer"></span>' +
            '<label class="switch mini" title="启用 / 暂停"><input type="checkbox" data-role="toggle" ' + (pair.enabled ? 'checked' : '') + '><span class="track"></span></label>' +
            '<div class="pair-actions">' +
              '<button class="icon-btn" data-act="sync" title="立即同步"><svg><use href="#i-sync"/></svg></button>' +
              '<button class="icon-btn" data-act="reveal" title="' + (isWindowsHost() ? '在资源管理器中打开' : '在访达中打开') + '"><svg><use href="#i-external"/></svg></button>' +
              '<button class="icon-btn danger" data-act="remove" title="移除同步"><svg><use href="#i-trash"/></svg></button>' +
            '</div>' +
          '</div>' +
          '<div class="path"><span class="os ' + (isWindowsHost() ? 'win">WIN' : (data.platform === 'darwin' ? 'mac">MAC' : 'dev">本机')) + '</span><code title="' + escapeHtml(pair.local) + '">' + escapeHtml(pair.local) + '</code></div>' +
          '<div class="path"><span class="os ' + remoteClass + '" title="' + escapeHtml(remoteLabel) + '">' + escapeHtml(remoteLabel.toUpperCase()) + '</span><code title="' + escapeHtml(pair.remote) + '">' + escapeHtml(pair.remote) + '</code></div>' +
          '<div class="pair-meta">' + meta.join(' ') + '</div>' +
          errorHtml +
        '</div>' +
      '</div>';
  }).join('');
}

function renderService(data) {
  if (data && data.hostOsLabel && data.platform !== 'win32') {
    $$('.row-sub').forEach(el => {
      if (el.textContent && el.textContent.includes('Windows')) {
        el.textContent = el.textContent.replace(/Windows/g, data.hostOsLabel);
      }
    });
    const addLocalInput = $('#addLocal');
    if (addLocalInput && addLocalInput.placeholder === 'D:\\论文') {
      addLocalInput.placeholder = data.platform === 'darwin' ? '/Users/你/Documents/论文' : '/home/你/Documents/论文';
    }
    const devKeyInput = $('#devKeyPath');
    if (devKeyInput && devKeyInput.placeholder.includes('C:\\Users')) {
      devKeyInput.placeholder = '~/.ssh/id_ed25519';
    }
  }
  const running = data.daemon.running;
  const badge = $('#svcBadge');
  badge.dataset.state = running ? 'ok' : 'off';
  badge.textContent = running ? '运行中' : '未运行';

  $('#btnStart').disabled = running;
  $('#btnStop').disabled = !running;
  $('#chkAuto').checked = !!data.daemon.autoStart;

  const interval = String(data.config.interval || 20);
  const select = $('#selInterval');
  if (document.activeElement !== select && select.value !== interval) {
    const option = Array.from(select.options).find(item => item.value === interval);
    if (option) select.value = interval;
  }

  $('#remoteDirText').textContent = data.config.remoteDir || '~/Desktop';
  updateSendTarget();
  const defaultDirInput = $('#syncRemoteDirInput');
  if (!state.syncRemoteDirDirty && !state.syncRemoteDirSaving && document.activeElement !== defaultDirInput) {
    defaultDirInput.value = data.config.syncRemoteDir || '~/Documents';
  }
  $('#addRemoteHint').textContent = '默认根目录：' + getSyncRemoteDir() + '。本次位置可手动修改，不改变默认设置。';
  if (!$('#addModal').hidden) updateSuggestedRemote();

  const nextRun = $('#nextRun');
  const text = $('#nextRunText');
  const status = data.status;
  const offlineDevices = status && Array.isArray(status.devices)
    ? status.devices.filter(item => item && item.online === false)
    : [];
  if (running && status && status.macOnline === false) {
    nextRun.dataset.state = 'off';
    text.textContent = 'Mac 离线，等待上线后自动恢复同步' +
      (status.offlineSince ? '（自 ' + clock(status.offlineSince) + '）' : '');
  } else if (running && offlineDevices.length > 0) {
    nextRun.dataset.state = 'warn';
    text.textContent = '设备离线：' + offlineDevices.map(item => item.name).join('、') + '；其余继续同步';
  } else if (running && status && status.nextRunAt) {
    nextRun.dataset.state = 'ok';
    text.textContent = '下一轮 ' + clock(status.nextRunAt) + ' · ' + relative(status.nextRunAt);
  } else if (running) {
    nextRun.dataset.state = 'ok';
    text.textContent = '守护运行中 · 每 ' + interval + ' 秒检查一次';
  } else {
    nextRun.dataset.state = 'off';
    text.textContent = '守护未运行，启动后自动同步';
  }
}

let clipDevicesSignature = '';

function renderClipDevices(data) {
  const listEl = $('#clipDeviceList');
  const summaryEl = $('#clipDevicesSummary');
  if (!listEl) return;
  const devices = allDevices();
  const clip = data.clip || { running: false, deviceIds: [], status: null };
  const selectedIds = Array.isArray(clip.deviceIds) ? clip.deviceIds : [];
  const selectedSet = new Set(selectedIds);
  const statusDevices = clip.status && Array.isArray(clip.status.devices) ? clip.status.devices : [];
  const statusById = new Map(statusDevices.map(d => [d.id, d]));

  if (summaryEl) {
    const selectedNames = devices.filter(d => selectedSet.has(d.id)).map(d => d.name);
    summaryEl.textContent = selectedNames.length
      ? ('本机 ⇄ ' + selectedNames.join('、'))
      : (devices.length ? '未选择设备（点击下方勾选）' : '请先添加远程设备');
  }

  const sig = JSON.stringify([
    devices.map(d => [d.id, d.name, d.os]),
    selectedIds,
    statusDevices.map(d => [d.id, d.online])
  ]);
  if (sig === clipDevicesSignature) return;
  clipDevicesSignature = sig;

  if (!devices.length) {
    listEl.innerHTML = '<div class="clip-dev-empty">还没有远程设备，请先在「远程设备 · 客机」中添加设备后再勾选同步剪贴板。</div>';
    return;
  }

  listEl.innerHTML = devices.map(dev => {
    const checked = selectedSet.has(dev.id);
    const st = statusById.get(dev.id);
    const dotClass = clip.running && checked && st ? (st.online ? 'on' : 'off') : '';
    const dotHtml = dotClass ? '<span class="clip-dev-dot ' + dotClass + '" title="' + (st.online ? '在线' : '离线') + '"></span>' : '';
    const osHtml = dev.os ? '<span class="clip-dev-os">' + escapeHtml(dev.os) + '</span>' : '';
    return '<label class="clip-dev-chip' + (checked ? ' checked' : '') + '">'
      + '<input type="checkbox" data-clip-device-id="' + escapeHtml(dev.id) + '"' + (checked ? ' checked' : '') + '>'
      + dotHtml
      + '<span>' + escapeHtml(dev.name) + '</span>'
      + osHtml
      + '</label>';
  }).join('');
}

async function saveClipDevicesFromUi() {
  const checked = $$('#clipDeviceList input[data-clip-device-id]:checked').map(el => el.dataset.clipDeviceId);
  try {
    await post('/api/config', { clipboardDeviceIds: checked });
    clipDevicesSignature = '';
    const names = allDevices().filter(d => checked.includes(d.id)).map(d => d.name);
    toast(names.length ? ('剪贴板同步设备已更新：本机 ⇄ ' + names.join('、')) : '已清空剪贴板同步设备', 'ok', 2400);
    await refreshState();
  } catch (error) {
    toast(error.message, 'error');
    clipDevicesSignature = '';
    await refreshState();
  }
}

function renderClip(data) {
  const clip = data.clip || { running: false, deviceIds: [], status: null };
  const running = !!clip.running;
  const selectedIds = Array.isArray(clip.deviceIds) ? clip.deviceIds : [];

  renderClipDevices(data);

  const badge = $('#clipBadge');
  badge.dataset.state = running ? 'ok' : 'off';
  badge.textContent = running ? '运行中' : '未运行';

  $('#btnClipStart').disabled = running;
  $('#btnClipStop').disabled = !running;
  $('#chkClipAuto').checked = !!clip.autoStart;

  const interval = String(clip.interval || 2);
  const select = $('#selClipInterval');
  if (document.activeElement !== select && select.value !== interval) {
    const option = Array.from(select.options).find(item => item.value === interval);
    if (option) select.value = interval;
  }

  const run = $('#clipRun');
  const text = $('#clipRunText');
  const status = clip.status;
  const offlineNames = status && Array.isArray(status.devices)
    ? status.devices.filter(d => d && d.online === false).map(d => d.name)
    : [];
  if (!running) {
    run.dataset.state = 'off';
    text.textContent = selectedIds.length
      ? '未运行，启动后在所选设备间自动同步文本与图片'
      : '请先在上方勾选至少 1 台要同步剪贴板的设备';
  } else if (status && (status.allOffline || status.macOnline === false)) {
    run.dataset.state = 'off';
    text.textContent = (offlineNames.length ? offlineNames.join('、') : '目标设备') + ' 离线，等待恢复后自动继续';
  } else if (status && status.lastSyncAt) {
    run.dataset.state = offlineNames.length ? 'warn' : 'ok';
    const kind = status.lastKind === 'image' ? '图片 · ' : (status.lastKind === 'text' ? '文本 · ' : '');
    const offHint = offlineNames.length ? ('（' + offlineNames.join('、') + ' 离线）') : '';
    text.textContent = kind + (status.lastDirection || '已同步') + ' · ' + clock(status.lastSyncAt) + offHint;
  } else {
    run.dataset.state = offlineNames.length ? 'warn' : 'ok';
    text.textContent = '运行中 · 每 ' + interval + ' 秒检查一次' + (offlineNames.length ? ('（' + offlineNames.join('、') + ' 离线）') : '');
  }
}

function renderJob(data) {
  const job = data.job || {};
  const running = !!job.running;
  const progress = $('#progress');
  const indicator = $('#jobIndicator');

  progress.hidden = !running;
  indicator.hidden = !running;

  let label = '处理中';
  if (running) {
    if (String(job.kind).startsWith('send:')) label = '正在传输到 ' + String(job.kind).slice(5);
    else if (job.kind === 'send') label = '正在传输到 Mac';
    else if (job.kind === 'clip') label = '正在同步剪贴板';
    else if (job.kind === 'sync:all') label = '正在同步全部文件夹';
    else if (String(job.kind).startsWith('sync:')) label = '正在同步 ' + String(job.kind).slice(5);
  }
  $('#jobText').textContent = label;

  $('#btnSyncAll').disabled = running;
  if ($('#btnSend')) $('#btnSend').disabled = running;
  $('#btnClipNow').disabled = running;
  $$('#pairList [data-act="sync"]').forEach(button => { button.disabled = running; });

  const dz = $('#sendDropZone');
  const isSendJob = String(job.kind || '').startsWith('send');
  if (dz && !state.dropUploading) {
    if (running && isSendJob) {
      dz.classList.add('is-busy');
      dz.classList.remove('is-done');
      if ($('#sendDropTitle')) $('#sendDropTitle').textContent = label + ' 桌面…';
      if ($('#sendDropProgress')) $('#sendDropProgress').hidden = false;
      if ($('#sendDropBarFill')) $('#sendDropBarFill').style.width = '100%';
      if ($('#sendDropProgressText')) $('#sendDropProgressText').textContent = (state.lastDropSummary ? ('正在发送 ' + state.lastDropSummary + ' …') : '正在通过加密通道传输到对方桌面…');
    } else if (!running && dz.classList.contains('is-busy')) {
      dz.classList.remove('is-busy');
      if ($('#sendDropProgress')) $('#sendDropProgress').hidden = true;
    }
  }

  if (state.lastJobRunning && !running) {
    if (job.ok) {
      if (isSendJob && dz) {
        dz.classList.remove('is-busy');
        dz.classList.add('is-done');
        if ($('#sendDropProgress')) $('#sendDropProgress').hidden = true;
        const targetName = deviceLabel(deviceById(state.sendDeviceId));
        if ($('#sendDropTitle')) {
          $('#sendDropTitle').textContent = '✓ 已送达 ' + targetName + ' 桌面' + (state.lastDropSummary ? ('：' + state.lastDropSummary) : '');
        }
        setTimeout(() => {
          if (!dz.classList.contains('is-busy') && !dz.classList.contains('is-dragover')) {
            dz.classList.remove('is-done');
            if ($('#sendDropTitle')) $('#sendDropTitle').textContent = '拖拽任意文件或文件夹到此处，松手即传桌面';
            updateSendTarget();
          }
        }, 3600);
      }
      toast(isSendJob ? ('已发送到 ' + deviceLabel(deviceById(state.sendDeviceId)) + ' 桌面')
        : (job.kind === 'clip' ? '剪贴板同步完成' : '同步完成'), 'ok');
    } else {
      if (isSendJob && dz) {
        dz.classList.remove('is-busy');
        if ($('#sendDropProgress')) $('#sendDropProgress').hidden = true;
        if ($('#sendDropTitle')) $('#sendDropTitle').textContent = '拖拽任意文件或文件夹到此处，松手即传桌面';
      }
      const lines = (job.output || []).filter(line => /失败|错误|error|FAIL|X\]/i.test(line));
      const detail = (lines.length ? lines[lines.length - 1] : (job.output || []).slice(-1)[0]) || '任务失败';
      toast(detail, 'error');
    }
    state.pairsSignature = '';
    refreshState();
    refreshLog();
  }

  state.lastJobRunning = running;
  state.lastJobKind = job.kind || '';
}

function classifyLogLine(text) {
  if (/失败|错误|异常|不可达|FAIL|\[X\]/i.test(text)) return 'l-bad';
  if (/冲突|conflict|跳过|警告|\[!\]/i.test(text)) return 'l-warn';
  if (/OK|完成|已发送|已启动|已停止/i.test(text)) return 'l-ok';
  return 'l-dim';
}

function renderLog(payload) {
  const view = $('#logView');
  const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 48;
  const lines = payload.lines || [];

  if (lines.length === 0) {
    view.innerHTML = '<span class="log-empty">暂无记录。同步开始后，这里会显示每一次上传、下载、删除和冲突。</span>';
    return;
  }

  view.innerHTML = lines.map(raw => {
    const line = String(raw);
    const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \| ([\s\S]*)$/);
    if (match) {
      return '<span class="log-line"><span class="l-time">' + escapeHtml(match[1].slice(11)) + '</span>  ' +
        '<span class="' + classifyLogLine(match[2]) + '">' + escapeHtml(match[2]) + '</span></span>';
    }
    return '<span class="log-line ' + classifyLogLine(line) + '">' + escapeHtml(line) + '</span>';
  }).join('');

  if (nearBottom || state.logWasAtBottom) {
    view.scrollTop = view.scrollHeight;
  }
}

// ---------- data refresh ----------

async function refreshState() {
  const serial = ++state.refreshSerial;
  let data;
  try {
    data = await api('/api/state');
  } catch (error) {
    if (serial === state.refreshSerial) $('#footStamp').textContent = '控制台连接中断';
    return;
  }
  if (serial !== state.refreshSerial) return;

  state.data = data;
  if (data.pairing && data.pairing.lastPairedEvent && data.pairing.lastPairedEvent.at) {
    if (state.lastPairedAt && state.lastPairedAt !== data.pairing.lastPairedEvent.at) {
      const ev = data.pairing.lastPairedEvent;
      if (ev.kind === 'disconnect') {
        toast('客机 ' + ev.name + ' (' + ev.host + ') 已主动断开与本机的连接', 'warn', 6500);
      } else {
        toast('客机 ' + ev.name + ' (' + ev.host + ') 已主动连接并同步环境', 'ok', 6500);
      }
      if (window.SmacRemote) window.SmacRemote.loadDevices();
    }
    state.lastPairedAt = data.pairing.lastPairedEvent.at;
  }
  renderChips(data);
  renderStats(data);
  renderDeviceSelects();
  renderPairs(data);
  renderService(data);
  renderClip(data);
  renderJob(data);
  renderAgent(data.agent);
  $('#footStamp').textContent = '更新于 ' + clock(data.serverTime);
}

async function refreshLog() {
  try {
    const payload = await api('/api/log?kind=' + state.logKind + '&lines=200');
    renderLog(payload);
  } catch { }
}

// ---------- remote agent ----------

function agentInfo() {
  return state.data && state.data.agent ? state.data.agent : null;
}

const AGENT_BACKEND_LABELS = {
  dsh: 'DeepSeek Harness',
  hermes: 'Hermes Agent',
  codex: 'Codex CLI',
  claude: 'Claude Code',
  agy: 'Gemini · Antigravity',
  opencode: 'OpenCode CLI'
};

const DESKTOP_TO_CLI_MAP = {
  'deepseek-harness': 'dsh',
  'claude-desktop': 'claude',
  'codex-desktop': 'codex',
  'antigravity-desktop': 'agy',
  'hermes-desktop': 'hermes',
  'opencode-desktop': 'opencode'
};

function normalizeAgentBackend(value) {
  const id = String(value || '').toLowerCase();
  return ['dsh', 'hermes', 'codex', 'claude', 'agy', 'opencode'].includes(id) ? id : 'hermes';
}

function agentBackendLabel(value) {
  return AGENT_BACKEND_LABELS[normalizeAgentBackend(value)];
}

function renderGuestEnvCards(envData) {
  const desktopBox = $('#guestDesktopCards');
  const cliBox = $('#guestCliCards');
  if (!desktopBox || !cliBox) return;

  const desktops = (envData && Array.isArray(envData.desktop)) ? envData.desktop : [
    { id: 'deepseek-harness', name: 'DeepSeek Harness', installed: false, badge: '待检测', description: 'DeepSeek 官方桌面端 · 可无头复用订阅' },
    { id: 'claude-desktop', name: 'Claude Desktop', installed: false, badge: '待检测', description: 'Anthropic Claude 桌面端 · 桥接 Claude Code' },
    { id: 'codex-desktop', name: 'Codex Desktop', installed: false, badge: '待检测', description: 'OpenAI Codex 桌面端 · 桥接 Codex CLI' },
    { id: 'antigravity-desktop', name: 'Antigravity Desktop', installed: false, badge: '待检测', description: 'Google Antigravity 桌面端 · 桥接 agy CLI' },
    { id: 'hermes-desktop', name: 'Hermes Desktop', installed: false, badge: '待检测', description: 'Hermes Agent 桌面端 · 桥接 Hermes CLI' },
    { id: 'opencode-desktop', name: 'OpenCode Desktop', installed: false, badge: '待检测', description: 'OpenCode 桌面端 · 桥接 OpenCode CLI' }
  ];

  const clis = (envData && Array.isArray(envData.cli)) ? envData.cli : [
    { id: 'dsh', name: 'DeepSeek Harness', installed: false, badge: '待检测', description: '内置无头 CLI · 复用客机桌面端官方订阅与自定义模型' },
    { id: 'hermes', name: 'Hermes Agent', installed: false, badge: '待检测', description: '使用客机 Hermes CLI 订阅' },
    { id: 'codex', name: 'Codex CLI', installed: false, autoInstall: true, badge: '可自动安装', description: '复用客机 ChatGPT / Codex 登录状态' },
    { id: 'claude', name: 'Claude Code', installed: false, autoInstall: true, badge: '可自动安装', description: '支持客机登录或密钥绑定' },
    { id: 'agy', name: 'Gemini · Antigravity', installed: false, autoInstall: true, badge: '可自动安装', description: '支持客机登录或密钥绑定' },
    { id: 'opencode', name: 'OpenCode CLI', installed: false, badge: '待检测', description: '客机 OpenCode 命令行' }
  ];

  const currentCli = $('#agentBackend') ? normalizeAgentBackend($('#agentBackend').value) : 'hermes';

  cliBox.innerHTML = clis.map(item => {
    const isSelected = currentCli === item.id;
    const badgeClass = (item.installed || item.authenticated) ? 'ok' : (item.autoInstall ? 'auto' : '');
    return '<button type="button" class="guest-env-card'
      + (isSelected ? ' selected' : '')
      + '" data-cli-id="' + escapeHtml(item.id) + '">'
      + '<div class="ge-top"><b>' + escapeHtml(item.name) + '</b>'
      + '<span class="ge-badge ' + badgeClass + '">' + escapeHtml(item.badge || (item.installed ? '已就绪' : '未安装')) + '</span></div>'
      + '<div class="ge-desc">' + escapeHtml(item.description || '') + '</div>'
      + '</button>';
  }).join('');

  const sortedDesktops = desktops.slice().sort((a, b) => (b.installed ? 1 : 0) - (a.installed ? 1 : 0));
  desktopBox.innerHTML = sortedDesktops.map(item => {
    const mappedCli = DESKTOP_TO_CLI_MAP[item.id] || '';
    const isSelected = Boolean(mappedCli && mappedCli === currentCli);
    const badgeClass = item.installed ? 'ok' : '';
    const badgeText = item.installed
      ? ((item.badge && item.badge !== '已安装') ? item.badge : (mappedCli ? '已安装 · 可无头复用' : '已安装'))
      : '未检测到';
    return '<button type="button" class="guest-env-card'
      + (isSelected ? ' selected' : '')
      + (item.installed ? '' : ' missing')
      + '" data-desktop-id="' + escapeHtml(item.id) + '" data-mapped-cli="' + escapeHtml(mappedCli) + '">'
      + '<div class="ge-top"><b>' + escapeHtml(item.name) + '</b>'
      + '<span class="ge-badge ' + badgeClass + '">' + escapeHtml(badgeText) + '</span></div>'
      + '<div class="ge-desc">' + escapeHtml(item.description || '') + '</div>'
      + '</button>';
  }).join('');
}

async function detectGuestEnv(deviceId, force) {
  if (!deviceId) {
    renderGuestEnvCards(null);
    return;
  }
  const devices = (state.agentOptions && state.agentOptions.devices) || [];
  const dev = devices.find(d => d.id === deviceId);
  if (!force && dev && dev.guestEnv) {
    state.guestEnv = dev.guestEnv;
    renderGuestEnvCards(dev.guestEnv);
    return;
  }
  const statusEl = $('#cliEnvStatus');
  if (statusEl) statusEl.textContent = '（正在连接客机检测 CLI 与桌面端订阅环境…）';
  try {
    const res = await api('/api/agent/env?deviceId=' + encodeURIComponent(deviceId) + (force ? '&force=1' : ''));
    if (res && res.env) {
      state.guestEnv = res.env;
      if (dev) dev.guestEnv = res.env;
      // 如果客机安装了 DeepSeek Harness 且当前还没有保存过引擎选择，优先推荐已安装的引擎
      const cInstalled = (res.env.cli || []).filter(x => x.installed);
      const dInstalled = (res.env.desktop || []).filter(x => x.installed);
      renderGuestEnvCards(res.env);
      if (statusEl) statusEl.textContent = '（客机已就绪 ' + cInstalled.length + ' 个无头 CLI、' + dInstalled.length + ' 个桌面端订阅源，点击即可切换）';
      if (force) toast('客机环境检测完成：' + cInstalled.length + ' 个无头 CLI，' + dInstalled.length + ' 个桌面端订阅源', 'ok');
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = '（环境检测失败：' + err.message + '）';
    renderGuestEnvCards(null);
    if (force) toast(err.message, 'error');
  }
}

function renderAgent(data) {
  const info = data || agentInfo();
  if (!info) return;
  const status = $('#agentStatus');
  const meta = $('#agentMeta');
  const open = $('#agentOpen');
  const stop = $('#btnAgentStop');
  const start = $('#btnAgentStart');
  const count = $('#agentCount');
  if (!status || !meta) return;

  if (info.running) {
    status.innerHTML = '<span class="agent-dot on"></span>已启动 · ' + escapeHtml(info.deviceName || info.deviceId)
      + (info.os ? ' · ' + escapeHtml(info.os) : '');
    meta.innerHTML = [
      ['无头引擎', agentBackendLabel(info.backend) + (info.model ? ' · ' + info.model : '')],
      ['本机入口', info.url ? '127.0.0.1:' + info.localPort : '—'],
      ['远端服务', '127.0.0.1:' + (info.remotePort || '—') + '（静默后台）'],
      ['允许目录', String((info.roots || []).length) + ' 个同步文件夹'],
      ['启动时间', info.startedAt ? clock(info.startedAt) : '—']
    ].map(row => '<div><dt>' + row[0] + '</dt><dd>' + escapeHtml(row[1]) + '</dd></div>').join('');
    if (open) {
      open.hidden = false;
      open.href = info.url || '#';
    }
    if (stop) stop.hidden = false;
    if (start) start.disabled = true;
    const deviceSelect = $('#agentDevice');
    if (deviceSelect) deviceSelect.disabled = true;
    const backendSelect = $('#agentBackend');
    if (backendSelect) backendSelect.disabled = true;
    if (count) {
      count.hidden = false;
      count.textContent = '1';
    }
  } else {
    status.innerHTML = '<span class="agent-dot"></span>未启动';
    meta.innerHTML = '<div><dt>状态</dt><dd>选择客机同步目录与无头 CLI 引擎后启动，全程后台静默运行不打扰客机</dd></div>';
    if (open) open.hidden = true;
    if (stop) stop.hidden = true;
    if (start) start.disabled = false;
    const deviceSelect = $('#agentDevice');
    if (deviceSelect) deviceSelect.disabled = false;
    const backendSelect = $('#agentBackend');
    if (backendSelect) backendSelect.disabled = false;
    if (count) count.hidden = true;
  }
}

function renderAgentPairs(pairs, selected) {
  const box = $('#agentPairs');
  if (!box) return;
  if (!pairs || !pairs.length) {
    box.innerHTML = '<p class="agent-empty">这台设备还没有同步文件夹。先在「文件中枢」里为它添加一个同步目录。</p>';
    return;
  }
  box.innerHTML = pairs.map(pair => {
    const checked = selected.includes(pair.name) ? ' checked' : '';
    return '<label class="agent-check">'
      + '<input type="checkbox" value="' + escapeHtml(pair.name) + '"' + checked + '>'
      + '<span><b>' + escapeHtml(pair.name) + '</b><em>' + escapeHtml(pair.remote || '') + '</em></span>'
      + '</label>';
  }).join('');
}

function fillAgentModels(models, providerId, preferredModel) {
  const select = $('#agentModel');
  if (!select) return;
  const provider = (models.providers || []).find(item => item.id === providerId);
  const labels = (models && models.modelLabels) || {};
  const list = provider && Array.isArray(provider.models) ? provider.models.slice() : [];
  select.innerHTML = list.length
    ? list.map(name => {
        const friendly = labels[name];
        const text = friendly && friendly !== name ? (name + ' · ' + friendly) : name;
        return '<option value="' + escapeHtml(name) + '">' + escapeHtml(text) + '</option>';
      }).join('')
    : '<option value="">未获取到模型（请检查客机登录或点刷新）</option>';
  const chosen = preferredModel && list.includes(preferredModel) ? preferredModel : (list[0] || '');
  select.value = chosen;
}

async function loadAgentModels(deviceId, backend, preferredProvider, preferredModel, forceRefresh) {
  const providerSelect = $('#agentProvider');
  const modelSelect = $('#agentModel');
  if (!providerSelect || !modelSelect) return;
  backend = normalizeAgentBackend(backend);
  const multiProvider = (backend === 'hermes' || backend === 'dsh' || backend === 'codex');
  providerSelect.disabled = !multiProvider;
  if (!deviceId) {
    providerSelect.innerHTML = '<option value="">自动（远端登录）</option>';
    modelSelect.innerHTML = '<option value="">默认模型</option>';
    return;
  }
  const key = deviceId + '|' + backend;
  let models = (!forceRefresh && state.agentModels && state.agentModels.key === key)
    ? state.agentModels.data : null;
  if (!models) {
    modelSelect.innerHTML = '<option value="">正在检测客机订阅与模型…</option>';
    try {
      models = await api('/api/agent/models?deviceId=' + encodeURIComponent(deviceId)
        + '&backend=' + encodeURIComponent(backend)
        + (forceRefresh ? '&refresh=1' : ''));
      state.agentModels = { key, data: models };
      if (models && models.autoSyncedCli) {
        toast('已自动为客机安装 Antigravity CLI 并同步桌面端订阅！', 'ok', 4500);
        detectGuestEnv(deviceId, true);
      }
    } catch (error) {
      state.agentModels = { key, data: { providers: [] } };
      const box = $('#agentError');
      if (box && box.hidden) {
        box.hidden = false;
        box.textContent = '读取远端模型列表失败，将使用远端默认设置：' + error.message;
      }
      models = state.agentModels.data;
    }
  }
  if (models && models.missing) {
    const box = $('#agentError');
    if (box) {
      box.hidden = false;
      box.textContent = backend === 'dsh'
        ? '客机尚未安装 DeepSeek Harness 桌面端；请先在客机安装并登录 DeepSeek Harness，或切换其他 CLI 引擎。'
        : ('远端还没有安装 ' + agentBackendLabel(backend) + '；启动时会自动安装，首次启动可能需要几分钟。');
    }
  } else if (models && models.error) {
    const box = $('#agentError');
    if (box) {
      box.hidden = false;
      box.textContent = models.error;
    }
  } else {
    const box = $('#agentError');
    if (box) box.hidden = true;
  }
  const providers = models.providers || [];
  providerSelect.innerHTML = (backend === 'hermes' ? '<option value="">自动（远端登录）</option>' : '')
    + (providers.length
      ? providers.map(item => '<option value="' + escapeHtml(item.id) + '">'
        + escapeHtml((item.active ? '● ' : '') + (item.label || item.id)) + '</option>').join('')
      : '<option value="">未检测到账号</option>');
  const provider = !multiProvider
    ? (providers[0] ? providers[0].id : backend)
    : (preferredProvider && providers.some(item => item.id === preferredProvider)
      ? preferredProvider
      : (models.defaultProvider || (providers[0] && providers[0].id) || ''));
  providerSelect.value = provider;
  fillAgentModels(models, provider, preferredModel || models.defaultModel || '');
}

async function refreshAgentOptions(force) {
  const info = agentInfo();
  const saved = info && info.selection ? info.selection : {};
  if (info && info.running) {
    const runningBackend = $('#agentBackend');
    if (runningBackend && info.backend) { runningBackend.value = info.backend; }
    renderAgent(info);
    return;
  }
  const select = $('#agentDevice');
  if (!select) return;
  const requested = select.value || saved.deviceId || '';
  if (!force && state.agentLoadedFor === requested && state.agentOptions) {
    renderAgent(info);
    return;
  }
  let options;
  try {
    options = await api('/api/agent/options?deviceId=' + encodeURIComponent(requested));
  } catch (error) {
    $('#agentError').hidden = false;
    $('#agentError').textContent = error.message;
    return;
  }
  const devices = options.devices || [];
  const valid = devices.some(device => device.id === requested);
  const chosen = valid ? requested : (options.selection && devices.some(device => device.id === options.selection.deviceId)
    ? options.selection.deviceId : (devices[0] ? devices[0].id : ''));
  if (chosen && chosen !== requested) {
    try { options = await api('/api/agent/options?deviceId=' + encodeURIComponent(chosen)); }
    catch (error) { }
  }
  const previousFor = state.agentLoadedFor;
  state.agentOptions = options;
  state.agentLoadedFor = chosen;
  select.innerHTML = devices.length
    ? devices.map(device => '<option value="' + escapeHtml(device.id) + '"' + (device.id === chosen ? ' selected' : '') + '>'
      + escapeHtml(device.name || device.host || device.id) + '</option>').join('')
    : '<option value="">没有可用于 Agent 的设备</option>';
  const savedPairs = options.selection && options.selection.deviceId === chosen && Array.isArray(options.selection.pairs)
    ? options.selection.pairs : [];
  const available = (options.pairs || []).map(pair => pair.name);
  const selected = savedPairs.filter(name => available.includes(name));
  renderAgentPairs(options.pairs || [], selected.length ? selected : available);
  const sameDevice = previousFor === chosen;
  const chosenDev = devices.find(d => d.id === chosen);
  const firstInstalledCli = chosenDev && chosenDev.guestEnv && Array.isArray(chosenDev.guestEnv.cli)
    ? (chosenDev.guestEnv.cli.find(x => x && x.installed) || {}).id
    : '';
  const savedBackend = (options.selection && options.selection.deviceId === chosen && options.selection.backend)
    ? normalizeAgentBackend(options.selection.backend)
    : normalizeAgentBackend(firstInstalledCli || 'dsh');
  const backendSelect = $('#agentBackend');
  if (!sameDevice && backendSelect) { backendSelect.value = savedBackend; }
  const backend = backendSelect ? normalizeAgentBackend(backendSelect.value) : savedBackend;
  loadAgentCredentials(chosen);
  detectGuestEnv(chosen, false);
  if (!devices.length) {
    renderAgent(info);
    $('#agentError').hidden = false;
    $('#agentError').textContent = '还没有带同步文件夹的 SSH 设备。远程 Agent 只支持已保存的 SSH 设备。';
    return;
  }
  $('#agentError').hidden = true;
  const savedProvider = options.selection && options.selection.deviceId === chosen ? options.selection.provider : '';
  const savedModel = options.selection && options.selection.deviceId === chosen ? options.selection.model : '';
  await loadAgentModels(
    chosen,
    backend,
    sameDevice ? $('#agentProvider').value : (savedProvider || ''),
    sameDevice ? $('#agentModel').value : (savedModel || '')
  );
  renderAgent(info);
}

function setCredState(backend, credential) {
  const el = $(backend === 'claude' ? '#agentClaudeState' : '#agentAgyState');
  if (!el) return;
  el.textContent = credential && credential.bound ? '已绑定访问密钥' : '未绑定（用远端登录）';
  el.classList.toggle('on', Boolean(credential && credential.bound));
}

async function loadAgentCredentials(deviceId) {
  $('#agentClaudeKey').value = '';
  $('#agentClaudeToken').value = '';
  $('#agentClaudeBase').value = '';
  $('#agentAgyKey').value = '';
  $('#agentAgyBase').value = '';
  if (!deviceId) {
    setCredState('claude', null);
    setCredState('agy', null);
    return;
  }
  try {
    const result = await api('/api/agent/credentials?deviceId=' + encodeURIComponent(deviceId));
    const credentials = result.credentials || {};
    setCredState('claude', credentials.claude);
    setCredState('agy', credentials.agy);
    if (credentials.claude && credentials.claude.baseUrl) {
      $('#agentClaudeBase').placeholder = '已保存 ANTHROPIC_BASE_URL（留空保持不变）';
    }
    if (credentials.agy && credentials.agy.baseUrl) {
      $('#agentAgyBase').placeholder = '已保存 GOOGLE_GEMINI_BASE_URL（留空保持不变）';
    }
  } catch {
    setCredState('claude', null);
    setCredState('agy', null);
  }
}

function agentCredentialPayload() {
  const claude = {};
  const agy = {};
  const claudeKey = $('#agentClaudeKey').value.trim();
  const claudeToken = $('#agentClaudeToken').value.trim();
  const claudeBase = $('#agentClaudeBase').value.trim();
  const agyKey = $('#agentAgyKey').value.trim();
  const agyBase = $('#agentAgyBase').value.trim();
  if (claudeKey) claude.apiKey = claudeKey;
  if (claudeToken) claude.oauthToken = claudeToken;
  if (claudeBase) claude.baseUrl = claudeBase;
  if (agyKey) agy.apiKey = agyKey;
  if (agyBase) agy.baseUrl = agyBase;
  return { claude, agy };
}

async function clearAgentCredentials(deviceId, backend) {
  if (!deviceId) return;
  try {
    const patch = {};
    patch[backend] = { clear: true };
    const result = await post('/api/agent/credentials', Object.assign({ deviceId }, patch));
    setCredState(backend, result.credentials && result.credentials[backend]);
    toast('已清除 ' + agentBackendLabel(backend) + ' 的访问绑定', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function openStandaloneAgentPopup(url) {
  const features = 'popup=yes,width=1360,height=880,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes';
  return window.open(url || 'about:blank', 'smac_agent_window', features);
}

async function startAgent() {
  const deviceId = $('#agentDevice').value;
  const pairs = $$('#agentPairs input[type="checkbox"]').filter(input => input.checked).map(input => input.value);
  if (!deviceId) { toast('请选择目标客机设备', 'error'); return; }
  if (!pairs.length) {
    toast('请先为该客机添加并勾选至少一个允许操作的同步目录', 'error');
    openAddSyncForDevice(deviceId);
    return;
  }
  const errorBox = $('#agentError');
  if (errorBox) errorBox.hidden = true;
  const win = openStandaloneAgentPopup('about:blank');
  const button = $('#btnAgentStart');
  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.textContent = '正在启动…';
  try {
    const credentials = agentCredentialPayload();
    if (Object.keys(credentials.claude).length || Object.keys(credentials.agy).length) {
      const saved = await post('/api/agent/credentials', Object.assign({ deviceId }, credentials));
      setCredState('claude', saved.credentials && saved.credentials.claude);
      setCredState('agy', saved.credentials && saved.credentials.agy);
    }
    const result = await post('/api/agent/start', {
      deviceId,
      pairs,
      backend: normalizeAgentBackend($('#agentBackend').value),
      provider: $('#agentProvider').value,
      model: $('#agentModel').value
    });
    if (state.data) state.data.agent = result.agent;
    renderAgent(result.agent);
    const targetUrl = result.agent.url;
    if (win) win.location.href = targetUrl;
    else toast('隧道已启动，请在右侧点击打开页面', 'ok', 6000);
    toast('远程无头 Agent 已启动（后台静默运行，不影响客机使用）', 'ok');
  } catch (error) {
    if (win) { try { win.close(); } catch { } }
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.textContent = error.message;
    }
    toast(error.message, 'error', 8000);
  } finally {
    button.innerHTML = originalHtml;
    button.disabled = Boolean(agentInfo() && agentInfo().running);
    renderGuestEnvCards(state.guestEnv);
  }
}

async function stopAgent() {
  const button = $('#btnAgentStop');
  button.disabled = true;
  try {
    const result = await post('/api/agent/stop', {});
    if (state.data) state.data.agent = result.agent;
    renderAgent(result.agent);
    toast('远程 Agent 已停止', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

// ---------- actions ----------

async function addPair() {
  const local = $('#addLocal').value.trim();
  const remote = $('#addRemote').value.trim();
  const name = $('#addName').value.trim();
  const errorBox = $('#addError');
  errorBox.hidden = true;

  if (!local) {
    errorBox.textContent = '请选择或填写本机文件夹路径。';
    errorBox.hidden = false;
    return;
  }
  if (!remote) {
    errorBox.textContent = '请填写远端目标位置，例如 ~/Desktop/论文。';
    errorBox.hidden = false;
    return;
  }

  const button = $('#btnAddSubmit');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '正在创建…';
  try {
    const result = await post('/api/sync/add', { local, remote, name, device: state.addDeviceId || undefined });
    const lines = String(result.output || '').split(/\r?\n/).filter(Boolean);
    toast(lines[lines.length - 1] || '已添加同步文件夹', 'ok');
    closeModal('addModal');
    state.pairsSignature = '';
    await refreshState();
    refreshLog();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function startSync(name) {
  try {
    await post('/api/sync/now', name ? { name } : {});
    state.lastJobRunning = true;
    toast(name ? '已开始同步 ' + name : '已开始同步全部文件夹', 'info', 1800);
    refreshState();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function togglePair(name, enabled) {
  try {
    await post('/api/sync/enable', { name, enabled });
    toast(enabled ? '已启用 ' + name : '已暂停 ' + name, 'ok', 2000);
    state.pairsSignature = '';
    refreshState();
  } catch (error) {
    toast(error.message, 'error');
    state.pairsSignature = '';
    refreshState();
  }
}

async function removePair(name) {
  const ok = await confirmDialog(
    '移除同步',
    '确定移除同步文件夹 <b>' + escapeHtml(name) + '</b> 吗？<br>两端的文件都会保留，只是不再自动同步。',
    '移除'
  );
  if (!ok) return;
  try {
    await post('/api/sync/remove', { name });
    toast('已移除 ' + name, 'ok');
    state.pairsSignature = '';
    refreshState();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function clipAction(action, successText) {
  $('#chkClipAuto').disabled = true;
  try {
    const result = await post('/api/clip/service', { action });
    const lines = String(result.output || '').split(/\r?\n/).filter(Boolean);
    toast(successText || lines[lines.length - 1] || '操作完成', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    $('#chkClipAuto').disabled = false;
    refreshState();
  }
}

async function clipSyncNow() {
  try {
    await post('/api/clip/now', {});
    state.lastJobRunning = true;
    toast('已开始同步剪贴板', 'info', 1800);
    refreshState();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function serviceAction(action, successText) {
  $('#chkAuto').disabled = true;
  try {
    const result = await post('/api/service', { action });
    const lines = String(result.output || '').split(/\r?\n/).filter(Boolean);
    toast(successText || lines[lines.length - 1] || '操作完成', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    $('#chkAuto').disabled = false;
    await refreshState();
  }
}

async function pickInto(inputSelector, kind) {
  try {
    if (kind === 'file') {
      const result = await post('/api/pick-file');
      if (result.files && result.files.length > 0) {
        state.sendPaths = result.files;
        $(inputSelector).value = result.files.length === 1
          ? result.files[0]
          : result.files[0] + ' 等 ' + result.files.length + ' 个文件';
        toast('已选择 ' + result.files.length + ' 个文件', 'ok', 1800);
      }
      return;
    }
    const result = await post('/api/pick-folder');
    if (result.path) {
      state.sendPaths = [];
      $(inputSelector).value = result.path;
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

function readAllDirectoryEntries(dirReader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const readBatch = () => {
      dirReader.readEntries(batch => {
        if (!batch || !batch.length) {
          resolve(all);
        } else {
          all.push(...batch);
          readBatch();
        }
      }, reject);
    };
    readBatch();
  });
}

async function collectDroppedEntries(entries, fallbackFiles) {
  const fileItems = [];
  const emptyDirs = [];
  const topNames = [];

  async function walkEntry(entry, parentPath) {
    if (!entry) return;
    const cleanName = String(entry.name || '').replace(/[\\/]/g, '_').trim();
    if (!cleanName || cleanName === '.' || cleanName === '..') return;
    const relPath = parentPath ? (parentPath + '/' + cleanName) : cleanName;
    if (!parentPath && !topNames.includes(cleanName)) topNames.push(cleanName);

    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      fileItems.push({ file, relPath });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const children = await readAllDirectoryEntries(reader);
      if (!children.length) {
        emptyDirs.push(relPath);
      } else {
        for (const child of children) {
          await walkEntry(child, relPath);
        }
      }
    }
  }

  if (entries && entries.length) {
    for (const entry of entries) {
      await walkEntry(entry, '');
    }
  }

  if (!fileItems.length && !emptyDirs.length && fallbackFiles && fallbackFiles.length) {
    for (const file of fallbackFiles) {
      const rel = String(file.webkitRelativePath || file.name || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!rel) continue;
      const top = rel.split('/')[0];
      if (top && !topNames.includes(top)) topNames.push(top);
      fileItems.push({ file, relPath: rel });
    }
  }

  return { fileItems, emptyDirs, topNames };
}

async function handleDropTransfer(dt) {
  if (state.dropUploading || (state.data && state.data.job && state.data.job.running)) {
    toast('当前有传输或同步任务正在运行，请稍候再拖入', 'warn');
    return;
  }

  const device = deviceById(state.sendDeviceId);
  const targetName = deviceLabel(device);
  if (!device && isWindowsHost() && !hasLegacyMacTarget()) {
    toast('请先在「远程设备 · 客机」添加目标设备后再拖拽发送', 'warn');
    return;
  }

  // 1. 快照拖拽句柄（必须在第一个 await 前同步读取 webkitGetAsEntry 与 files）
  const entries = [];
  const rawFiles = Array.from((dt && dt.files) || []);
  if (dt && dt.items && dt.items.length) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (item && item.kind === 'file' && typeof item.webkitGetAsEntry === 'function') {
        try {
          const entry = item.webkitGetAsEntry();
          if (entry) entries.push(entry);
        } catch { }
      }
    }
  }

  // 2. macOS 原生 WKWebView 零拷贝本地路径直传通道
  const nativePaths = (Array.isArray(window.__smacNativeDragPaths)
    && window.__smacNativeDragPaths.length > 0
    && (Date.now() - (window.__smacNativeDragAt || 0) < 25000))
    ? window.__smacNativeDragPaths.slice()
    : null;
  window.__smacNativeDragPaths = null;

  const dz = $('#sendDropZone');
  if (nativePaths && nativePaths.length) {
    const names = nativePaths.map(p => basename(p)).filter(Boolean);
    state.lastDropSummary = names.length === 1
      ? ('「' + names[0] + '」')
      : ('「' + (names[0] || '项目') + '」等 ' + names.length + ' 项');
    try {
      if (dz) {
        dz.classList.remove('is-dragover', 'is-done');
        dz.classList.add('is-busy');
      }
      await post('/api/send', { paths: nativePaths, device: state.sendDeviceId || undefined });
      state.lastJobRunning = true;
      toast('开始传输 ' + state.lastDropSummary + ' 到 ' + targetName + ' 桌面', 'info', 2500);
      refreshState();
    } catch (error) {
      if (dz) dz.classList.remove('is-busy');
      toast(error.message, 'error');
    }
    return;
  }

  // 3. 通用 HTML5 文件 / 图片 / 压缩包 / 递归文件夹流式传输
  state.dropUploading = true;
  if (dz) {
    dz.classList.remove('is-dragover', 'is-done');
    dz.classList.add('is-busy');
  }
  const titleEl = $('#sendDropTitle');
  const progBox = $('#sendDropProgress');
  const barFill = $('#sendDropBarFill');
  const progText = $('#sendDropProgressText');
  if (titleEl) titleEl.textContent = '正在扫描拖入的文件与文件夹…';
  if (progBox) progBox.hidden = false;
  if (barFill) barFill.style.width = '5%';
  if (progText) progText.textContent = '正在读取目录层级…';

  try {
    const { fileItems, emptyDirs, topNames } = await collectDroppedEntries(entries, rawFiles);
    if (!fileItems.length && !emptyDirs.length) {
      throw new Error('未识别到可传输的文件或文件夹，请从桌面或资源管理器/Finder 直接拖入');
    }

    const summary = topNames.length === 1
      ? ('「' + topNames[0] + '」' + (fileItems.length > 1 ? '（共 ' + fileItems.length + ' 个文件）' : ''))
      : ('「' + (topNames[0] || '文件') + '」等 ' + topNames.length + ' 项（共 ' + (fileItems.length || emptyDirs.length) + ' 个文件）');
    state.lastDropSummary = summary;

    const batchId = 'drop_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const totalBytes = fileItems.reduce((acc, it) => acc + (Number(it.file.size) || 0), 0);
    let uploadedBytes = 0;

    if (titleEl) titleEl.textContent = '正在发往 ' + targetName + ' 桌面…';

    for (let i = 0; i < fileItems.length; i++) {
      const it = fileItems[i];
      const pct = totalBytes > 0
        ? Math.min(96, Math.max(6, Math.round((uploadedBytes / totalBytes) * 92) + 4))
        : Math.min(96, Math.round(((i + 1) / fileItems.length) * 92));
      if (barFill) barFill.style.width = pct + '%';
      if (progText) {
        progText.textContent = '正在读取 (' + (i + 1) + '/' + fileItems.length + ')：' + it.relPath;
      }

      const upRes = await fetch('/api/send/upload-item?batchId=' + encodeURIComponent(batchId), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Batch-Id': batchId,
          'X-Rel-Path': encodeURIComponent(it.relPath)
        },
        body: it.file
      });
      const upData = await upRes.json().catch(() => ({}));
      if (!upRes.ok || !upData.ok) {
        throw new Error((upData && upData.output) || ('读取文件失败: ' + it.relPath));
      }
      uploadedBytes += Number(it.file.size) || 0;
    }

    if (barFill) barFill.style.width = '100%';
    if (progText) progText.textContent = '正在通过加密通道传输 ' + summary + ' 到 ' + targetName + ' 桌面…';

    await post('/api/send/commit-batch', {
      batchId,
      device: state.sendDeviceId || undefined,
      emptyDirs
    });

    state.dropUploading = false;
    state.lastJobRunning = true;
    toast('开始传输 ' + summary + ' 到 ' + targetName + ' 桌面', 'info', 2600);
    refreshState();
  } catch (error) {
    state.dropUploading = false;
    if (dz) dz.classList.remove('is-busy');
    if (progBox) progBox.hidden = true;
    if (titleEl) titleEl.textContent = '拖拽任意文件或文件夹到此处，松手即传桌面';
    updateSendTarget();
    toast(error.message || '拖拽传输失败', 'error');
  }
}

function bindSendDropZone() {
  const dz = $('#sendDropZone');
  const panel = $('#transferPanel');
  if (!dz) return;

  // 阻止窗口任意位置误拖入文件导致页面跳转
  window.addEventListener('dragover', e => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
    }
  });
  window.addEventListener('drop', e => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      if (!dz.contains(e.target) && (!panel || !panel.contains(e.target))) {
        e.preventDefault();
      }
    }
  });

  let dragDepth = 0;
  const targetArea = panel || dz;

  targetArea.addEventListener('dragenter', e => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth++;
    dz.classList.add('is-dragover');
    dz.classList.remove('is-done');
    const targetName = deviceLabel(deviceById(state.sendDeviceId));
    if ($('#sendDropTitle') && !state.dropUploading) {
      $('#sendDropTitle').textContent = '松开鼠标，立即发送到 ' + targetName + ' 桌面';
    }
  });

  targetArea.addEventListener('dragover', e => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!dz.classList.contains('is-dragover')) dz.classList.add('is-dragover');
  });

  targetArea.addEventListener('dragleave', e => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dz.classList.remove('is-dragover');
      if ($('#sendDropTitle') && !state.dropUploading && !dz.classList.contains('is-busy')) {
        $('#sendDropTitle').textContent = '拖拽任意文件或文件夹到此处，松手即传桌面';
      }
    }
  });

  targetArea.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    dz.classList.remove('is-dragover');
    if (e.dataTransfer) {
      handleDropTransfer(e.dataTransfer);
    }
  });

  dz.addEventListener('paste', e => {
    if (e.clipboardData && ((e.clipboardData.files && e.clipboardData.files.length) || (e.clipboardData.items && e.clipboardData.items.length))) {
      e.preventDefault();
      handleDropTransfer(e.clipboardData);
    }
  });
}

async function showRemoteList() {
  const body = $('#remoteListBody');
  const device = deviceById(state.sendDeviceId);
  const title = $('#remoteListTitle');
  if (title) title.textContent = deviceLabel(device) + ' 接收目录';
  body.textContent = '正在读取 ' + deviceLabel(device) + ' 的接收目录…';
  openModal('listModal');
  try {
    const result = await post('/api/remote-list', { device: state.sendDeviceId || undefined });
    body.textContent = result.output || '(空)';
  } catch (error) {
    body.textContent = error.message;
  }
}

function getSyncRemoteDir() {
  return String(state.data && state.data.config.syncRemoteDir || '~/Documents').replace(/\/+$/, '');
}

function updateSuggestedRemote() {
  if (!state.addRemoteAuto) return;
  const name = basename($('#addLocal').value) || basename($('#addName').value);
  $('#addRemote').value = getAddRemoteRoot() + (name ? '/' + name : '');
}

async function saveSyncRemoteDir() {
  if (state.syncRemoteDirSaving) return;
  const input = $('#syncRemoteDirInput');
  const value = input.value.trim();
  if (!value) {
    toast('请填写 Mac 默认同步目录，例如 ~/Documents', 'warn');
    input.focus();
    return;
  }
  const button = $('#btnSaveSyncRemoteDir');
  state.syncRemoteDirSaving = true;
  button.disabled = true;
  input.disabled = true;
  button.textContent = '保存中…';
  try {
    await post('/api/config', { syncRemoteDir: value });
    state.refreshSerial++;
    const savedDir = value.replace(/\/+$/, '');
    if (state.data) state.data.config.syncRemoteDir = savedDir;
    input.value = savedDir;
    state.syncRemoteDirDirty = false;
    toast('默认同步目录已保存；已有同步和发送目录保持不变', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.syncRemoteDirSaving = false;
    button.disabled = false;
    input.disabled = false;
    button.textContent = '保存';
    await refreshState();
  }
}

// ---------- view switching ----------

function applyView(view, updateHash) {
  const remote = view === 'remote';
  const agentViewMode = view === 'agent';
  const hubViewMode = view === 'hub';
  const dash = $('#dashView');
  const remoteView = $('#remoteView');
  const agentView = $('#agentView');
  const hubView = $('#hubView');
  if (!dash || !remoteView || !agentView) return;
  dash.hidden = remote || agentViewMode || hubViewMode;
  remoteView.hidden = !remote;
  agentView.hidden = !agentViewMode;
  if (hubView) hubView.hidden = !hubViewMode;
  const activeKey = hubViewMode ? 'hub' : (agentViewMode ? 'agent' : (remote ? 'remote' : 'files'));
  document.body.dataset.view = activeKey;
  $$('#viewSwitch .view-btn').forEach(button => {
    button.classList.toggle('active', button.dataset.view === activeKey);
  });
  if (updateHash) {
    const target = hubViewMode ? '#hub' : (agentViewMode ? '#agent' : (remote ? '#remote' : location.pathname + location.search));
    if (hubViewMode ? location.hash !== '#hub' : (agentViewMode ? location.hash !== '#agent' : (remote ? location.hash !== '#remote' : location.hash))) {
      history.replaceState(null, '', target);
    }
  }
  if (remote && window.SmacRemote) {
    window.SmacRemote.init();
    window.SmacRemote.activate();
  }
  if (hubViewMode && window.SmacHub) {
    window.SmacHub.activate();
  }
  if (agentViewMode) refreshAgentOptions(true);
  window.scrollTo(0, 0);
}

function setView(view) {
  applyView(view, true);
}
window.setView = setView;

// ---------- wiring ----------

// ---------- 客机快捷操作与安装包配对 ----------

function openAddSyncForDevice(deviceId) {
  resetAddForm();
  state.addDeviceId = deviceId || '';
  const deviceSelect = $('#addDevice');
  if (deviceSelect) deviceSelect.value = state.addDeviceId;
  updateAddDeviceMode();
  updateSuggestedRemote();
  openModal('addModal');
  setTimeout(() => $('#addLocal').focus(), 60);
}

function openSendToDeviceDesktop(deviceId) {
  setView('files');
  state.sendDeviceId = deviceId || '';
  const sendSelect = $('#sendDevice');
  if (sendSelect) sendSelect.value = state.sendDeviceId;
  updateSendTarget();
  setTimeout(() => {
    const dz = $('#sendDropZone');
    if (dz) {
      dz.scrollIntoView({ behavior: 'smooth', block: 'center' });
      dz.classList.add('pulse-highlight');
      dz.focus();
      setTimeout(() => dz.classList.remove('pulse-highlight'), 1800);
    }
    toast('已切换发送目标到 ' + deviceLabel(deviceById(state.sendDeviceId)) + ' 的桌面，直接将文件或文件夹拖入传输区即可发送', 'info', 2800);
  }, 80);
}

function openAgentForDevice(deviceId) {
  setView('agent');
  const select = $('#agentDevice');
  if (select && deviceId) {
    select.value = deviceId;
    state.agentLoadedFor = '';
    refreshAgentOptions(true);
  }
}

async function openGuestPairingModal() {
  $('#guestModalError').hidden = true;
  $('#guestPairCodeInput').value = '';
  if ($('#guestOverrideAddr')) $('#guestOverrideAddr').value = '';
  openModal('guestModal');
  try {
    const res = await api('/api/guest/pairing');
    if (res && res.pairing && Array.isArray(res.pairing.endpoints)) {
      const ztInfo = res.pairing.zerotierNetworkId
        ? 'ZeroTier 组: ' + res.pairing.zerotierNetworkId + (res.pairing.zerotierIp ? ' (' + res.pairing.zerotierIp + ')' : ' (待授权/未分配IP)') + '  |  '
        : '';
      $('#hostPairEndpoints').textContent = ztInfo + (res.pairing.endpoints.join('  |  ') || '未检测到局域网/ZeroTier/Tailscale IP');
    }
  } catch (err) {
    $('#hostPairEndpoints').textContent = '读取配对地址失败: ' + err.message;
  }
}

function downloadGuestSetupZip() {
  toast('正在生成客机端安装包 (smac-guest-setup.zip)…', 'info', 2500);
  const a = document.createElement('a');
  a.href = '/api/guest/package';
  a.download = 'smac-guest-setup.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function submitGuestPairCode() {
  const code = $('#guestPairCodeInput').value.trim();
  const overrideAddress = $('#guestOverrideAddr') ? $('#guestOverrideAddr').value.trim() : '';
  const errBox = $('#guestModalError');
  errBox.hidden = true;
  if (!code) {
    errBox.textContent = '请粘贴客机安装完成时输出的 SMAC-GUEST:// 配对码';
    errBox.hidden = false;
    return;
  }
  const btn = $('#btnSubmitPairCode');
  btn.disabled = true;
  btn.textContent = '连接中…';
  try {
    const res = await post('/api/guest/pair-code', { code, overrideAddress });
    closeModal('guestModal');
    toast('客机 ' + (res.device && res.device.name || '') + ' 已成功连接并同步环境！', 'ok', 5000);
    await refreshState();
    if (window.SmacRemote) window.SmacRemote.loadDevices();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '立即接入';
  }
}

let installModalState = { deviceId: '', catalog: null, env: null, running: false };

function updateInstallSelectedCount() {
  const count = $$('#installToolsModal input[data-install-id]:checked').length;
  const el = $('#installSelectedCount');
  if (el) el.textContent = '已选 ' + count + ' 项';
  const btn = $('#btnRunRemoteInstall');
  if (btn && !installModalState.running) btn.disabled = count === 0;
}

function renderInstallGrids() {
  const cliGrid = $('#installCliGrid');
  const deskGrid = $('#installDesktopGrid');
  if (!cliGrid || !deskGrid || !installModalState.catalog) return;
  const dev = deviceById(installModalState.deviceId);
  const isWinTarget = !dev || !dev.os || /win/i.test(dev.os);
  const env = installModalState.env;

  const findEnv = (kind, id) => {
    if (!env) return null;
    const arr = kind === 'desktop' ? env.desktop : env.cli;
    return Array.isArray(arr) ? arr.find(x => x && x.id === id) : null;
  };

  const renderList = (list, kind) => list.map(item => {
    const detected = findEnv(kind, item.id);
    const installed = Boolean(detected && detected.installed);
    const method = isWinTarget ? item.methodWin : item.methodPosix;
    const titlePath = installed && detected.path ? ('已安装: ' + detected.path) : method;
    return '<label class="install-item' + (installed ? ' installed' : '') + '" title="' + escapeHtml(titlePath) + '">' +
      '<input type="checkbox" data-install-kind="' + kind + '" data-install-id="' + escapeHtml(item.id) + '">' +
      '<div class="install-item-body">' +
        '<div class="install-item-top"><b>' + escapeHtml(item.name) + '</b>' +
          '<span class="ge-badge ' + (installed ? 'ok' : '') + '">' + (installed ? '已安装' : '未安装') + '</span>' +
        '</div>' +
        '<div class="install-item-sub">' + escapeHtml(installed && detected.path ? detected.path : method) + '</div>' +
      '</div>' +
    '</label>';
  }).join('');

  cliGrid.innerHTML = renderList(installModalState.catalog.cli || [], 'cli');
  deskGrid.innerHTML = renderList(installModalState.catalog.desktop || [], 'desktop');
  updateInstallSelectedCount();
}

async function openInstallToolsForDevice(deviceId) {
  const id = String(deviceId || ($('#agentDevice') && $('#agentDevice').value) || '').trim();
  if (!id) {
    toast('请先选择一台已连接的客机设备', 'warn');
    return;
  }
  const dev = deviceById(id);
  installModalState.deviceId = id;
  installModalState.env = (dev && dev.guestEnv) || (state.agentLoadedFor === id ? state.guestEnv : null);
  $('#installToolsTitle').textContent = '远程给 ' + (dev ? dev.name : '客机') + ' 安装 CLI / Desktop';
  $('#installToolsError').hidden = true;
  $('#installResultsBox').hidden = true;
  $('#installResultsList').innerHTML = '';
  openModal('installToolsModal');

  try {
    if (!installModalState.catalog) {
      const cat = await api('/api/agent/install-catalog');
      installModalState.catalog = cat.catalog || { cli: [], desktop: [] };
    }
    renderInstallGrids();
    if (!installModalState.env) {
      const res = await api('/api/agent/env?deviceId=' + encodeURIComponent(id));
      if (res && res.env) {
        installModalState.env = res.env;
        renderInstallGrids();
      }
    }
  } catch (err) {
    $('#installToolsError').textContent = err.message;
    $('#installToolsError').hidden = false;
  }
}

async function runRemoteInstallTools() {
  if (installModalState.running) return;
  const deviceId = installModalState.deviceId;
  const checked = $$('#installToolsModal input[data-install-id]:checked');
  const items = checked.map(el => ({
    kind: el.dataset.installKind || 'cli',
    id: el.dataset.installId || ''
  })).filter(x => x.id);
  if (!deviceId || !items.length) {
    toast('请先勾选至少一个要安装的 CLI 或 Desktop 组件', 'warn');
    return;
  }

  installModalState.running = true;
  const btn = $('#btnRunRemoteInstall');
  const errBox = $('#installToolsError');
  const resBox = $('#installResultsBox');
  const resList = $('#installResultsList');
  const resTitle = $('#installResultsTitle');
  errBox.hidden = true;
  btn.disabled = true;
  btn.textContent = '正在远程安装（可能需要 1–3 分钟）…';
  resBox.hidden = false;
  resTitle.textContent = '正在客机后台静默安装 ' + items.length + ' 项组件（默认目录）…';
  resList.innerHTML = '<div class="install-res-row">请稍候，安装完成后会自动重新探测客机并返回每项状态。</div>';

  try {
    const data = await post('/api/agent/install-tools', { deviceId, items });
    if (data.env) {
      installModalState.env = data.env;
      if (state.agentLoadedFor === deviceId) {
        state.guestEnv = data.env;
        renderGuestEnvCards(data.env);
      }
    }
    const rows = Array.isArray(data.results) ? data.results : [];
    resTitle.textContent = '安装完成：成功 ' + (data.okCount || 0) + ' / ' + (data.total || rows.length) + ' 项';
    resList.innerHTML = rows.map(r => {
      const icon = r.ok ? '✓' : '✕';
      return '<div class="install-res-row ' + (r.ok ? 'ok' : 'fail') + '">' +
        '<span><b>' + icon + ' ' + escapeHtml(r.name || r.id) + '</b> · ' + escapeHtml(r.message || '') + '</span>' +
        (r.path ? '<code>' + escapeHtml(r.path) + '</code>' : '') +
      '</div>';
    }).join('');
    renderInstallGrids();
    await refreshState();
    if (window.SmacRemote) window.SmacRemote.loadDevices();
    toast('远程安装完成：成功 ' + (data.okCount || 0) + '/' + (data.total || rows.length) + ' 项', data.ok ? 'ok' : 'warn', 6000);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.hidden = false;
    resTitle.textContent = '安装失败';
    toast(err.message, 'error', 6000);
  } finally {
    installModalState.running = false;
    btn.textContent = '开始远程安装';
    updateInstallSelectedCount();
  }
}

window.toast = toast;
window.confirmDialog = confirmDialog;
window.closeModal = closeModal;
window.SmacHostActions = {
  openAddSyncForDevice,
  openSendToDeviceDesktop,
  openAgentForDevice,
  openInstallToolsForDevice
};

function resetAddForm() {
  $('#addLocal').value = '';
  state.addRemoteAuto = true;
  const devices = remoteDevices();
  state.addDeviceId = hasLegacyMacTarget() ? '' : (devices[0] ? devices[0].id : '');
  const deviceSelect = $('#addDevice');
  if (deviceSelect) deviceSelect.value = state.addDeviceId;
  updateAddDeviceMode();
  $('#addRemote').value = getAddRemoteRoot();
  $('#addName').value = '';
  $('#addError').hidden = true;
}

function wire() {
  $('#viewSwitch').addEventListener('click', event => {
    const button = event.target.closest('.view-btn');
    if (button) setView(button.dataset.view);
  });
  window.addEventListener('hashchange', () => {
    const view = location.hash === '#hub' ? 'hub' : (location.hash === '#remote' ? 'remote' : (location.hash === '#agent' ? 'agent' : 'files'));
    if (view !== document.body.dataset.view) applyView(view, false);
  });
  if (window.SmacRemote) window.SmacRemote.init();
  $('#btnOpenAdd').addEventListener('click', () => { resetAddForm(); openModal('addModal'); setTimeout(() => $('#addLocal').focus(), 60); });
  if ($('#btnDiscoverPeers')) {
    $('#btnDiscoverPeers').addEventListener('click', async () => {
      const btn = $('#btnDiscoverPeers');
      const orig = btn.innerHTML;
      btn.disabled = true;
      btn.textContent = '识别中…';
      try {
        const res = await post('/api/peer/discover', {});
        state.pairsSignature = '';
        await refreshState();
        if (window.SmacRemote) window.SmacRemote.loadDevices();
        const pCount = (res.addedPairs || []).length;
        const dCount = (res.addedDevices || []).length;
        if (pCount || dCount) {
          toast('已自动识别并导入 ' + pCount + ' 个同步目录' + (dCount ? '、' + dCount + ' 台已配对设备' : ''), 'ok', 5000);
        } else if (res.peersMatched > 0) {
          toast('已连接 ' + res.peersMatched + ' 台已配对主机，所有同步目录均已最新显示', 'info', 3500);
        } else {
          toast('未发现新的已配对目录；请确认目标主机已添加到「远程设备 · 客机」且 SSH 可达', 'info', 4000);
        }
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    });
  }
  $('#btnEmptyAdd').addEventListener('click', () => { resetAddForm(); openModal('addModal'); setTimeout(() => $('#addLocal').focus(), 60); });
  $('#btnBrowseLocal').addEventListener('click', async () => {
    await pickInto('#addLocal', 'folder');
    updateSuggestedRemote();
  });
  $('#addLocal').addEventListener('input', updateSuggestedRemote);
  $('#addName').addEventListener('input', updateSuggestedRemote);
  $('#addRemote').addEventListener('input', () => { state.addRemoteAuto = false; });
  $('#addDevice').addEventListener('change', event => {
    state.addDeviceId = event.target.value || '';
    state.addRemoteAuto = true;
    updateAddDeviceMode();
    updateSuggestedRemote();
  });
  $('#sendDevice').addEventListener('change', event => {
    state.sendDeviceId = event.target.value || '';
    updateSendTarget();
  });
  $('#btnAddSubmit').addEventListener('click', addPair);
  $('#syncRemoteDirInput').addEventListener('input', () => { state.syncRemoteDirDirty = true; });
  $('#syncRemoteDirInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveSyncRemoteDir();
    }
  });
  $('#btnSaveSyncRemoteDir').addEventListener('click', saveSyncRemoteDir);

  $$('#remotePresets button').forEach(button => {
    button.addEventListener('click', () => {
      const preset = button.dataset.preset;
      const remoteInput = $('#addRemote');
      if (preset === 'same' || preset === 'default') {
        state.addRemoteAuto = true;
        updateSuggestedRemote();
      } else {
        state.addRemoteAuto = false;
        remoteInput.value = preset;
      }
      remoteInput.focus();
    });
  });

  $$('[data-close]').forEach(button => {
    button.addEventListener('click', () => closeModal(button.dataset.close));
  });

  $$('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('mousedown', event => {
      if (event.target === backdrop && backdrop.id !== 'confirmModal') closeModal(backdrop.id);
    });
  });

  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      const open = $$('.modal-backdrop:not([hidden])');
      if (open.length > 0) {
        const top = open[open.length - 1];
        if (top.id === 'confirmModal') settleConfirm(false);
        else closeModal(top.id);
      }
    }
    if (event.key === 'Enter' && !$('#addModal').hidden) {
      if (event.target.tagName === 'INPUT') addPair();
    }
  });

  $('#confirmOk').addEventListener('click', () => settleConfirm(true));
  $('#confirmCancel').addEventListener('click', () => settleConfirm(false));
  $('#confirmModal').addEventListener('mousedown', event => {
    if (event.target === $('#confirmModal')) settleConfirm(false);
  });

  $('#pairList').addEventListener('click', event => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const card = button.closest('.pair');
    const name = card.dataset.name;
    const action = button.dataset.act;
    if (action === 'sync') {
      button.classList.add('busy');
      startSync(name);
    } else if (action === 'remove') {
      removePair(name);
    } else if (action === 'reveal') {
      const pair = (state.data && state.data.pairs || []).find(item => item.name === name);
      if (!pair) return;
      post('/api/reveal', { path: pair.local }).catch(error => toast(error.message, 'error'));
    }
  });

  $('#pairList').addEventListener('change', event => {
    const input = event.target.closest('input[data-role="toggle"]');
    if (!input) return;
    const card = input.closest('.pair');
    togglePair(card.dataset.name, input.checked);
  });

  $('#btnSyncAll').addEventListener('click', () => startSync(null));
  $('#btnStart').addEventListener('click', () => serviceAction('start', '同步服务已启动'));
  $('#btnStop').addEventListener('click', () => serviceAction('stop', '同步服务已停止'));

  $('#btnAgentStart').addEventListener('click', startAgent);
  if ($('#agentOpen')) {
    $('#agentOpen').addEventListener('click', event => {
      const href = $('#agentOpen').getAttribute('href');
      if (href && href !== '#') {
        event.preventDefault();
        openStandaloneAgentPopup(href);
      }
    });
  }
  if ($('#btnOpenInstallModal')) $('#btnOpenInstallModal').addEventListener('click', () => openInstallToolsForDevice($('#agentDevice').value));
  if ($('#btnRunRemoteInstall')) $('#btnRunRemoteInstall').addEventListener('click', runRemoteInstallTools);
  if ($('#btnInstallReprobe')) $('#btnInstallReprobe').addEventListener('click', async () => {
    if (!installModalState.deviceId) return;
    toast('正在重新探测客机环境…', 'info', 2000);
    try {
      const res = await api('/api/agent/env?deviceId=' + encodeURIComponent(installModalState.deviceId) + '&force=1');
      if (res && res.env) {
        installModalState.env = res.env;
        renderInstallGrids();
        toast('客机环境已刷新', 'ok', 1800);
      }
    } catch (e) { toast(e.message, 'error'); }
  });
  if ($('#btnSelectMissingCli')) $('#btnSelectMissingCli').addEventListener('click', () => {
    $$('#installCliGrid .install-item:not(.installed) input[type="checkbox"]').forEach(cb => { cb.checked = true; });
    updateInstallSelectedCount();
  });
  if ($('#btnSelectMissingDesktop')) $('#btnSelectMissingDesktop').addEventListener('click', () => {
    $$('#installDesktopGrid .install-item:not(.installed) input[type="checkbox"]').forEach(cb => { cb.checked = true; });
    updateInstallSelectedCount();
  });
  if ($('#installToolsModal')) $('#installToolsModal').addEventListener('change', e => {
    if (e.target && e.target.matches('input[data-install-id]')) updateInstallSelectedCount();
  });
  if ($('#btnDetectEnv')) $('#btnDetectEnv').addEventListener('click', () => detectGuestEnv($('#agentDevice').value, true));
  if ($('#btnAgentQuickAddPair')) $('#btnAgentQuickAddPair').addEventListener('click', () => openAddSyncForDevice($('#agentDevice').value));
  if ($('#btnAgentQuickSend')) $('#btnAgentQuickSend').addEventListener('click', () => openSendToDeviceDesktop($('#agentDevice').value));
  if ($('#btnTopGuestModal')) $('#btnTopGuestModal').addEventListener('click', openGuestPairingModal);
  if ($('#btnOpenGuestModal')) $('#btnOpenGuestModal').addEventListener('click', openGuestPairingModal);
  if ($('#btnDownloadGuestPkg')) $('#btnDownloadGuestPkg').addEventListener('click', downloadGuestSetupZip);
  if ($('#btnModalDownloadGuest')) $('#btnModalDownloadGuest').addEventListener('click', downloadGuestSetupZip);
  if ($('#btnSubmitPairCode')) $('#btnSubmitPairCode').addEventListener('click', submitGuestPairCode);

  const selectCliBackend = async (backendId, fromDesktopName) => {
    const backend = normalizeAgentBackend(backendId);
    $('#agentBackend').value = backend;
    $('#agentError').hidden = true;
    renderGuestEnvCards(state.guestEnv);
    const deviceId = $('#agentDevice').value;
    $('#agentProvider').disabled = (backend !== 'hermes' && backend !== 'dsh' && backend !== 'codex');
    if (fromDesktopName) {
      toast('已切换至 ' + agentBackendLabel(backend) + '（后台无头静默复用 ' + fromDesktopName + ' 订阅，不影响客机使用）', 'info', 3200);
    }
    if (deviceId) {
      try { await loadAgentModels(deviceId, backend, '', '', false); } catch { }
    }
  };

  if ($('#guestDesktopCards')) {
    $('#guestDesktopCards').addEventListener('click', ev => {
      const card = ev.target.closest('[data-desktop-id]');
      if (!card) return;
      const mapped = card.dataset.mappedCli;
      const titleEl = card.querySelector('.ge-top b');
      const dName = titleEl ? titleEl.textContent : card.dataset.desktopId;
      if (mapped) {
        selectCliBackend(mapped, dName);
      }
    });
  }

  if ($('#guestCliCards')) {
    $('#guestCliCards').addEventListener('click', ev => {
      const card = ev.target.closest('[data-cli-id]');
      if (!card) return;
      selectCliBackend(card.dataset.cliId, '');
    });
  }

  $('#btnAgentStop').addEventListener('click', stopAgent);
  $('#btnAgentRefresh').addEventListener('click', () => {
    state.agentLoadedFor = '';
    refreshAgentOptions(true);
  });
  $('#agentDevice').addEventListener('change', () => {
    state.agentLoadedFor = '';
    $('#agentError').hidden = true;
    refreshAgentOptions(true);
  });

  $('#agentBackend').addEventListener('change', async () => {
    const deviceId = $('#agentDevice').value;
    const backend = normalizeAgentBackend($('#agentBackend').value);
    $('#agentError').hidden = true;
    renderGuestEnvCards(state.guestEnv);
    $('#agentProvider').disabled = (backend !== 'hermes' && backend !== 'dsh' && backend !== 'codex');
    if (!deviceId) return;
    try {
      await loadAgentModels(deviceId, backend, '', '', false);
    } catch (error) {
      $('#agentError').hidden = false;
      $('#agentError').textContent = error.message;
    }
  });

  if ($('#btnAgentRefreshModels')) {
    $('#btnAgentRefreshModels').addEventListener('click', async () => {
      const deviceId = $('#agentDevice').value;
      const backend = normalizeAgentBackend($('#agentBackend').value);
      if (!deviceId) return;
      const btn = $('#btnAgentRefreshModels');
      btn.disabled = true;
      btn.textContent = '刷新中…';
      try {
        await loadAgentModels(deviceId, backend, $('#agentProvider').value, '', true);
        toast('已重新从客机拉取最新账号与模型列表', 'ok');
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '刷新';
      }
    });
  }

  $$('[data-cred-clear]').forEach(button => {
    button.addEventListener('click', () => {
      clearAgentCredentials($('#agentDevice').value, button.dataset.credClear);
    });
  });

  $('#agentProvider').addEventListener('change', () => {
    const models = state.agentModels && state.agentModels.data;
    if (models) { fillAgentModels(models, $('#agentProvider').value, ''); }
  });

  $('#chkAuto').addEventListener('change', event => {
    if (event.target.checked) serviceAction('install', '已设置开机自启');
    else serviceAction('uninstall', '已取消开机自启');
  });

  $('#selInterval').addEventListener('change', async event => {
    const value = event.target.value;
    try {
      await post('/api/config', { interval: value });
      toast('同步间隔已设为 ' + (value >= 60 ? (Number(value) / 60) + ' 分钟' : value + ' 秒'), 'ok');
      refreshState();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('#btnClipStart').addEventListener('click', () => clipAction('start', '剪贴板同步已启动'));
  $('#btnClipStop').addEventListener('click', () => clipAction('stop', '剪贴板同步已停止'));
  $('#btnClipNow').addEventListener('click', clipSyncNow);
  if ($('#clipDeviceList')) {
    $('#clipDeviceList').addEventListener('change', event => {
      if (event.target && event.target.matches('input[data-clip-device-id]')) {
        saveClipDevicesFromUi();
      }
    });
  }

  $('#chkClipAuto').addEventListener('change', event => {
    if (event.target.checked) clipAction('install', '已设置剪贴板同步开机自启');
    else clipAction('uninstall', '已取消剪贴板同步开机自启');
  });

  $('#selClipInterval').addEventListener('change', async event => {
    const value = event.target.value;
    try {
      await post('/api/config', { clipInterval: value });
      toast('剪贴板检查间隔已设为 ' + value + ' 秒', 'ok');
      refreshState();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  bindSendDropZone();
  $('#btnRemoteList').addEventListener('click', showRemoteList);

  $('#logTabs').addEventListener('click', event => {
    const button = event.target.closest('.seg');
    if (!button) return;
    state.logKind = button.dataset.kind;
    $$('#logTabs .seg').forEach(item => item.classList.toggle('active', item === button));
    $('#logHint').textContent = state.logKind === 'sync' ? '最近同步记录'
      : (state.logKind === 'clip' ? '最近剪贴板同步记录' : '最近传输记录');
    state.logWasAtBottom = true;
    refreshLog();
  });

  $('#logView').addEventListener('scroll', () => {
    const view = $('#logView');
    state.logWasAtBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 48;
  });
}

async function boot() {
  wire();
  applyView(location.hash === '#hub' ? 'hub' : (location.hash === '#remote' ? 'remote' : (location.hash === '#agent' ? 'agent' : 'files')), false);
  const footAddr = $('#footAddr');
  if (footAddr && location.host) footAddr.textContent = location.host;
  if (new URLSearchParams(location.search).has('add')) {
    resetAddForm();
    openModal('addModal');
  }
  await refreshState();
  await refreshLog();
  state.timer = setInterval(async () => {
    await refreshState();
    if (state.lastJobRunning) await refreshLog();
  }, 2500);
  setInterval(() => {
    const data = state.data;
    if (!data || !data.daemon.running) return;
    const status = data.status;
    if (status && status.nextRunAt) {
      $('#nextRunText').textContent = '下一轮 ' + clock(status.nextRunAt) + ' · ' + relative(status.nextRunAt);
    }
  }, 1000);
  setInterval(refreshLog, 8000);
}

boot();
