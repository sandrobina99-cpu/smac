'use strict';

// Shared ssh2 dialer with multi-host fallback and transparent SSH Jump-Host
// (ProxyJump via jumpDeviceId) support.
// Used by ssh-bridge.js, remote.js, agent-manager.js, and peer-discovery.js.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let ssh2 = null;
try { ssh2 = require('ssh2'); } catch { }

const USER_HOME = process.env.USERPROFILE || os.homedir();
const DEVICES_FILE = path.join(USER_HOME, '.smac', 'devices.json');
const ROUTE_CACHE_FILE = path.join(USER_HOME, '.smac', 'ssh-route-cache.json');
const ROUTE_CACHE_TTL_MS = 10 * 60 * 1000;

function readRouteCache() {
  try {
    const data = JSON.parse(fs.readFileSync(ROUTE_CACHE_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function getCachedRoute(deviceId) {
  if (!deviceId) return null;
  const entry = readRouteCache()[deviceId];
  if (!entry || !entry.host || !entry.at) return null;
  if (Date.now() - Number(entry.at) > ROUTE_CACHE_TTL_MS) return null;
  return entry;
}

function saveCachedRoute(deviceId, route) {
  if (!deviceId || !route || !route.host) return;
  try {
    const cache = readRouteCache();
    cache[deviceId] = Object.assign({ at: Date.now() }, route);
    fs.mkdirSync(path.dirname(ROUTE_CACHE_FILE), { recursive: true });
    const tmp = ROUTE_CACHE_FILE + '.tmp-' + process.pid + '-' + crypto.randomBytes(2).toString('hex');
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, ROUTE_CACHE_FILE);
  } catch { }
}

function readAllDevices() {
  try {
    const raw = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8').replace(/^\uFEFF/, ''));
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.devices) ? raw.devices : []);
    return list.filter(Boolean);
  } catch {
    return [];
  }
}

function fingerprintOf(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function isNetworkError(error) {
  const code = String((error && error.code) || '');
  const msg = String((error && error.message) || '');
  const text = code + ' ' + msg;
  return /econnrefused|etimedout|ehostunreach|enetunreach|enotfound|econnreset|epipe|timed? ?out|timeout|socket|network|no route|before handshake|connection closed|closed by|unreachable/i.test(text);
}

function buildAuthOptions(device, credentials) {
  const creds = credentials || {};
  const out = {};
  if (device.auth === 'password') {
    const password = creds.password != null && creds.password !== ''
      ? String(creds.password)
      : String(device.password || '');
    if (!password) {
      const err = new Error('设备未保存密码，请在设备设置中保存密码或在终端连接时输入');
      err.code = 'password-missing';
      throw err;
    }
    out.password = password;
    out.tryKeyboard = true;
  } else {
    const keyPath = String(device.keyPath || '');
    if (!keyPath) {
      const err = new Error('设备未配置私钥');
      err.code = 'key-missing';
      throw err;
    }
    try {
      out.privateKey = fs.readFileSync(keyPath);
    } catch {
      const err = new Error('无法读取私钥: ' + keyPath);
      err.code = 'key-unreadable';
      throw err;
    }
    if (creds.passphrase) out.passphrase = String(creds.passphrase);
  }
  return out;
}

function connectSingle(device, target, opts) {
  const { credentials, timeoutMs, sock, onMismatch } = opts || {};
  const effectiveTimeout = Math.max(Number(timeoutMs) || 15000, 2000);

  return new Promise((resolve, reject) => {
    if (!ssh2) {
      reject(new Error('缺少 ssh2 组件，请在 web 目录执行 npm install'));
      return;
    }
    const conn = new ssh2.Client();
    let settled = false;
    let authOpts;
    try {
      authOpts = buildAuthOptions(device, credentials);
    } catch (err) {
      reject(err);
      return;
    }

    const options = Object.assign({
      username: device.user,
      readyTimeout: effectiveTimeout,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      hostVerifier: (key, callback) => {
        const cb = typeof callback === 'function' ? callback : (() => { });
        if (!key) { cb(true); return true; }
        const actual = fingerprintOf(key);
        if (device.hostFingerprint && actual !== device.hostFingerprint) {
          const error = new Error('Host verification failed');
          error.code = 'hostkey-mismatch';
          error.expected = device.hostFingerprint;
          error.actual = actual;
          options.__mismatch = error;
          if (onMismatch) onMismatch(error);
          cb(false);
          return false;
        }
        options.__fingerprint = actual;
        cb(true);
        return true;
      }
    }, authOpts);

    if (sock) {
      options.sock = sock;
    } else {
      options.host = target.host;
      options.port = Number(target.port) || 22;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch { }
      try { if (sock && !sock.destroyed) sock.destroy(); } catch { }
      const err = new Error('连接超时');
      err.code = 'timeout';
      reject(err);
    }, effectiveTimeout + 1500);

    conn.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      finish(prompts.map(() => String(authOpts.password || '')));
    });

    conn.on('ready', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        conn,
        host: target.host,
        usedHost: target.host,
        fingerprint: options.__fingerprint || ''
      });
    });

    conn.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch { }
      if (options.__mismatch) {
        reject(options.__mismatch);
        return;
      }
      reject(error);
    });

    conn.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = new Error('Connection closed before handshake');
      err.code = 'ECONNRESET';
      reject(err);
    });

    try {
      conn.connect(options);
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

function openJumpStream(jumpConn, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const err = new Error('跳板转发超时');
      err.code = 'timeout';
      reject(err);
    }, Math.max(Number(timeoutMs) || 8000, 2000));

    jumpConn.forwardOut('127.0.0.1', 0, host, Number(port) || 22, (err, stream) => {
      if (done) {
        if (stream) try { stream.destroy(); } catch { }
        return;
      }
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(stream);
    });
  });
}

