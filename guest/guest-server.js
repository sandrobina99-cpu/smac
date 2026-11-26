'use strict';

// smac 客机端本地图形控制台后端 (Windows / macOS / Linux)
// 零第三方依赖，仅监听 127.0.0.1（默认端口 8790）。
// 提供：
//  1. 主动连接主机端（恢复 SSH 公钥授权 + 按 局域网 -> Tailscale -> ZeroTier 顺序主动握手注册并上报 CLI/Desktop 环境）
//  2. 主动断联主机端（主动通知主机端下线 + 从 authorized_keys 吊销主机公钥阻断 SSH + 停止后台 Agent 与剪贴板代理）
//  3. 自定义/切换主机地址（局域网 / Tailscale / ZeroTier）、配对令牌与公钥
//  4. 客机 ZeroTier 一键入组、本机 CLI/Desktop 订阅环境探测与兜底配对码生成

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const guestEnv = require('./guest-env');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const BASE_PORT = Number(process.env.SMAC_GUEST_PORT) || 8790;
const PORT_TRIES = 7;
let PORT = BASE_PORT;
const BIND = '127.0.0.1';

const USER_HOME = process.env.USERPROFILE || os.homedir();
const GUEST_DIR = path.join(USER_HOME, '.smac-guest');
const AGENT_DIR = path.join(USER_HOME, '.smac-agent');
const PROFILE_FILE = path.join(GUEST_DIR, 'host-profile.json');
const SEED_FILE = path.join(__dirname, 'host-profile.seed.json');
const PAIRING_CODE_FILE = path.join(GUEST_DIR, 'pairing-code.txt');
const LOG_FILE = path.join(GUEST_DIR, 'guest.log');
const PID_FILE = path.join(GUEST_DIR, 'guest-web.pid');
const PORT_FILE = path.join(GUEST_DIR, 'guest-web-port');
const DEVICE_ID_FILE = path.join(GUEST_DIR, 'device-id');
const ACCOUNT_SESSION_FILE = path.join(GUEST_DIR, 'account-session.json');
const DEFAULT_GATEWAY_URL = 'https://hub.sandrobina.me';

let envCache = null;

function normalizeGatewayUrl(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return 'http://' + s;
}

function getOrCreateDeviceId() {
  try {
    const existing = fs.readFileSync(DEVICE_ID_FILE, 'utf8').trim();
    if (/^[a-zA-Z0-9._:-]{4,96}$/.test(existing)) return existing;
  } catch { }
  const hostSlug = os.hostname().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'guest';
  const id = 'smac_' + hostSlug.toLowerCase() + '_' + crypto.randomBytes(4).toString('hex');
  try {
    fs.mkdirSync(GUEST_DIR, { recursive: true });
    fs.writeFileSync(DEVICE_ID_FILE, id, 'utf8');
  } catch { }
  return id;
}

function readAccountSession() {
  const seed = readJson(SEED_FILE);
  const seedGw = (seed && seed.gatewayUrl) ? normalizeGatewayUrl(seed.gatewayUrl) : '';
  const data = readJson(ACCOUNT_SESSION_FILE);
  if (data && typeof data === 'object') {
    return {
      gatewayUrl: normalizeGatewayUrl(data.gatewayUrl || seedGw || DEFAULT_GATEWAY_URL) || DEFAULT_GATEWAY_URL,
      token: String(data.token || ''),
      userId: Number(data.userId) || 0,
      username: String(data.username || ''),
      displayName: String(data.displayName || ''),
      profile: data.profile && typeof data.profile === 'object' ? data.profile : null
    };
  }
  return {
    gatewayUrl: seedGw || DEFAULT_GATEWAY_URL,
    token: '',
    userId: 0,
    username: '',
    displayName: '',
    profile: null
  };
}

function writeAccountSession(patch) {
  const cur = readAccountSession();
  const next = Object.assign({}, cur, patch || {});
  if (next.gatewayUrl) next.gatewayUrl = normalizeGatewayUrl(next.gatewayUrl) || DEFAULT_GATEWAY_URL;
  writeJson(ACCOUNT_SESSION_FILE, next);
  if (!IS_WIN) { try { fs.chmodSync(ACCOUNT_SESSION_FILE, 0o600); } catch { } }
  return next;
}

function applyHostBindingFromProfile(profile) {
  if (!profile || !profile.hostBinding || typeof profile.hostBinding !== 'object') return;
  const hb = profile.hostBinding;
  const patch = {};
  if (hb.hostName) patch.hostName = String(hb.hostName).trim();
  if (hb.publicKey) patch.publicKey = String(hb.publicKey).trim();
  if (hb.pairToken) patch.pairToken = String(hb.pairToken).trim();
  if (Array.isArray(hb.endpoints) && hb.endpoints.length) patch.endpoints = hb.endpoints;
  if (hb.zerotierNetworkId) patch.zerotierNetworkId = String(hb.zerotierNetworkId).trim();
  if (Object.keys(patch).length) saveHostProfile(patch);
}

