'use strict';

// 远程设备与 SSH 终端后端。
// 设备配置保存在 %USERPROFILE%\.smac\devices.json；密码可选择明文保存，供后台同步/发送使用。
// 密码不会通过 API 返回给浏览器，网页终端仍在使用时输入。

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

let ssh2 = null;
let WebSocketServer = null;
try { ssh2 = require('ssh2'); } catch { }
try { WebSocketServer = require('ws').WebSocketServer; } catch { }
const sshDial = require('./ssh-dial');

const USER_HOME = process.env.USERPROFILE || os.homedir();
const DATA_DIR = path.join(USER_HOME, '.smac');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const MAX_SESSIONS = 8;

const sessions = new Set();
let wss = null;

function available() {
  return Boolean(ssh2 && WebSocketServer);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function expandHome(value) {
  const text = String(value || '').trim();
  if (text === '~') return USER_HOME;
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(USER_HOME, text.slice(2));
  return text;
}

function guessKeyPath() {
  const sshDir = path.join(USER_HOME, '.ssh');
  const names = ['smac_peer_ed25519', 'id_ed25519', 'id_ecdsa', 'id_rsa'];
  for (const name of names) {
    const candidate = path.join(sshDir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { }
  }
  return '';
}

function nowIso() {
  return new Date().toISOString();
}

function cleanDevice(raw) {
  const device = {
    id: String(raw.id || '').trim(),
    name: String(raw.name || '').trim(),
    host: String(raw.host || '').trim().replace(/^\[(.*)\]$/, '$1'),
    fallbackHost: String(raw.fallbackHost || '').trim().replace(/^\[(.*)\]$/, '$1'),
    port: Number(raw.port) || 22,
    user: String(raw.user || '').trim(),
    auth: raw.auth === 'password' ? 'password' : 'key',
    keyPath: expandHome(raw.keyPath),
    password: typeof raw.password === 'string' ? raw.password : '',
    hostFingerprint: String(raw.hostFingerprint || ''),
    os: String(raw.os || ''),
    jumpDeviceId: String(raw.jumpDeviceId || '').trim(),
    zerotierNodeId: String(raw.zerotierNodeId || '').trim(),
    zerotierIp: String(raw.zerotierIp || '').trim(),
    zerotierStatus: String(raw.zerotierStatus || '').trim(),
    zerotierNetworkId: String(raw.zerotierNetworkId || '').trim(),
    accountId: Number(raw.accountId) || 0,
    accountUsername: String(raw.accountUsername || '').trim(),
    accountDisplayName: String(raw.accountDisplayName || '').trim(),
    accountEnabled: raw.accountEnabled !== false,
    gatewayDeviceId: String(raw.gatewayDeviceId || '').trim(),
    guestDisconnected: Boolean(raw.guestDisconnected),
    guestEnv: raw.guestEnv && typeof raw.guestEnv === 'object' ? raw.guestEnv : null,
    createdAt: raw.createdAt || nowIso(),
    updatedAt: raw.updatedAt || nowIso(),
    lastConnectedAt: raw.lastConnectedAt || '',
    lastError: String(raw.lastError || '')
  };
  if (device.fallbackHost === device.host) device.fallbackHost = '';
  return device;
}

function seedDevices() {
  if (fs.existsSync(DEVICES_FILE)) return;
  const config = readJsonSafe(CONFIG_FILE) || {};
  const host = String(config.lanHost || config.host || '').trim();
  const devices = [];
  if (host) {
    devices.push(cleanDevice({
      id: crypto.randomUUID(),
      name: String(config.defaultDeviceName || (process.platform === 'win32' ? 'Mac' : 'Windows')),
      host,
      fallbackHost: config.host && config.host !== host ? config.host : '',
      port: Number(config.port) || 22,
      user: config.user || '',
      auth: 'key',
      keyPath: config.key ? expandHome(config.key) : guessKeyPath()
    }));
  }
  writeDevices(devices);
}

function readDevices() {
  seedDevices();
  const data = readJsonSafe(DEVICES_FILE);
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.devices) ? data.devices : []);
  return list.map(cleanDevice);
}