function isTailscaleIp(host) {
  return /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(String(host || '').trim());
}

function classifyHost(host, device, allHosts) {
  const ip = String(host || '').trim();
  const ztIp = String((device && device.zerotierIp) || '').trim();
  if (ztIp && ip === ztIp) {
    return { kind: 'zerotier', label: 'ZeroTier', rank: 3 };
  }
  if (isTailscaleIp(ip)) {
    return { kind: 'tailscale', label: 'Tailscale', rank: 2 };
  }
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    return { kind: 'lan', label: '局域网', rank: 1 };
  }
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    // 10.x.x.x is treated as ZeroTier when paired with Tailscale/LAN or typical ZeroTier ranges
    const hasLanOrTs = (allHosts || []).some(h => h !== ip && (isTailscaleIp(h) || /^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)));
    if (hasLanOrTs || /^10\.(21|147|241|242|243|244)\./.test(ip)) {
      return { kind: 'zerotier', label: 'ZeroTier', rank: 3 };
    }
    return { kind: 'lan', label: '局域网', rank: 1 };
  }
  return { kind: 'public', label: '直连', rank: 4 };
}

function orderedHosts(device) {
  const raw = [];
  for (const h of [device.host, device.fallbackHost, device.zerotierIp]) {
    const clean = String(h || '').trim();
    if (clean && !raw.includes(clean)) raw.push(clean);
  }
  return raw
    .map((host, idx) => Object.assign({ host, idx }, classifyHost(host, device, raw)))
    .sort((a, b) => (a.rank - b.rank) || (a.idx - b.idx));
}