async function gatewayClientFetch(method, apiPath, body, opts = {}) {
  const sess = readAccountSession();
  const baseUrl = normalizeGatewayUrl(opts.gatewayUrl || sess.gatewayUrl) || DEFAULT_GATEWAY_URL;
  const token = opts.token !== undefined ? opts.token : sess.token;
  const headers = { 'Accept': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(baseUrl + apiPath, {
    method,
    headers,
    body: (body !== undefined && method !== 'GET' && method !== 'HEAD') ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs || 10000)
  });
  const data = await res.json().catch(() => ({}));
  if ((res.status === 401 || res.status === 403) && apiPath !== '/api/client/login' && !opts.skipClearOnAuthErr) {
    writeAccountSession({ token: '', profile: null });
  }
  if (!res.ok) {
    throw new Error((data && (data.error || data.message)) || ('网关返回 HTTP ' + res.status));
  }
  return data;
}

async function loginAccount(gatewayUrl, username, password) {
  const baseUrl = normalizeGatewayUrl(gatewayUrl || readAccountSession().gatewayUrl) || DEFAULT_GATEWAY_URL;
  const res = await gatewayClientFetch('POST', '/api/client/login', { username, password }, {
    gatewayUrl: baseUrl,
    token: '',
    skipClearOnAuthErr: true
  });
  const prof = res.profile || null;
  const user = (prof && prof.user) || {};
  writeAccountSession({
    gatewayUrl: baseUrl,
    token: res.token || '',
    userId: Number(user.id) || 0,
    username: String(user.username || username),
    displayName: String(user.displayName || user.username || username),
    profile: prof
  });
  applyHostBindingFromProfile(prof);
  appendLog('ACCOUNT_LOGIN | 已登录账号 ' + (user.displayName || user.username || username) + ' (@' + (user.username || username) + ') -> ' + baseUrl);
  return { ok: true, account: readAccountSession(), profile: prof };
}

async function refreshAccountProfile() {
  const sess = readAccountSession();
  if (!sess.token) return { ok: false, loggedIn: false };
  const prof = await gatewayClientFetch('GET', '/api/client/me');
  const user = (prof && prof.user) || {};
  writeAccountSession({
    userId: Number(user.id) || sess.userId,
    username: String(user.username || sess.username),
    displayName: String(user.displayName || user.username || sess.displayName),
    profile: prof
  });
  applyHostBindingFromProfile(prof);
  return { ok: true, loggedIn: true, profile: prof };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + crypto.randomBytes(3).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function stamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function appendLog(line) {
  try {
    fs.mkdirSync(GUEST_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, stamp() + ' | ' + line + '\n', 'utf8');
  } catch { }
}

function tailLogs(maxLines = 120) {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const text = fs.readFileSync(LOG_FILE, 'utf8').replace(/^\uFEFF/, '');
    return text.split(/\r?\n/).filter(l => l.trim().length > 0).slice(-maxLines);
  } catch {
    return [];
  }
}

// ---------- Endpoint normalization & LAN -> Tailscale -> ZeroTier ordering ----------

function normalizeEndpointUrl(raw) {
  let text = String(raw || '').trim();
  if (!text || text.includes('__SMAC_')) return '';
  if (!/^https?:\/\//i.test(text)) {
    text = 'http://' + text;
  }
  try {
    const u = new URL(text);
    if (!u.port) u.port = '8797';
    return (u.protocol + '//' + u.host).replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function classifyEndpoint(epUrl) {
  try {
    const u = new URL(epUrl);
    const h = String(u.hostname || '').trim();
    if (/^192\.168\.\d+\.\d+$/.test(h) || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)) {
      return { kind: 'lan', label: '局域网', rank: 1 };
    }
    if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d+\.\d+$/.test(h)) {
      return { kind: 'tailscale', label: 'Tailscale', rank: 2 };
    }
    if (/^10\.\d+\.\d+\.\d+$/.test(h)) {
      return { kind: 'zerotier', label: 'ZeroTier', rank: 3 };
    }
    return { kind: 'public', label: '公网/其他', rank: 4 };
  } catch {
    return { kind: 'other', label: '其他', rank: 5 };
  }
}

function orderEndpoints(list) {
  const raw = Array.isArray(list) ? list : String(list || '').split(/[\r\n,;|\s]+/);
  const unique = [];
  for (const item of raw) {
    const norm = normalizeEndpointUrl(item);
    if (norm && !unique.includes(norm)) unique.push(norm);
  }
  return unique
    .map((url, idx) => Object.assign({ url, idx }, classifyEndpoint(url)))
    .sort((a, b) => (a.rank - b.rank) || (a.idx - b.idx))
    .map(x => x.url);
}

// ---------- Host profile management ----------

