'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const remote = require('./remote');
const agent = require('./agent-manager');
const guestPackager = require('./guest-packager');
const hostEngine = require('./host-engine');
const peerDiscovery = require('./peer-discovery');
const zerotier = require('./zerotier');
const guestInstaller = require('./guest-installer');
const clipboardSync = require('./clipboard-sync');
const apiHubBridge = require('./api-hub-bridge');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// 8787 常被其他本机服务占用，从 8788 起自动寻找空闲端口（支持 SMAC_PORT 覆盖）
const BASE_PORT = Number(process.env.SMAC_PORT) || 8788;
const PORT_TRIES = 8;
let PORT = BASE_PORT;
const BIND = '127.0.0.1';
const APP_DIR = path.resolve(__dirname, '..');
const SMAC = path.join(APP_DIR, 'smac.ps1');
const USER_HOME = process.env.USERPROFILE || os.homedir();
const DATA_DIR = path.join(USER_HOME, '.smac');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATUS_FILE = path.join(DATA_DIR, 'sync-status.json');
const SYNC_LOG = path.join(DATA_DIR, 'sync.log');
const HISTORY_LOG = path.join(DATA_DIR, 'history.log');
const WATCH_PID = path.join(DATA_DIR, 'watch.pid');
const CLIP_STATUS_FILE = path.join(DATA_DIR, 'clip-status.json');
const CLIP_LOG = path.join(DATA_DIR, 'clip.log');
const CLIP_PID = path.join(DATA_DIR, 'clip.pid');
const CLIP_STARTUP_LNK = path.join(process.env.APPDATA || '',
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'smac-clip.lnk');
const WEB_PID = path.join(DATA_DIR, 'web.pid');
const WEB_PORT = path.join(DATA_DIR, 'web-port');
const STARTUP_LNK = path.join(process.env.APPDATA || '',
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'smac-sync.lnk');
const PS = path.join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const job = { running: false, kind: '', startedAt: null, finishedAt: null, ok: null, output: [] };

// ---------- helpers ----------

function readJsonSafe(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readPid(file) {
  try {
    const value = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeName(name) {
  const cleaned = String(name || '').replace(/[^\p{L}\p{N}_.\-]/gu, '_');
  return cleaned || 'sync';
}

function tailLines(file, maxLines) {
  try {
    const size = fs.statSync(file).size;
    const length = Math.min(size, 262144);
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    fs.closeSync(fd);
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/);
    if (size > length) lines.shift();
    return lines.filter(line => line.trim().length > 0).slice(-maxLines);
  } catch {
    return [];
  }
}

function pushJobLine(text) {
  const lines = String(text).split(/\r?\n/).filter(line => line.trim().length > 0);
  for (const line of lines) job.output.push(line);
  if (job.output.length > 400) job.output.splice(0, job.output.length - 400);
}

// Keep configuration-changing web requests in order so saves cannot overwrite each other.
let configWriteQueue = Promise.resolve();
function runPs(args, options = {}) {
  const changesConfig = (args[0] === 'config' && args[1] === 'set') ||
    (args[0] === 'sync' && ['add', 'remove', 'enable', 'disable'].includes(args[1]));
  if (!changesConfig) return runPsProcess(args, options);
  const result = configWriteQueue.then(() => runPsProcess(args, options));
  configWriteQueue = result.then(() => undefined, () => undefined);
  return result;
}

function runPsProcess(args, options = {}) {
  const timeoutMs = options.timeoutMs || 120000;
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SMAC, ...args], {
        windowsHide: true,
        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
      });
    } catch (error) {
      resolve({ ok: false, code: -1, output: error.message });
      return;
    }
    let output = '';
    let buffer = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { }
    }, timeoutMs);

    if (child.stdout) child.stdout.setEncoding('utf8');
    if (child.stderr) child.stderr.setEncoding('utf8');

    child.stdout.on('data', chunk => {
      output += chunk;
      if (options.stream) {
        buffer += chunk;
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop();
        pushJobLine(parts.join('\n'));
      }
    });
    child.stderr.on('data', chunk => {
      output += chunk;
      if (options.stream) pushJobLine(chunk);
    });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, output: error.message });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (options.stream && buffer.trim()) pushJobLine(buffer);
      resolve({ ok: code === 0, code, output: output.trim() });
    });
  });
}

function startNodeJob(kind, taskFn) {
  if (job.running) return false;
  job.running = true;
  job.kind = kind;
  job.startedAt = new Date().toISOString();
  job.finishedAt = null;
  job.ok = null;
  job.output = [];
  Promise.resolve()
    .then(() => taskFn(line => pushJobLine(line)))
    .then(result => {
      job.ok = Boolean(result && result.ok);
      if (result && result.output && !job.output.length) pushJobLine(result.output);
    })
    .catch(error => {
      job.ok = false;
      pushJobLine(String(error && error.message ? error.message : error));
    })
    .finally(() => {
      job.running = false;
      job.finishedAt = new Date().toISOString();
      folderCache.clear();
      stateCache.clear();
    });
  return true;
}

function startJob(kind, args, timeoutMs) {
  if (job.running) return false;
  job.running = true;
  job.kind = kind;
  job.startedAt = new Date().toISOString();
  job.finishedAt = null;
  job.ok = null;
  job.output = [];
  runPs(args, { timeoutMs: timeoutMs || 3600000, stream: true })
    .then(result => {
      job.ok = result.ok;
      if (!result.ok) pushJobLine(result.output);
    })
    .catch(error => {
      job.ok = false;
      pushJobLine(String(error && error.message ? error.message : error));
    })
    .finally(() => {
      job.running = false;
      job.finishedAt = new Date().toISOString();
    });
  return true;
}

