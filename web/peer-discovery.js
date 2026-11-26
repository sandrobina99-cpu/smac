'use strict';

// Ultra-minimal Paired Peer Auto-Discovery & Automatic Sync-Folder Reflection.
// When smac Host is deployed on macOS / Windows / Linux and connects to an
// already-paired machine running smac, this module automatically:
//   1. Recognizes already-paired machines (from bootstrap manifest, ~/.ssh/config, or devices.json);
//   2. Reads non-secret sync metadata from the remote peer's ~/.smac/config.json;
//   3. Automatically reflects/inverts all synced folders targeting this machine
//      into local ~/.smac/config.json so they appear immediately with zero manual setup.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const remote = require('./remote');
const sshDial = require('./ssh-dial');
const guestEnv = require('../agent/guest-env');
const zerotier = require('./zerotier');

const USER_HOME = process.env.USERPROFILE || os.homedir();
const DATA_DIR = path.join(USER_HOME, '.smac');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const BOOTSTRAP_FILE = path.join(DATA_DIR, 'bootstrap-peer.json');
const BRIDGE = path.join(__dirname, 'ssh-bridge.js');

let discoveryRunning = false;
let lastDiscovery = { at: '', peersChecked: 0, peersMatched: 0, addedPairs: [], addedDevices: [] };

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

function expandHome(value) {
  const text = String(value || '').trim();
  if (text === '~') return USER_HOME;
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(USER_HOME, text.slice(2));
  return text;
}

function normPath(p) {
  const s = String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return (process.platform === 'win32' || process.platform === 'darwin') ? s.toLowerCase() : s;
}