function ensureHostProfile() {
  let profile = readJson(PROFILE_FILE);
  const seed = readJson(SEED_FILE);
  if (!profile || typeof profile !== 'object') {
    profile = {
      hostName: '',
      publicKey: '',
      pairToken: '',
      endpoints: [],
      zerotierNetworkId: '',
      connected: false,
      lastConnectedAt: '',
      lastDisconnectedAt: '',
      lastActiveEndpoint: '',
      lastHostResponse: ''
    };
  }
  if (seed && typeof seed === 'object') {
    const seedKey = String(seed.publicKey || '').trim();
    const seedToken = String(seed.pairToken || '').trim();
    const seedHost = String(seed.hostName || '').trim();
    const seedZt = String(seed.zerotierNetworkId || '').trim();
    const seedEps = orderEndpoints(seed.endpoints || []);
    if (seedKey && !seedKey.includes('__SMAC_') && !profile.publicKey) profile.publicKey = seedKey;
    if (seedToken && !seedToken.includes('__SMAC_') && !profile.pairToken) profile.pairToken = seedToken;
    if (seedHost && !seedHost.includes('__SMAC_') && !profile.hostName) profile.hostName = seedHost;
    if (seedZt && !seedZt.includes('__SMAC_') && !profile.zerotierNetworkId) profile.zerotierNetworkId = seedZt;
    if (seedEps.length && (!Array.isArray(profile.endpoints) || !profile.endpoints.length)) {
      profile.endpoints = seedEps;
    }
  }
  profile.endpoints = orderEndpoints(profile.endpoints || []);
  const keyAuth = isHostKeyAuthorized(profile.publicKey);
  if (keyAuth && !profile.lastDisconnectedAt) {
    profile.connected = true;
  }
  writeJson(PROFILE_FILE, profile);
  return profile;
}

function saveHostProfile(patch) {
  const cur = ensureHostProfile();
  const next = Object.assign({}, cur, patch || {});
  if (patch && patch.endpoints != null) {
    next.endpoints = orderEndpoints(patch.endpoints);
  }
  if (patch && typeof patch.publicKey === 'string') {
    next.publicKey = patch.publicKey.trim();
  }
  if (patch && typeof patch.pairToken === 'string') {
    next.pairToken = patch.pairToken.trim();
  }
  if (patch && typeof patch.hostName === 'string') {
    next.hostName = patch.hostName.trim();
  }
  if (patch && typeof patch.zerotierNetworkId === 'string') {
    next.zerotierNetworkId = patch.zerotierNetworkId.trim().toLowerCase();
  }
  writeJson(PROFILE_FILE, next);
  return next;
}

// ---------- SSH key authorization & revocation ----------

function getAuthorizedKeysFiles() {
  const files = [path.join(USER_HOME, '.ssh', 'authorized_keys')];
  if (IS_WIN) {
    const adminKeys = path.join(process.env.ProgramData || 'C:\\ProgramData', 'ssh', 'administrators_authorized_keys');
    files.push(adminKeys);
  }
  return files;
}

function normalizeKeyCore(keyLine) {
  const parts = String(keyLine || '').trim().split(/\s+/);
  if (parts.length >= 2 && /^ssh-(ed25519|rsa|ecdsa)/i.test(parts[0])) {
    return parts[0] + ' ' + parts[1];
  }
  return '';
}

function isHostKeyAuthorized(publicKey) {
  const core = normalizeKeyCore(publicKey);
  for (const file of getAuthorizedKeysFiles()) {
    try {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (core && normalizeKeyCore(trimmed) === core) return true;
        if (!core && /\bsmac-guest$/.test(trimmed)) return true;
      }
    } catch { }
  }
  return false;
}

function authorizeHostKey(publicKey) {
  const keyLine = String(publicKey || '').trim();
  const core = normalizeKeyCore(keyLine);
  if (!core) {
    return { ok: false, authorized: false, note: '尚未配置主机 SSH 公钥（可从主机下载客机安装包或在下方粘贴主机公钥）' };
  }
  const userSshDir = path.join(USER_HOME, '.ssh');
  const userKeyFile = path.join(userSshDir, 'authorized_keys');
  try {
    fs.mkdirSync(userSshDir, { recursive: true });
    if (!IS_WIN) { try { fs.chmodSync(userSshDir, 0o700); } catch { } }
    let existing = '';
    try { existing = fs.readFileSync(userKeyFile, 'utf8'); } catch { }
    const lines = existing.split(/\r?\n/);
    const already = lines.some(l => normalizeKeyCore(l) === core);
    if (!already) {
      const eol = IS_WIN ? '\r\n' : '\n';
      const prefix = existing && !existing.endsWith('\n') ? eol : '';
      fs.appendFileSync(userKeyFile, prefix + keyLine + eol, 'utf8');
    }
    if (!IS_WIN) { try { fs.chmodSync(userKeyFile, 0o600); } catch { } }
  } catch (err) {
    return { ok: false, authorized: false, note: '写入用户 authorized_keys 失败: ' + err.message };
  }

  if (IS_WIN) {
    const adminKeyFile = path.join(process.env.ProgramData || 'C:\\ProgramData', 'ssh', 'administrators_authorized_keys');
    try {
      fs.mkdirSync(path.dirname(adminKeyFile), { recursive: true });
      let existing = '';
      try { existing = fs.readFileSync(adminKeyFile, 'utf8'); } catch { }
      const already = existing.split(/\r?\n/).some(l => normalizeKeyCore(l) === core);
      if (!already) {
        const prefix = existing && !existing.endsWith('\n') ? '\r\n' : '';
        fs.appendFileSync(adminKeyFile, prefix + keyLine + '\r\n', 'utf8');
        spawnSync('icacls.exe', [adminKeyFile, '/inheritance:r', '/grant', '*S-1-5-32-544:F', '/grant', '*S-1-5-18:F'], { windowsHide: true, timeout: 5000 });
      }
    } catch { }
  }

  return { ok: true, authorized: true, note: '主机 SSH 免密公钥已写入并授权生效' };
}

