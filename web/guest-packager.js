'use strict';

// smac 主机端 ⇄ 客机端 打包器与自动配对服务
// 1. 生成主机专用 SSH 密钥对 (smac_peer_ed25519) 与配对令牌 (pairToken)；
// 2. 启动独立的轻量客机配对监听端口 (默认 8797，仅接受持合法 pairToken 的 POST /api/guest/register)；
// 3. 动态打包客机端安装包 (dist/smac-guest-setup.zip)，内嵌公钥、主机地址与配对令牌；
// 4. 客机端安装完成后自动回连主机注册，上报 IP、SSH 端口、用户名以及检测到的 CLI + Desktop 环境；
// 5. 同时支持粘贴客机生成的 SMAC-GUEST:// 配对码一键接入。

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const remote = require('./remote');
const agent = require('./agent-manager');
const guestEnv = require('../agent/guest-env');
const zerotier = require('./zerotier');

const USER_HOME = process.env.USERPROFILE || os.homedir();
const DATA_DIR = path.join(USER_HOME, '.smac');
const PAIRING_FILE = path.join(DATA_DIR, 'guest-pairing.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const APP_DIR = path.resolve(__dirname, '..');
const GUEST_TPL_DIR = path.join(APP_DIR, 'guest');
const DIST_DIR = path.join(APP_DIR, 'dist');
const PAIR_BASE_PORT = Number(process.env.SMAC_PAIR_PORT) || 8797;

let pairServer = null;
let pairPort = PAIR_BASE_PORT;
let lastPairedEvent = null;

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

function ensureSshKeyPair(keyName = 'smac_peer_ed25519') {
  const sshDir = path.join(USER_HOME, '.ssh');
  fs.mkdirSync(sshDir, { recursive: true });
  const keyPath = path.join(sshDir, keyName);
  const pubPath = keyPath + '.pub';

  if (!fs.existsSync(keyPath) || !fs.existsSync(pubPath)) {
    const keygenCandidates = [
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe'),
      'ssh-keygen.exe',
      'ssh-keygen'
    ];
    let keygen = 'ssh-keygen';
    for (const cand of keygenCandidates) {
      if (cand.includes(path.sep) && fs.existsSync(cand)) { keygen = cand; break; }
    }
    spawnSync(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'smac-guest', '-f', keyPath], {
      windowsHide: true,
      timeout: 15000
    });
  }

  let publicKey = '';
  try { publicKey = fs.readFileSync(pubPath, 'utf8').trim(); } catch { }
  if (!publicKey) {
    throw new Error('未能读取或生成 SSH 公钥: ' + pubPath);
  }
  return { keyPath, pubPath, publicKey };
}

function ensurePairingConfig() {
  let cfg = readJson(PAIRING_FILE);
  const keyInfo = ensureSshKeyPair('smac_peer_ed25519');
  if (!cfg || !cfg.pairToken) {
    cfg = {
      pairToken: crypto.randomBytes(20).toString('hex'),
      createdAt: new Date().toISOString()
    };
    writeJson(PAIRING_FILE, cfg);
  }
  const hostMachine = guestEnv.detectNetworkAndMachine();
  const zt = zerotier.getLocalStatus();
  const endpoints = [];
  // 严格按「局域网 -> Tailscale -> ZeroTier -> 其他」顺序排列回调地址
  const orderedIps = [
    ...(hostMachine.lanIps || []),
    ...(hostMachine.tailscaleIps || []),
    ...(zt && zt.ip ? [zt.ip] : []),
    ...(hostMachine.zerotierIps || []),
    ...(hostMachine.meshIps || []),
    ...(hostMachine.publicIps || [])
  ];
  for (const ip of orderedIps) {
    if (!ip) continue;
    const url = 'http://' + ip + ':' + pairPort;
    if (!endpoints.includes(url)) endpoints.push(url);
  }
  return {
    pairToken: cfg.pairToken,
    pairPort,
    keyPath: keyInfo.keyPath,
    publicKey: keyInfo.publicKey,
    hostName: hostMachine.hostname,
    lanIps: hostMachine.lanIps || [],
    tailscaleIps: hostMachine.tailscaleIps || [],
    zerotierNetworkId: (zt && zt.networkId) ? zt.networkId : '',
    zerotierIp: zt ? zt.ip : '',
    zerotierNodeId: zt ? zt.nodeId : '',
    zerotierStatus: zt ? zt.status : 'NOT_INSTALLED',
    endpoints,
    lastPairedEvent
  };
}

