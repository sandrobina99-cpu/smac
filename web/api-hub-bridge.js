'use strict';

// smac 主机端 <-> API Hub 网关桥接层：
// - 管理唯一管理员对 API 分发网关（默认 https://hub.sandrobina.me 或自定义地址 / 本机内置网关）的登录会话
// - 代理管理员 API 请求（账号、模型、倍率、配额、流水、网关设置、客机账号绑定）
// - 将本机主机端 SSH 公钥 / 配对端口 / ZeroTier 组号同步到网关，让客机端凭账号密码登录后自动接入
// - 将网关中账号 ↔ 多客机绑定关系实时标注到本地 remote.js 设备列表（accountId / accountUsername / accountDisplayName）

const fs = require('fs');
const path = require('path');
const os = require('os');
const remote = require('./remote');
const guestPackager = require('./guest-packager');

const USER_HOME = process.env.USERPROFILE || os.homedir();
const DATA_DIR = path.join(USER_HOME, '.smac');
const HUB_STATE_FILE = path.join(DATA_DIR, 'hub-admin.json');
const DEFAULT_GATEWAY_URL = 'https://hub.sandrobina.me';

function normalizeUrl(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return 'http://' + s;
}

function readHubState() {
  try {
    const data = JSON.parse(fs.readFileSync(HUB_STATE_FILE, 'utf8'));
    if (data && typeof data === 'object') {
      return {
        serverUrl: normalizeUrl(data.serverUrl || DEFAULT_GATEWAY_URL) || DEFAULT_GATEWAY_URL,
        token: String(data.token || ''),
        adminUsername: String(data.adminUsername || ''),
        lastSyncAt: Number(data.lastSyncAt) || 0
      };
    }
  } catch { }
  return {
    serverUrl: DEFAULT_GATEWAY_URL,
    token: '',
    adminUsername: '',
    lastSyncAt: 0
  };
}

function writeHubState(patch) {
  const cur = readHubState();
  const next = Object.assign({}, cur, patch || {});
  if (next.serverUrl) next.serverUrl = normalizeUrl(next.serverUrl) || DEFAULT_GATEWAY_URL;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = HUB_STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  if (process.platform !== 'win32') {
    try { fs.chmodSync(tmp, 0o600); } catch { }
  }
  fs.renameSync(tmp, HUB_STATE_FILE);
  return next;
}

function getPublicHubState() {
  const st = readHubState();
  return {
    serverUrl: st.serverUrl,
    loggedIn: Boolean(st.token),
    adminUsername: st.adminUsername || '',
    uniqueAdmin: true,
    lastSyncAt: st.lastSyncAt || 0
  };
}

async function hubFetch(method, apiPath, body, opts = {}) {
  const st = readHubState();
  const baseUrl = normalizeUrl(opts.serverUrl || st.serverUrl) || DEFAULT_GATEWAY_URL;
  const token = opts.token !== undefined ? opts.token : st.token;
  const headers = {
    'Accept': 'application/json'
  };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
  }

  let res;
  try {
    res = await fetch(baseUrl + apiPath, {
      method,
      headers,
      body: (body !== undefined && method !== 'GET' && method !== 'HEAD') ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs || 15000)
    });
  } catch (err) {
    const e = new Error('无法连接 API 分发网关 (' + baseUrl + ')：' + (err && err.message ? err.message : String(err)));
    e.statusCode = 502;
    throw e;
  }

  const text = await res.text();
  let json = {};
  if (text) {
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
  }

  if (res.status === 401 && apiPath !== '/api/admin/login' && !opts.skipClearOn401) {
    writeHubState({ token: '' });
  }

  if (!res.ok) {
    const msg = (json && (json.error || json.message)) || ('网关返回 HTTP ' + res.status);
    const e = new Error(msg);
    e.statusCode = res.status;
    e.payload = json;
    throw e;
  }

  return json;
}