function revokeHostKey(publicKey) {
  const core = normalizeKeyCore(publicKey);
  let removedCount = 0;

  for (const file of getAuthorizedKeysFiles()) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split(/\r?\n/);
      const filtered = lines.filter(line => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        if (core && normalizeKeyCore(trimmed) === core) {
          removedCount += 1;
          return false;
        }
        if (/\bsmac-guest$/.test(trimmed)) {
          removedCount += 1;
          return false;
        }
        return true;
      });
      const eol = IS_WIN ? '\r\n' : '\n';
      fs.writeFileSync(file, filtered.join(eol), 'utf8');
    } catch { }
  }
  return { ok: true, removedCount };
}

// ---------- Background Agent & Clipboard bridge process control ----------

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch { return false; }
}

function getLocalServicesStatus() {
  let agentPid = 0;
  let agentPort = 0;
  try {
    const srv = readJson(path.join(AGENT_DIR, 'server.json'));
    if (srv && pidAlive(srv.pid)) {
      agentPid = Number(srv.pid);
      agentPort = Number(srv.port) || 8799;
    }
  } catch { }

  let clipPid = 0;
  try {
    const p = parseInt(fs.readFileSync(path.join(GUEST_DIR, 'clip-bridge', 'agent.pid'), 'utf8').trim(), 10);
    if (pidAlive(p)) clipPid = p;
  } catch { }

  return {
    agentRunning: agentPid > 0,
    agentPid,
    agentPort,
    clipBridgeRunning: clipPid > 0,
    clipPid
  };
}

function stopGuestBackgroundServices() {
  const st = getLocalServicesStatus();
  let stoppedAgent = false;
  let stoppedClip = false;
  if (st.agentPid) {
    try { process.kill(st.agentPid, 'SIGTERM'); stoppedAgent = true; } catch { }
    if (IS_WIN) {
      try { spawnSync('taskkill.exe', ['/PID', String(st.agentPid), '/T', '/F'], { windowsHide: true, timeout: 4000 }); } catch { }
    }
    try { fs.rmSync(path.join(AGENT_DIR, 'server.json'), { force: true }); } catch { }
  }
  if (st.clipPid) {
    try { process.kill(st.clipPid, 'SIGTERM'); stoppedClip = true; } catch { }
    if (IS_WIN) {
      try { spawnSync('taskkill.exe', ['/PID', String(st.clipPid), '/T', '/F'], { windowsHide: true, timeout: 4000 }); } catch { }
    }
    try { fs.rmSync(path.join(GUEST_DIR, 'clip-bridge', 'agent.pid'), { force: true }); } catch { }
  }
  return { ok: true, stoppedAgent, stoppedClip };
}

// ---------- Local ZeroTier status & join ----------