function probeTcp(host, port, timeoutMs = 1800) {
  return new Promise(resolve => {
    if (!host) {
      resolve({ ok: false, host: '', ms: 0 });
      return;
    }
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, host, ms: ok ? Date.now() - started : 0 });
    };
    socket.setTimeout(timeoutMs);
    // Verify real SSH banner rather than raw TCP connect so TUN/proxy fake-ACKs never report false online
    socket.once('data', chunk => {
      const text = chunk ? chunk.toString('utf8', 0, 16) : '';
      finish(/^SSH-/i.test(text));
    });
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

let connCache = { at: 0, data: null };

async function getConnectivity(config, defaultDev) {
  if (connCache.data && Date.now() - connCache.at < 8000) return connCache.data;
  const port = Number((defaultDev && defaultDev.port) || config.port) || 22;
  const isTs = h => /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(String(h || ''));
  const isLan = h => /^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(String(h || ''));
  const candidates = [
    config.lanHost,
    config.host,
    defaultDev && defaultDev.host,
    defaultDev && defaultDev.fallbackHost,
    defaultDev && defaultDev.zerotierIp
  ].map(s => String(s || '').trim()).filter(Boolean);

  const lanHost = candidates.find(isLan) || '';
  const tailHost = candidates.find(isTs) || '';
  const ztHost = String((defaultDev && defaultDev.zerotierIp) || config.zerotierHost || '').trim()
    || candidates.find(h => /^10\./.test(h) && h !== lanHost && h !== tailHost) || '';

  const [lan, tail, zt] = await Promise.all([
    lanHost ? probeTcp(lanHost, port) : Promise.resolve({ ok: false, host: '', ms: 0 }),
    tailHost ? probeTcp(tailHost, port) : Promise.resolve({ ok: false, host: '', ms: 0 }),
    ztHost ? probeTcp(ztHost, port) : Promise.resolve({ ok: false, host: '', ms: 0 })
  ]);
  const data = { lan, tail, zt };
  connCache = { at: Date.now(), data };
  return data;
}

const folderCache = new Map();

async function folderStats(dir) {
  const cached = folderCache.get(dir);
  if (cached && Date.now() - cached.at < 15000) return cached.data;
  let exists = false;
  let files = 0;
  let bytes = 0;
  let truncated = false;
  try {
    const stat = await fsp.stat(dir);
    exists = stat.isDirectory();
    if (exists) {
      const limit = 20000;
      const walk = async (current, depth) => {
        if (files >= limit) { truncated = true; return; }
        let entries;
        try {
          entries = await fsp.readdir(current, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (files >= limit) { truncated = true; return; }
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            if (depth < 24) await walk(full, depth + 1);
          } else if (entry.isFile()) {
            files += 1;
            try { bytes += (await fsp.stat(full)).size; } catch { }
          }
        }
      };
      await walk(dir, 0);
    }
  } catch { }
  const data = { exists, files, bytes, truncated };
  folderCache.set(dir, { at: Date.now(), data });
  return data;
}

const stateCache = new Map();

function trackedStats(pairName) {
  const cached = stateCache.get(pairName);
  if (cached && Date.now() - cached.at < 8000) return cached.data;
  const state = readJsonSafe(path.join(DATA_DIR, 'sync-state-' + safeName(pairName) + '.json'));
  let count = 0;
  let bytes = 0;
  if (state && state.files) {
    for (const key of Object.keys(state.files)) {
      count += 1;
      const entry = state.files[key];
      if (entry && Number.isFinite(Number(entry.ls))) bytes += Number(entry.ls);
    }
  }
  const data = { tracked: count, trackedBytes: bytes };
  stateCache.set(pairName, { at: Date.now(), data });
  return data;
}

function hasLegacyMacConfig(config) {
  return Boolean(IS_WIN && config && String(config.host || '').trim() && String(config.user || '').trim());
}