function resolveActualLocalPath(rawRemotePath) {
  let expanded = expandHome(rawRemotePath);
  if (!expanded) return '';
  if (process.platform === 'win32') {
    expanded = path.normalize(expanded.replace(/\//g, '\\'));
  } else {
    expanded = expanded.replace(/\\/g, '/');
  }
  try {
    if (fs.existsSync(expanded)) {
      return fs.realpathSync.native ? fs.realpathSync.native(expanded) : fs.realpathSync(expanded);
    }
    // On macOS/Windows case-insensitive FS, normalize parent directory casing (e.g. ~/documents -> ~/Documents)
    const parent = path.dirname(expanded);
    const base = path.basename(expanded);
    if (parent && parent !== expanded && fs.existsSync(parent)) {
      const realParent = fs.realpathSync.native ? fs.realpathSync.native(parent) : fs.realpathSync(parent);
      return path.join(realParent, base);
    }
  } catch { }
  return expanded;
}

function bridge(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { }
      reject(new Error('SSH 桥接超时'));
    }, Number(timeoutMs) || 25000);
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', e => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    child.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const line = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop();
      if (!line) { reject(new Error(err.trim() || 'SSH 无输出')); return; }
      try {
        const payload = JSON.parse(line);
        if (!payload.ok) reject(new Error(String(payload.error || 'SSH 失败')));
        else resolve(payload);
      } catch {
        reject(new Error('SSH 返回格式错误'));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function readDevicesRaw() {
  const data = readJson(DEVICES_FILE);
  return Array.isArray(data) ? data : (data && Array.isArray(data.devices) ? data.devices : []);
}

function saveDevicesRaw(list) {
  writeJson(DEVICES_FILE, { version: 1, devices: list });
}

function readConfigRaw() {
  const cfg = readJson(CONFIG_FILE) || {};
  return Object.assign({
    host: '',
    lanHost: '',
    user: '',
    port: 22,
    key: '',
    remoteDir: '~/Desktop',
    syncRemoteDir: '~/Documents',
    syncPairs: [],
    syncIntervalSeconds: 20,
    clipboardIntervalSeconds: 2,
    defaultDeviceId: ''
  }, cfg, {
    syncPairs: Array.isArray(cfg.syncPairs) ? cfg.syncPairs.filter(Boolean) : []
  });
}

function parseSshConfigHosts() {
  const file = path.join(USER_HOME, '.ssh', 'config');
  if (!fs.existsSync(file)) return [];
  const entries = [];
  let cur = null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^["']|["']$/g, '');
    if (key === 'host') {
      if (cur && cur.hostName && !cur.alias.includes('*')) entries.push(cur);
      cur = { alias: val.split(/\s+/)[0], hostName: '', user: '', port: 22, identityFile: '' };
    } else if (cur) {
      if (key === 'hostname') cur.hostName = val;
      else if (key === 'user') cur.user = val;
      else if (key === 'port') cur.port = Number(val) || 22;
      else if (key === 'identityfile') cur.identityFile = expandHome(val);
    }
  }
  if (cur && cur.hostName && !cur.alias.includes('*')) entries.push(cur);
  return entries;
}

// Import initial paired peer definitions from ~/.smac/bootstrap-peer.json (when
// deployed from another smac Host) or from local ~/.ssh/config if devices.json is empty.
function bootstrapLocalPeers() {
  const addedDevices = [];
  const devices = readDevicesRaw();
  let changed = false;

  const upsert = item => {
    if (!item || !item.host || !item.user) return null;
    const exists = devices.find(d => d && (
      d.host === item.host
      || (item.fallbackHost && (d.host === item.fallbackHost || d.fallbackHost === item.fallbackHost))
      || (d.fallbackHost && d.fallbackHost === item.host)
    ));
    if (exists) return exists;
    const keyPath = expandHome(item.keyPath || '');
    if (item.auth !== 'password' && (!keyPath || !fs.existsSync(keyPath))) return null;
    const now = new Date().toISOString();
    const dev = {
      id: crypto.randomUUID(),
      name: String(item.name || item.host).slice(0, 38),
      host: String(item.host).trim(),
      fallbackHost: String(item.fallbackHost || '').trim(),
      port: Number(item.port) || 22,
      user: String(item.user).trim(),
      auth: item.auth === 'password' ? 'password' : 'key',
      keyPath,
      password: '',
      hostFingerprint: '',
      os: String(item.os || ''),
      guestEnv: null,
      createdAt: now,
      updatedAt: now,
      lastConnectedAt: '',
      lastError: ''
    };
    devices.push(dev);
    addedDevices.push(dev.name);
    changed = true;
    return dev;
  };

  // 1. Optional bootstrap manifest written during deployment from an existing smac Host
  const bootstrap = readJson(BOOTSTRAP_FILE);
  if (bootstrap && Array.isArray(bootstrap.peers)) {
    for (const peer of bootstrap.peers) {
      upsert(peer);
    }
  }

  if (changed) {
    saveDevicesRaw(devices);
    const cfg = readConfigRaw();
    if (!cfg.host && devices.length) {
      const first = devices[0];
      cfg.defaultDeviceId = first.id;
      cfg.host = first.fallbackHost || first.host;
      cfg.lanHost = first.fallbackHost ? first.host : '';
      cfg.user = first.user;
      cfg.port = first.port || 22;
      cfg.key = first.keyPath || '';
      writeJson(CONFIG_FILE, cfg);
    }
  }
  return addedDevices;
}

function buildMetaScripts() {
  const defaultNwid = zerotier.getConfiguredNetworkId();
  const winScript = [
    "$ErrorActionPreference='SilentlyContinue'",
    "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)",
    "$dir = Join-Path $env:USERPROFILE '.smac'",
    "$cf = Join-Path $dir 'config.json'; $df = Join-Path $dir 'devices.json'",
    "if (-not (Test-Path -LiteralPath $cf)) { 'SMAC_PEER_NONE'; exit 0 }",
    "$c = Get-Content -LiteralPath $cf -Raw -Encoding UTF8 | ConvertFrom-Json",
    "$ztNwid = if ($c.zerotierNetworkId) { [string]$c.zerotierNetworkId } else { '" + defaultNwid + "' }",
    "$ztIp = ''; $ztNode = ''",
    "foreach ($zp in @('C:\\ProgramData\\ZeroTier\\One\\zerotier-one_x64.exe','C:\\Program Files (x86)\\ZeroTier\\One\\zerotier-one_x64.exe','C:\\Program Files\\ZeroTier\\One\\zerotier-one_x64.exe')) {",
    "  if (Test-Path -LiteralPath $zp) {",
    "    $ir = (& $zp -q info 2>&1 | Out-String); if ($ir -match '200\\s+info\\s+([0-9a-f]{10})') { $ztNode = $Matches[1].ToLower() }",
    "    $nr = (& $zp -q -j listnetworks 2>&1 | Out-String).Trim()",
    "    if ($ztNwid -and $nr.StartsWith('[')) { try { $hit = @($nr | ConvertFrom-Json | Where-Object { ([string]$_.nwid).ToLower() -eq $ztNwid.ToLower() }) | Select-Object -First 1; if ($hit -and $hit.status -eq 'OK') { foreach ($a in @($hit.assignedAddresses)) { $cand = ([string]$a).Split('/')[0]; if ($cand -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$') { $ztIp = $cand; break } } } } catch {} }",
    "    break",
    "  }",
    "}",
    "$devs = @()",
    "if (Test-Path -LiteralPath $df) {",
    "  $rawD = Get-Content -LiteralPath $df -Raw -Encoding UTF8 | ConvertFrom-Json",
    "  $arr = if ($rawD.devices) { $rawD.devices } else { $rawD }",
    "  foreach ($d in @($arr)) { if ($d -and $d.id) { $devs += @{ id=[string]$d.id; name=[string]$d.name; host=[string]$d.host; fallbackHost=[string]$d.fallbackHost; port=([int]$d.port); user=[string]$d.user; os=[string]$d.os; auth=[string]$d.auth; zerotierIp=[string]$d.zerotierIp; zerotierNodeId=[string]$d.zerotierNodeId; zerotierStatus=[string]$d.zerotierStatus } } }",
    "}",
    "$pairs = @()",
    "foreach ($p in @($c.syncPairs)) { if ($p -and $p.name) { $pairs += @{ name=[string]$p.name; local=[string]$p.local; remote=[string]$p.remote; deviceId=[string]$p.deviceId; enabled=($p.enabled -ne $false); propagateDeletes=($p.propagateDeletes -ne $false) } } }",
    "$lanIp = ''; $tsIp = ''",
    "foreach ($a in @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)) {",
    "  $ip = [string]$a.IPAddress",
    "  if ($ip -like '127.*' -or $ip -like '169.254.*' -or $ip -like '198.18.*' -or $ip -like '198.19.*') { continue }",
    "  if ($ip -match '^100\\.(6[4-9]|[7-9]\\d|1[0-1]\\d|12[0-7])\\.') { if (-not $tsIp) { $tsIp = $ip } }",
    "  elseif ($ip -match '^192\\.168\\.' -and -not $ip.EndsWith('.1')) { if (-not $lanIp) { $lanIp = $ip } }",
    "}",
    "$out = @{ ok=$true; hostname=$env:COMPUTERNAME; user=$env:USERNAME; os='Windows'; host=[string]$c.host; lanHost=[string]$c.lanHost; defaultUser=[string]$c.user; peerLanIp=$lanIp; peerTailscaleIp=$tsIp; zerotierNetworkId=$ztNwid; zerotierIp=$ztIp; zerotierNodeId=$ztNode; syncPairs=$pairs; devices=$devs }",
    "'SMAC_PEER_META ' + ($out | ConvertTo-Json -Depth 6 -Compress)"
  ].join('\n');
  const posixScript = [
    'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.hermes/node/bin:$PATH"',
    'if [ ! -f "$HOME/.smac/config.json" ]; then echo SMAC_PEER_NONE; exit 0; fi',
    'node -e \'const fs=require("fs"),os=require("os"),cp=require("child_process"),p=os.homedir()+"/.smac";const rj=f=>{try{return JSON.parse(fs.readFileSync(f,"utf8").replace(/^\\uFEFF/,""))}catch{return null}};const c=rj(p+"/config.json")||{};const nwid=String(c.zerotierNetworkId||"' + defaultNwid + '").toLowerCase();let ztIp="",ztNode="";try{const cli=["/usr/local/bin/zerotier-cli","/opt/homebrew/bin/zerotier-cli","/usr/sbin/zerotier-cli"].find(x=>fs.existsSync(x));if(cli){const ir=cp.spawnSync(cli,["info"],{encoding:"utf8",timeout:3000}).stdout||"";const im=/200\\s+info\\s+([0-9a-f]{10})/i.exec(ir);if(im)ztNode=im[1].toLowerCase();const nr=cp.spawnSync(cli,["-j","listnetworks"],{encoding:"utf8",timeout:3000}).stdout||"";const arr=JSON.parse(nr);const hit=nwid?(arr||[]).find(x=>String(x.nwid||x.id||"").toLowerCase()===nwid&&x.status==="OK"):null;if(hit){for(const a of (hit.assignedAddresses||[])){const cand=String(a).split("/")[0];if(/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(cand)){ztIp=cand;break;}}}}}catch{}const rd=rj(p+"/devices.json");const arr=Array.isArray(rd)?rd:(rd&&rd.devices)||[];const devs=arr.filter(d=>d&&d.id).map(d=>({id:String(d.id),name:String(d.name||""),host:String(d.host||""),fallbackHost:String(d.fallbackHost||""),port:Number(d.port)||22,user:String(d.user||""),os:String(d.os||""),auth:String(d.auth||"key"),zerotierIp:String(d.zerotierIp||""),zerotierNodeId:String(d.zerotierNodeId||""),zerotierStatus:String(d.zerotierStatus||"")}));const pairs=(Array.isArray(c.syncPairs)?c.syncPairs:[]).filter(x=>x&&x.name).map(x=>({name:String(x.name),local:String(x.local||""),remote:String(x.remote||""),deviceId:String(x.deviceId||""),enabled:x.enabled!==false,propagateDeletes:x.propagateDeletes!==false}));console.log("SMAC_PEER_META "+JSON.stringify({ok:true,hostname:os.hostname(),user:os.userInfo().username,os:process.platform==="darwin"?"macOS":"Linux",host:String(c.host||""),lanHost:String(c.lanHost||""),defaultUser:String(c.user||""),zerotierNetworkId:nwid,zerotierIp:ztIp,zerotierNodeId:ztNode,syncPairs:pairs,devices:devs}))\''
  ].join('\n');
  return { winScript, posixScript };
}

function execOnConn(conn, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('远端命令超时'));
    }, timeoutMs || 15000);
    conn.exec(command, (err, stream) => {
      if (err) { clearTimeout(timer); done = true; reject(err); return; }
      let stdout = '';
      stream.on('data', d => { stdout += d.toString('utf8'); });
      stream.stderr.on('data', () => { });
      stream.on('close', code => {
        clearTimeout(timer);
        if (done) return;
        done = true;
        resolve({ code: Number.isFinite(code) ? code : 0, stdout });
      });
      stream.on('error', e => {
        clearTimeout(timer);
        if (done) return;
        done = true;
        reject(e);
      });
    });
  });
}

