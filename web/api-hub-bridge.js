'use strict';

// smac 主机端 <-> API Hub 网关桥接层：
// - 管理唯一管理员对 API 分发网关（默认 https://hub.sandrobina.me 或自定义地址）的登录会话
// - 代理管理员 API 请求（账号、模型、倍率、配额、流水、网关设置、客机账号绑定）
// - 管理员设备互联：登录后把本机注册为「管理员节点」，通过 SSE 实时同步其它管理员节点与全网客机列表，
//   自动互相授权 SSH 公钥，登出后自动吊销
// - 客机握手审批 / 请求改连到本机 / 强制断联（仅直连主机可操作客机，其它管理员主机只能下发这两类指令）

const fs = require('fs');
const path = require('path');
const os = require('os');
const remote = require('./remote');
const guestPackager = require('./guest-packager');
const adminMesh = require('./admin-mesh');

const USER_HOME = process.env.USERPROFILE || os.homedir();
const DATA_DIR = path.join(USER_HOME, '.smac');
const HUB_STATE_FILE = path.join(DATA_DIR, 'hub-admin.json');
const DEFAULT_GATEWAY_URL = 'https://hub.sandrobina.me';

let adminNodesCache = [];
let changeListener = null;
const meshState = { running: false, connected: false, lastEventAt: 0, error: '' };
let meshGeneration = 0;
let streamAbort = null;
let heartbeatTimer = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
  return { serverUrl: DEFAULT_GATEWAY_URL, token: '', adminUsername: '', lastSyncAt: 0 };
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
    lastSyncAt: st.lastSyncAt || 0,
    localAdminNodeId: adminMesh.getLocalAdminNodeId(),
    adminNodes: adminNodesCache,
    mesh: Object.assign({}, meshState)
  };
}

function getAdminNodes() {
  return adminNodesCache;
}

function setChangeListener(fn) {
  changeListener = typeof fn === 'function' ? fn : null;
}

function notifyChanged() {
  if (changeListener) {
    try { changeListener(); } catch { }
  }
}