function writeDevices(devices) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DEVICES_FILE + '.tmp';
  const payload = JSON.stringify({ version: 1, devices }, null, 2);
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, DEVICES_FILE);
}

function listDevices() {
  return readDevices().map(publicDevice);
}

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    host: device.host,
    fallbackHost: device.fallbackHost,
    port: device.port,
    user: device.user,
    auth: device.auth,
    keyPath: device.keyPath,
    hasPassword: Boolean(device.password),
    hostFingerprint: device.hostFingerprint,
    os: device.os,
    jumpDeviceId: device.jumpDeviceId || '',
    zerotierNodeId: device.zerotierNodeId || '',
    zerotierIp: device.zerotierIp || '',
    zerotierStatus: device.zerotierStatus || '',
    zerotierNetworkId: device.zerotierNetworkId || '',
    accountId: Number(device.accountId) || 0,
    accountUsername: device.accountUsername || '',
    accountDisplayName: device.accountDisplayName || '',
    accountEnabled: device.accountEnabled !== false,
    gatewayDeviceId: device.gatewayDeviceId || '',
    guestDisconnected: Boolean(device.guestDisconnected),
    guestEnv: device.guestEnv || null,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    lastConnectedAt: device.lastConnectedAt,
    lastError: device.lastError
  };
}

function setDeviceAccountBinding(id, binding) {
  const devices = readDevices();
  const target = devices.find(d => d.id === id);
  if (!target) return null;
  if (binding.accountId !== undefined) target.accountId = Number(binding.accountId) || 0;
  if (binding.accountUsername !== undefined) target.accountUsername = String(binding.accountUsername || '').trim();
  if (binding.accountDisplayName !== undefined) target.accountDisplayName = String(binding.accountDisplayName || '').trim();
  if (binding.accountEnabled !== undefined) target.accountEnabled = binding.accountEnabled !== false;
  if (binding.gatewayDeviceId !== undefined) target.gatewayDeviceId = String(binding.gatewayDeviceId || '').trim();
  if (binding.guestDisconnected !== undefined) target.guestDisconnected = Boolean(binding.guestDisconnected);
  target.updatedAt = nowIso();
  writeDevices(devices);
  return publicDevice(target);
}

function disconnectDeviceSessions(id) {
  for (const session of sessions) {
    if (session.deviceId === id) {
      try { session.closeNow(); } catch { }
    }
  }
}

function findDevice(id) {
  return readDevices().find(item => item.id === id) || null;
}

function updateDevice(id, patch) {
  const devices = readDevices();
  const index = devices.findIndex(item => item.id === id);
  if (index < 0) return null;
  devices[index] = cleanDevice(Object.assign({}, devices[index], patch, { updatedAt: nowIso() }));
  writeDevices(devices);
  return devices[index];
}

function validateHost(value) {
  return Boolean(value) && value.length <= 255 && !/[\s\x00-\x1f]/.test(value) && !value.startsWith('-');
}

function validateUser(value) {
  return Boolean(value) && value.length <= 64 && !/[\s\x00-\x1f]/.test(value);
}