function upsertGuestDevice(payload) {
  const keyInfo = ensureSshKeyPair('smac_peer_ed25519');
  const rawName = String(payload.name || payload.hostname || payload.primaryIp || '客机').trim().slice(0, 38);
  const primaryIp = String(payload.primaryIp || payload.host || '').trim();
  const fallbackIp = String(payload.fallbackIp || payload.fallbackHost || '').trim();
  const user = String(payload.user || '').trim();
  const sshPort = Number(payload.sshPort || payload.port) || 22;
  const osLabel = String(payload.os || (payload.env && payload.env.machine && payload.env.machine.osLabel) || 'Windows').trim();

  if (!primaryIp || !user) {
    throw new Error('客机注册信息缺少 IP 地址或用户名');
  }

  const rawData = readJson(DEVICES_FILE);
  const devices = Array.isArray(rawData) ? rawData : (rawData && Array.isArray(rawData.devices) ? rawData.devices : []);

  // 查找是否已有同一网关 ID、同一 IP 或同名的非管理员设备
  let existing = devices.find(d =>
    d && !d.isAdminNode && (
      (payload.gatewayDeviceId && d.gatewayDeviceId === payload.gatewayDeviceId)
      || d.host === primaryIp
      || (fallbackIp && (d.host === fallbackIp || d.fallbackHost === fallbackIp))
      || String(d.name || '').toLowerCase() === rawName.toLowerCase()
    )
  );

  const now = new Date().toISOString();
  if (existing) {
    existing.host = primaryIp;
    if (fallbackIp && fallbackIp !== primaryIp) existing.fallbackHost = fallbackIp;
    existing.port = sshPort;
    existing.user = user;
    existing.os = osLabel || existing.os;
    if (payload.useKeyAuth !== false) {
      existing.auth = 'key';
      existing.keyPath = keyInfo.keyPath;
    }
    if (payload.env && typeof payload.env === 'object') {
      existing.guestEnv = payload.env;
    }
    if (payload.zerotierIp) existing.zerotierIp = String(payload.zerotierIp).trim();
    if (payload.zerotierNodeId) existing.zerotierNodeId = String(payload.zerotierNodeId).trim();
    if (payload.zerotierStatus) existing.zerotierStatus = String(payload.zerotierStatus).trim();
    if (payload.zerotierNetworkId) existing.zerotierNetworkId = String(payload.zerotierNetworkId).trim();
    if (payload.accountId !== undefined && Number(payload.accountId) > 0) existing.accountId = Number(payload.accountId);
    if (payload.accountUsername) existing.accountUsername = String(payload.accountUsername).trim();
    if (payload.accountDisplayName) existing.accountDisplayName = String(payload.accountDisplayName).trim();
    if (payload.accountEnabled !== undefined) existing.accountEnabled = payload.accountEnabled !== false;
    if (payload.gatewayDeviceId) existing.gatewayDeviceId = String(payload.gatewayDeviceId).trim();
    if (payload.hostAdminNodeId !== undefined) existing.hostAdminNodeId = String(payload.hostAdminNodeId || '').trim();
    if (payload.hostAdminName !== undefined) existing.hostAdminName = String(payload.hostAdminName || '').trim();
    if (payload.handshakeStatus !== undefined) existing.handshakeStatus = String(payload.handshakeStatus || 'connected').trim();
    if (payload.pendingCommand !== undefined) existing.pendingCommand = payload.pendingCommand || null;
    existing.guestDisconnected = Boolean(payload.guestDisconnected);
    existing.updatedAt = now;
    existing.lastConnectedAt = now;
    existing.lastError = '';
  } else {
    let uniqueName = rawName;
    let suffix = 2;
    while (devices.some(d => d && String(d.name || '').toLowerCase() === uniqueName.toLowerCase())) {
      uniqueName = rawName.slice(0, 34) + '-' + suffix++;
    }
    existing = {
      id: crypto.randomUUID(),
      name: uniqueName,
      host: primaryIp,
      fallbackHost: fallbackIp && fallbackIp !== primaryIp ? fallbackIp : '',
      port: sshPort,
      user,
      auth: 'key',
      keyPath: keyInfo.keyPath,
      password: '',
      hostFingerprint: '',
      os: osLabel,
      zerotierNodeId: String(payload.zerotierNodeId || '').trim(),
      zerotierIp: String(payload.zerotierIp || '').trim(),
      zerotierStatus: String(payload.zerotierStatus || '').trim(),
      zerotierNetworkId: String(payload.zerotierNetworkId || '').trim(),
      accountId: Number(payload.accountId) || 0,
      accountUsername: String(payload.accountUsername || '').trim(),
      accountDisplayName: String(payload.accountDisplayName || '').trim(),
      accountEnabled: payload.accountEnabled !== false,
      gatewayDeviceId: String(payload.gatewayDeviceId || '').trim(),
      isAdminNode: false,
      adminNodeId: '',
      hostAdminNodeId: String(payload.hostAdminNodeId || '').trim(),
      hostAdminName: String(payload.hostAdminName || '').trim(),
      handshakeStatus: String(payload.handshakeStatus || 'connected').trim(),
      pendingCommand: payload.pendingCommand || null,
      guestDisconnected: Boolean(payload.guestDisconnected),
      guestEnv: payload.env && typeof payload.env === 'object' ? payload.env : null,
      createdAt: now,
      updatedAt: now,
      lastConnectedAt: now,
      lastError: ''
    };
    devices.push(existing);
  }

  writeJson(DEVICES_FILE, { version: 1, devices });
  lastPairedEvent = {
    kind: 'connect',
    at: now,
    deviceId: existing.id,
    name: existing.name,
    host: existing.host,
    os: existing.os
  };
  return existing;
}