async function probeSshCandidateForSmac(candidate, connectTimeoutMs) {
  let connected;
  try {
    connected = await sshDial.connect(candidate, { connectTimeoutMs: connectTimeoutMs || 3500 });
  } catch {
    return null;
  }
  const { conn, jumpConn, host } = connected;
  try {
    let osName = 'posix';
    try {
      const u = await execOnConn(conn, 'uname -s 2>/dev/null || echo unknown', 5000);
      const t = String(u.stdout || '').trim().split(/\r?\n/)[0] || '';
      if (/MINGW|MSYS|CYGWIN/i.test(t)) osName = 'windows';
      else if (!/linux|darwin|bsd/i.test(t)) {
        const psCmd = 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '
          + Buffer.from("if ($env:OS -eq 'Windows_NT') { 'SMAC_OS_WINDOWS' }", 'utf16le').toString('base64');
        const w = await execOnConn(conn, psCmd, 8000);
        if (/SMAC_OS_WINDOWS/.test(w.stdout)) osName = 'windows';
      }
    } catch { }

    const { winScript, posixScript } = buildMetaScripts();
    const cmd = osName === 'windows'
      ? ('powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '
        + Buffer.from(winScript, 'utf16le').toString('base64'))
      : ('echo ' + Buffer.from(posixScript, 'utf8').toString('base64') + ' | openssl base64 -d -A | sh');
    const res = await execOnConn(conn, cmd, 15000);
    const line = String(res.stdout || '').split(/\r?\n/).map(s => s.trim()).find(s => s.startsWith('SMAC_PEER_META '));
    if (!line) return null;
    return Object.assign(JSON.parse(line.slice('SMAC_PEER_META '.length)), { remoteOs: osName, connectedHost: host });
  } catch {
    return null;
  } finally {
    try { conn.end(); } catch { }
    try { if (jumpConn) jumpConn.end(); } catch { }
  }
}