async function hubFetch(method, apiPath, body, opts = {}) {
  const st = readHubState();
  const baseUrl = normalizeUrl(opts.serverUrl || st.serverUrl) || DEFAULT_GATEWAY_URL;
  const token = opts.token !== undefined ? opts.token : st.token;
  const headers = { 'Accept': 'application/json' };
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
    stopAdminMesh();
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

// ---------- 管理员设备互联 ----------

function localDevices() {
  try { return remote.listDevices(); } catch { return []; }
}

function syncGuestDevicesFromList(gwDevices) {
  const list = Array.isArray(gwDevices) ? gwDevices : [];
  const local = localDevices();
  const seenGatewayIds = new Set();

  for (const gd of list) {
    if (!gd || !gd.id) continue;
    seenGatewayIds.add(gd.id);
    const topo = {
      accountId: gd.userId,
      accountUsername: gd.accountUsername || '',
      accountDisplayName: gd.accountDisplayName || gd.accountUsername || '',
      accountEnabled: gd.accountEnabled !== false,
      gatewayDeviceId: gd.id,
      guestDisconnected: gd.connected === false,
      hostAdminNodeId: gd.hostAdminNodeId || '',
      hostAdminName: gd.hostAdminName || '',
      handshakeStatus: gd.handshakeStatus || 'connected',
      pendingCommand: gd.pendingCommand || null
    };
    const match = local.find(ld =>
      !ld.isAdminNode && (
        ld.gatewayDeviceId === gd.id
        || (gd.primaryIp && (ld.host === gd.primaryIp || ld.fallbackHost === gd.primaryIp))
        || (gd.zerotierIp && ld.zerotierIp === gd.zerotierIp)
        || (gd.deviceName && String(ld.name || '').toLowerCase() === String(gd.deviceName).toLowerCase())
      )
    );
    if (match) {
      remote.setDeviceAccountBinding(match.id, topo);
    } else if (gd.primaryIp && gd.sshUser) {
      try {
        guestPackager.upsertGuestDevice(Object.assign({
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
          env: gd.env || null
        }, topo));
      } catch { }
    }
  }

  // 网关里已被管理员删除的客机：仅解除本地的账号 / 直连标注，保留用户手动添加的设备记录
  for (const ld of local) {
    if (ld.isAdminNode || !ld.gatewayDeviceId || seenGatewayIds.has(ld.gatewayDeviceId)) continue;
    remote.setDeviceAccountBinding(ld.id, {
      accountId: 0,
      accountUsername: '',
      accountDisplayName: '',
      gatewayDeviceId: '',
      hostAdminNodeId: '',
      hostAdminName: '',
      handshakeStatus: 'connected',
      pendingCommand: null
    });
  }
}

function applyTopologySnapshot(snapshot) {
  const nodes = snapshot && Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const devices = snapshot && Array.isArray(snapshot.devices) ? snapshot.devices : [];
  adminNodesCache = nodes;
  const localId = adminMesh.getLocalAdminNodeId();
  const peers = nodes.filter(n => n && n.id && n.id !== localId);
  try { adminMesh.syncAuthorizedAdminPeers(peers); } catch { }
  try { remote.syncAdminPeers(localId, peers, adminMesh.getKeyPath()); } catch { }
  try { syncGuestDevicesFromList(devices); } catch { }
  meshState.lastEventAt = Date.now();
  writeHubState({ lastSyncAt: Date.now() });
  notifyChanged();
}

async function registerLocalAdminNode() {
  const st = readHubState();
  if (!st.token) return { ok: false, skipped: true };
  const payload = adminMesh.buildLocalAdminNodePayload();
  return hubFetch('POST', '/api/admin/nodes/register', payload);
}

async function syncFullTopology() {
  const st = readHubState();
  if (!st.token) return { ok: false, nodes: [], devices: [] };
  const [nodesRes, devRes] = await Promise.all([
    hubFetch('GET', '/api/admin/nodes'),
    hubFetch('GET', '/api/admin/devices')
  ]);
  const snapshot = {
    nodes: Array.isArray(nodesRes.nodes) ? nodesRes.nodes : [],
    devices: Array.isArray(devRes.devices) ? devRes.devices : []
  };
  applyTopologySnapshot(snapshot);
  return { ok: true, nodes: snapshot.nodes, devices: snapshot.devices };
}

function handleSseBlock(block) {
  let event = 'message';
  const dataLines = [];
  for (const line of String(block).split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return;
  if (event !== 'snapshot' && event !== 'admin-nodes' && event !== 'devices') return;
  try {
    applyTopologySnapshot(JSON.parse(dataLines.join('\n')));
  } catch { }
}

async function runStreamLoop(generation) {
  let attempt = 0;
  while (generation === meshGeneration) {
    const st = readHubState();
    if (!st.token) break;
    try {
      const ctrl = new AbortController();
      streamAbort = ctrl;
      const res = await fetch(st.serverUrl + '/api/admin/stream?token=' + encodeURIComponent(st.token), {
        headers: { Accept: 'text/event-stream' },
        signal: ctrl.signal
      });
      if (res.status === 401) {
        writeHubState({ token: '' });
        break;
      }
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      meshState.connected = true;
      meshState.error = '';
      attempt = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (generation === meshGeneration) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleSseBlock(block);
        }
      }
    } catch (err) {
      if (generation !== meshGeneration) break;
      meshState.error = err && err.message ? err.message : String(err);
    }
    meshState.connected = false;
    if (generation !== meshGeneration) break;
    attempt += 1;
    await sleep(Math.min(15000, Math.round(1500 * Math.pow(1.6, attempt))));
  }
  if (generation === meshGeneration) {
    meshState.running = false;
    meshState.connected = false;
  }
}

function stopAdminMesh() {
  meshGeneration += 1;
  meshState.running = false;
  meshState.connected = false;
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (streamAbort) {
    try { streamAbort.abort(); } catch { }
    streamAbort = null;
  }
}

function startAdminMesh() {
  stopAdminMesh();
  const st = readHubState();
  if (!st.token) return;
  const generation = meshGeneration;
  meshState.running = true;
  registerLocalAdminNode().then(() => syncFullTopology()).catch(() => { });
  heartbeatTimer = setInterval(() => { registerLocalAdminNode().catch(() => { }); }, 60000);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
  runStreamLoop(generation).catch(() => { });
}