function markGuestDisconnected(payload, remoteIp) {
  const rawData = readJson(DEVICES_FILE);
  const devices = Array.isArray(rawData) ? rawData : (rawData && Array.isArray(rawData.devices) ? rawData.devices : []);
  const rawName = String((payload && (payload.name || payload.hostname)) || '').trim().replace(/\.local$/i, '').toLowerCase();
  const ips = [
    remoteIp,
    payload && payload.primaryIp,
    payload && payload.fallbackIp,
    payload && payload.zerotierIp
  ].map(s => String(s || '').trim()).filter(Boolean);

  const match = devices.find(d => d && (
    ips.includes(d.host)
    || (d.fallbackHost && ips.includes(d.fallbackHost))
    || (d.zerotierIp && ips.includes(d.zerotierIp))
    || (rawName && String(d.name || '').toLowerCase() === rawName)
  ));
  if (!match) return null;

  const now = new Date().toISOString();
  match.guestDisconnected = true;
  match.lastError = '客机已主动断开连接';
  match.updatedAt = now;
  writeJson(DEVICES_FILE, { version: 1, devices });

  try {
    if (typeof remote.disconnectDeviceSessions === 'function') {
      remote.disconnectDeviceSessions(match.id);
    }
  } catch { }
  try {
    const st = agent.publicState();
    if (st && st.running && st.deviceId === match.id) {
      agent.stop().catch(() => { });
    }
  } catch { }

  lastPairedEvent = {
    kind: 'disconnect',
    at: now,
    deviceId: match.id,
    name: match.name,
    host: match.host,
    os: match.os
  };
  return match;
}

function parsePairingCode(codeText) {
  const cleaned = String(codeText || '').trim();
  if (!cleaned) throw new Error('请输入客机配对码');
  const rawBase64 = cleaned.replace(/^SMAC-GUEST:\/\//i, '').trim();
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(rawBase64, 'base64').toString('utf8'));
  } catch {
    throw new Error('配对码格式无效，请复制客机安装完成后显示的完整 SMAC-GUEST:// 配对码');
  }
  return decoded;
}