// Probe ~/.ssh/config entries that aren't in devices.json yet, and ONLY persist
// hosts that actually have ~/.smac/config.json (never polluting devices.json with
// unrelated VPS / server entries).
async function discoverPairedPeersFromSshConfig() {
  const addedDevices = [];
  const addedIds = [];
  const existing = readDevicesRaw();
  const sshHosts = parseSshConfigHosts();
  if (!sshHosts.length) return { addedDevices, addedIds };

  const peerKey = path.join(USER_HOME, '.ssh', 'smac_peer_ed25519');
  const edKey = path.join(USER_HOME, '.ssh', 'id_ed25519');
  const rsaKey = path.join(USER_HOME, '.ssh', 'id_rsa');

  for (const entry of sshHosts) {
    if (!entry.hostName || !entry.user) continue;
    const already = existing.some(d => d && (d.host === entry.hostName || d.fallbackHost === entry.hostName));
    if (already) continue;

    const candidateKeys = [];
    if (entry.identityFile && fs.existsSync(entry.identityFile) && !candidateKeys.includes(entry.identityFile)) {
      candidateKeys.push(entry.identityFile);
    }
    for (const fallbackKey of [peerKey, edKey, rsaKey]) {
      if (fs.existsSync(fallbackKey) && !candidateKeys.includes(fallbackKey)) {
        candidateKeys.push(fallbackKey);
      }
    }
    if (!candidateKeys.length) continue;

    for (const keyPath of candidateKeys) {
      const meta = await probeSshCandidateForSmac({
        id: 'probe-' + entry.alias,
        name: entry.alias,
        host: entry.hostName,
        port: entry.port || 22,
        user: entry.user,
        auth: 'key',
        keyPath
      }, 3500);
      if (meta && meta.ok) {
        const now = new Date().toISOString();
        const dev = {
          id: crypto.randomUUID(),
          name: String(entry.alias || meta.hostname || entry.hostName).slice(0, 38),
          host: entry.hostName,
          fallbackHost: '',
          port: entry.port || 22,
          user: entry.user,
          auth: 'key',
          keyPath,
          password: '',
          hostFingerprint: '',
          os: String(meta.os || (/^win/i.test(entry.alias) ? 'Windows' : '')),
          jumpDeviceId: '',
          guestEnv: null,
          createdAt: now,
          updatedAt: now,
          lastConnectedAt: now,
          lastError: ''
        };
        existing.push(dev);
        saveDevicesRaw(existing);
        addedDevices.push(dev.name);
        addedIds.push(dev.id);
        break;
      }
    }
  }
  return { addedDevices, addedIds };
}