async function connect(device, opts) {
  const options = opts || {};
  const depth = Number(options._depth || 0);
  const allDevices = Array.isArray(options.allDevices) ? options.allDevices : readAllDevices();
  const credentials = options.credentials || {};
  const connectTimeoutMs = Math.max(Number(options.connectTimeoutMs) || 15000, 2500);
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
  const ignoreRouteCache = Boolean(options.ignoreRouteCache);

  const candidates = orderedHosts(device);
  const hosts = candidates.map(c => c.host);
  const metaByHost = new Map(candidates.map(c => [c.host, c]));
  if (!hosts.length) {
    throw new Error('设备未填写主机地址');
  }

  const jumpDevice = (depth < 1 && device.jumpDeviceId && device.jumpDeviceId !== device.id)
    ? (allDevices.find(d => d && d.id === device.jumpDeviceId) || null)
    : null;

  const tryJump = async preferredHosts => {
    let jumpRes = null;
    let jumpErrLast = null;
    try {
      if (onStatus) onStatus(preferredHosts[0] + ' (经 ' + (jumpDevice.name || jumpDevice.host) + ' 中转)', true);
      jumpRes = await connect(jumpDevice, {
        allDevices,
        connectTimeoutMs: Math.min(8000, connectTimeoutMs),
        _depth: depth + 1
      });
      for (let i = 0; i < preferredHosts.length; i += 1) {
        const host = preferredHosts[i];
        const hasMore = i < preferredHosts.length - 1;
        let stream = null;
        try {
          stream = await openJumpStream(jumpRes.conn, host, device.port || 22, hasMore ? 3500 : 10000);
          const targetRes = await connectSingle(device, { host, port: device.port || 22 }, {
            credentials,
            timeoutMs: hasMore ? 5000 : connectTimeoutMs,
            sock: stream
          });
          const closeJump = () => {
            try { if (stream && !stream.destroyed) stream.destroy(); } catch { }
            try { jumpRes.conn.end(); } catch { }
          };
          targetRes.conn.once('close', closeJump);
          targetRes.conn.once('end', closeJump);
          targetRes.jumpConn = jumpRes.conn;
          targetRes.via = jumpDevice.name || jumpDevice.host;
          targetRes.routeKind = 'jump';
          targetRes.routeLabel = '经 ' + targetRes.via + ' 跳板';
          targetRes.usedHost = host + ' (via ' + targetRes.via + ')';
          targetRes.host = targetRes.usedHost;
          saveCachedRoute(device.id, { mode: 'jump', host, jumpDeviceId: jumpDevice.id });
          return targetRes;
        } catch (err) {
          if (stream) try { stream.destroy(); } catch { }
          jumpErrLast = err;
          if (!isNetworkError(err)) {
            try { jumpRes.conn.end(); } catch { }
            throw err;
          }
        }
      }
      try { jumpRes.conn.end(); } catch { }
    } catch (jumpErr) {
      if (jumpRes && jumpRes.conn) try { jumpRes.conn.end(); } catch { }
      if (jumpErr && !isNetworkError(jumpErr) && jumpErr.code !== 'password-missing') {
        throw jumpErr;
      }
      jumpErrLast = jumpErr;
    }
    throw jumpErrLast || new Error('跳板连接失败');
  };

  let lastError = null;
  let triedJumpFirst = false;

  // 0. Fast-path: unless strict verification order (LAN -> Tailscale -> ZeroTier) is requested,
  // try recently-working route first to avoid repeated timeouts on unreachable addresses.
  const cached = ignoreRouteCache ? null : getCachedRoute(device.id);
  if (cached && cached.mode === 'jump' && jumpDevice && cached.jumpDeviceId === jumpDevice.id && hosts.includes(cached.host)) {
    triedJumpFirst = true;
    try {
      const ordered = [cached.host, ...hosts.filter(h => h !== cached.host)];
      return await tryJump(ordered);
    } catch (err) {
      lastError = err;
      if (!isNetworkError(err)) throw err;
    }
  } else if (cached && cached.mode === 'direct' && hosts.includes(cached.host) && hosts[0] !== cached.host) {
    const idx = hosts.indexOf(cached.host);
    if (idx > 0) {
      hosts.splice(idx, 1);
      hosts.unshift(cached.host);
    }
  }

  // 1. Try direct hosts in strict LAN -> Tailscale -> ZeroTier order
  for (let i = 0; i < hosts.length; i += 1) {
    const host = hosts[i];
    const info = metaByHost.get(host) || { kind: 'direct', label: '直连' };
    const hasMore = (i < hosts.length - 1) || (Boolean(jumpDevice) && !triedJumpFirst);
    if (onStatus) onStatus(host + ' (' + info.label + ')', i > 0);
    const attemptTimeout = hasMore ? Math.min(2800, connectTimeoutMs) : connectTimeoutMs;
    try {
      const res = await connectSingle(device, { host, port: device.port || 22 }, {
        credentials,
        timeoutMs: attemptTimeout
      });
      res.routeKind = info.kind;
      res.routeLabel = info.label;
      if (hosts.length > 1 || jumpDevice) {
        saveCachedRoute(device.id, { mode: 'direct', host });
      }
      return res;
    } catch (error) {
      lastError = error;
      if (!isNetworkError(error)) {
        throw error;
      }
    }
  }

  // 2. Transparent SSH Jump-Host fallback (e.g. Mac -> Windows Host -> ZeroTier Guest `game`)
  if (jumpDevice && !triedJumpFirst) {
    try {
      return await tryJump(hosts);
    } catch (jumpErr) {
      if (jumpErr && !isNetworkError(jumpErr) && jumpErr.code !== 'password-missing') {
        lastError = jumpErr;
      }
    }
  }

  throw lastError || new Error('连接失败');
}

module.exports = {
  available: () => Boolean(ssh2),
  connect,
  orderedHosts,
  fingerprintOf,
  isNetworkError,
  readAllDevices
};