function findZeroTierCli() {
  if (IS_WIN) {
    for (const p of [
      'C:\\Program Files (x86)\\ZeroTier\\One\\zerotier-one_x64.exe',
      'C:\\Program Files\\ZeroTier\\One\\zerotier-one_x64.exe',
      'C:\\ProgramData\\ZeroTier\\One\\zerotier-one_x64.exe'
    ]) {
      if (fs.existsSync(p)) return p;
    }
    return '';
  }
  for (const p of [
    '/usr/local/bin/zerotier-cli',
    '/opt/homebrew/bin/zerotier-cli',
    '/usr/sbin/zerotier-cli',
    '/usr/bin/zerotier-cli',
    '/Applications/ZeroTier.app/Contents/MacOS/zerotier-cli'
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function getZeroTierStatus(configuredNetworkId) {
  const cli = findZeroTierCli();
  const nwid = String(configuredNetworkId || '').trim().toLowerCase();
  const centralUrl = nwid ? ('https://my.zerotier.com/network/' + nwid) : 'https://my.zerotier.com/';
  if (!cli) {
    return {
      installed: false,
      nodeId: '',
      online: false,
      networkId: nwid,
      status: 'NOT_INSTALLED',
      ip: '',
      networks: [],
      centralUrl,
      downloadUrl: 'https://www.zerotier.com/download/'
    };
  }
  const argsPrefix = IS_WIN ? ['-q'] : [];
  const infoRes = spawnSync(cli, [...argsPrefix, 'info'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const infoOut = String(infoRes.stdout || '');
  const im = /200\s+info\s+([0-9a-f]{10})\s+\S+\s+(\S+)/i.exec(infoOut);
  const nodeId = im ? im[1].toLowerCase() : '';
  const online = im ? /online/i.test(im[2]) : false;

  const netRes = spawnSync(cli, [...argsPrefix, '-j', 'listnetworks'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  let networks = [];
  try {
    const arr = JSON.parse(String(netRes.stdout || '[]'));
    if (Array.isArray(arr)) {
      networks = arr.map(n => {
        const assigned = Array.isArray(n.assignedAddresses) ? n.assignedAddresses : [];
        let ipv4 = '';
        for (const a of assigned) {
          const cand = String(a).split('/')[0].trim();
          if (/^\d+\.\d+\.\d+\.\d+$/.test(cand)) { ipv4 = cand; break; }
        }
        return {
          nwid: String(n.nwid || n.id || '').toLowerCase(),
          name: String(n.name || ''),
          status: String(n.status || 'UNKNOWN'),
          ipv4
        };
      }).filter(n => n.nwid);
    }
  } catch { }

  const target = nwid ? networks.find(n => n.nwid === nwid) : (networks.find(n => n.status === 'OK') || networks[0] || null);
  return {
    installed: true,
    nodeId,
    online,
    networkId: nwid || (target ? target.nwid : ''),
    status: !nwid && !target ? 'UNCONFIGURED' : (target ? target.status : 'NOT_JOINED'),
    networkName: target ? target.name : '',
    ip: target ? target.ipv4 : '',
    networks,
    centralUrl
  };
}

function joinZeroTier(rawNwid) {
  const nwid = String(rawNwid || '').trim().toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(nwid)) {
    throw new Error('请输入有效的 16 位十六进制 ZeroTier 组号');
  }
  const cli = findZeroTierCli();
  if (!cli) {
    throw new Error('本机尚未安装 ZeroTier One，请先从 https://www.zerotier.com/download/ 安装');
  }
  const argsPrefix = IS_WIN ? ['-q'] : [];
  spawnSync(cli, [...argsPrefix, 'join', nwid], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  saveHostProfile({ zerotierNetworkId: nwid });
  appendLog('JOIN_ZEROTIER | 已执行加入 ZeroTier 组 ' + nwid);
  return getZeroTierStatus(nwid);
}

// ---------- Pairing payload & Host HTTP handshake ----------

function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise(resolve => {
    if (!host) { resolve(false); return; }
    const socket = new net.Socket();
    let done = false;
    const finish = ok => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try { socket.connect(port, host); } catch { finish(false); }
  });
}

let envScanPromise = null;

function refreshEnvCacheAsync() {
  if (envScanPromise) return envScanPromise;
  envScanPromise = new Promise(resolve => {
    try {
      const child = spawn(process.execPath, [path.join(__dirname, 'guest-env.js')], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      let out = '';
      child.stdout.on('data', chunk => { out += chunk.toString('utf8'); });
      const timer = setTimeout(() => {
        try { child.kill(); } catch { }
      }, 15000);
      child.on('close', () => {
        clearTimeout(timer);
        envScanPromise = null;
        const idx = out.indexOf('SMAC_GUEST_ENV ');
        if (idx >= 0) {
          const line = out.slice(idx + 'SMAC_GUEST_ENV '.length).trim().split(/\r?\n/)[0];
          try {
            const parsed = JSON.parse(line);
            if (parsed && parsed.ok) envCache = parsed;
          } catch { }
        }
        resolve(envCache);
      });
      child.on('error', () => {
        clearTimeout(timer);
        envScanPromise = null;
        resolve(envCache);
      });
    } catch {
      envScanPromise = null;
      resolve(envCache);
    }
  });
  return envScanPromise;
}

function buildGuestRegistrationPayload() {
  const profile = ensureHostProfile();
  if (!envCache) {
    envCache = {
      ok: true,
      detectedAt: new Date().toISOString(),
      machine: guestEnv.detectNetworkAndMachine(),
      cli: [],
      desktop: []
    };
    refreshEnvCacheAsync();
  }
  const zt = getZeroTierStatus(profile.zerotierNetworkId);
  const machine = (envCache && envCache.machine) || guestEnv.detectNetworkAndMachine();
  const lanIp = (machine.lanIps || [])[0] || '';
  const tsIp = (machine.tailscaleIps || [])[0] || '';
  const ztIp = zt.ip || (machine.zerotierIps || [])[0] || '';
  // 按 局域网 -> Tailscale -> ZeroTier 顺序确定主地址与备用地址
  const ordered = [lanIp, tsIp, ztIp, machine.primaryIp].filter(Boolean);
  const uniqueIps = Array.from(new Set(ordered));
  const primaryIp = uniqueIps[0] || '';
  const fallbackIp = uniqueIps[1] || '';

  const acc = readAccountSession();
  const deviceId = getOrCreateDeviceId();

  const payload = {
    name: os.hostname().replace(/\.local$/i, ''),
    hostname: os.hostname(),
    primaryIp,
    fallbackIp,
    sshPort: machine.sshPort || 22,
    user: machine.user,
    os: machine.osLabel,
    zerotierNetworkId: zt.networkId || '',
    zerotierNodeId: zt.nodeId || '',
    zerotierStatus: zt.status || '',
    zerotierIp: ztIp,
    accountId: acc.userId || 0,
    accountUsername: acc.username || '',
    accountDisplayName: acc.displayName || '',
    gatewayDeviceId: deviceId,
    env: envCache
  };

  const json = JSON.stringify(payload);
  const pairingCode = 'SMAC-GUEST://' + Buffer.from(json, 'utf8').toString('base64');
  try {
    fs.mkdirSync(GUEST_DIR, { recursive: true });
    fs.writeFileSync(PAIRING_CODE_FILE, pairingCode, 'utf8');
  } catch { }

  return { payload, pairingCode, zt, machine };
}

async function activelyConnectToHost(customPatch, forceEnvRefresh = false) {
  if (customPatch && typeof customPatch === 'object') {
    saveHostProfile(customPatch);
  }
  const acc = readAccountSession();
  if (acc.token) {
    try { await refreshAccountProfile(); } catch { }
  }
  const profile = ensureHostProfile();
  const keyRes = authorizeHostKey(profile.publicKey);

  if (profile.zerotierNetworkId && /^[0-9a-f]{16}$/i.test(profile.zerotierNetworkId)) {
    try { joinZeroTier(profile.zerotierNetworkId); } catch { }
  }

  if (forceEnvRefresh) {
    await refreshEnvCacheAsync();
  }
  const { payload, pairingCode } = buildGuestRegistrationPayload();
  const deviceId = getOrCreateDeviceId();

  // 如果客机已登录账号体系，先向网关上报并绑定本机到当前账号（支持 1 账号多客机）
  let gatewaySynced = false;
  if (readAccountSession().token) {
    try {
      const regRes = await gatewayClientFetch('POST', '/api/client/devices/register', {
        id: deviceId,
        deviceName: payload.name,
        hostname: payload.hostname,
        os: payload.os,
        sshUser: payload.user,
        sshPort: payload.sshPort,
        primaryIp: payload.primaryIp,
        fallbackIp: payload.fallbackIp,
        zerotierIp: payload.zerotierIp,
        zerotierNodeId: payload.zerotierNodeId,
        zerotierNetworkId: payload.zerotierNetworkId,
        connected: true,
        sshAuthorized: Boolean(keyRes.authorized),
        env: payload.env
      });
      gatewaySynced = true;
      if (regRes && regRes.hostBinding) {
        applyHostBindingFromProfile({ hostBinding: regRes.hostBinding });
      }
      if (regRes && Array.isArray(regRes.devices)) {
        const curSess = readAccountSession();
        if (curSess.profile) {
          curSess.profile.boundDevices = regRes.devices;
          writeAccountSession({ profile: curSess.profile });
        }
      }
    } catch (err) {
      appendLog('GATEWAY_BIND_WARN | 网关账号绑定同步失败: ' + (err && err.message ? err.message : err));
    }
  }

  const freshProfile = ensureHostProfile();
  const endpoints = orderEndpoints(freshProfile.endpoints || []);
  let connectedHostName = freshProfile.hostName || '';
  let activeEndpoint = '';
  let hostMessage = '';
  let lastErr = '';

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep + '/api/guest/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Smac-Pair-Token': freshProfile.pairToken || ''
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4000)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.ok) {
        activeEndpoint = ep;
        connectedHostName = data.hostName || connectedHostName || ep;
        hostMessage = data.message || ('已成功连接到主机端 ' + connectedHostName);
        break;
      } else {
        lastErr = (data && data.error) || ('HTTP ' + res.status);
      }
    } catch (err) {
      lastErr = err.message || '连接超时';
    }
  }

  const now = new Date().toISOString();
  if (activeEndpoint) {
    saveHostProfile({
      hostName: connectedHostName,
      connected: true,
      lastConnectedAt: now,
      lastDisconnectedAt: '',
      lastActiveEndpoint: activeEndpoint,
      lastHostResponse: hostMessage
    });
    appendLog('CONNECT_OK | 已主动连接主机端 ' + connectedHostName + ' (' + activeEndpoint + ')' + (gatewaySynced ? ' [账号绑定已同步]' : ''));
    return {
      ok: true,
      connected: true,
      hostNotified: true,
      gatewaySynced,
      keyAuthorized: keyRes.authorized,
      activeEndpoint,
      hostName: connectedHostName,
      pairingCode,
      message: hostMessage + '（通道：' + activeEndpoint + '）'
    };
  }

  saveHostProfile({
    connected: keyRes.authorized,
    lastConnectedAt: now,
    lastDisconnectedAt: '',
    lastHostResponse: endpoints.length
      ? ('未直连到主机配对端口（' + lastErr + '），已开启本机 SSH 授权' + (gatewaySynced ? '并已绑定至账号' : '并刷新配对码'))
      : '已开启本机 SSH 授权并生成配对码（可在下方填写主机地址或复制配对码到主机端接入）'
  });
  const fallbackMsg = endpoints.length
    ? ('已开启本机 SSH 免密授权' + (gatewaySynced ? '并已将本机注册到当前账号' : '') + '（未能直接回连主机 8797 端口：' + lastErr + '）')
    : '已开启本机 SSH 免密授权并生成最新配对码；登录账号或填写主机 IP 即可直连。';
  appendLog('CONNECT_AUTH | ' + fallbackMsg);
  return {
    ok: true,
    connected: keyRes.authorized,
    hostNotified: false,
    gatewaySynced,
    keyAuthorized: keyRes.authorized,
    activeEndpoint: '',
    hostName: connectedHostName,
    pairingCode,
    message: fallbackMsg
  };
}

async function activelyDisconnectFromHost() {
  const profile = ensureHostProfile();
  const { payload } = buildGuestRegistrationPayload();
  const endpoints = orderEndpoints(profile.endpoints || []);
  let hostNotified = false;
  let notifiedEp = '';

  const deviceId = getOrCreateDeviceId();
  if (readAccountSession().token) {
    try {
      const discRes = await gatewayClientFetch('POST', '/api/client/devices/' + encodeURIComponent(deviceId) + '/disconnect', {});
      if (discRes && Array.isArray(discRes.devices)) {
        const curSess = readAccountSession();
        if (curSess.profile) {
          curSess.profile.boundDevices = discRes.devices;
          writeAccountSession({ profile: curSess.profile });
        }
      }
    } catch { }
  }

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep + '/api/guest/disconnect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Smac-Pair-Token': profile.pairToken || ''
        },
        body: JSON.stringify({
          name: payload.name,
          hostname: payload.hostname,
          primaryIp: payload.primaryIp,
          fallbackIp: payload.fallbackIp,
          zerotierIp: payload.zerotierIp,
          user: payload.user
        }),
        signal: AbortSignal.timeout(3500)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.ok) {
        hostNotified = true;
        notifiedEp = ep;
        break;
      }
    } catch { }
  }

  const revokeRes = revokeHostKey(profile.publicKey);
  const stopRes = stopGuestBackgroundServices();
  const now = new Date().toISOString();

  const msg = '已主动断开与主机端的连接：已吊销主机 SSH 免密公钥'
    + (stopRes.stoppedAgent || stopRes.stoppedClip ? '、已停止后台 Agent/剪贴板会话' : '')
    + (hostNotified ? ('、已通知主机端 (' + notifiedEp + ') 下线') : '');

  saveHostProfile({
    connected: false,
    lastDisconnectedAt: now,
    lastActiveEndpoint: '',
    lastHostResponse: msg
  });
  appendLog('DISCONNECT | ' + msg + ' (移除公钥条目: ' + revokeRes.removedCount + ')');

  return {
    ok: true,
    connected: false,
    keyAuthorized: false,
    hostNotified,
    stoppedAgent: stopRes.stoppedAgent,
    stoppedClip: stopRes.stoppedClip,
    message: msg
  };
}