// Fetch ONLY non-secret sync metadata from a remote peer's ~/.smac directory.
async function fetchRemoteSmacMetadata(device) {
  const probe = await bridge({ op: 'probe', deviceId: device.id, connectTimeoutMs: 4500, timeoutMs: 12000 }, 16000);
  const osName = probe.os === 'windows' ? 'windows' : 'posix';
  const { winScript, posixScript } = buildMetaScripts();
  const script = osName === 'windows' ? winScript : posixScript;
  const res = await bridge({ op: 'exec', deviceId: device.id, os: osName, script, connectTimeoutMs: 6000, timeoutMs: 25000 }, 30000);
  const line = String(res.stdout || '').split(/\r?\n/).map(s => s.trim()).find(s => s.startsWith('SMAC_PEER_META '));
  if (!line) return null;
  try {
    return Object.assign(JSON.parse(line.slice('SMAC_PEER_META '.length)), { remoteOs: osName, connectedHost: probe.host });
  } catch {
    return null;
  }
}

async function reflectFromDevice(deviceId) {
  const devices = readDevicesRaw();
  const device = devices.find(d => d && d.id === deviceId);
  if (!device) return { matched: false, error: '设备不存在', addedPairs: [], updatedPairs: [], addedDevices: [] };
  if (remote.isSelfDevice(device)) {
    return { matched: false, error: '', addedPairs: [], updatedPairs: [], addedDevices: [] };
  }
  let localAdminNodeId = '';
  try { localAdminNodeId = fs.readFileSync(path.join(DATA_DIR, 'admin-node-id'), 'utf8').trim(); } catch { }
  if (!device.isAdminNode && ((device.hostAdminNodeId && localAdminNodeId && device.hostAdminNodeId !== localAdminNodeId) || device.handshakeStatus === 'pending' || device.handshakeStatus === 'rejected')) {
    return { matched: false, error: '', addedPairs: [], updatedPairs: [], addedDevices: [] };
  }
  if (device.auth === 'password' && !device.password) {
    return { matched: false, error: '未保存密码', addedPairs: [], updatedPairs: [], addedDevices: [] };
  }

  let meta;
  try {
    meta = await fetchRemoteSmacMetadata(device);
  } catch (err) {
    return { matched: false, error: err && err.message ? err.message : String(err), peerName: device.name, addedPairs: [], updatedPairs: [], addedDevices: [] };
  }
  if (!meta || !meta.ok) return { matched: false, error: '对端未配置 smac 同步目录', peerName: device.name, addedPairs: [], updatedPairs: [], addedDevices: [] };

  const me = guestEnv.detectNetworkAndMachine();
  let localZt = null;
  try { localZt = zerotier.getLocalStatus(); } catch { }
  const myIps = new Set([
    ...(me.lanIps || []),
    ...(me.tailscaleIps || []),
    ...(me.zerotierIps || []),
    ...(me.meshIps || []),
    ...(me.publicIps || []),
    ...(localZt && localZt.ip ? [localZt.ip] : [])
  ].filter(Boolean));
  const myUser = String(me.user || '').toLowerCase();
  const myHost = String(me.hostname || '').toLowerCase().replace(/\.local$/, '');

  const isTargetMe = (hostA, hostB, hostC, targetUser, targetName, remotePathOnTarget) => {
    if (hostA && myIps.has(hostA)) return true;
    if (hostB && myIps.has(hostB)) return true;
    if (hostC && myIps.has(hostC)) return true;
    const tName = String(targetName || '').toLowerCase().replace(/\.local$/, '');
    if (tName && myHost && tName === myHost) return true;
    if (targetUser && myUser && String(targetUser).toLowerCase() === myUser) {
      const expanded = expandHome(remotePathOnTarget);
      if (expanded && (fs.existsSync(expanded) || fs.existsSync(path.dirname(expanded)))) return true;
    }
    return false;
  };

  const cfg = readConfigRaw();
  const addedPairs = [];
  const updatedPairs = [];
  const addedDevices = [];
  let configChanged = false;
  let devicesChanged = false;

  // Update device OS & ZeroTier mesh metadata from the paired peer
  if (meta.os && !device.os) {
    device.os = meta.os;
    devicesChanged = true;
  }
  if (meta.zerotierNetworkId && !cfg.zerotierNetworkId) {
    cfg.zerotierNetworkId = String(meta.zerotierNetworkId).trim().toLowerCase();
    configChanged = true;
  }
  if (meta.zerotierNodeId && device.zerotierNodeId !== meta.zerotierNodeId) {
    device.zerotierNodeId = meta.zerotierNodeId;
    devicesChanged = true;
  }
  if (meta.peerLanIp && /^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(meta.peerLanIp)) {
    const isCurrentLan = /^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(device.host || '');
    if (!isCurrentLan) {
      if (device.host && !device.fallbackHost) device.fallbackHost = device.host;
      device.host = meta.peerLanIp;
      devicesChanged = true;
    }
  }
  if (meta.peerTailscaleIp && device.host !== meta.peerTailscaleIp && device.fallbackHost !== meta.peerTailscaleIp) {
    if (!device.fallbackHost) {
      device.fallbackHost = meta.peerTailscaleIp;
      devicesChanged = true;
    }
  }
  if (meta.zerotierIp) {
    if (device.zerotierIp !== meta.zerotierIp) {
      device.zerotierIp = meta.zerotierIp;
      device.zerotierStatus = 'OK';
      device.zerotierNetworkId = meta.zerotierNetworkId || cfg.zerotierNetworkId || zerotier.DEFAULT_NETWORK_ID;
      devicesChanged = true;
    }
  }

  // 1. Reflect every direct syncPair on the peer that targets THIS machine
  const targetCanonicalId = resolveCanonicalDeviceId(device.id, cfg, devices);
  const reflectedLocalByPeerLocal = new Map();
  for (const p of (Array.isArray(meta.syncPairs) ? meta.syncPairs : [])) {
    if (!p || !p.local || !p.remote) continue;
    let matchesMe = false;
    if (!p.deviceId) {
      matchesMe = isTargetMe(meta.host, meta.lanHost, '', meta.defaultUser, '', p.remote);
    } else {
      const targetDev = (meta.devices || []).find(d => d && d.id === p.deviceId);
      if (targetDev) {
        matchesMe = isTargetMe(targetDev.host, targetDev.fallbackHost, targetDev.zerotierIp, targetDev.user, targetDev.name, p.remote);
      }
    }
    if (!matchesMe) continue;

    const myLocal = resolveActualLocalPath(p.remote);
    const myRemote = String(p.local).trim().replace(/\\/g, '/');
    if (!myLocal || !myRemote) continue;
    reflectedLocalByPeerLocal.set(normPath(myRemote), myLocal);

    // Match existing pair by local path + canonical target device (treating empty deviceId as the default Mac device!)
    const existingSameTarget = cfg.syncPairs.find(existing => existing
      && normPath(existing.local) === normPath(myLocal)
      && resolveCanonicalDeviceId(existing.deviceId, cfg, devices) === targetCanonicalId);
    if (existingSameTarget) {
      if (!existingSameTarget.peerRemotes || typeof existingSameTarget.peerRemotes !== 'object') {
        existingSameTarget.peerRemotes = {};
      }
      if (existingSameTarget.peerRemotes[device.id] !== myRemote) {
        existingSameTarget.peerRemotes[device.id] = myRemote;
        configChanged = true;
        updatedPairs.push(existingSameTarget.name);
      }
      if (existingSameTarget.autoPaired && existingSameTarget.remote !== myRemote) {
        existingSameTarget.remote = myRemote;
        configChanged = true;
        if (!updatedPairs.includes(existingSameTarget.name)) updatedPairs.push(existingSameTarget.name);
      }
      continue;
    }

    let pairName = String(p.name || path.basename(myLocal) || 'sync').trim();
    if (cfg.syncPairs.some(existing => existing && existing.name === pairName)) {
      pairName = pairName + '-' + (device.name || 'peer');
    }
    cfg.syncPairs.push({
      name: pairName,
      local: myLocal,
      remote: myRemote,
      deviceId: device.id,
      enabled: p.enabled !== false,
      propagateDeletes: p.propagateDeletes !== false,
      autoPaired: true
    });
    addedPairs.push(pairName);
    configChanged = true;
  }

  // 2. If THIS machine also has the shared smac_peer_ed25519 key, reflect other
  // key-authenticated Guests paired on the remote peer (e.g. `game`) so this
  // Host can also reach them seamlessly!
  const peerKeyPath = path.join(USER_HOME, '.ssh', 'smac_peer_ed25519');
  if (fs.existsSync(peerKeyPath)) {
    for (const remoteDev of (Array.isArray(meta.devices) ? meta.devices : [])) {
      if (!remoteDev || !remoteDev.host || !remoteDev.user) continue;
      // Skip self!
      if (myIps.has(remoteDev.host) || (remoteDev.fallbackHost && myIps.has(remoteDev.fallbackHost)) || (remoteDev.zerotierIp && myIps.has(remoteDev.zerotierIp)) || remote.isSelfDevice(remoteDev)) continue;
      if (remoteDev.auth !== 'key') continue;
      let localGuest = devices.find(d => d && (
        remote.devicesMatchSameMachine(d, remoteDev)
        || (d.name && remoteDev.name && d.name.toLowerCase() === remoteDev.name.toLowerCase())
      ));
      if (!localGuest) {
        const now = new Date().toISOString();
        localGuest = {
          id: crypto.randomUUID(),
          name: remoteDev.name || remoteDev.host,
          host: remoteDev.host,
          fallbackHost: remoteDev.fallbackHost || '',
          port: Number(remoteDev.port) || 22,
          user: remoteDev.user,
          auth: 'key',
          keyPath: peerKeyPath,
          password: '',
          hostFingerprint: '',
          os: remoteDev.os || '',
          jumpDeviceId: device.id,
          zerotierIp: remoteDev.zerotierIp || '',
          zerotierNodeId: remoteDev.zerotierNodeId || '',
          zerotierStatus: remoteDev.zerotierStatus || '',
          zerotierNetworkId: meta.zerotierNetworkId || cfg.zerotierNetworkId || '',
          guestEnv: null,
          createdAt: now,
          updatedAt: now,
          lastConnectedAt: '',
          lastError: ''
        };
        devices.push(localGuest);
        addedDevices.push(localGuest.name);
        devicesChanged = true;
      } else {
        if (!localGuest.jumpDeviceId && localGuest.id !== device.id) {
          localGuest.jumpDeviceId = device.id;
          devicesChanged = true;
        }
        if (remoteDev.zerotierIp && localGuest.zerotierIp !== remoteDev.zerotierIp) {
          localGuest.zerotierIp = remoteDev.zerotierIp;
          localGuest.zerotierNodeId = remoteDev.zerotierNodeId || localGuest.zerotierNodeId || '';
          localGuest.zerotierStatus = remoteDev.zerotierStatus || 'OK';
          localGuest.zerotierNetworkId = meta.zerotierNetworkId || cfg.zerotierNetworkId || '';
          devicesChanged = true;
        }
      }
      // Record transitive guest folder paths in primaryPair.peerRemotes[localGuest.id]
      // instead of creating duplicate sync folder cards!
      for (const gp of (Array.isArray(meta.syncPairs) ? meta.syncPairs : [])) {
        if (!gp || gp.deviceId !== remoteDev.id) continue;
        const mappedLocal = reflectedLocalByPeerLocal.get(normPath(gp.local));
        if (!mappedLocal) continue;
        const guestRemote = String(gp.remote || '').trim().replace(/\\/g, '/');
        if (!guestRemote) continue;
        const primaryPair = cfg.syncPairs.find(existing => existing && normPath(existing.local) === normPath(mappedLocal));
        if (primaryPair) {
          if (!primaryPair.peerRemotes || typeof primaryPair.peerRemotes !== 'object') {
            primaryPair.peerRemotes = {};
          }
          if (primaryPair.peerRemotes[localGuest.id] !== guestRemote) {
            primaryPair.peerRemotes[localGuest.id] = guestRemote;
            configChanged = true;
          }
        }
      }
    }
  }

  if (dedupeSyncPairs(cfg, devices)) {
    configChanged = true;
  }

  if (!cfg.host && device.host) {
    cfg.defaultDeviceId = device.id;
    cfg.host = device.fallbackHost || device.host;
    cfg.lanHost = device.fallbackHost ? device.host : '';
    cfg.user = device.user;
    cfg.port = device.port || 22;
    cfg.key = device.keyPath || '';
    configChanged = true;
  }

  if (devicesChanged) saveDevicesRaw(devices);
  if (configChanged) writeJson(CONFIG_FILE, cfg);

  return {
    matched: true,
    error: '',
    peerName: device.name,
    peerHostname: meta.hostname,
    addedPairs,
    updatedPairs,
    addedDevices
  };
}