function validateDeviceInput(body, existing) {
  const device = existing ? Object.assign({}, existing) : cleanDevice({ id: crypto.randomUUID() });
  const name = String(body.name != null ? body.name : device.name).trim();
  const host = String(body.host != null ? body.host : device.host).trim().replace(/^\[(.*)\]$/, '$1');
  const fallbackHost = String(body.fallbackHost != null ? body.fallbackHost : device.fallbackHost).trim().replace(/^\[(.*)\]$/, '$1');
  const zerotierIp = String(body.zerotierIp != null ? body.zerotierIp : (device.zerotierIp || '')).trim().replace(/^\[(.*)\]$/, '$1');
  const user = String(body.user != null ? body.user : device.user).trim();
  const portRaw = body.port != null ? body.port : device.port;
  const port = parseInt(portRaw, 10);
  const auth = body.auth === 'password' ? 'password' : (body.auth === 'key' ? 'key' : device.auth);
  const keyPath = expandHome(body.keyPath != null ? body.keyPath : device.keyPath);
  const passwordInput = body.password != null ? String(body.password) : null;
  let password = device.password || '';
  const authChanged = auth !== device.auth;
  const loginChanged = host !== device.host || port !== device.port || user !== device.user;
  if (auth === 'key') {
    password = '';
  }
  else {
    if (authChanged || loginChanged) password = '';
    if (passwordInput) {
      if (passwordInput.length > 1024) throw badRequest('密码过长');
      password = passwordInput;
    }
    if (body.savePassword === false) password = '';
  }

  if (!name) throw badRequest('请填写设备名称');
  if (name.length > 40) throw badRequest('设备名称不能超过 40 个字符');
  if (!validateHost(host)) throw badRequest('主机地址无效');
  if (fallbackHost && !validateHost(fallbackHost)) throw badRequest('备用地址无效');
  if (zerotierIp && !validateHost(zerotierIp)) throw badRequest('ZeroTier IP 地址无效');
  if (!validateUser(user)) throw badRequest('用户名无效');
  if (!Number.isFinite(port) || port < 1 || port > 65535) throw badRequest('端口需在 1-65535 之间');
  if (auth === 'key') {
    if (!keyPath) throw badRequest('请填写私钥路径');
    if (keyPath.length > 1024) throw badRequest('私钥路径过长');
    let stat = null;
    try { stat = fs.statSync(keyPath); } catch { }
    if (!stat || !stat.isFile()) throw badRequest('私钥文件不存在: ' + keyPath);
  }

  const duplicates = readDevices().filter(item => item.id !== device.id && item.name.toLowerCase() === name.toLowerCase());
  if (duplicates.length) throw badRequest('已有同名设备: ' + name);

  const hostChanged = host !== device.host || port !== device.port;

  return cleanDevice({
    id: device.id,
    name,
    host,
    fallbackHost: fallbackHost === host ? '' : fallbackHost,
    port,
    user,
    auth,
    keyPath,
    password,
    hostFingerprint: hostChanged ? '' : device.hostFingerprint,
    os: hostChanged ? '' : device.os,
    jumpDeviceId: body.jumpDeviceId != null ? String(body.jumpDeviceId).trim() : (device.jumpDeviceId || ''),
    zerotierNodeId: device.zerotierNodeId || '',
    zerotierIp,
    zerotierStatus: device.zerotierStatus || '',
    zerotierNetworkId: device.zerotierNetworkId || '',
    guestEnv: device.guestEnv || null,
    createdAt: device.createdAt,
    updatedAt: nowIso(),
    lastConnectedAt: device.lastConnectedAt,
    lastError: hostChanged ? '' : device.lastError
  });
}

function saveDevice(body) {
  const existing = body.id ? findDevice(String(body.id)) : null;
  if (body.id && !existing) throw badRequest('设备不存在，可能已被删除');
  const device = validateDeviceInput(body, existing);
  const devices = readDevices();
  const index = devices.findIndex(item => item.id === device.id);
  if (index >= 0) devices[index] = device;
  else devices.push(device);
  writeDevices(devices);
  return publicDevice(device);
}

function removeDevice(id) {
  const devices = readDevices();
  const next = devices.filter(item => item.id !== id);
  if (next.length === devices.length) throw badRequest('设备不存在');
  for (const session of sessions) {
    if (session.deviceId === id) session.closeNow();
  }
  writeDevices(next);
  return { ok: true };
}