async function buildGuestState() {
  const profile = ensureHostProfile();
  const { payload, pairingCode, zt, machine } = buildGuestRegistrationPayload(false);
  const sshOpen = await probeTcp('127.0.0.1', machine.sshPort || 22, 1200);
  const keyAuthorized = isHostKeyAuthorized(profile.publicKey);
  const services = getLocalServicesStatus();

  return {
    platform: process.platform,
    osLabel: machine.osLabel,
    machine: {
      hostname: os.hostname(),
      name: payload.name,
      osLabel: machine.osLabel,
      arch: machine.arch,
      user: machine.user,
      home: machine.home,
      sshPort: machine.sshPort || 22,
      sshOpen,
      lanIps: machine.lanIps || [],
      tailscaleIps: machine.tailscaleIps || [],
      zerotierIps: zt.ip ? [zt.ip] : (machine.zerotierIps || []),
      primaryIp: payload.primaryIp,
      fallbackIp: payload.fallbackIp
    },
    zerotier: zt,
    hostProfile: {
      hostName: profile.hostName || '',
      publicKey: profile.publicKey || '',
      hasPublicKey: Boolean(normalizeKeyCore(profile.publicKey)),
      pairToken: profile.pairToken || '',
      endpoints: profile.endpoints || [],
      zerotierNetworkId: profile.zerotierNetworkId || '',
      connected: Boolean(profile.connected && keyAuthorized),
      keyAuthorized,
      lastConnectedAt: profile.lastConnectedAt || '',
      lastDisconnectedAt: profile.lastDisconnectedAt || '',
      lastActiveEndpoint: profile.lastActiveEndpoint || '',
      lastHostResponse: profile.lastHostResponse || ''
    },
    services,
    pairingCode,
    deviceId: getOrCreateDeviceId(),
    account: (() => {
      const s = readAccountSession();
      return {
        loggedIn: Boolean(s.token),
        gatewayUrl: s.gatewayUrl || DEFAULT_GATEWAY_URL,
        userId: s.userId || 0,
        username: s.username || '',
        displayName: s.displayName || '',
        profile: s.profile || null
      };
    })(),
    env: envCache,
    logs: tailLogs(100),
    serverTime: new Date().toISOString()
  };
}