function resolveCanonicalDeviceId(pairDeviceId, cfg, devices) {
  const id = String(pairDeviceId || '').trim();
  const list = Array.isArray(devices) ? devices : [];
  if (id) {
    const match = list.find(d => d && d.id === id);
    if (match) return match.id;
    return id;
  }
  const host = String((cfg && cfg.host) || '').trim();
  const lanHost = String((cfg && cfg.lanHost) || '').trim();
  const defId = String((cfg && cfg.defaultDeviceId) || '').trim();
  const defMatch = list.find(d => d && (
    (defId && d.id === defId)
    || (lanHost && (d.host === lanHost || d.fallbackHost === lanHost))
    || (host && (d.host === host || d.fallbackHost === host))
    || ((host || lanHost) && String(d.name || '').trim().toLowerCase() === 'mac')
  ));
  return defMatch ? defMatch.id : '__default__';
}

function dedupeSyncPairs(cfg, devices) {
  if (!cfg || !Array.isArray(cfg.syncPairs)) return false;
  const list = Array.isArray(devices) ? devices : readDevicesRaw();
  let changed = false;

  // Pass 1: fold any autoPaired disabled transitive pair (e.g. 阅读-game on Mac) into primary.peerRemotes
  const primaryByLocal = new Map();
  for (const p of cfg.syncPairs) {
    if (!p || !p.local) continue;
    const lk = normPath(p.local);
    if (!primaryByLocal.has(lk) || (primaryByLocal.get(lk).autoPaired && !p.autoPaired)) {
      primaryByLocal.set(lk, p);
    }
  }

  const kept = [];
  const seenByTargetAndLocal = new Map();

  for (const p of cfg.syncPairs) {
    if (!p || !p.name || !p.local) { changed = true; continue; }
    const lk = normPath(p.local);
    const primary = primaryByLocal.get(lk);

    if (p.autoPaired && p.enabled === false && primary && primary !== p && p.deviceId && p.remote) {
      if (!primary.peerRemotes || typeof primary.peerRemotes !== 'object') primary.peerRemotes = {};
      primary.peerRemotes[p.deviceId] = String(p.remote).trim().replace(/\\/g, '/');
      changed = true;
      continue;
    }

    const canonDev = resolveCanonicalDeviceId(p.deviceId, cfg, list);
    const key = canonDev + '|' + lk;
    if (!seenByTargetAndLocal.has(key)) {
      seenByTargetAndLocal.set(key, p);
      kept.push(p);
    } else {
      // Duplicate pair for the same local folder and same target device (e.g. 2026研一秋季学期 vs 2026研一秋季学期-Mac)!
      const existing = seenByTargetAndLocal.get(key);
      if (existing.autoPaired && !p.autoPaired) {
        // Prefer the user-created primary pair over autoPaired duplicate
        if (existing.deviceId && existing.remote) {
          if (!p.peerRemotes || typeof p.peerRemotes !== 'object') p.peerRemotes = {};
          p.peerRemotes[existing.deviceId] = String(existing.remote).trim().replace(/\\/g, '/');
        }
        const idx = kept.indexOf(existing);
        if (idx >= 0) kept[idx] = p;
        seenByTargetAndLocal.set(key, p);
      } else if (p.deviceId && p.remote) {
        if (!existing.peerRemotes || typeof existing.peerRemotes !== 'object') existing.peerRemotes = {};
        existing.peerRemotes[p.deviceId] = String(p.remote).trim().replace(/\\/g, '/');
      }
      changed = true;
    }
  }

  if (changed) {
    cfg.syncPairs = kept;
  }
  return changed;
}