function resetHostKey(id) {
  const device = updateDevice(id, { hostFingerprint: '', lastError: '' });
  if (!device) throw badRequest('设备不存在');
  return publicDevice(device);
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function fingerprintOf(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function clamp(value, min, max, fallback) {
  const number = parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function isNetworkError(error) {
  const text = String(error && (error.code || '') + ' ' + (error.message || '')).toLowerCase();
  return /econnrefused|etimedout|ehostunreach|enetunreach|enotfound|econnreset|timed? ?out|socket|network/.test(text);
}

function friendlyError(error) {
  const message = String(error && error.message ? error.message : error);
  if (/Encrypted private .* no passphrase/i.test(message)) return '私钥已加密，需要输入口令';
  if (/bad passphrase/i.test(message)) return '私钥口令不正确';
  if (/All configured authentication methods failed/i.test(message)) return '认证失败：请检查用户名、私钥或密码';
  if (/Host verification failed/i.test(message)) return '服务器主机密钥与上次记录不一致';
  if (/Timed out while waiting for handshake|Timed out/i.test(message)) return '连接超时，设备可能不可达';
  if (/ENOTFOUND|getaddrinfo/i.test(message)) return '找不到该主机，请检查地址';
  if (/ECONNREFUSED/i.test(message)) return '端口拒绝连接，请检查 SSH 端口';
  return message;
}

function classifyError(error) {
  const message = String(error && error.message ? error.message : error);
  if (error && error.code === 'hostkey-mismatch') return 'hostkey-mismatch';
  if (/Encrypted private .* no passphrase/i.test(message)) return 'passphrase-required';
  if (/bad passphrase/i.test(message)) return 'passphrase-invalid';
  if (/Host verification failed/i.test(message)) return 'hostkey-mismatch';
  if (/All configured authentication methods failed/i.test(message)) return 'auth-failed';
  if (/Timed out while waiting for handshake|Timed out/i.test(message)) return 'timeout';
  if (isNetworkError(error)) return 'unreachable';
  return 'connect-failed';
}

async function connectDevice(device, credentials, cols, rows, onStatus, dialOpts) {
  const result = await sshDial.connect(device, Object.assign({
    credentials: credentials || {},
    connectTimeoutMs: 20000,
    onStatus
  }, dialOpts || {}));
  return {
    conn: result.conn,
    jumpConn: result.jumpConn || null,
    fingerprint: result.fingerprint || '',
    usedHost: result.usedHost || result.host || device.host,
    routeKind: result.routeKind || '',
    routeLabel: result.routeLabel || '',
    cols: clamp(cols, 20, 400, 100),
    rows: clamp(rows, 5, 200, 30)
  };
}

function detectOs(conn) {
  return new Promise(resolve => {
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(''), 4000);
    try {
      conn.exec('uname -s 2>/dev/null || ver', (error, stream) => {
        if (error) { clearTimeout(timer); finish(''); return; }
        let text = '';
        stream.on('data', chunk => {
          text += chunk.toString('utf8');
          if (text.length > 200) text = text.slice(0, 200);
        });
        stream.stderr.on('data', () => { });
        stream.on('close', () => {
          clearTimeout(timer);
          const value = text.trim().split(/\r?\n/)[0] || '';
          if (/MINGW|MSYS|CYGWIN/i.test(value)) finish('Windows');
          else if (/darwin/i.test(value)) finish('macOS');
          else if (/linux/i.test(value)) finish('Linux');
          else if (/windows|microsoft/i.test(value)) finish('Windows');
          else if (/freebsd|openbsd|netbsd/i.test(value)) finish('BSD');
          else finish(value.slice(0, 24));
        });
      });
    } catch {
      clearTimeout(timer);
      finish('');
    }
  });
}

function probeTcp(host, port, timeoutMs = 2500) {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, ms: ok ? Date.now() - started : 0 });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

async function testDevice(id, credentials = {}) {
  const device = findDevice(String(id || ''));
  if (!device) throw badRequest('设备不存在');
  if (device.auth === 'password' && !credentials.password && device.password) {
    credentials = Object.assign({}, credentials, { password: device.password });
  }
  const started = Date.now();

  if (device.auth === 'password' && !credentials.password) {
    const targets = sshDial.orderedHosts(device);
    for (const item of targets) {
      const result = await probeTcp(item.host, device.port);
      if (result.ok) {
        return {
          ok: true,
          tcpOnly: true,
          host: item.host,
          routeKind: item.kind,
          routeLabel: item.label,
          latencyMs: Date.now() - started,
          message: '端口可达 (' + item.label + ' ' + item.host + ')；密码将在连接时输入并验证'
        };
      }
    }
    return { ok: false, code: 'unreachable', message: '无法连接到 ' + device.host + ':' + device.port };
  }

  let result;
  try {
    // 严格按「局域网 -> Tailscale -> ZeroTier -> 跳板」顺序验证连接
    result = await connectDevice(device, credentials, 100, 30, null, { ignoreRouteCache: true });
  } catch (error) {
    const code = error.code === 'hostkey-mismatch' ? 'hostkey-mismatch' : classifyError(error);
    updateDevice(device.id, { lastError: friendlyError(error) });
    return {
      ok: false,
      code,
      message: friendlyError(error),
      expected: error.expected || '',
      actual: error.actual || ''
    };
  }

  try {
    const remoteOs = await detectOs(result.conn);
    const patch = { lastError: '', guestDisconnected: false, lastConnectedAt: nowIso() };
    if (remoteOs) patch.os = remoteOs;
    if (!device.hostFingerprint && result.fingerprint) patch.hostFingerprint = result.fingerprint;
    updateDevice(device.id, patch);
    return {
      ok: true,
      host: result.usedHost,
      routeKind: result.routeKind || '',
      routeLabel: result.routeLabel || '',
      latencyMs: Date.now() - started,
      fingerprint: result.fingerprint || device.hostFingerprint,
      os: remoteOs || device.os || ''
    };
  } finally {
    try { result.conn.end(); } catch { }
    try { if (result.jumpConn) result.jumpConn.end(); } catch { }
  }
}

// ---------------- WebSocket 终端 ----------------

function isAllowedRequest(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return false;
  const origin = String(req.headers.origin || '').toLowerCase();
  if (origin && origin !== 'http://127.0.0.1:' + port && origin !== 'http://localhost:' + port) return false;
  return true;
}

function attachUpgrade(server, getPort) {
  if (!available()) return false;
  if (!wss) {
    wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
    wss.on('connection', (ws, req) => handleConnection(ws, req));
  }
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { socket.destroy(); return; }
    if (url.pathname !== '/ws/ssh') { socket.destroy(); return; }
    if (!isAllowedRequest(req, getPort())) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, client => {
      wss.emit('connection', client, req, url);
    });
  });
  return true;
}