async function buildState() {
  const config = peerDiscovery.ensureCleanSyncPairs() || readJsonSafe(CONFIG_FILE) || {};
  const hasLegacyMac = hasLegacyMacConfig(config);
  const status = readJsonSafe(STATUS_FILE);
  const watcherPid = readPid(WATCH_PID);
  const daemonRunning = pidAlive(watcherPid);
  const pairs = [];
  let deviceList = [];
  try { deviceList = remote.listDevices(); } catch { }

  const defaultDev = !IS_WIN
    ? hostEngine.resolveDefaultDevice(config)
    : (deviceList.find(d => d && (d.id === config.defaultDeviceId || (config.lanHost && d.host === config.lanHost) || (config.host && (d.host === config.host || d.fallbackHost === config.host)))) || deviceList[0] || null);
  const defaultPeerName = hasLegacyMac ? 'Mac' : (defaultDev ? defaultDev.name : '远程设备');
  for (const pair of (Array.isArray(config.syncPairs) ? config.syncPairs : [])) {
    if (!pair || !pair.name) continue;
    const stats = await folderStats(pair.local);
    const tracked = trackedStats(pair.name);
    const pairDeviceId = String(pair.deviceId || '');
    let pairDeviceName = defaultPeerName;
    if (pairDeviceId) {
      const match = deviceList.find(item => item.id === pairDeviceId);
      pairDeviceName = match ? match.name : '(设备已删除)';
    }
    pairs.push({
      name: pair.name,
      local: pair.local,
      remote: pair.remote,
      deviceId: pairDeviceId,
      deviceName: pairDeviceName,
      enabled: pair.enabled !== false,
      autoPaired: Boolean(pair.autoPaired),
      localExists: stats.exists,
      fileCount: stats.files,
      sizeBytes: stats.bytes,
      truncated: stats.truncated,
      trackedFiles: tracked.tracked,
      trackedBytes: tracked.trackedBytes
    });
  }

  const connectivity = await getConnectivity(config, defaultDev);

  const clipStatus = readJsonSafe(CLIP_STATUS_FILE);
  const clipPid = readPid(CLIP_PID);
  const clipRunning = pidAlive(clipPid);
  const clipDeviceIds = clipboardSync.getSelectedDeviceIds(config);

  return {
    platform: process.platform,
    hostOsLabel: IS_WIN ? 'Windows' : (IS_MAC ? 'macOS' : 'Linux'),
    hasLegacyMac,
    defaultPeerName,
    config: {
      host: config.host || '',
      lanHost: config.lanHost || '',
      user: config.user || '',
      port: config.port || 22,
      remoteDir: config.remoteDir || '~/Desktop',
      syncRemoteDir: config.syncRemoteDir || '~/Documents',
      interval: Number(config.syncIntervalSeconds) || 20,
      clipInterval: Number(config.clipboardIntervalSeconds) || 2,
      clipboardDeviceIds: clipDeviceIds,
      zerotierNetworkId: zerotier.getConfiguredNetworkId()
    },
    daemon: {
      running: daemonRunning,
      pid: daemonRunning ? watcherPid : 0,
      autoStart: IS_WIN ? fs.existsSync(STARTUP_LNK) : hostEngine.hasAutoStart('sync')
    },
    clip: {
      running: clipRunning,
      pid: clipRunning ? clipPid : 0,
      autoStart: IS_WIN ? fs.existsSync(CLIP_STARTUP_LNK) : hostEngine.hasAutoStart('clip'),
      interval: Number(config.clipboardIntervalSeconds) || 2,
      deviceIds: clipDeviceIds,
      status: clipStatus
    },
    status,
    pairs,
    devices: deviceList,
    connectivity,
    agent: agent.publicState(),
    hub: apiHubBridge.getPublicHubState(),
    pairing: (() => { try { return guestPackager.ensurePairingConfig(); } catch { return null; } })(),
    peerDiscovery: peerDiscovery.getLastDiscovery(),
    job,
    serverTime: new Date().toISOString()
  };
}

// ---------- http ----------

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
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
      if (chunks.length === 0) { resolve({}); return; }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求格式错误'));
      }
    });
    req.on('error', reject);
  });
}

const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/terminal.js': { file: 'terminal.js', type: 'text/javascript; charset=utf-8' },
  '/hub.js': { file: 'hub.js', type: 'text/javascript; charset=utf-8' },
  '/vendor/xterm.js': { file: 'vendor/xterm.js', type: 'text/javascript; charset=utf-8' },
  '/vendor/xterm.css': { file: 'vendor/xterm.css', type: 'text/css; charset=utf-8' },
  '/vendor/addon-fit.js': { file: 'vendor/addon-fit.js', type: 'text/javascript; charset=utf-8' }
};