async function checkGatewayHealth(serverUrl) {
  const baseUrl = normalizeUrl(serverUrl || readHubState().serverUrl) || DEFAULT_GATEWAY_URL;
  try {
    const res = await fetch(baseUrl + '/health', { signal: AbortSignal.timeout(4500) });
    if (!res.ok) return { ok: false, serverUrl: baseUrl };
    const data = await res.json().catch(() => ({}));
    return { ok: true, serverUrl: baseUrl, service: data.service || 'gateway', time: data.time || Date.now() };
  } catch (err) {
    return { ok: false, serverUrl: baseUrl, error: err && err.message ? err.message : String(err) };
  }
}

async function loginAdmin(serverUrl, username, password) {
  const baseUrl = normalizeUrl(serverUrl || readHubState().serverUrl) || DEFAULT_GATEWAY_URL;
  const data = await hubFetch('POST', '/api/admin/login', { username, password }, {
    serverUrl: baseUrl,
    token: '',
    skipClearOn401: true
  });
  writeHubState({
    serverUrl: baseUrl,
    token: data.token || '',
    adminUsername: (data.admin && data.admin.username) || username
  });
  // 登录后静默把本机主机配对信息发布到网关，并拉取账号客机绑定状态
  syncHostBindingToGateway().catch(() => { });
  syncGatewayDevicesToLocal().catch(() => { });
  return {
    ok: true,
    serverUrl: baseUrl,
    admin: Object.assign({ uniqueAdmin: true, role: 'super_admin' }, data.admin || { username })
  };
}

function logoutAdmin() {
  writeHubState({ token: '' });
  return { ok: true };
}

async function syncHostBindingToGateway() {
  const st = readHubState();
  if (!st.token) return { ok: false, skipped: true };
  const pairing = guestPackager.ensurePairingConfig();
  const payload = {
    hostName: pairing.hostName || os.hostname(),
    publicKey: pairing.publicKey || '',
    pairToken: pairing.pairToken || '',
    endpoints: Array.isArray(pairing.endpoints) ? pairing.endpoints : [],
    zerotierNetworkId: pairing.zerotierNetworkId || ''
  };
  const res = await hubFetch('PUT', '/api/admin/host-binding', payload);
  writeHubState({ lastSyncAt: Date.now() });
  return res;
}

async function syncGatewayDevicesToLocal() {
  const st = readHubState();
  if (!st.token) return { ok: false, devices: [] };
  let gwDevices = [];
  try {
    const res = await hubFetch('GET', '/api/admin/devices');
    gwDevices = Array.isArray(res.devices) ? res.devices : [];
  } catch {
    return { ok: false, devices: [] };
  }

  const localDevices = remote.listDevices();
  for (const gd of gwDevices) {
    if (!gd || !gd.id) continue;
    const match = localDevices.find(ld =>
      ld.gatewayDeviceId === gd.id
      || (gd.primaryIp && (ld.host === gd.primaryIp || ld.fallbackHost === gd.primaryIp))
      || (gd.zerotierIp && ld.zerotierIp === gd.zerotierIp)
      || (gd.deviceName && String(ld.name || '').toLowerCase() === String(gd.deviceName).toLowerCase())
    );
    if (match) {
      remote.setDeviceAccountBinding(match.id, {
        accountId: gd.userId,
        accountUsername: gd.accountUsername || '',
        accountDisplayName: gd.accountDisplayName || gd.accountUsername || '',
        accountEnabled: gd.accountEnabled !== false,
        gatewayDeviceId: gd.id,
        guestDisconnected: gd.connected === false
      });
    } else if (gd.primaryIp && gd.sshUser) {
      try {
        guestPackager.upsertGuestDevice({
          name: gd.deviceName || gd.hostname || gd.primaryIp,
          hostname: gd.hostname || gd.deviceName,
          primaryIp: gd.primaryIp,
          fallbackIp: gd.fallbackIp || '',
          sshPort: gd.sshPort || 22,
          user: gd.sshUser,
          os: gd.os || 'Windows',
          zerotierIp: gd.zerotierIp || '',
          zerotierNodeId: gd.zerotierNodeId || '',
          zerotierNetworkId: gd.zerotierNetworkId || '',
          accountId: gd.userId,
          accountUsername: gd.accountUsername || '',
          accountDisplayName: gd.accountDisplayName || gd.accountUsername || '',
          accountEnabled: gd.accountEnabled !== false,
          gatewayDeviceId: gd.id,
          guestDisconnected: gd.connected === false,
          env: gd.env || null
        });
      } catch { }
    }
  }
  writeHubState({ lastSyncAt: Date.now() });
  return { ok: true, devices: gwDevices };
}