function handleConnection(ws, req, url) {
  if (sessions.size >= MAX_SESSIONS) {
    ws.close(1013, 'too many sessions');
    return;
  }
  let deviceId = '';
  try { deviceId = new URL(req.url, 'http://127.0.0.1').searchParams.get('id') || ''; } catch { }
  const device = findDevice(deviceId);
  if (!device) {
    ws.send(JSON.stringify({ type: 'error', code: 'not-found', message: '设备不存在，可能已被删除' }));
    ws.close();
    return;
  }

  const session = {
    ws,
    deviceId,
    conn: null,
    stream: null,
    decoder: null,
    closing: false,
    closeNow() {
      this.closing = true;
      try { if (this.stream) this.stream.close(); } catch { }
      try { if (this.conn) this.conn.end(); } catch { }
      try { ws.close(); } catch { }
    }
  };
  sessions.add(session);

  const send = payload => {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  };
  send({
    type: 'hello',
    device: { id: device.id, name: device.name, user: device.user, host: device.host, port: device.port, os: device.os }
  });
  send({ type: 'status', status: 'idle' });

  let started = false;
  let cols = 100;
  let rows = 30;

  const shutdown = () => {
    session.closing = true;
    try { if (session.stream) session.stream.close(); } catch { }
    try { if (session.conn) session.conn.end(); } catch { }
    session.stream = null;
    session.conn = null;
    sessions.delete(session);
  };

  ws.on('message', raw => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'connect') {
      if (started) return;
      started = true;
      cols = clamp(message.cols, 20, 400, 100);
      rows = clamp(message.rows, 5, 200, 30);
      const credentials = {
        password: typeof message.password === 'string' ? message.password : '',
        passphrase: typeof message.passphrase === 'string' ? message.passphrase : ''
      };
      startShell(session, device, credentials, send, value => { cols = value.cols; rows = value.rows; })
        .catch(error => {
          const code = error.code === 'hostkey-mismatch' ? 'hostkey-mismatch' : classifyError(error);
          send({
            type: 'error',
            code,
            message: friendlyError(error),
            expected: error.expected || '',
            actual: error.actual || ''
          });
          send({ type: 'status', status: 'error' });
          updateDevice(device.id, { lastError: friendlyError(error) });
          shutdown();
        });
      return;
    }

    if (message.type === 'input') {
      if (session.stream && typeof message.data === 'string') {
        try { session.stream.write(message.data); } catch { }
      }
      return;
    }

    if (message.type === 'resize') {
      cols = clamp(message.cols, 20, 400, cols);
      rows = clamp(message.rows, 5, 200, rows);
      if (session.stream) {
        try { session.stream.setWindow(rows, cols, 0, 0); } catch { }
      }
      return;
    }

    if (message.type === 'disconnect') {
      shutdown();
      return;
    }

    if (message.type === 'ping') send({ type: 'pong', at: Date.now() });
  });

  ws.on('close', shutdown);
  ws.on('error', shutdown);
}