function serveStatic(res, entry) {
  fs.readFile(path.join(__dirname, entry.file), (error, data) => {
    if (error) {
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
}

function hostAllowed(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return host === '127.0.0.1:' + PORT || host === 'localhost:' + PORT;
}

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (req.method === 'GET' && route === '/api/health') {
    sendJson(res, 200, { ok: true, app: 'smac', pid: process.pid, port: PORT });
    return;
  }

  if (req.method === 'GET' && route === '/api/state') {
    sendJson(res, 200, await buildState());
    return;
  }

  if (req.method === 'GET' && route === '/api/log') {
    const requested = url.searchParams.get('kind');
    const kind = requested === 'history' || requested === 'clip' ? requested : 'sync';
    const lines = Math.min(Math.max(parseInt(url.searchParams.get('lines'), 10) || 160, 20), 500);
    const file = kind === 'history' ? HISTORY_LOG : (kind === 'clip' ? CLIP_LOG : SYNC_LOG);
    sendJson(res, 200, { kind, lines: tailLines(file, lines) });
    return;
  }

  if (req.method === 'POST' && route === '/api/sync/add') {
    const body = await readBody(req);
    const local = String(body.local || '').trim();
    const remotePath = String(body.remote || '').trim();
    const name = String(body.name || '').trim();
    const deviceId = String(body.device || '').trim();
    if (!local || !remotePath) { sendJson(res, 400, { ok: false, output: '请填写本机文件夹和远端路径' }); return; }
    let stat;
    try {
      stat = fs.statSync(local);
    } catch {
      sendJson(res, 400, { ok: false, output: '本机文件夹不存在: ' + local });
      return;
    }
    if (!stat.isDirectory()) {
      sendJson(res, 400, { ok: false, output: '请选择文件夹，而不是单个文件: ' + local });
      return;
    }
    if (deviceId) {
      const device = remote.listDevices().find(item => item.id === deviceId);
      if (!device) { sendJson(res, 400, { ok: false, output: '远程设备不存在，可能已被删除' }); return; }
      if (device.auth === 'password' && !device.hasPassword) {
        sendJson(res, 400, { ok: false, output: '该设备还没有保存密码，请先在“远程设备”里编辑并保存密码，后台同步才能自动连接' });
        return;
      }
    } else if (IS_WIN && !hasLegacyMacConfig(readJsonSafe(CONFIG_FILE))) {
      sendJson(res, 400, { ok: false, output: '请先在「远程设备 · 客机」添加目标设备（支持局域网 / Tailscale / ZeroTier）后再添加同步目录' });
      return;
    }
    let result;
    if (IS_WIN) {
      const args = ['sync', 'add', local, remotePath];
      if (name) args.push(name);
      if (deviceId) args.push('--device', deviceId);
      result = await runPs(args, { timeoutMs: 60000 });
    } else {
      result = hostEngine.addSyncPair({ local, remote: remotePath, name, deviceId });
    }
    folderCache.delete(local);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (req.method === 'POST' && route === '/api/sync/remove') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name) { sendJson(res, 400, { ok: false, output: '缺少同步名称' }); return; }
    const result = IS_WIN ? await runPs(['sync', 'remove', name], { timeoutMs: 60000 }) : hostEngine.removeSyncPair(name);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (req.method === 'POST' && route === '/api/sync/enable') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name) { sendJson(res, 400, { ok: false, output: '缺少同步名称' }); return; }
    const action = body.enabled === false ? 'disable' : 'enable';
    const result = IS_WIN ? await runPs(['sync', action, name], { timeoutMs: 60000 }) : hostEngine.enableSyncPair(name, body.enabled !== false);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (req.method === 'POST' && route === '/api/sync/now') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const ok = IS_WIN
      ? startJob(name ? 'sync:' + name : 'sync:all', name ? ['sync', 'now', name] : ['sync', 'now'])
      : startNodeJob(name ? 'sync:' + name : 'sync:all', log => hostEngine.syncNow(name, log));
    if (!ok) {
      sendJson(res, 409, { ok: false, output: '已有任务在运行，请稍候' });
      return;
    }
    sendJson(res, 200, { ok: true, started: true });
    return;
  }

  if (req.method === 'POST' && route === '/api/service') {
    const body = await readBody(req);
    const map = { start: 'start', stop: 'stop', install: 'install', uninstall: 'uninstall' };
    const action = map[String(body.action || '')];
    if (!action) { sendJson(res, 400, { ok: false, output: '未知操作' }); return; }
    let result;
    if (IS_WIN) {
      result = await runPs(['sync', action], { timeoutMs: 90000 });
    } else if (action === 'start') {
      result = hostEngine.startDaemon('sync');
    } else if (action === 'stop') {
      result = hostEngine.stopDaemon('sync');
    } else {
      result = hostEngine.setAutoStart('sync', action === 'install');
    }
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (req.method === 'POST' && route === '/api/clip/service') {
    const body = await readBody(req);
    const map = { start: 'start', stop: 'stop', install: 'install', uninstall: 'uninstall' };
    const action = map[String(body.action || '')];
    if (!action) { sendJson(res, 400, { ok: false, output: '未知操作' }); return; }
    let result;
    if (action === 'start') {
      const selected = clipboardSync.getSelectedDeviceIds();
      if (!selected.length) {
        sendJson(res, 400, { ok: false, output: '请先在剪贴板同步面板勾选至少 1 台设备' });
        return;
      }
      result = hostEngine.startDaemon('clip');
    } else if (action === 'stop') {
      result = hostEngine.stopDaemon('clip');
    } else if (IS_WIN) {
      result = await runPs(['clip', action], { timeoutMs: 90000 });
    } else {
      result = hostEngine.setAutoStart('clip', action === 'install');
    }
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (req.method === 'POST' && route === '/api/clip/now') {
    const selected = clipboardSync.getSelectedDeviceIds();
    if (!selected.length) {
      sendJson(res, 400, { ok: false, output: '请先在剪贴板同步面板勾选至少 1 台设备' });
      return;
    }
    const ok = startNodeJob('clip', () => hostEngine.clipNow());
    if (!ok) {
      sendJson(res, 409, { ok: false, output: '已有任务在运行，请稍候' });
      return;
    }
    sendJson(res, 200, { ok: true, started: true });
    return;
  }

  if (req.method === 'POST' && route === '/api/config') {
    const body = await readBody(req);
    if (Array.isArray(body.clipboardDeviceIds)) {
      const validIds = new Set(remote.listDevices().map(d => d.id));
      const ids = Array.from(new Set(body.clipboardDeviceIds.map(v => String(v || '').trim()).filter(id => validIds.has(id))));
      const result = hostEngine.setConfigValue('clipboardDeviceIds', ids);
      sendJson(res, result.ok ? 200 : 400, Object.assign({ deviceIds: ids }, result));
      return;
    }
    if (body.syncRemoteDir != null) {
      if (body.interval != null) {
        sendJson(res, 400, { ok: false, output: '请一次保存一项设置' });
        return;
      }
      const value = typeof body.syncRemoteDir === 'string'
        ? body.syncRemoteDir.trim().replace(/\/+$/, '') : '';
      if (!value || value === '~' || !/^(~\/|\/|[A-Za-z]:\/)/.test(value) || /[\x00-\x1f\\]/.test(value) ||
          value.split('/').some(part => part === '..' || part === '.')) {
        sendJson(res, 400, { ok: false, output: '请填写有效的远端同步子文件夹路径，例如 ~/Documents' });
        return;
      }
      const result = IS_WIN
        ? await runPs(['config', 'set', 'syncRemoteDir', value], { timeoutMs: 30000 })
        : hostEngine.setConfigValue('syncRemoteDir', value);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }
    if (body.clipInterval != null) {
      const value = parseInt(body.clipInterval, 10);
      if (!Number.isFinite(value) || value < 1 || value > 300) {
        sendJson(res, 400, { ok: false, output: '剪贴板同步间隔需在 1-300 秒之间' });
        return;
      }
      const result = IS_WIN
        ? await runPs(['config', 'set', 'clipboardIntervalSeconds', String(value)], { timeoutMs: 30000 })
        : hostEngine.setConfigValue('clipboardIntervalSeconds', value);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }
    if (body.interval != null) {
      const value = parseInt(body.interval, 10);
      if (!Number.isFinite(value) || value < 5 || value > 86400) {
        sendJson(res, 400, { ok: false, output: '同步间隔需在 5-86400 秒之间' });
        return;
      }
      const result = IS_WIN
        ? await runPs(['config', 'set', 'syncIntervalSeconds', String(value)], { timeoutMs: 30000 })
        : hostEngine.setConfigValue('syncIntervalSeconds', value);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }
    sendJson(res, 400, { ok: false, output: '未知配置项' });
    return;
  }

  if (req.method === 'GET' && route === '/api/devices') {
    try {
      sendJson(res, 200, { ok: true, available: remote.available(), devices: remote.listDevices() });
    } catch (error) {
      sendJson(res, 500, { ok: false, available: remote.available(), devices: [], output: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/devices/save') {
    const body = await readBody(req);
    try {
      const device = remote.saveDevice(body);
      // 自动识别该机器是否已经配对过 smac 并同步映射其同步文件夹（异步不阻塞保存响应）
      peerDiscovery.reflectFromDevice(device.id).then(() => folderCache.clear()).catch(() => { });
      sendJson(res, 200, { ok: true, device });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { ok: false, output: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/devices/delete') {
    const body = await readBody(req);
    try {
      remote.removeDevice(String(body.id || ''));
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { ok: false, output: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/devices/reset-hostkey') {
    const body = await readBody(req);
    try {
      const device = remote.resetHostKey(String(body.id || ''));
      sendJson(res, 200, { ok: true, device });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { ok: false, output: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/devices/test') {
    const body = await readBody(req);
    try {
      const result = await remote.testDevice(String(body.id || ''), {
        password: typeof body.password === 'string' ? body.password : '',
        passphrase: typeof body.passphrase === 'string' ? body.passphrase : ''
      });
      if (result.ok) {
        try {
          const reflected = await peerDiscovery.reflectFromDevice(String(body.id || ''));
          if (reflected && reflected.addedPairs && reflected.addedPairs.length) {
            result.reflectedPairs = reflected.addedPairs;
            folderCache.clear();
          }
        } catch { }
      }
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, output: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/peer/discover') {
    try {
      const result = await peerDiscovery.discoverAllPairedPeers();
      folderCache.clear();
      stateCache.clear();
      connCache.at = 0;
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'GET' && route === '/api/zerotier/status') {
    try {
      const nwid = String(url.searchParams.get('networkId') || '').trim();
      sendJson(res, 200, zerotier.getLocalStatus(nwid || undefined));
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/zerotier/join') {
    const body = await readBody(req);
    try {
      const result = await zerotier.joinLocal(String(body.networkId || '').trim());
      stateCache.clear();
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/zerotier/remote-join') {
    const body = await readBody(req);
    try {
      const deviceId = String(body.deviceId || '').trim();
      if (!deviceId) { sendJson(res, 400, { ok: false, error: '缺少目标设备 ID' }); return; }
      const result = await zerotier.remoteJoinDevice(deviceId, String(body.networkId || '').trim(), {
        autoInstall: body.autoInstall !== false,
        preferZerotier: Boolean(body.preferZerotier)
      });
      stateCache.clear();
      connCache.at = 0;
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/devices/pick-key') {
    if (!IS_WIN) {
      sendJson(res, 200, await hostEngine.pickKey());
      return;
    }
    const initialDir = path.join(USER_HOME, '.ssh');
    const script = [
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      "$dialog.Title = '选择 SSH 私钥文件'",
      "$dialog.Filter = '私钥文件|id_*;*.pem;*.key;*.ppk|所有文件|*.*'",
      "$dialog.InitialDirectory = '" + initialDir.replace(/'/g, "''") + "'",
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }'
    ].join('; ');
    const result = await new Promise(resolve => {
      const child = spawn(PS, ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; });
      child.on('close', code => resolve({ ok: code === 0, path: output.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || '' }));
      child.on('error', () => resolve({ ok: false, path: '' }));
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && route === '/api/send') {
    const body = await readBody(req);
    const paths = (Array.isArray(body.paths) ? body.paths : [body.path])
      .map(value => String(value || '').trim())
      .filter(Boolean);
    if (paths.length === 0) { sendJson(res, 400, { ok: false, output: '请先拖拽要发送的文件或文件夹' }); return; }
    for (const item of paths) {
      try {
        fs.statSync(item);
      } catch {
        sendJson(res, 400, { ok: false, output: '路径不存在: ' + item });
        return;
      }
    }
    const deviceId = String(body.device || '').trim();
    const legacyMac = hasLegacyMacConfig(readJsonSafe(CONFIG_FILE));
    let device = null;
    if (deviceId) {
      device = remote.listDevices().find(item => item.id === deviceId) || null;
      if (!device) { sendJson(res, 400, { ok: false, output: '远程设备不存在，可能已被删除' }); return; }
      if (device.auth === 'password' && !device.hasPassword) {
        sendJson(res, 400, { ok: false, output: '该设备还没有保存密码，请先在“远程设备”里编辑并保存密码' });
        return;
      }
    } else if (IS_WIN && !legacyMac) {
      sendJson(res, 400, { ok: false, output: '请先在「远程设备 · 客机」添加目标设备后再发送' });
      return;
    }
    const kind = device ? 'send:' + device.name : 'send';
    const startedOk = IS_WIN
      ? startJob(kind, deviceId ? ['send', ...paths, '--device', deviceId] : ['send', ...paths], 7200000)
      : startNodeJob(kind, log => hostEngine.sendItems(paths, deviceId, log));
    if (!startedOk) {
      sendJson(res, 409, { ok: false, output: '已有任务在运行，请稍候' });
      return;
    }
    sendJson(res, 200, { ok: true, started: true, device: device ? device.name : (legacyMac ? 'Mac' : '远程设备') });
    return;
  }

  if (req.method === 'POST' && route === '/api/send/upload-item') {
    const batchId = String(url.searchParams.get('batchId') || req.headers['x-batch-id'] || '').trim();
    if (!/^[a-zA-Z0-9_-]{4,64}$/.test(batchId)) {
      req.resume();
      sendJson(res, 400, { ok: false, output: '无效的传输批次号' });
      return;
    }
    let rawRel = url.searchParams.get('relPath') || '';
    if (!rawRel && req.headers['x-rel-path']) {
      try { rawRel = decodeURIComponent(String(req.headers['x-rel-path'])); } catch { rawRel = ''; }
    }
    const segments = String(rawRel || '').replace(/\\/g, '/').split('/').map(s => s.trim()).filter(Boolean);
    if (!segments.length || segments.some(s => s === '.' || s === '..' || /[\x00-\x1f<>:"|?*]/.test(s))) {
      req.resume();
      sendJson(res, 400, { ok: false, output: '无效的相对文件路径: ' + rawRel });
      return;
    }
    const batchDir = path.join(DATA_DIR, 'drop-staging', batchId);
    const destPath = path.join(batchDir, ...segments);
    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const bytes = await new Promise((resolve, reject) => {
        let written = 0;
        const out = fs.createWriteStream(destPath);
        req.on('data', chunk => { written += chunk.length; });
        req.on('error', reject);
        out.on('error', reject);
        out.on('finish', () => resolve(written));
        req.pipe(out);
      });
      sendJson(res, 200, { ok: true, relPath: segments.join('/'), bytes });
    } catch (error) {
      sendJson(res, 500, { ok: false, output: '写入拖拽缓存文件失败: ' + (error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/send/commit-batch') {
    const body = await readBody(req);
    const batchId = String(body.batchId || '').trim();
    if (!/^[a-zA-Z0-9_-]{4,64}$/.test(batchId)) {
      sendJson(res, 400, { ok: false, output: '无效的传输批次号' });
      return;
    }
    const batchDir = path.join(DATA_DIR, 'drop-staging', batchId);
    if (Array.isArray(body.emptyDirs)) {
      for (const rawDir of body.emptyDirs) {
        const segs = String(rawDir || '').replace(/\\/g, '/').split('/').map(s => s.trim()).filter(Boolean);
        if (segs.length && !segs.some(s => s === '.' || s === '..' || /[\x00-\x1f<>:"|?*]/.test(s))) {
          try { fs.mkdirSync(path.join(batchDir, ...segs), { recursive: true }); } catch { }
        }
      }
    }
    let entries = [];
    try {
      if (fs.existsSync(batchDir)) {
        entries = fs.readdirSync(batchDir).filter(n => n && n !== '.' && n !== '..');
      }
    } catch { }
    if (!entries.length) {
      sendJson(res, 400, { ok: false, output: '未接收到任何拖拽的文件或文件夹' });
      return;
    }
    const paths = entries.map(name => path.join(batchDir, name));
    const deviceId = String(body.device || '').trim();
    const legacyMac = hasLegacyMacConfig(readJsonSafe(CONFIG_FILE));
    let device = null;
    if (deviceId) {
      device = remote.listDevices().find(item => item.id === deviceId) || null;
      if (!device) {
        try { fs.rmSync(batchDir, { recursive: true, force: true }); } catch { }
        sendJson(res, 400, { ok: false, output: '远程设备不存在，可能已被删除' });
        return;
      }
      if (device.auth === 'password' && !device.hasPassword) {
        try { fs.rmSync(batchDir, { recursive: true, force: true }); } catch { }
        sendJson(res, 400, { ok: false, output: '该设备还没有保存密码，请先在“远程设备”里编辑并保存密码' });
        return;
      }
    } else if (IS_WIN && !legacyMac) {
      try { fs.rmSync(batchDir, { recursive: true, force: true }); } catch { }
      sendJson(res, 400, { ok: false, output: '请先在「远程设备 · 客机」添加目标设备后再发送' });
      return;
    }

    const kind = device ? 'send:' + device.name : 'send';
    const startedOk = startNodeJob(kind, async log => {
      try {
        if (IS_WIN) {
          const psArgs = deviceId ? ['send', ...paths, '--device', deviceId] : ['send', ...paths];
          return await runPs(psArgs, { timeoutMs: 7200000, stream: true });
        }
        return await hostEngine.sendItems(paths, deviceId, log);
      } finally {
        try { fs.rmSync(batchDir, { recursive: true, force: true }); } catch { }
      }
    });

    if (!startedOk) {
      try { fs.rmSync(batchDir, { recursive: true, force: true }); } catch { }
      sendJson(res, 409, { ok: false, output: '已有任务在运行，请稍候' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      started: true,
      count: paths.length,
      items: entries,
      device: device ? device.name : (legacyMac ? 'Mac' : '远程设备')
    });
    return;
  }

  if (req.method === 'POST' && route === '/api/pick-folder') {
    if (!IS_WIN) {
      sendJson(res, 200, await hostEngine.pickFolder());
      return;
    }
    const script = [
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$dialog.Description = '选择要同步的文件夹'",
      '$dialog.ShowNewFolderButton = $true',
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }"
    ].join('; ');
    const result = await new Promise(resolve => {
      const child = spawn(PS, ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; });
      child.on('close', code => resolve({ ok: code === 0, path: output.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || '' }));
      child.on('error', () => resolve({ ok: false, path: '' }));
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && route === '/api/pick-file') {
    if (!IS_WIN) {
      sendJson(res, 200, await hostEngine.pickFile());
      return;
    }
    const script = [
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      '$dialog.Multiselect = $true',
      "$dialog.Title = '选择要发送的文件'",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.FileNames | ForEach-Object { Write-Output $_ } }"
    ].join('; ');
    const result = await new Promise(resolve => {
      const child = spawn(PS, ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; });
      child.on('close', code => {
        const files = output.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        resolve({ ok: code === 0, files });
      });
      child.on('error', () => resolve({ ok: false, files: [] }));
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && route === '/api/reveal') {
    const body = await readBody(req);
    const target = String(body.path || '').trim();
    const config = readJsonSafe(CONFIG_FILE) || {};
    const known = (Array.isArray(config.syncPairs) ? config.syncPairs : []).map(pair => pair.local);
    if (!known.includes(target)) { sendJson(res, 400, { ok: false, output: '未知路径' }); return; }
    try {
      fs.accessSync(target);
    } catch {
      sendJson(res, 400, { ok: false, output: '文件夹不存在' });
      return;
    }
    if (IS_WIN) {
      spawn('explorer.exe', [target], { windowsHide: false, detached: true }).unref();
    } else {
      hostEngine.revealPath(target);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && route === '/api/remote-list') {
    const body = await readBody(req);
    const deviceId = String(body.device || '').trim();
    if (IS_WIN && !deviceId && !hasLegacyMacConfig(readJsonSafe(CONFIG_FILE))) {
      sendJson(res, 400, { ok: false, output: '请先在「远程设备 · 客机」添加目标设备' });
      return;
    }
    const result = IS_WIN
      ? await runPs(deviceId ? ['ls', '--device', deviceId] : ['ls'], { timeoutMs: 60000 })
      : await hostEngine.remoteList(deviceId);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (req.method === 'GET' && route === '/api/agent/state') {
    sendJson(res, 200, agent.publicState());
    return;
  }

  if (req.method === 'GET' && route === '/api/agent/options') {
    const deviceId = String(url.searchParams.get('deviceId') || '').trim();
    sendJson(res, 200, agent.optionsForDevice(deviceId));
    return;
  }

  if (req.method === 'GET' && route === '/api/agent/models') {
    const deviceId = String(url.searchParams.get('deviceId') || '').trim();
    const raw = String(url.searchParams.get('backend') || '').trim().toLowerCase();
    const backend = ['dsh', 'hermes', 'codex', 'claude', 'agy', 'opencode'].includes(raw) ? raw : 'hermes';
    try {
      const models = await agent.modelsForDevice(deviceId, backend);
      sendJson(res, 200, models);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error), providers: [] });
    }
    return;
  }

  if (req.method === 'GET' && route === '/api/agent/env') {
    const deviceId = String(url.searchParams.get('deviceId') || '').trim();
    const force = url.searchParams.get('force') === '1';
    try {
      const env = await agent.detectEnvForDevice(deviceId, force);
      sendJson(res, 200, { ok: true, env });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'GET' && route === '/api/agent/install-catalog') {
    sendJson(res, 200, { ok: true, catalog: guestInstaller.getCatalog() });
    return;
  }

  if (req.method === 'POST' && route === '/api/agent/install-tools') {
    const body = await readBody(req);
    try {
      const deviceId = String(body.deviceId || '').trim();
      if (!deviceId) { sendJson(res, 400, { ok: false, error: '缺少目标客机 ID' }); return; }
      const result = await guestInstaller.installOnDevice(deviceId, Array.isArray(body.items) ? body.items : []);
      stateCache.clear();
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/devices/bind-account') {
    const body = await readBody(req);
    try {
      const result = await apiHubBridge.bindLocalDeviceToAccount(
        String(body.deviceId || '').trim(),
        body.userId ? Number(body.userId) : 0
      );
      stateCache.clear();
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 400, { ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'GET' && route === '/api/hub/state') {
    sendJson(res, 200, apiHubBridge.getPublicHubState());
    return;
  }

  if (req.method === 'GET' && route === '/api/hub/health') {
    const target = url.searchParams.get('url') || '';
    sendJson(res, 200, await apiHubBridge.checkGatewayHealth(target));
    return;
  }

  if (req.method === 'POST' && route === '/api/hub/login') {
    const body = await readBody(req);
    try {
      const result = await apiHubBridge.loginAdmin(body.serverUrl, body.username, body.password);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 400, { ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/hub/logout') {
    sendJson(res, 200, apiHubBridge.logoutAdmin());
    return;
  }

  if (req.method === 'POST' && route === '/api/hub/sync-host-binding') {
    try {
      sendJson(res, 200, await apiHubBridge.syncHostBindingToGateway());
    } catch (error) {
      sendJson(res, error.statusCode || 400, { ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/hub/sync-devices') {
    try {
      const r = await apiHubBridge.syncGatewayDevicesToLocal();
      stateCache.clear();
      sendJson(res, 200, r);
    } catch (error) {
      sendJson(res, error.statusCode || 400, { ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (route.startsWith('/api/hub/admin/')) {
    const subPath = route.slice('/api/hub/admin'.length);
    const body = (req.method === 'GET' || req.method === 'HEAD') ? undefined : await readBody(req);
    try {
      const result = await apiHubBridge.hubFetch(req.method, '/api/admin' + subPath + url.search, body);
      if (subPath === '/password' && result && result.token) {
        apiHubBridge.writeHubState({ token: result.token });
      }
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 400, { ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'GET' && route === '/api/guest/pairing') {
    try {
      sendJson(res, 200, { ok: true, pairing: guestPackager.ensurePairingConfig() });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/guest/pair-code') {
    const body = await readBody(req);
    try {
      const device = await guestPackager.pairByCode(String(body.code || ''), String(body.overrideAddress || ''));
      try {
        await peerDiscovery.reflectFromDevice(device.id);
        folderCache.clear();
      } catch { }
      sendJson(res, 200, { ok: true, device });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'GET' && route === '/api/guest/package') {
    try {
      const built = guestPackager.buildGuestSetupZip();
      const data = fs.readFileSync(built.zipPath);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': data.length,
        'Content-Disposition': 'attachment; filename="smac-guest-setup.zip"',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'GET' && route === '/api/agent/credentials') {
    const deviceId = String(url.searchParams.get('deviceId') || '').trim();
    try {
      sendJson(res, 200, { ok: true, credentials: agent.publicCredentials(deviceId) });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/agent/credentials') {
    const body = await readBody(req);
    try {
      const credentials = agent.saveCredentials(String(body.deviceId || '').trim(), body);
      sendJson(res, 200, { ok: true, credentials });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/agent/start') {
    const body = await readBody(req);
    try {
      const state = await agent.start({
        deviceId: String(body.deviceId || '').trim(),
        pairs: Array.isArray(body.pairs) ? body.pairs : [],
        backend: String(body.backend || '').trim(),
        provider: String(body.provider || '').trim(),
        model: String(body.model || '').trim()
      });
      sendJson(res, 200, { ok: true, agent: state });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/agent/stop') {
    await agent.stop();
    sendJson(res, 200, { ok: true, agent: agent.publicState() });
    return;
  }

  sendJson(res, 404, { ok: false, output: '接口不存在' });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    const entry = STATIC[url.pathname];
    if (entry && req.method === 'GET') {
      serveStatic(res, entry);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, output: String(error && error.message ? error.message : error) });
    } else {
      res.end();
    }
  }
});

try {
  guestPackager.startPairingListener();
} catch (error) {
  console.error('客机配对服务启动失败: ' + (error && error.message ? error.message : error));
}

try {
  if (!remote.attachUpgrade(server, () => PORT)) {
    console.warn('远程终端组件缺失：请在 web 目录执行 npm install');
  }
} catch (error) {
  console.error('远程终端初始化失败: ' + (error && error.message ? error.message : error));
}

let attempt = 0;

server.on('error', error => {
  if (error.code === 'EADDRINUSE' && attempt < PORT_TRIES) {
    attempt += 1;
    PORT = BASE_PORT + attempt;
    server.listen(PORT, BIND);
    return;
  }
  console.error(error.code === 'EADDRINUSE'
    ? '端口 ' + BASE_PORT + '-' + (BASE_PORT + PORT_TRIES) + ' 都被占用，无法启动控制台'
    : error.message);
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
      const profileDir = path.join(localAppData, 'smac-window-profile', 'host');
      try { fs.mkdirSync(profileDir, { recursive: true }); } catch { }
      spawn(exe, [
        '--app=' + url,
        '--user-data-dir=' + profileDir,
        '--window-size=1380,880',
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
      '/Applications/smac 主机控制台.app',
      path.join(USER_HOME, 'Applications', 'smac 主机控制台.app')
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
        const profileDir = path.join(USER_HOME, 'Library', 'Application Support', 'smac-window-profile', 'host');
        try { fs.mkdirSync(profileDir, { recursive: true }); } catch { }
        spawn(browserBin, [
          '--app=' + url,
          '--user-data-dir=' + profileDir,
          '--window-size=1380,880',
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
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WEB_PID, String(process.pid), 'ascii');
    fs.writeFileSync(WEB_PORT, String(PORT), 'ascii');
  } catch { }
  const url = 'http://' + BIND + ':' + PORT + '/';
  console.log('smac web console: ' + url);
  if (process.argv.includes('--open')) {
    openStandaloneWindow(url);
  }
  // 仅当存在 bootstrap-peer.json 或已配置设备时才在启动时自动识别同步目录；
  // 全新安装默认保持零 SSH 连接配置，不主动探测本机 ~/.ssh/config。
  const existingDevs = (() => { try { return remote.listDevices(); } catch { return []; } })();
  if (fs.existsSync(path.join(DATA_DIR, 'bootstrap-peer.json')) || (!IS_WIN && existingDevs.length > 0)) {
    setTimeout(() => {
      peerDiscovery.discoverAllPairedPeers().then(r => {
        if (r && (r.addedPairs.length || r.addedDevices.length)) {
          folderCache.clear();
          console.log('[peer-discovery] auto-reflected devices=' + r.addedDevices.join(',') + ' pairs=' + r.addedPairs.join(','));
        }
      }).catch(() => { });
    }, 600).unref();
  }
});

function cleanupFiles() {
  try {
    if (readPid(WEB_PID) === process.pid) fs.unlinkSync(WEB_PID);
  } catch { }
  try {
    if (readPid(WEB_PORT) === PORT) fs.unlinkSync(WEB_PORT);
  } catch { }
}

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) { return; }
  shuttingDown = true;
  const finish = () => {
    cleanupFiles();
    process.exit(0);
  };
  const timer = setTimeout(finish, 3500);
  timer.unref();
  Promise.resolve()
    .then(() => agent.stop())
    .catch(() => { })
    .finally(() => { clearTimeout(timer); finish(); });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', cleanupFiles);

server.listen(BASE_PORT, BIND);