function ensureCleanSyncPairs() {
  const cfg = readJson(CONFIG_FILE);
  if (!cfg || !Array.isArray(cfg.syncPairs)) return cfg || {};
  const devices = readDevicesRaw();
  if (dedupeSyncPairs(cfg, devices)) {
    writeJson(CONFIG_FILE, cfg);
  }
  return cfg;
}

async function discoverAllPairedPeers() {
  if (discoveryRunning) return Object.assign({ ok: true, running: true }, lastDiscovery);
  discoveryRunning = true;
  try {
    let localAdminNodeId = '';
    try { localAdminNodeId = fs.readFileSync(path.join(DATA_DIR, 'admin-node-id'), 'utf8').trim(); } catch { }
    try { remote.dedupeAndPruneDevices(localAdminNodeId); } catch { }
    ensureCleanSyncPairs();
    const bootAdded = bootstrapLocalPeers();
    const currentRaw = readDevicesRaw();
    const sshAdded = currentRaw.length === 0 ? await discoverPairedPeersFromSshConfig() : { addedDevices: [], addedIds: [] };
    const devices = readDevicesRaw().filter(d => {
      if (!d || !d.id) return false;
      if (remote.isSelfDevice(d, localAdminNodeId)) return false;
      if (!d.isAdminNode && ((d.hostAdminNodeId && localAdminNodeId && d.hostAdminNodeId !== localAdminNodeId) || d.handshakeStatus === 'pending' || d.handshakeStatus === 'rejected')) return false;
      return d.auth === 'key' || Boolean(d.password);
    });
    const addedPairs = [];
    const updatedPairs = [];
    const addedDevices = [...bootAdded, ...sshAdded.addedDevices];
    const unreachable = [];
    let peersMatched = 0;

    for (const dev of devices) {
      const r = await reflectFromDevice(dev.id);
      if (r.matched) peersMatched += 1;
      else if (r.error && r.error !== '对端未配置 smac 同步目录') {
        unreachable.push({ id: dev.id, name: dev.name, error: r.error });
      }
      if (r.addedPairs && r.addedPairs.length) addedPairs.push(...r.addedPairs);
      if (r.updatedPairs && r.updatedPairs.length) updatedPairs.push(...r.updatedPairs);
      if (r.addedDevices && r.addedDevices.length) addedDevices.push(...r.addedDevices);
    }

    try { remote.dedupeAndPruneDevices(localAdminNodeId); } catch { }
    ensureCleanSyncPairs();

    lastDiscovery = {
      at: new Date().toISOString(),
      peersChecked: devices.length,
      peersMatched,
      addedPairs,
      updatedPairs,
      addedDevices,
      unreachable
    };
    return Object.assign({ ok: true }, lastDiscovery);
  } finally {
    discoveryRunning = false;
  }
}

function getLastDiscovery() {
  return lastDiscovery;
}

module.exports = {
  bootstrapLocalPeers,
  reflectFromDevice,
  discoverAllPairedPeers,
  getLastDiscovery,
  dedupeSyncPairs,
  ensureCleanSyncPairs
};