function startIfLoggedIn() {
  if (readHubState().token) startAdminMesh();
}

// ---------- 登录 / 登出 ----------

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
  syncHostBindingToGateway().catch(() => { });
  startAdminMesh();
  return {
    ok: true,
    serverUrl: baseUrl,
    localAdminNodeId: adminMesh.getLocalAdminNodeId(),
    admin: Object.assign({ uniqueAdmin: true, role: 'super_admin' }, data.admin || { username })
  };
}

async function logoutAdmin() {
  const st = readHubState();
  const localId = adminMesh.getLocalAdminNodeId();
  stopAdminMesh();
  if (st.token) {
    try {
      await hubFetch('DELETE', '/api/admin/nodes/' + encodeURIComponent(localId), undefined, { skipClearOn401: true, timeoutMs: 6000 });
    } catch { }
  }
  writeHubState({ token: '' });
  adminNodesCache = [];
  try { adminMesh.syncAuthorizedAdminPeers([]); } catch { }
  try { remote.syncAdminPeers(localId, [], adminMesh.getKeyPath()); } catch { }
  notifyChanged();
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
  try {
    const r = await syncFullTopology();
    return { ok: r.ok, devices: r.devices || [] };
  } catch {
    return { ok: false, devices: [] };
  }
}

// ---------- 客机归属 / 握手审批 / 远程指令 ----------

function requireLocalDevice(localDeviceId) {
  const dev = localDevices().find(d => d.id === localDeviceId);
  if (!dev) {
    const err = new Error('未找到指定的客机设备');
    err.statusCode = 404;
    throw err;
  }
  if (!dev.gatewayDeviceId) {
    const err = new Error('该设备尚未登记到网关，请先绑定账号或等待客机发起握手');
    err.statusCode = 400;
    throw err;
  }
  return dev;
}

async function postDeviceAction(localDeviceId, action, body) {
  const dev = requireLocalDevice(localDeviceId);
  const result = await hubFetch('POST', '/api/admin/devices/' + encodeURIComponent(dev.gatewayDeviceId) + '/' + action, body);
  try { await syncFullTopology(); } catch { }
  return result;
}

function approveHandshake(localDeviceId) {
  return postDeviceAction(localDeviceId, 'approve', { adminNodeId: adminMesh.getLocalAdminNodeId() });
}

function rejectHandshake(localDeviceId) {
  return postDeviceAction(localDeviceId, 'reject', { adminNodeId: adminMesh.getLocalAdminNodeId() });
}

function switchClientHost(localDeviceId) {
  const localId = adminMesh.getLocalAdminNodeId();
  return postDeviceAction(localDeviceId, 'switch-host', { targetAdminNodeId: localId, issuedByAdminNodeId: localId });
}

function forceDisconnectClient(localDeviceId) {
  return postDeviceAction(localDeviceId, 'force-disconnect', { issuedByAdminNodeId: adminMesh.getLocalAdminNodeId() });
}

async function bindLocalDeviceToAccount(localDeviceId, userId) {
  const localDev = localDevices().find(d => d.id === localDeviceId);
  if (!localDev) {
    const err = new Error('未找到指定的本地客机设备');
    err.statusCode = 404;
    throw err;
  }

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
  try { await syncFullTopology(); } catch { }
  return { ok: true, device: updated, gatewayDevice: gwDevice };
}

module.exports = {
  DEFAULT_GATEWAY_URL,
  readHubState,
  writeHubState,
  getPublicHubState,
  getAdminNodes,
  setChangeListener,
  checkGatewayHealth,
  hubFetch,
  loginAdmin,
  logoutAdmin,
  startAdminMesh,
  stopAdminMesh,
  startIfLoggedIn,
  registerLocalAdminNode,
  syncFullTopology,
  syncHostBindingToGateway,
  syncGatewayDevicesToLocal,
  approveHandshake,
  rejectHandshake,
  switchClientHost,
  forceDisconnectClient,
  bindLocalDeviceToAccount
};