// ---------- HTTP server ----------

function sendJson(res, code, payload) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

const STATIC = {
  '/': { file: 'guest.html', type: 'text/html; charset=utf-8' },
  '/guest.html': { file: 'guest.html', type: 'text/html; charset=utf-8' },
  '/guest.css': { file: 'guest.css', type: 'text/css; charset=utf-8' },
  '/guest.js': { file: 'guest.js', type: 'text/javascript; charset=utf-8' }
};

function hostAllowed(req) {
  const h = String(req.headers.host || '').toLowerCase();
  return h === '127.0.0.1:' + PORT || h === 'localhost:' + PORT;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;

    if (req.method === 'GET' && route === '/api/health') {
      sendJson(res, 200, { ok: true, app: 'smac-guest', pid: process.pid, port: PORT });
      return;
    }

    if (req.method === 'GET' && route === '/api/state') {
      sendJson(res, 200, await buildGuestState());
      return;
    }

    if (req.method === 'POST' && route === '/api/account/login') {
      const body = await readBody(req);
      const loginRes = await loginAccount(body.gatewayUrl, body.username, body.password);
      // 登录后自动执行一次连接与账号客机绑定
      const connRes = await activelyConnectToHost(null, false).catch(e => ({ ok: false, message: e.message }));
      sendJson(res, 200, Object.assign({ connectResult: connRes }, loginRes));
      return;
    }

    if (req.method === 'POST' && route === '/api/account/logout') {
      writeAccountSession({ token: '', profile: null });
      appendLog('ACCOUNT_LOGOUT | 已退出账号登录');
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && route === '/api/account/refresh') {
      const r = await refreshAccountProfile();
      sendJson(res, 200, r);
      return;
    }

    if (req.method === 'POST' && route === '/api/account/test-key') {
      const r = await gatewayClientFetch('POST', '/api/client/test-key', {});
      sendJson(res, 200, r);
      return;
    }

    if (req.method === 'POST' && route === '/api/connect') {
      const body = await readBody(req);
      const result = await activelyConnectToHost(body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && route === '/api/disconnect') {
      const result = await activelyDisconnectFromHost();
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && route === '/api/profile') {
      const body = await readBody(req);
      const saved = saveHostProfile({
        hostName: body.hostName,
        endpoints: body.endpoints,
        pairToken: body.pairToken,
        publicKey: body.publicKey,
        zerotierNetworkId: body.zerotierNetworkId
      });
      appendLog('PROFILE | 已保存主机连接配置 (' + (saved.endpoints.join(', ') || '无地址') + ')');
      sendJson(res, 200, { ok: true, hostProfile: saved });
      return;
    }

    if (req.method === 'POST' && route === '/api/env/refresh') {
      const st = ensureHostProfile();
      if (st.connected && isHostKeyAuthorized(st.publicKey)) {
        const result = await activelyConnectToHost(null, true);
        sendJson(res, 200, Object.assign({ env: envCache }, result));
      } else {
        await refreshEnvCacheAsync();
        const { pairingCode } = buildGuestRegistrationPayload();
        appendLog('ENV_SCAN | 已重新扫描本机 CLI 与 Desktop 环境');
        sendJson(res, 200, { ok: true, env: envCache, pairingCode, message: '本机 CLI 与 Desktop 环境已刷新' });
      }
      return;
    }

    if (req.method === 'POST' && route === '/api/zerotier/join') {
      const body = await readBody(req);
      const zt = joinZeroTier(body.networkId);
      sendJson(res, 200, { ok: true, zerotier: zt, message: '已执行加入 ZeroTier 组 ' + zt.networkId });
      return;
    }

    if (req.method === 'POST' && route === '/api/services/stop') {
      const r = stopGuestBackgroundServices();
      appendLog('STOP_SERVICES | 已手动停止客机后台 Agent 与剪贴板会话');
      sendJson(res, 200, Object.assign({ message: '已停止客机后台 Agent 与剪贴板服务' }, r));
      return;
    }

    const entry = STATIC[route];
    if (req.method === 'GET' && entry) {
      fs.readFile(path.join(__dirname, entry.file), (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': entry.type,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(data);
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: '接口不存在' });
  } catch (err) {
    sendJson(res, 400, { ok: false, error: String(err && err.message ? err.message : err) });
  }
});