function parseHostPortOverride(raw) {
  const text = String(raw || '').trim().replace(/^ssh:\/\//i, '');
  if (!text) return null;
  // Support [ipv6]:port or host:port or host
  const m = /^([^:\s]+)(?::(\d{1,5}))?$/.exec(text);
  if (!m) throw new Error('跨公网连接地址格式无效，请填写 IP/域名 或 IP/域名:端口（例如 frp.example.com:22022）');
  const host = m[1].trim();
  const port = m[2] ? Number(m[2]) : 0;
  if (port && (port < 1 || port > 65535)) throw new Error('端口号必须在 1-65535 之间');
  return { host, port };
}

async function pairByCode(codeText, overrideAddress) {
  const payload = parsePairingCode(codeText);
  const override = parseHostPortOverride(overrideAddress);
  if (override && override.host) {
    if (payload.primaryIp && payload.primaryIp !== override.host && !payload.fallbackIp) {
      payload.fallbackIp = payload.primaryIp;
    }
    payload.primaryIp = override.host;
    if (override.port) payload.sshPort = override.port;
  }
  const device = upsertGuestDevice(payload);
  // 异步探测一次最新环境与主机指纹
  try {
    await remote.testDevice(device.id);
    await agent.detectEnvForDevice(device.id, true);
  } catch { }
  return remote.listDevices().find(d => d.id === device.id) || device;
}

function startPairingListener() {
  if (pairServer) return;
  const info = ensurePairingConfig();

  const tryListen = (port, left) => {
    const srv = http.createServer((req, res) => {
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end(); return; }

      if (req.method === 'GET' && url.pathname === '/api/guest/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, app: 'smac-host-pair', host: os.hostname() }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/guest/register') {
        const token = String(req.headers['x-smac-pair-token'] || url.searchParams.get('token') || '').trim();
        const currentCfg = ensurePairingConfig();
        if (!token || token !== currentCfg.pairToken) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '配对令牌不匹配' }));
          return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
          body += chunk;
          if (body.length > 2 * 1024 * 1024) req.destroy();
        });
        req.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}');
            const remoteIp = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
            if (remoteIp && remoteIp !== '127.0.0.1' && remoteIp !== '::1') {
              // 如果客机是通过 ZeroTier / Tailscale / 公网 IP 回连主机的，优先记录实际可达的 remoteIp
              const ztIp = String(payload.zerotierIp || '').trim();
              const isZtMatch = Boolean(ztIp && ztIp === remoteIp);
              const isRemoteMeshOrPublic = isZtMatch
                || /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(remoteIp)
                || !/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(remoteIp);
              if (!payload.primaryIp) {
                payload.primaryIp = remoteIp;
              } else if (isRemoteMeshOrPublic && payload.primaryIp !== remoteIp) {
                if (!payload.fallbackIp) payload.fallbackIp = payload.primaryIp;
                payload.primaryIp = remoteIp;
              } else if (payload.primaryIp !== remoteIp && !payload.fallbackIp) {
                payload.fallbackIp = remoteIp;
              }
            }
            const device = upsertGuestDevice(payload);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
              ok: true,
              deviceId: device.id,
              deviceName: device.name,
              hostName: os.hostname(),
              message: '已成功连接到主机端 ' + os.hostname()
            }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/guest/disconnect') {
        const token = String(req.headers['x-smac-pair-token'] || url.searchParams.get('token') || '').trim();
        const currentCfg = ensurePairingConfig();
        if (!token || token !== currentCfg.pairToken) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '配对令牌不匹配' }));
          return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
          body += chunk;
          if (body.length > 512 * 1024) req.destroy();
        });
        req.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}');
            const remoteIp = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
            const dev = markGuestDisconnected(payload, remoteIp);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
              ok: true,
              deviceId: dev ? dev.id : '',
              deviceName: dev ? dev.name : '',
              hostName: os.hostname(),
              message: '已通知主机端断开连接'
            }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    srv.once('error', err => {
      if (err && err.code === 'EADDRINUSE' && left > 0) {
        tryListen(port + 1, left - 1);
      }
    });

    srv.listen(port, '0.0.0.0', () => {
      pairPort = port;
      pairServer = srv;
    });
  };

  tryListen(info.pairPort || PAIR_BASE_PORT, 6);
}