async function bindLocalDeviceToAccount(localDeviceId, userId) {
  const localDev = remote.listDevices().find(d => d.id === localDeviceId);
  if (!localDev) {
    const err = new Error('未找到指定的本地客机设备');
    err.statusCode = 404;
    throw err;
  }

  // 如果未传 userId，表示解除账号绑定
  if (!userId) {
    if (localDev.gatewayDeviceId && readHubState().token) {
      try {
        await hubFetch('DELETE', '/api/admin/devices/' + encodeURIComponent(localDev.gatewayDeviceId));
      } catch { }
    }
    const updated = remote.setDeviceAccountBinding(localDev.id, {
      accountId: 0,
      accountUsername: '',
      accountDisplayName: '',
      accountEnabled: true,
      gatewayDeviceId: ''
    });
    return { ok: true, device: updated };
  }

  const targetUserId = Number(userId);
  const st = readHubState();
  if (!st.token) {
    const err = new Error('请先在「API 分发与账号」页登录唯一管理员账号，再绑定客机归属');
    err.statusCode = 401;
    throw err;
  }

  let gwDevice = null;
  if (localDev.gatewayDeviceId) {
    try {
      const r = await hubFetch('PATCH', '/api/admin/devices/' + encodeURIComponent(localDev.gatewayDeviceId) + '/bind', {
        userId: targetUserId,
        deviceName: localDev.name
      });
      gwDevice = r.device;
    } catch (err) {
      if (err && err.statusCode !== 404) throw err;
    }
  }
  if (!gwDevice) {
    const r = await hubFetch('POST', '/api/admin/devices', {
      id: localDev.gatewayDeviceId || ('smac-' + localDev.id),
      userId: targetUserId,
      deviceName: localDev.name,
      hostname: localDev.name,
      os: localDev.os || '',
      sshUser: localDev.user || '',
      sshPort: localDev.port || 22,
      primaryIp: localDev.host || '',
      fallbackIp: localDev.fallbackHost || '',
      zerotierIp: localDev.zerotierIp || '',
      zerotierNodeId: localDev.zerotierNodeId || '',
      zerotierNetworkId: localDev.zerotierNetworkId || '',
      connected: !localDev.guestDisconnected,
      sshAuthorized: !localDev.guestDisconnected,
      env: localDev.guestEnv || null
    });
    gwDevice = r.device;
  }

  const updated = remote.setDeviceAccountBinding(localDev.id, {
    accountId: gwDevice.userId,
    accountUsername: gwDevice.accountUsername || '',
    accountDisplayName: gwDevice.accountDisplayName || gwDevice.accountUsername || '',
    accountEnabled: gwDevice.accountEnabled !== false,
    gatewayDeviceId: gwDevice.id
  });
  return { ok: true, device: updated, gatewayDevice: gwDevice };
}

module.exports = {
  DEFAULT_GATEWAY_URL,
  readHubState,
  writeHubState,
  getPublicHubState,
  checkGatewayHealth,
  hubFetch,
  loginAdmin,
  logoutAdmin,
  syncHostBindingToGateway,
  syncGatewayDevicesToLocal,
  bindLocalDeviceToAccount
};