let attempt = 0;
server.on('error', err => {
  if (err && err.code === 'EADDRINUSE' && attempt < PORT_TRIES) {
    attempt += 1;
    PORT = BASE_PORT + attempt;
    server.listen(PORT, BIND);
    return;
  }
  console.error('无法启动客机控制台: ' + (err && err.message ? err.message : err));
  process.exit(1);
});

function openStandaloneWindow(url) {
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA || path.join(USER_HOME, 'AppData', 'Local');
    const candidates = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ];
    const exe = candidates.find(p => fs.existsSync(p));
    if (exe) {
      const profileDir = path.join(localAppData, 'smac-window-profile', 'guest');
      try { fs.mkdirSync(profileDir, { recursive: true }); } catch { }
      spawn(exe, [
        '--app=' + url,
        '--user-data-dir=' + profileDir,
        '--window-size=1260,860',
        '--no-first-run',
        '--no-default-browser-check'
      ], { detached: true, stdio: 'ignore' }).unref();
      return;
    }
    spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (IS_MAC) {
    for (const appPath of [
      '/Applications/smac 客机控制台.app',
      path.join(USER_HOME, 'Applications', 'smac 客机控制台.app')
    ]) {
      if (fs.existsSync(appPath)) {
        spawn('open', ['-a', appPath], { detached: true, stdio: 'ignore' }).unref();
        return;
      }
    }
    for (const browserBin of [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ]) {
      if (fs.existsSync(browserBin)) {
        const profileDir = path.join(USER_HOME, 'Library', 'Application Support', 'smac-window-profile', 'guest');
        try { fs.mkdirSync(profileDir, { recursive: true }); } catch { }
        spawn(browserBin, [
          '--app=' + url,
          '--user-data-dir=' + profileDir,
          '--window-size=1260,860',
          '--no-first-run',
          '--no-default-browser-check'
        ], { detached: true, stdio: 'ignore' }).unref();
        return;
      }
    }
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

server.on('listening', () => {
  try {
    fs.mkdirSync(GUEST_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid), 'ascii');
    fs.writeFileSync(PORT_FILE, String(PORT), 'ascii');
  } catch { }
  const url = 'http://' + BIND + ':' + PORT + '/';
  console.log('smac guest console: ' + url);
  if (process.argv.includes('--open')) {
    openStandaloneWindow(url);
  }
});

function cleanup() {
  try {
    const p = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (p === process.pid) fs.rmSync(PID_FILE, { force: true });
  } catch { }
  try {
    const pt = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);
    if (pt === PORT) fs.rmSync(PORT_FILE, { force: true });
  } catch { }
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

server.listen(BASE_PORT, BIND);