async function startShell(session, device, credentials, send, onSize) {
  send({ type: 'status', status: 'connecting', message: '正在连接 ' + device.host });

  const result = await connectDevice(device, credentials, 100, 30, (host, isFallback) => {
    if (!isFallback) return;
    send({
      type: 'status',
      status: 'fallback',
      message: '主地址不可达，正在尝试 ' + host
    });
  });
  const conn = result.conn;
  session.conn = conn;
  send({ type: 'status', status: 'authenticated', message: '认证成功，正在打开终端' });
  if (result.fingerprint) send({ type: 'fingerprint', fingerprint: result.fingerprint });

  // 首次连接采用 TOFU：认证成功后才记录主机指纹
  const patch = { lastError: '', lastConnectedAt: nowIso() };
  if (!device.hostFingerprint && result.fingerprint) patch.hostFingerprint = result.fingerprint;
  updateDevice(device.id, patch);

  detectOs(conn).then(remoteOs => {
    if (!remoteOs) return;
    updateDevice(device.id, { os: remoteOs });
    send({ type: 'device', os: remoteOs });
  }).catch(() => { });

  await new Promise((resolve, reject) => {
    conn.shell({ term: 'xterm-256color', cols: result.cols, rows: result.rows }, (error, stream) => {
      if (error) { reject(error); return; }
      session.stream = stream;
      session.decoder = new StringDecoder('utf8');
      onSize({ cols: result.cols, rows: result.rows });
      send({
        type: 'status',
        status: 'connected',
        message: '已连接',
        host: result.usedHost
      });

      stream.on('data', chunk => {
        send({ type: 'data', data: session.decoder.write(chunk) });
      });
      stream.stderr.on('data', chunk => {
        send({ type: 'data', data: session.decoder.write(chunk) });
      });
      stream.on('close', (code, signal) => {
        const tail = session.decoder ? session.decoder.end() : '';
        if (tail) send({ type: 'data', data: tail });
        send({ type: 'exit', code: code == null ? 0 : code, signal: signal || '' });
        send({ type: 'status', status: 'closed', message: '会话已结束' });
        session.stream = null;
        try { conn.end(); } catch { }
      });
      conn.on('close', () => {
        if (session.closing) return;
        session.closing = true;
        send({ type: 'status', status: 'closed', message: '连接已断开' });
        try { session.ws.close(); } catch { }
        sessions.delete(session);
      });
      resolve();
    });
  });
}

module.exports = {
  available,
  listDevices,
  saveDevice,
  removeDevice,
  resetHostKey,
  testDevice,
  setDeviceAccountBinding,
  disconnectDeviceSessions,
  attachUpgrade
};