function buildGuestSetupZip() {
  const cfg = ensurePairingConfig();
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const stageDir = path.join(DIST_DIR, 'guest-stage');
  try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { }
  fs.mkdirSync(stageDir, { recursive: true });

  const endpointsJson = JSON.stringify(cfg.endpoints);
  const ztNetworkId = String(cfg.zerotierNetworkId || '').trim();
  const ztDisplay = ztNetworkId || '未配置（仅使用局域网 / Tailscale；如需 ZeroTier，请在主机控制台填入你的 16 位组号后重新下载）';
  const ztCentralUrl = ztNetworkId ? ('https://my.zerotier.com/network/' + ztNetworkId) : 'https://my.zerotier.com/';
  const replaceTokens = content => String(content)
    .replace(/__SMAC_PUBLIC_KEY__/g, cfg.publicKey)
    .replace(/__SMAC_PAIR_TOKEN__/g, cfg.pairToken)
    .replace(/__SMAC_HOST_NAME__/g, cfg.hostName)
    .replace(/__SMAC_HOST_ENDPOINTS__/g, endpointsJson)
    .replace(/__SMAC_ZEROTIER_NETWORK__/g, ztNetworkId);
  const replaceReadmeTokens = content => String(content)
    .replace(/__SMAC_HOST_NAME__/g, cfg.hostName)
    .replace(/__SMAC_ZEROTIER_DISPLAY__/g, ztDisplay)
    .replace(/__SMAC_ZEROTIER_CENTRAL_URL__/g, ztCentralUrl)
    .replace(/__SMAC_ZEROTIER_NETWORK__/g, ztNetworkId || '(未配置)');

  const utf8Bom = Buffer.from([0xEF, 0xBB, 0xBF]);
  const writeBomFile = (dest, text) => {
    fs.writeFileSync(dest, Buffer.concat([utf8Bom, Buffer.from(text, 'utf8')]));
  };

  // 1. install-guest.ps1
  const psTpl = fs.readFileSync(path.join(GUEST_TPL_DIR, 'install-guest.ps1'), 'utf8').replace(/^\uFEFF/, '');
  writeBomFile(path.join(stageDir, 'install-guest.ps1'), replaceTokens(psTpl));

  // 2. 一键安装客机端.cmd
  const cmdTpl = fs.readFileSync(path.join(GUEST_TPL_DIR, '一键安装客机端.cmd'), 'utf8');
  fs.writeFileSync(path.join(stageDir, '一键安装客机端.cmd'), cmdTpl, 'utf8');

  // 3. install-guest.sh & 一键安装客机端(Mac).command (macOS / Linux)
  if (fs.existsSync(path.join(GUEST_TPL_DIR, 'install-guest.sh'))) {
    const shTpl = fs.readFileSync(path.join(GUEST_TPL_DIR, 'install-guest.sh'), 'utf8');
    fs.writeFileSync(path.join(stageDir, 'install-guest.sh'), replaceTokens(shTpl).replace(/\r\n/g, '\n'), 'utf8');
  }
  if (fs.existsSync(path.join(GUEST_TPL_DIR, '一键安装客机端(Mac).command'))) {
    const macCmdTpl = fs.readFileSync(path.join(GUEST_TPL_DIR, '一键安装客机端(Mac).command'), 'utf8');
    fs.writeFileSync(path.join(stageDir, '一键安装客机端(Mac).command'), macCmdTpl.replace(/\r\n/g, '\n'), 'utf8');
  }

  // 4. guest-env.js + 客机前端控制台 (guest-server.js, guest.html, guest.css, guest.js, smac-guest.exe) + macOS 原生独立窗口组件
  fs.copyFileSync(path.join(APP_DIR, 'agent', 'guest-env.js'), path.join(stageDir, 'guest-env.js'));
  for (const uiFile of ['guest-server.js', 'guest.html', 'guest.css', 'guest.js', 'smac-guest.exe']) {
    const srcUi = path.join(GUEST_TPL_DIR, uiFile);
    if (fs.existsSync(srcUi)) {
      fs.copyFileSync(srcUi, path.join(stageDir, uiFile));
    }
  }
  for (const macAsset of ['smac-mac-bin', 'AppIcon-guest.icns']) {
    const srcMac = path.join(APP_DIR, 'macos', macAsset);
    if (fs.existsSync(srcMac)) {
      fs.copyFileSync(srcMac, path.join(stageDir, macAsset));
    }
  }
  let gatewayUrl = 'https://hub.sandrobina.me';
  try {
    const hubCfg = readJson(path.join(DATA_DIR, 'hub-admin.json'));
    if (hubCfg && hubCfg.serverUrl) gatewayUrl = String(hubCfg.serverUrl).trim();
  } catch { }
  writeJson(path.join(stageDir, 'host-profile.seed.json'), {
    hostName: cfg.hostName,
    publicKey: cfg.publicKey,
    pairToken: cfg.pairToken,
    endpoints: cfg.endpoints,
    zerotierNetworkId: ztNetworkId,
    gatewayUrl
  });
  const winGuestConsoleCmd = '@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\nif exist "%~dp0smac-guest.exe" (\r\n  start "" "%~dp0smac-guest.exe"\r\n) else (\r\n  node "%~dp0guest-server.js" --open\r\n)\r\n';
  fs.writeFileSync(path.join(stageDir, '启动客机控制台.cmd'), winGuestConsoleCmd, 'utf8');
  const macGuestConsoleCmd = '#!/usr/bin/env bash\nexport PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.hermes/node/bin:$PATH"\ncd "$(dirname "$0")"\nif [ -d "/Applications/smac 客机控制台.app" ]; then\n  open -a "/Applications/smac 客机控制台.app"\nelse\n  nohup node ./guest-server.js --open >/dev/null 2>&1 </dev/null &\n  sleep 1\nfi\n';
  fs.writeFileSync(path.join(stageDir, '启动客机控制台(Mac).command'), macGuestConsoleCmd, 'utf8');

  // 5. 使用说明.txt
  if (fs.existsSync(path.join(GUEST_TPL_DIR, '使用说明.txt'))) {
    const readmeTpl = fs.readFileSync(path.join(GUEST_TPL_DIR, '使用说明.txt'), 'utf8').replace(/^\uFEFF/, '');
    writeBomFile(path.join(stageDir, '使用说明.txt'), replaceReadmeTokens(readmeTpl));
  }

  const zipPath = path.join(DIST_DIR, 'smac-guest-setup.zip');
  try { fs.rmSync(zipPath, { force: true }); } catch { }

  let res;
  if (process.platform === 'win32') {
    const psZip = [
      `$ErrorActionPreference = 'Stop'`,
      `Add-Type -AssemblyName System.IO.Compression`,
      `$src = (Resolve-Path -LiteralPath '${stageDir.replace(/'/g, "''")}').Path.TrimEnd('\\','/')`,
      `$fs = [IO.File]::Open('${zipPath.replace(/'/g, "''")}', [IO.FileMode]::Create)`,
      `try {`,
      `  $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create, $false, [System.Text.Encoding]::UTF8)`,
      `  try {`,
      `    foreach ($f in (Get-ChildItem -LiteralPath $src -Recurse -File -Force)) {`,
      `      $rel = $f.FullName.Substring($src.Length + 1).Replace('\\','/')`,
      `      $e = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)`,
      `      if ($rel -match '\\.(sh|command)$' -or $rel -match 'smac-mac-bin$' -or $rel -match '/Contents/MacOS/') { $e.ExternalAttributes = (([int]0x81ED) -shl 16) } else { $e.ExternalAttributes = (([int]0x81A4) -shl 16) }`,
      `      $es = $e.Open(); try { $in = [IO.File]::OpenRead($f.FullName); try { $in.CopyTo($es) } finally { $in.Dispose() } } finally { $es.Dispose() }`,
      `    }`,
      `  } finally { $zip.Dispose() }`,
      `} finally { $fs.Dispose() }`
    ].join('; ');
    res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psZip], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true
    });
  } else {
    try {
      for (const f of ['install-guest.sh', '一键安装客机端(Mac).command', '启动客机控制台(Mac).command', 'smac-mac-bin']) {
        const fp = path.join(stageDir, f);
        if (fs.existsSync(fp)) fs.chmodSync(fp, 0o755);
      }
    } catch { }
    res = spawnSync('zip', ['-r', '-q', zipPath, '.'], {
      cwd: stageDir,
      encoding: 'utf8',
      timeout: 30000
    });
  }
  if (res.status !== 0 || !fs.existsSync(zipPath)) {
    throw new Error('打包客机安装包失败: ' + (res.stderr || res.stdout || 'zip 压缩失败'));
  }

  return {
    zipPath,
    size: fs.statSync(zipPath).size,
    config: cfg
  };
}

module.exports = {
  ensureSshKeyPair,
  ensurePairingConfig,
  startPairingListener,
  upsertGuestDevice,
  pairByCode,
  buildGuestSetupZip
};
