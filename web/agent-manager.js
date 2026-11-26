'use strict';

// 控制台侧的“远程 Agent”管理器：
// 1. 通过 ssh-bridge 把 agent-server.js / path-guard.js 安装到远端用户目录；
// 2. 写入本次允许的同步目录（roots.json）并启动只监听 127.0.0.1 的远端服务；
// 3. 用 ssh2 建立 127.0.0.1:<本地端口> → 远端 127.0.0.1:<远端端口> 的隧道。
// 密码只从 devices.json 读取，不经过命令行参数。

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

let ssh2 = null;
try { ssh2 = require('ssh2'); } catch { }
const sshDial = require('./ssh-dial');

const USER_HOME = process.env.USERPROFILE || os.homedir();
const DATA_DIR = path.join(USER_HOME, '.smac');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SELECTION_FILE = path.join(DATA_DIR, 'remote-agent.json');
const CREDENTIALS_FILE = path.join(DATA_DIR, 'agent-credentials.json');
const AGENT_SRC = path.resolve(__dirname, '..', 'agent');
const BACKEND_IDS = ['dsh', 'hermes', 'codex', 'claude', 'agy', 'opencode'];
const BRIDGE = path.join(__dirname, 'ssh-bridge.js');
const BIND = '127.0.0.1';
const BASE_PORT = 8799;
const PORT_TRIES = 7;
const REMOTE_DIR_NAME = '.smac-agent';

const POSIX_PATH_EXPORT = [
  'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.gemini/bin:$HOME/.local/bin:$HOME/.hermes/node/bin:$HOME/.antigravity/antigravity/bin:$PATH"',
  'for _smac_nvm in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$_smac_nvm" ] && export PATH="$_smac_nvm:$PATH"; done'
].join('\n');

const MAC_PROXY_EXPORT = [
  'if [ -z "$HTTPS_PROXY" ] && [ -z "$https_proxy" ] && [ "$(uname -s)" = "Darwin" ]; then',
  '  _px=$(scutil --proxy 2>/dev/null || true)',
  '  _he=$(printf "%s\\n" "$_px" | awk \'$1=="HTTPSEnable"{print $3; exit}\')',
  '  _hh=$(printf "%s\\n" "$_px" | awk \'$1=="HTTPSProxy"{print $3; exit}\')',
  '  _hp=$(printf "%s\\n" "$_px" | awk \'$1=="HTTPSPort"{print $3; exit}\')',
  '  if [ "$_he" = "1" ] && [ -n "$_hh" ] && [ -n "$_hp" ]; then',
  '    export HTTPS_PROXY="http://${_hh}:${_hp}" https_proxy="http://${_hh}:${_hp}"',
  '  fi',
  '  _e1=$(printf "%s\\n" "$_px" | awk \'$1=="HTTPEnable"{print $3; exit}\')',
  '  _h1=$(printf "%s\\n" "$_px" | awk \'$1=="HTTPProxy"{print $3; exit}\')',
  '  _p1=$(printf "%s\\n" "$_px" | awk \'$1=="HTTPPort"{print $3; exit}\')',
  '  if [ "$_e1" = "1" ] && [ -n "$_h1" ] && [ -n "$_p1" ]; then',
  '    export HTTP_PROXY="http://${_h1}:${_p1}" http_proxy="http://${_h1}:${_p1}"',
  '  fi',
  'fi'
].join('\n');

let active = null;
const envCache = new Map();

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

function readDevices() {
  const data = readJson(DEVICES_FILE);
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.devices) ? data.devices : []);
  return list.filter(item => item && item.id).map(item => ({
    id: String(item.id),
    name: String(item.name || ''),
    host: String(item.host || ''),
    fallbackHost: String(item.fallbackHost || ''),
    port: Number(item.port) || 22,
    user: String(item.user || ''),
    auth: item.auth === 'password' ? 'password' : 'key',
    keyPath: String(item.keyPath || ''),
    password: typeof item.password === 'string' ? item.password : '',
    hostFingerprint: String(item.hostFingerprint || ''),
    os: String(item.os || ''),
    jumpDeviceId: String(item.jumpDeviceId || ''),
    zerotierIp: String(item.zerotierIp || ''),
    isAdminNode: Boolean(item.isAdminNode),
    hostAdminNodeId: String(item.hostAdminNodeId || ''),
    hostAdminName: String(item.hostAdminName || ''),
    handshakeStatus: String(item.handshakeStatus || 'connected'),
    guestEnv: item.guestEnv && typeof item.guestEnv === 'object' ? item.guestEnv : null
  }));
}

function saveDeviceGuestEnv(deviceId, envData) {
  try {
    const raw = readJson(DEVICES_FILE);
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.devices) ? raw.devices : []);
    const idx = list.findIndex(item => item && item.id === deviceId);
    if (idx >= 0) {
      list[idx].guestEnv = envData;
      if (envData && envData.machine && envData.machine.osLabel) {
        list[idx].os = envData.machine.osLabel;
      }
      writeJson(DEVICES_FILE, { version: 1, devices: list });
    }
  } catch { }
}

function findDevice(deviceId) {
  return readDevices().find(item => item.id === deviceId) || null;
}

function syncPairs() {
  const config = readJson(CONFIG_FILE) || {};
  return Array.isArray(config.syncPairs) ? config.syncPairs : [];
}

function normLocalKey(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isDefaultMacDevice(device, config) {
  if (!device || !config) return false;
  const host = String(config.host || '').trim();
  const lanHost = String(config.lanHost || '').trim();
  if (config.defaultDeviceId && device.id === config.defaultDeviceId) return true;
  if (lanHost && (device.host === lanHost || device.fallbackHost === lanHost)) return true;
  if (host && (device.host === host || device.fallbackHost === host)) return true;
  if ((host || lanHost) && String(device.name || '').trim().toLowerCase() === 'mac') return true;
  return false;
}

function toPortableRemotePath(rawRemote, fallbackFolderName) {
  const text = String(rawRemote || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!text) return '~/Documents/' + (fallbackFolderName || 'sync');
  if (text === '~' || text.startsWith('~/')) return text;
  const m = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)\/(.+)$/i.exec(text);
  if (m && m[1]) return '~/' + m[1];
  return '~/Documents/' + (fallbackFolderName || path.basename(text) || 'sync');
}

function pairsForDevice(deviceId) {
  const id = String(deviceId || '').trim();
  if (!id) return [];
  const config = readJson(CONFIG_FILE) || {};
  const devices = readDevices();
  const device = devices.find(d => d.id === id) || null;
  const allPairs = syncPairs().filter(pair => pair && pair.name && pair.local);
  const isDefMac = isDefaultMacDevice(device, config);

  const isDirectMatch = pair => {
    const pid = String(pair.deviceId || '').trim();
    if (pid === id) return true;
    if (!pid && isDefMac) return true;
    return false;
  };

  // Group all syncPairs by normalized local folder path so each bidirectional folder
  // is listed once and automatically resolves its target path on ANY selected guest device.
  const groups = new Map();
  for (const pair of allPairs) {
    const key = normLocalKey(pair.local) || String(pair.name).toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, { primary: pair, list: [] });
    }
    const g = groups.get(key);
    g.list.push(pair);
    // Prefer the non-autoPaired / unsuffixed pair as primary label
    if (g.primary.autoPaired && !pair.autoPaired) {
      g.primary = pair;
    } else if (String(pair.name).length < String(g.primary.name).length && !pair.autoPaired) {
      g.primary = pair;
    }
  }

  const out = [];
  for (const [, g] of groups) {
    const primary = g.primary;
    const folderBase = path.basename(String(primary.local || '').replace(/[\\/]+$/, '')) || primary.name;
    let remotePath = '';

    // 1. Direct pair targeting this deviceId (or empty deviceId when device is default Mac)
    const direct = g.list.find(isDirectMatch);
    if (direct && direct.remote) {
      remotePath = String(direct.remote).trim();
    }
    // 2. Explicit peerRemotes mapping saved by peer-discovery
    if (!remotePath) {
      for (const p of g.list) {
        if (p.peerRemotes && typeof p.peerRemotes === 'object' && p.peerRemotes[id]) {
          remotePath = String(p.peerRemotes[id]).trim();
          break;
        }
      }
    }
    // 3. Fallback: portable ~/... path so any bidirectional sync folder can be used on any guest
    if (!remotePath) {
      remotePath = toPortableRemotePath(primary.remote, folderBase);
    }

    out.push({
      name: String(primary.name),
      local: String(primary.local || ''),
      remote: remotePath,
      deviceId: id
    });
  }
  return out;
}

function selection() {
  return readJson(SELECTION_FILE) || {};
}

function saveSelection(patch) {
  const current = selection();
  writeJson(SELECTION_FILE, Object.assign({}, current, patch, { updatedAt: new Date().toISOString() }));
}

function normalizeBackend(value) {
  const id = String(value || '').trim().toLowerCase();
  return BACKEND_IDS.includes(id) ? id : 'hermes';
}

// Access-style bindings are kept only in the local console data directory.
// They are uploaded to the remote home right before the agent starts and are
// never included in API responses or the remote roots.json.
function readCredentialStore() {
  const data = readJson(CREDENTIALS_FILE);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function cleanCredentialFields(source, fields) {
  const input = source && typeof source === 'object' ? source : {};
  const out = {};
  fields.forEach(field => {
    if (typeof input[field] === 'string') { out[field] = input[field].trim(); }
  });
  return out;
}

function credentialsFor(deviceId) {
  const entry = readCredentialStore()[deviceId];
  const data = entry && typeof entry === 'object' ? entry : {};
  return {
    claude: Object.assign({ apiKey: '', oauthToken: '', baseUrl: '' },
      cleanCredentialFields(data.claude, ['apiKey', 'oauthToken', 'baseUrl'])),
    agy: Object.assign({ apiKey: '', baseUrl: '' },
      cleanCredentialFields(data.agy, ['apiKey', 'baseUrl']))
  };
}

function publicCredentials(deviceId) {
  const creds = credentialsFor(deviceId);
  return {
    claude: {
      bound: Boolean(creds.claude.apiKey || creds.claude.oauthToken),
      hasApiKey: Boolean(creds.claude.apiKey),
      hasOauthToken: Boolean(creds.claude.oauthToken),
      baseUrl: creds.claude.baseUrl || ''
    },
    agy: {
      bound: Boolean(creds.agy.apiKey),
      hasApiKey: Boolean(creds.agy.apiKey),
      baseUrl: creds.agy.baseUrl || ''
    }
  };
}

function saveCredentials(deviceId, patch) {
  if (!deviceId) { throw new Error('缺少设备'); }
  const store = readCredentialStore();
  const current = store[deviceId] && typeof store[deviceId] === 'object' ? store[deviceId] : {};
  const next = {
    claude: Object.assign({ apiKey: '', oauthToken: '', baseUrl: '' },
      cleanCredentialFields(current.claude, ['apiKey', 'oauthToken', 'baseUrl'])),
    agy: Object.assign({ apiKey: '', baseUrl: '' },
      cleanCredentialFields(current.agy, ['apiKey', 'baseUrl']))
  };
  const incoming = patch && typeof patch === 'object' ? patch : {};
  ['claude', 'agy'].forEach(backend => {
    const raw = incoming[backend];
    if (!raw || typeof raw !== 'object') { return; }
    if (raw.clear) {
      Object.keys(next[backend]).forEach(key => { next[backend][key] = ''; });
      return;
    }
    Object.keys(next[backend]).forEach(key => {
      if (typeof raw[key] !== 'string') { return; }
      const value = raw[key].trim();
      if (value) { next[backend][key] = value; }
      else if (raw.clearEmptyFields) { next[backend][key] = ''; }
    });
  });
  store[deviceId] = next;
  writeJson(CREDENTIALS_FILE, store);
  try { fs.chmodSync(CREDENTIALS_FILE, 0o600); } catch { }
  return publicCredentials(deviceId);
}

function forwardSlash(value) {
  return String(value || '').replace(/\\/g, '/');
}

function trace(label) {
  if (process.env.SMAC_AGENT_TRACE === '1') { console.error('[agent] ' + label); }
}

function bridge(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    trace('bridge ' + String(request.op || '') + ' start');
    const started = Date.now();
    const child = spawn(process.execPath, [BRIDGE], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) { return; }
      done = true;
      try { child.kill(); } catch { }
      reject(new Error('SSH 桥接超时'));
    }, Number(timeoutMs) || 120000);
    child.stdout.on('data', chunk => { out += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { err += chunk.toString('utf8'); });
    child.on('error', error => {
      if (done) { return; }
      done = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', () => {
      if (done) { return; }
      done = true;
      clearTimeout(timer);
      trace('bridge ' + String(request.op || '') + ' done ' + (Date.now() - started) + 'ms');
      const line = out.split(/\r?\n/).map(text => text.trim()).filter(Boolean).pop();
      if (!line) { reject(new Error(err.trim() || 'SSH 桥接无输出')); return; }
      let payload;
      try { payload = JSON.parse(line); }
      catch { reject(new Error('SSH 桥接返回格式错误: ' + line.slice(0, 200))); return; }
      if (!payload.ok) {
        const detail = String(payload.error || '').trim()
          || String(payload.stderr || payload.stdout || '').trim().slice(0, 300)
          || 'SSH 操作失败';
        reject(new Error(detail + ' [' + String(request.op || 'exec') + ']'));
        return;
      }
      resolve(payload);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function connectTunnelDevice(device) {
  trace('tunnel connect ' + device.host + (device.jumpDeviceId ? ' (jump=' + device.jumpDeviceId + ')' : ''));
  return sshDial.connect(device, { connectTimeoutMs: 20000 });
}

function remoteScript(osName, script) {
  return bridge({ op: 'exec', deviceId: activeDeviceId, os: osName, script, timeoutMs: 120000 });
}

let activeDeviceId = '';

async function remoteDir(device, osName) {
  const script = osName === 'windows'
    ? "$p = Join-Path $env:USERPROFILE '" + REMOTE_DIR_NAME + "'; New-Item -ItemType Directory -Force -Path $p | Out-Null; $p.Replace('\\','/')"
    : "mkdir -p \"$HOME/" + REMOTE_DIR_NAME + "\" && printf '%s\\n' \"$HOME/" + REMOTE_DIR_NAME + "\"";
  const result = await remoteScript(osName, script);
  const text = String(result.stdout || '').trim().split(/\r?\n/).pop();
  if (!text) { throw new Error('无法确定远端 Agent 目录'); }
  return text.replace(/\/+$/, '');
}

async function uploadFile(device, osName, local, remote) {
  await bridge({
    op: 'upload',
    deviceId: device.id,
    os: osName,
    local,
    remote: forwardSlash(remote),
    timeoutMs: 120000
  });
}

async function removeRemoteFile(osName, remote) {
  const safe = forwardSlash(remote);
  const script = osName === 'windows'
    ? "try { Remove-Item -LiteralPath '" + safe.replace(/'/g, "''") + "' -Force -ErrorAction Stop } catch { }; 'SMAC_OK'"
    : "rm -f '" + safe.replace(/'/g, "'\\''") + "' 2>/dev/null; echo SMAC_OK";
  await remoteScript(osName, script);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readServerFile(osName, dir) {
  const temp = path.join(os.tmpdir(), 'smac-agent-server-' + crypto.randomBytes(4).toString('hex') + '.json');
  try {
    await bridge({
      op: 'download',
      deviceId: activeDeviceId,
      os: osName,
      remote: forwardSlash(dir) + '/server.json',
      local: temp,
      timeoutMs: 60000
    });
    const data = readJson(temp);
    if (!data || !data.port || !data.token) { return null; }
    return data;
  } catch {
    return null;
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { }
  }
}

function writeRootsFile(device, roots, provider, model, backend) {
  const payload = {
    device: device.name,
    backend: normalizeBackend(backend),
    roots: roots.map(root => ({ label: root.label, path: root.path })),
    provider: provider || '',
    model: model || '',
    timeoutSeconds: 900,
    updatedAt: new Date().toISOString()
  };
  const temp = path.join(os.tmpdir(), 'smac-agent-roots-' + crypto.randomBytes(4).toString('hex') + '.json');
  fs.writeFileSync(temp, JSON.stringify(payload, null, 2), 'utf8');
  return { temp, payload };
}

function startRemote(osName, dir) {
  const remoteDirPath = forwardSlash(dir);
  const script = osName === 'windows'
    ? [
      "$ErrorActionPreference='Stop'",
      "$dir = Join-Path $env:USERPROFILE '" + REMOTE_DIR_NAME + "'",
      "$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source",
      "if (-not $node) { $cand = Join-Path $env:LOCALAPPDATA 'hermes\\node\\node.exe'; if (Test-Path -LiteralPath $cand) { $node = $cand } }",
      "if (-not $node) { throw '远端未找到 node.exe' }",
      "$logDir = Join-Path $dir 'logs'",
      "New-Item -ItemType Directory -Force -Path $logDir | Out-Null",
      "$cmdFile = Join-Path $dir 'run-agent.cmd'",
      "$cmdBody = \"@echo off`r`nset SSH_CONNECTION=`r`nset SSH_CLIENT=`r`nset SSH_TTY=`r`ncd /d `\"%~dp0`\"`r`n`\"$node`\" agent-server.js --port 8799 > logs\\server.log 2> logs\\server.err.log`r`n\"",
      "[IO.File]::WriteAllText($cmdFile, $cmdBody, (New-Object Text.UTF8Encoding($false)))",
      "$vbsFile = Join-Path $dir 'run-agent.vbs'",
      "$vbsBody = 'CreateObject(\"WScript.Shell\").Run \"\"\"\" & CreateObject(\"Scripting.FileSystemObject\").GetParentFolderName(WScript.ScriptFullName) & \"\\run-agent.cmd\"\"\", 0, False'",
      "Set-Content -LiteralPath $vbsFile -Value $vbsBody -Encoding ASCII",
      "$launched = $false",
      "try {",
      "  $taskName = 'SmacAgentServer'",
      "  $userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
      "  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('\"' + $vbsFile + '\"')",
      "  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited",
      "  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden",
      "  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null",
      "  Start-ScheduledTask -TaskName $taskName",
      "  Start-Sleep -Milliseconds 300",
      "  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null",
      "  $launched = $true",
      "} catch { }",
      "if (-not $launched) {",
      "  $line = 'cmd.exe /c \"' + $cmdFile + '\"'",
      "  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $line; CurrentDirectory = $dir }",
      "  if ($r.ReturnValue -ne 0) { throw ('WMI 启动失败，返回值 ' + $r.ReturnValue) }",
      "}",
      "'SMAC_AGENT_STARTED'"
    ].join('\n')
    : [
      POSIX_PATH_EXPORT,
      "dir=\"$HOME/" + REMOTE_DIR_NAME + "\"",
      "cd \"$dir\" || exit 9",
      "mkdir -p logs",
      "node_bin=$(command -v node 2>/dev/null || true)",
      "if [ -z \"$node_bin\" ] && [ -x \"$HOME/.hermes/node/bin/node\" ]; then node_bin=\"$HOME/.hermes/node/bin/node\"; fi",
      "if [ -z \"$node_bin\" ] && [ -x /opt/homebrew/bin/node ]; then node_bin=/opt/homebrew/bin/node; fi",
      "if [ -z \"$node_bin\" ] && [ -x /usr/local/bin/node ]; then node_bin=/usr/local/bin/node; fi",
      "if [ -z \"$node_bin\" ]; then echo '远端未找到 node 运行时' >&2; exit 10; fi",
      "cat > \"$dir/run-agent.sh\" <<SMAC_AGENT_SH",
      "#!/bin/sh",
      "export HOME=\"$HOME\"",
      "export PATH=\"$PATH\"",
      "unset SSH_CONNECTION SSH_CLIENT SSH_TTY",
      "SMAC_AGENT_SH",
      "cat >> \"$dir/run-agent.sh\" <<'SMAC_AGENT_SH2'",
      MAC_PROXY_EXPORT,
      "SMAC_AGENT_SH2",
      "printf 'cd \"%s\" || exit 9\\nexec \"%s\" agent-server.js --port 8799\\n' \"$dir\" \"$node_bin\" >> \"$dir/run-agent.sh\"",
      "chmod +x \"$dir/run-agent.sh\"",
      "launched=0",
      "if [ \"$(uname -s)\" = \"Darwin\" ]; then",
      "  uid=$(id -u)",
      "  plist=\"$dir/com.smac.agent.plist\"",
      "  launchctl bootout \"gui/$uid/com.smac.agent\" 2>/dev/null || true",
      "  cat > \"$plist\" <<SMAC_PLIST",
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
      "<plist version=\"1.0\"><dict>",
      "<key>Label</key><string>com.smac.agent</string>",
      "<key>LimitLoadToSessionType</key><string>Aqua</string>",
      "<key>RunAtLoad</key><true/>",
      "<key>ProgramArguments</key><array><string>/bin/sh</string><string>$dir/run-agent.sh</string></array>",
      "<key>StandardOutPath</key><string>$dir/logs/server.log</string>",
      "<key>StandardErrorPath</key><string>$dir/logs/server.err.log</string>",
      "</dict></plist>",
      "SMAC_PLIST",
      "  if launchctl bootstrap \"gui/$uid\" \"$plist\" >/dev/null 2>&1; then launched=1; fi",
      "fi",
      "if [ \"$launched\" -eq 0 ]; then",
      "  nohup /bin/sh \"$dir/run-agent.sh\" >\"$dir/logs/server.log\" 2>\"$dir/logs/server.err.log\" &",
      "  echo $! > \"$dir/server.pid\"",
      "fi",
      "echo SMAC_AGENT_STARTED"
    ].join('\n');
  return remoteScript(osName, script).then(result => {
    if (!/SMAC_AGENT_STARTED/.test(String(result.stdout || ''))) {
      throw new Error('远端 Agent 启动失败: ' + (String(result.stdout || '') + String(result.stderr || '')).trim());
    }
    return remoteDirPath;
  });
}

async function stopRemote(osName, dir) {
  try {
    const script = osName === 'windows'
      ? [
        "$dir = Join-Path $env:USERPROFILE '" + REMOTE_DIR_NAME + "'",
        "$f = Join-Path $dir 'server.json'",
        "if (Test-Path $f) { $j = Get-Content -LiteralPath $f -Raw | ConvertFrom-Json; if ($j.pid) { taskkill /PID $j.pid /T /F 2>$null | Out-Null } }",
        "Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue",
        "'SMAC_OK'"
      ].join('\n')
      : [
        POSIX_PATH_EXPORT,
        "dir=\"$HOME/" + REMOTE_DIR_NAME + "\"",
        "if [ \"$(uname -s)\" = \"Darwin\" ]; then launchctl bootout \"gui/$(id -u)/com.smac.agent\" 2>/dev/null || true; fi",
        "if [ -f \"$dir/server.json\" ]; then pid=$(node -e \"try{console.log(require('$dir/server.json').pid||'')}catch{}\" 2>/dev/null || sed -n 's/.*\"pid\"[[:space:]]*:[[:space:]]*\\([0-9]*\\).*/\\1/p' \"$dir/server.json\" | head -n 1); if [ -n \"$pid\" ]; then kill -TERM \"$pid\" 2>/dev/null || true; fi; fi",
        "if [ -f \"$dir/server.pid\" ]; then pid=$(cat \"$dir/server.pid\" 2>/dev/null || true); if [ -n \"$pid\" ]; then kill -TERM \"$pid\" 2>/dev/null || true; fi; fi",
        "rm -f \"$dir/server.json\" \"$dir/server.pid\"",
        "echo SMAC_OK"
      ].join('\n');
    await remoteScript(osName, script);
  } catch { }
}

// 确保远端装了 Codex CLI；第一次使用 Codex 后端时自动安装到 ~/.smac-agent/tools。
async function ensureCodex(device, osName) {
  const script = osName === 'windows'
    ? [
      "$ErrorActionPreference='Stop'",
      "$tools = Join-Path $env:USERPROFILE '.smac-agent/tools'",
      "$exe = @(Get-ChildItem -Path (Join-Path $tools 'node_modules') -Recurse -Filter codex.exe -ErrorAction SilentlyContinue | Select-Object -First 1)",
      "if ($exe.Length -gt 0) { 'SMAC_CODEX_OK ' + $exe[0].FullName; exit 0 }",
      "$npm = Join-Path $env:LOCALAPPDATA 'hermes/node/npm.cmd'",
      "if (-not (Test-Path -LiteralPath $npm)) { $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source }",
      "if (-not $npm) { throw '远端找不到 npm，无法自动安装 Codex CLI' }",
      "New-Item -ItemType Directory -Force -Path $tools | Out-Null",
      "& $npm install --prefix $tools '@openai/codex@0.171.0' --no-audit --no-fund *> (Join-Path $env:TEMP 'smac-codex-install.log')",
      "$exe = @(Get-ChildItem -Path (Join-Path $tools 'node_modules') -Recurse -Filter codex.exe -ErrorAction SilentlyContinue | Select-Object -First 1)",
      "if ($exe.Length -eq 0) { throw ('Codex 安装失败，日志: ' + (Join-Path $env:TEMP 'smac-codex-install.log')) }",
      "'SMAC_CODEX_OK ' + $exe[0].FullName"
    ].join('\n')
    : [
      POSIX_PATH_EXPORT,
      "tools=\"$HOME/.smac-agent/tools\"; mkdir -p \"$tools\"",
      "if command -v codex >/dev/null 2>&1; then echo \"SMAC_CODEX_OK $(command -v codex)\"; exit 0; fi",
      "npm install --prefix \"$tools\" @openai/codex@0.171.0 --no-audit --no-fund >\"$tools/install.log\" 2>&1 || true",
      "if [ -x \"$tools/node_modules/.bin/codex\" ]; then echo \"SMAC_CODEX_OK $tools/node_modules/.bin/codex\"; exit 0; fi",
      "echo SMAC_CODEX_MISSING; exit 1"
    ].join('\n');
  const result = await bridge({ op: 'exec', deviceId: device.id, os: osName, script, timeoutMs: 480000 });
  if (!/SMAC_CODEX_OK/.test(String(result.stdout || ''))) {
    throw new Error('远端没有可用的 Codex CLI，自动安装未成功');
  }
  return String(result.stdout || '').trim().split(/\r?\n/).pop().replace(/^SMAC_CODEX_OK\s*/, '');
}

// Claude Code 通过 npm 装到 ~/.smac-agent/tools；agent-server 会直接用当前的
// node 运行包里的 cli.js，因此不依赖 PATH 或 shell shim。
async function ensureClaude(device, osName) {
  const script = osName === 'windows'
    ? [
      "$ErrorActionPreference='Stop'",
      "$tools = Join-Path $env:USERPROFILE '.smac-agent/tools'",
      "$cli = Join-Path $tools 'node_modules/@anthropic-ai/claude-code/cli.js'",
      "if (Test-Path -LiteralPath $cli) { 'SMAC_CLAUDE_OK ' + $cli; exit 0 }",
      "$native = Join-Path $env:USERPROFILE '.local/bin/claude.exe'",
      "if (Test-Path -LiteralPath $native) { 'SMAC_CLAUDE_OK ' + $native; exit 0 }",
      "$cmd = (Get-Command claude.exe -ErrorAction SilentlyContinue).Source",
      "if ($cmd) { 'SMAC_CLAUDE_OK ' + $cmd; exit 0 }",
      "$npm = Join-Path $env:LOCALAPPDATA 'hermes/node/npm.cmd'",
      "if (-not (Test-Path -LiteralPath $npm)) { $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source }",
      "if (-not $npm) { throw '远端找不到 npm，无法自动安装 Claude Code CLI' }",
      "New-Item -ItemType Directory -Force -Path $tools | Out-Null",
      "& $npm install --prefix $tools '@anthropic-ai/claude-code@latest' --no-audit --no-fund *> (Join-Path $env:TEMP 'smac-claude-install.log')",
      "if (-not (Test-Path -LiteralPath $cli)) { throw ('Claude Code 安装失败，日志: ' + (Join-Path $env:TEMP 'smac-claude-install.log')) }",
      "'SMAC_CLAUDE_OK ' + $cli"
    ].join('\n')
    : [
      POSIX_PATH_EXPORT,
      "tools=\"$HOME/.smac-agent/tools\"; mkdir -p \"$tools\"",
      "if command -v claude >/dev/null 2>&1; then echo \"SMAC_CLAUDE_OK $(command -v claude)\"; exit 0; fi",
      "if [ -f \"$tools/node_modules/@anthropic-ai/claude-code/cli.js\" ]; then echo \"SMAC_CLAUDE_OK $tools/node_modules/@anthropic-ai/claude-code/cli.js\"; exit 0; fi",
      "npm_bin=$(command -v npm 2>/dev/null || true)",
      "if [ -z \"$npm_bin\" ] && [ -x \"$HOME/.hermes/node/bin/npm\" ]; then npm_bin=\"$HOME/.hermes/node/bin/npm\"; fi",
      "if [ -n \"$npm_bin\" ]; then \"$npm_bin\" install --prefix \"$tools\" @anthropic-ai/claude-code@latest --no-audit --no-fund >\"$tools/install.log\" 2>&1 || true; fi",
      "if [ -f \"$tools/node_modules/@anthropic-ai/claude-code/cli.js\" ]; then echo \"SMAC_CLAUDE_OK $tools/node_modules/@anthropic-ai/claude-code/cli.js\"; exit 0; fi",
      "echo SMAC_CLAUDE_MISSING; exit 1"
    ].join('\n');
  const result = await bridge({ op: 'exec', deviceId: device.id, os: osName, script, timeoutMs: 480000 });
  if (!/SMAC_CLAUDE_OK/.test(String(result.stdout || ''))) {
    throw new Error('远端没有可用的 Claude Code CLI，自动安装未成功');
  }
  return String(result.stdout || '').trim().split(/\r?\n/).pop().replace(/^SMAC_CLAUDE_OK\s*/, '');
}

// Antigravity CLI：优先复用与桌面端同源的官方路径（~/.gemini/bin/agy、%LOCALAPPDATA%\agy\bin\agy.exe 等），
// 缺失时通过官方脚本自动安装并同步共享系统密钥链订阅。
async function ensureAgy(device, osName) {
  const script = osName === 'windows'
    ? [
      "$ErrorActionPreference='Stop'",
      "$cands = @(",
      "  (Join-Path $env:USERPROFILE '.gemini\\bin\\agy.exe'),",
      "  (Join-Path $env:LOCALAPPDATA 'agy\\bin\\agy.exe'),",
      "  (Join-Path $env:USERPROFILE '.local\\bin\\agy.exe'),",
      "  (Join-Path $env:USERPROFILE '.smac-agent\\tools\\antigravity\\agy.exe'),",
      "  (Join-Path $env:USERPROFILE '.smac-agent\\tools\\antigravity\\bin\\agy.exe')",
      ")",
      "foreach ($c in $cands) { if (Test-Path -LiteralPath $c) { 'SMAC_AGY_OK ' + $c; exit 0 } }",
      "$cmd = (Get-Command agy.exe -ErrorAction SilentlyContinue).Source",
      "if ($cmd) { 'SMAC_AGY_OK ' + $cmd; exit 0 }",
      "$dir = Join-Path $env:USERPROFILE '.smac-agent\\tools\\antigravity'",
      "New-Item -ItemType Directory -Force -Path $dir | Out-Null",
      "$found = @(Get-ChildItem -Path $dir -Recurse -Filter agy.exe -ErrorAction SilentlyContinue | Select-Object -First 1)",
      "if ($found.Length -gt 0) { 'SMAC_AGY_OK ' + $found[0].FullName; exit 0 }",
      "$tmp = Join-Path $env:TEMP 'smac-agy-install.ps1'",
      "$log = Join-Path $env:TEMP 'smac-agy-install.log'",
      "Invoke-WebRequest -UseBasicParsing 'https://antigravity.google/cli/install.ps1' -OutFile $tmp",
      "try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tmp *> $log } catch { }",
      "foreach ($c in $cands) { if (Test-Path -LiteralPath $c) { 'SMAC_AGY_OK ' + $c; exit 0 } }",
      "try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tmp -d $dir *>> $log } catch { }",
      "$found = @(Get-ChildItem -Path $dir -Recurse -Filter agy.exe -ErrorAction SilentlyContinue | Select-Object -First 1)",
      "if ($found.Length -gt 0) { 'SMAC_AGY_OK ' + $found[0].FullName; exit 0 }",
      "$cmd = (Get-Command agy.exe -ErrorAction SilentlyContinue).Source",
      "if ($cmd) { 'SMAC_AGY_OK ' + $cmd; exit 0 }",
      "throw ('Antigravity CLI 安装失败，日志: ' + $log)"
    ].join('\n')
    : [
      POSIX_PATH_EXPORT,
      MAC_PROXY_EXPORT,
      "dir=\"$HOME/.smac-agent/tools/antigravity\"; mkdir -p \"$dir\"",
      "for c in \"$HOME/.gemini/bin/agy\" \"$HOME/.local/bin/agy\" /opt/homebrew/bin/agy /usr/local/bin/agy \"$dir/agy\" \"$dir/bin/agy\"; do",
      "  if [ -x \"$c\" ]; then echo \"SMAC_AGY_OK $c\"; exit 0; fi",
      "done",
      "if command -v agy >/dev/null 2>&1; then echo \"SMAC_AGY_OK $(command -v agy)\"; exit 0; fi",
      "curl -fsSL https://antigravity.google/cli/install.sh -o \"$dir/install.sh\" >\"$dir/install.log\" 2>&1 || true",
      "if [ -s \"$dir/install.sh\" ]; then",
      "  bash \"$dir/install.sh\" >>\"$dir/install.log\" 2>&1 || bash \"$dir/install.sh\" --dir \"$dir\" >>\"$dir/install.log\" 2>&1 || bash \"$dir/install.sh\" -d \"$dir\" >>\"$dir/install.log\" 2>&1 || true",
      "fi",
      "for c in \"$HOME/.gemini/bin/agy\" \"$HOME/.local/bin/agy\" /opt/homebrew/bin/agy /usr/local/bin/agy \"$dir/agy\" \"$dir/bin/agy\"; do",
      "  if [ -x \"$c\" ]; then echo \"SMAC_AGY_OK $c\"; exit 0; fi",
      "done",
      "if command -v agy >/dev/null 2>&1; then echo \"SMAC_AGY_OK $(command -v agy)\"; exit 0; fi",
      "echo SMAC_AGY_MISSING; exit 1"
    ].join('\n');
  const result = await bridge({ op: 'exec', deviceId: device.id, os: osName, script, timeoutMs: 600000 });
  if (!/SMAC_AGY_OK/.test(String(result.stdout || ''))) {
    throw new Error('远端没有可用的 Gemini / Antigravity CLI，自动安装未成功');
  }
  return String(result.stdout || '').trim().split(/\r?\n/).pop().replace(/^SMAC_AGY_OK\s*/, '');
}

function findLocalPort() {
  return new Promise((resolve, reject) => {
    let port = BASE_PORT;
    const tryPort = () => {
      if (port >= BASE_PORT + PORT_TRIES) { reject(new Error('本地 8799-8805 端口都被占用')); return; }
      const tester = net.createServer();
      tester.once('error', () => { port += 1; tryPort(); });
      tester.once('listening', () => {
        const chosen = port;
        tester.close(() => resolve(chosen));
      });
      tester.listen(port, BIND);
    };
    tryPort();
  });
}

function openTunnel(conn, localPort, remotePort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => {
      conn.forwardOut(socket.remoteAddress || '127.0.0.1', socket.remotePort || 0, '127.0.0.1', remotePort, (error, stream) => {
        if (error) { socket.destroy(); return; }
        socket.pipe(stream).pipe(socket);
        socket.on('error', () => stream.destroy());
        stream.on('error', () => socket.destroy());
        stream.on('close', () => socket.destroy());
      });
    });
    server.once('error', reject);
    server.listen(localPort, BIND, () => { server.removeListener('error', reject); resolve(server); });
  });
}

async function fetchInfo(url, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url + '/api/info?health=1', {
      headers: { 'X-Smac-Token': token },
      signal: controller.signal
    });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function start(options) {
  const deviceId = String(options.deviceId || '');
  const device = findDevice(deviceId);
  if (!device) { throw new Error('设备不存在或已被删除'); }
  if (!ssh2) { throw new Error('缺少 ssh2 组件，请在 web 目录执行 npm install'); }

  const chosen = Array.isArray(options.pairs) ? options.pairs.map(String) : [];
  const available = pairsForDevice(deviceId);
  const pairs = available.filter(pair => chosen.includes(String(pair.name)));
  if (!pairs.length) { throw new Error('请至少选择一个同步目录'); }
  const roots = pairs.map(pair => ({
    label: String(pair.name),
    path: String(pair.remote || '')
  })).filter(item => item.path);
  if (!roots.length) { throw new Error('所选同步目录没有配置远端路径'); }
  const backend = normalizeBackend(options.backend);

  await stop();

  const probe = await bridge({ op: 'probe', deviceId, timeoutMs: 60000 });
  const osName = probe.os === 'windows' ? 'windows' : 'posix';
  activeDeviceId = deviceId;

  let step = '准备远端目录';
  try {
    trace('step ' + step);
    const dir = await remoteDir(device, osName);
    step = '批量上传 Agent 组件';
    trace('step ' + step);
    const { temp, payload } = writeRootsFile(device, roots, options.provider, options.model, backend);
    const credentialFile = path.join(os.tmpdir(), 'smac-agent-credentials-' + crypto.randomBytes(4).toString('hex') + '.json');
    try {
      fs.writeFileSync(credentialFile, JSON.stringify(credentialsFor(deviceId), null, 2), 'utf8');
      await bridge({
        op: 'upload-batch',
        deviceId: device.id,
        os: osName,
        files: [
          { local: path.join(AGENT_SRC, 'path-guard.js'), remote: forwardSlash(dir + '/path-guard.js') },
          { local: path.join(AGENT_SRC, 'agent-server.js'), remote: forwardSlash(dir + '/agent-server.js') },
          { local: path.join(AGENT_SRC, 'codex-hook.js'), remote: forwardSlash(dir + '/codex-hook.js') },
          { local: path.join(AGENT_SRC, 'smac-mcp.js'), remote: forwardSlash(dir + '/smac-mcp.js') },
          { local: path.join(AGENT_SRC, 'ui.css'), remote: forwardSlash(dir + '/ui.css') },
          { local: path.join(AGENT_SRC, 'ui.js'), remote: forwardSlash(dir + '/ui.js') },
          { local: path.join(AGENT_SRC, 'ui.html'), remote: forwardSlash(dir + '/ui.html') },
          { local: path.join(AGENT_SRC, 'guest-env.js'), remote: forwardSlash(dir + '/guest-env.js') },
          { local: temp, remote: forwardSlash(dir + '/roots.json') },
          { local: credentialFile, remote: forwardSlash(dir + '/credentials.json') }
        ],
        timeoutMs: 180000
      });
      if (osName !== 'windows') {
        await remoteScript(osName, "chmod 600 \"$HOME/" + REMOTE_DIR_NAME + "/credentials.json\" 2>/dev/null; echo SMAC_OK");
      }
      // 首次启动时把离线 KaTeX 渲染库同步到远端（已存在则跳过，零额外耗时）
      const localKatexDir = path.join(AGENT_SRC, 'katex');
      if (fs.existsSync(path.join(localKatexDir, 'katex.min.js'))) {
        try {
          const checkScript = osName === 'windows'
            ? "if ((Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.smac-agent\\katex\\katex.min.js')) -and (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.smac-agent\\katex\\fonts\\KaTeX_Main-Regular.woff2'))) { 'SMAC_KATEX_OK' } else { 'SMAC_KATEX_MISSING' }"
            : "if [ -f \"$HOME/" + REMOTE_DIR_NAME + "/katex/katex.min.js\" ] && [ -f \"$HOME/" + REMOTE_DIR_NAME + "/katex/fonts/KaTeX_Main-Regular.woff2\" ]; then echo SMAC_KATEX_OK; else echo SMAC_KATEX_MISSING; fi";
          const check = await remoteScript(osName, checkScript);
          if (!/SMAC_KATEX_OK/.test(String(check.stdout || ''))) {
            step = '同步公式渲染组件 (KaTeX)';
            trace('step ' + step);
            await bridge({
              op: 'upload-tree',
              deviceId: device.id,
              os: osName,
              local: localKatexDir,
              remote: forwardSlash(dir + '/katex'),
              timeoutMs: 180000
            });
          }
        } catch { }
      }
    } finally {
      try { fs.rmSync(temp, { force: true }); } catch { }
      try { fs.rmSync(credentialFile, { force: true }); } catch { }
    }

    if (backend === 'codex') {
      step = '准备 Codex CLI';
      trace('step ' + step);
      await ensureCodex(device, osName);
    } else if (backend === 'claude') {
      step = '准备 Claude Code CLI';
      trace('step ' + step);
      await ensureClaude(device, osName);
    } else if (backend === 'agy') {
      step = '准备 Gemini / Antigravity CLI';
      trace('step ' + step);
      await ensureAgy(device, osName);
    }

    // 清掉上一次可能残留的远端服务，避免端口被旧实例占住。
    step = '停止旧实例';
    trace('step ' + step);
    await stopRemote(osName, dir);
    step = '清理旧状态';
    trace('step ' + step);
    await removeRemoteFile(osName, dir + '/server.json');
    step = '启动远端服务';
    trace('step ' + step);
    await startRemote(osName, dir);

    let serverInfo = null;
    step = '等待远端服务';
    trace('step ' + step);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(700);
      serverInfo = await readServerFile(osName, dir);
      if (serverInfo) { break; }
    }
    if (!serverInfo) {
      throw new Error('远端 Agent 没有在预期时间内启动，请查看远端 ' + dir + '/logs/server.err.log');
    }

    step = '建立 SSH 隧道';
    trace('step ' + step);
    const connected = await connectTunnelDevice(device);
    const localPort = await findLocalPort();
    let localServer;
    try {
      localServer = await openTunnel(connected.conn, localPort, serverInfo.port);
    } catch (error) {
      try { connected.conn.end(); } catch { }
      throw error;
    }

    const url = 'http://' + BIND + ':' + localPort + '/?token=' + encodeURIComponent(serverInfo.token);
    step = '健康检查';
    trace('step ' + step);
    try {
      const info = await fetchInfo('http://' + BIND + ':' + localPort, serverInfo.token);
      if (!info || !info.ok) { throw new Error('远端 Agent 健康检查失败'); }
    } catch (error) {
      try { localServer.close(); } catch { }
      try { connected.conn.end(); } catch { }
      throw new Error('无法通过隧道连接远端 Agent: ' + error.message);
    }

    active = {
      deviceId,
      deviceName: device.name,
      host: connected.host,
      os: osName,
      dir,
      roots: payload.roots,
      backend: payload.backend,
      provider: payload.provider,
      model: payload.model,
      remotePort: serverInfo.port,
      localPort,
      token: serverInfo.token,
      url,
      startedAt: new Date().toISOString(),
      conn: connected.conn,
      jumpConn: connected.jumpConn || null,
      server: localServer
    };

    connected.conn.on('close', () => {
      if (!active || active.conn !== connected.conn) { return; }
      try { active.server.close(); } catch { }
      active = null;
    });

    saveSelection({
      deviceId,
      pairs: pairs.map(pair => String(pair.name)),
      backend,
      provider: String(options.provider || ''),
      model: String(options.model || '')
    });

    return publicState();
  } catch (error) {
    throw new Error(step + '失败: ' + (error && error.message ? error.message : error));
  }
}

async function stop() {
  const current = active;
  active = null;
  if (!current) { return { ok: true, stopped: false }; }
  try {
    await fetch('http://' + BIND + ':' + current.localPort + '/api/shutdown', {
      method: 'POST',
      headers: { 'X-Smac-Token': current.token, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(1500)
    });
  } catch { }
  try { current.server.close(); } catch { }
  try { current.conn.end(); } catch { }
  try { if (current.jumpConn) current.jumpConn.end(); } catch { }
  await stopRemote(current.os, current.dir);
  return { ok: true, stopped: true };
}

function publicState() {
  const current = active;
  return {
    available: Boolean(ssh2),
    running: Boolean(current),
    deviceId: current ? current.deviceId : '',
    deviceName: current ? current.deviceName : '',
    host: current ? current.host : '',
    os: current ? current.os : '',
    roots: current ? current.roots : [],
    backend: current ? current.backend : '',
    provider: current ? current.provider : '',
    model: current ? current.model : '',
    remotePort: current ? current.remotePort : 0,
    localPort: current ? current.localPort : 0,
    url: current ? current.url : '',
    startedAt: current ? current.startedAt : '',
    selection: selection()
  };
}

function optionsForDevice(deviceId, localAdminNodeId) {
  const devices = readDevices()
    .filter(device => {
      if (device.isAdminNode) return true;
      if (localAdminNodeId && device.hostAdminNodeId && device.hostAdminNodeId !== localAdminNodeId) return false;
      if (device.handshakeStatus === 'pending' || device.handshakeStatus === 'rejected') return false;
      return true;
    })
    .map(device => ({
      id: device.id,
      name: device.name,
      host: device.host,
      auth: device.auth,
      hasPassword: Boolean(device.password),
      os: device.os || '',
      isAdminNode: Boolean(device.isAdminNode),
      hostAdminNodeId: device.hostAdminNodeId || '',
      hostAdminName: device.hostAdminName || '',
      pairCount: pairsForDevice(device.id).length,
      guestEnv: device.guestEnv || null
    }));
  const pairs = pairsForDevice(deviceId).map(pair => ({
    name: String(pair.name),
    remote: String(pair.remote || ''),
    local: String(pair.local || '')
  }));
  return { devices, pairs, selection: selection() };
}

async function detectEnvForDevice(deviceId, force) {
  const device = findDevice(deviceId);
  if (!device) { throw new Error('设备不存在或已被删除'); }
  if (!force && envCache.has(deviceId)) {
    const cached = envCache.get(deviceId);
    if (Date.now() - cached.at < 30000) return cached.data;
  }
  if (!force && device.guestEnv && device.guestEnv.ok) {
    envCache.set(deviceId, { at: Date.now(), data: device.guestEnv });
  }
  const probe = await bridge({ op: 'probe', deviceId, timeoutMs: 45000 });
  const osName = probe.os === 'windows' ? 'windows' : 'posix';
  activeDeviceId = deviceId;
  const dir = await remoteDir(device, osName);
  await uploadFile(device, osName, path.join(AGENT_SRC, 'guest-env.js'), dir + '/guest-env.js');

  const script = osName === 'windows'
    ? [
        "$ErrorActionPreference='Stop'",
        "[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)",
        "$dir = Join-Path $env:USERPROFILE '" + REMOTE_DIR_NAME + "'",
        "$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source",
        "if (-not $node) { $cand = Join-Path $env:LOCALAPPDATA 'hermes\\node\\node.exe'; if (Test-Path -LiteralPath $cand) { $node = $cand } }",
        "if (-not $node) { throw '客机未找到 Node.js 运行时' }",
        "& $node (Join-Path $dir 'guest-env.js')"
      ].join('\n')
    : [
        POSIX_PATH_EXPORT,
        "dir=\"$HOME/" + REMOTE_DIR_NAME + "\"",
        "node_bin=$(command -v node 2>/dev/null || true)",
        "if [ -z \"$node_bin\" ] && [ -x \"$HOME/.hermes/node/bin/node\" ]; then node_bin=\"$HOME/.hermes/node/bin/node\"; fi",
        "if [ -z \"$node_bin\" ] && [ -x /opt/homebrew/bin/node ]; then node_bin=/opt/homebrew/bin/node; fi",
        "if [ -z \"$node_bin\" ] && [ -x /usr/local/bin/node ]; then node_bin=/usr/local/bin/node; fi",
        "\"$node_bin\" \"$dir/guest-env.js\""
      ].join('\n');

  const res = await bridge({ op: 'exec', deviceId, os: osName, script, timeoutMs: 60000 });
  const line = String(res.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(s => s.startsWith('SMAC_GUEST_ENV ')).pop();
  if (!line) {
    throw new Error('客机环境检测未返回有效结果');
  }
  const parsed = JSON.parse(line.slice('SMAC_GUEST_ENV '.length));
  envCache.set(deviceId, { at: Date.now(), data: parsed });
  saveDeviceGuestEnv(deviceId, parsed);
  return parsed;
}

function providerLabel(id) {
  const text = String(id || '');
  if (text.startsWith('custom:')) {
    return '自定义 · ' + text.slice('custom:'.length).replace(/#.*$/, '');
  }
  return text;
}

function normalizeModels(payload) {
  const active = payload && payload.active ? String(payload.active) : '';
  const seen = new Set();
  const providers = [];
  const list = payload && Array.isArray(payload.providers) ? payload.providers : [];
  for (const item of list) {
    const id = String((item && item.id) || '');
    if (!id || seen.has(id)) { continue; }
    seen.add(id);
    const models = Array.from(new Set(((item && item.models) || []).map(String).filter(Boolean)));
    providers.push({ id, label: providerLabel(id), models, active: id === active });
  }
  if (active && !seen.has(active)) {
    providers.unshift({ id: active, label: providerLabel(active), models: [], active: true });
  }
  providers.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || a.id.localeCompare(b.id));
  const chosen = providers.find(item => item.active) || providers[0] || { id: '', models: [] };
  return {
    active,
    defaultProvider: chosen.id || '',
    defaultModel: (chosen.models && chosen.models[0]) || '',
    providers
  };
}

// 读取远端 Hermes 的登录方式与模型目录，供控制台用下拉框选择。
async function modelsForDevice(deviceId, backend) {
  const device = findDevice(deviceId);
  if (!device) { throw new Error('设备不存在或已被删除'); }
  const probe = await bridge({ op: 'probe', deviceId, timeoutMs: 60000 });
  const osName = probe.os === 'windows' ? 'windows' : 'posix';

  if (backend === 'dsh' || backend === 'codex') {
    activeDeviceId = deviceId;
    const dir = await remoteDir(device, osName);
    await uploadFile(device, osName, path.join(AGENT_SRC, 'probe-models.js'), dir + '/probe-models.js');
    const script = osName === 'windows'
      ? [
        "$ErrorActionPreference='SilentlyContinue'",
        "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)",
        "$dir = Join-Path $env:USERPROFILE '" + REMOTE_DIR_NAME + "'",
        "$n=(Get-Command node.exe -ErrorAction SilentlyContinue).Source",
        "if(-not $n){$c=Join-Path $env:LOCALAPPDATA 'hermes\\node\\node.exe';if(Test-Path -LiteralPath $c){$n=$c}}",
        "if(-not $n){$c=Join-Path $env:LOCALAPPDATA 'Programs\\DeepSeek Harness\\resources\\runtime\\node\\node.exe';if(Test-Path -LiteralPath $c){$n=$c}}",
        "& $n (Join-Path $dir 'probe-models.js') " + backend
      ].join('\n')
      : [
        POSIX_PATH_EXPORT,
        "dir=\"$HOME/" + REMOTE_DIR_NAME + "\"",
        "node_bin=$(command -v node 2>/dev/null || true)",
        "if [ -z \"$node_bin\" ] && [ -x \"$HOME/.hermes/node/bin/node\" ]; then node_bin=\"$HOME/.hermes/node/bin/node\"; fi",
        "if [ -z \"$node_bin\" ] && [ -x /opt/homebrew/bin/node ]; then node_bin=/opt/homebrew/bin/node; fi",
        "if [ -z \"$node_bin\" ] && [ -x /usr/local/bin/node ]; then node_bin=/usr/local/bin/node; fi",
        "\"$node_bin\" \"$dir/probe-models.js\" " + backend
      ].join('\n');
    const result = await bridge({ op: 'exec', deviceId, os: osName, script, timeoutMs: 90000 });
    const line = String(result.stdout || '').split(/\r?\n/).map(item => item.trim())
      .filter(item => item.startsWith('SMAC_MODELS ')).pop();
    if (!line) {
      throw new Error('无法读取客机 ' + backend + ' 模型目录');
    }
    let payload = { backend, providers: [], missing: false };
    try { payload = JSON.parse(line.slice('SMAC_MODELS '.length)); } catch { }
    return Object.assign({ backend }, payload);
  }

  if (backend === 'claude') {
    const script = osName === 'windows'
      ? [
        "$ErrorActionPreference='SilentlyContinue'",
        "$cli = Join-Path $env:USERPROFILE '.smac-agent/tools/node_modules/@anthropic-ai/claude-code/cli.js'",
        "$native = Join-Path $env:USERPROFILE '.local/bin/claude.exe'",
        "$cmd = (Get-Command claude.exe -ErrorAction SilentlyContinue).Source",
        "$ok = (Test-Path -LiteralPath $cli) -or (Test-Path -LiteralPath $native) -or [bool]$cmd",
        "'SMAC_MODELS ' + (@{ models = @('sonnet','opus','haiku'); missing = (-not $ok) } | ConvertTo-Json -Compress)"
      ].join('\n')
      : [
        POSIX_PATH_EXPORT,
        "tools=\"$HOME/.smac-agent/tools\"",
        "if command -v claude >/dev/null 2>&1 || [ -f \"$tools/node_modules/@anthropic-ai/claude-code/cli.js\" ]; then",
        "  echo 'SMAC_MODELS {\"models\":[\"sonnet\",\"opus\",\"haiku\"],\"missing\":false}'",
        "else",
        "  echo 'SMAC_MODELS {\"models\":[\"sonnet\",\"opus\",\"haiku\"],\"missing\":true}'",
        "fi"
      ].join('\n');
    const result = await bridge({ op: 'exec', deviceId, os: osName, script, timeoutMs: 60000 });
    const line = String(result.stdout || '').split(/\r?\n/).map(item => item.trim())
      .filter(item => item.startsWith('SMAC_MODELS ')).pop();
    let payload = { models: ['sonnet', 'opus', 'haiku'], missing: false };
    if (line) {
      try { payload = JSON.parse(line.slice('SMAC_MODELS '.length)); } catch { }
    }
    const models = Array.from(new Set((payload.models || []).map(String).filter(Boolean)));
    const reasoning = {};
    models.forEach(slug => {
      reasoning[slug] = { levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: '', fast: false };
    });
    return {
      backend: 'claude',
      active: 'claude',
      defaultProvider: 'claude',
      defaultModel: models[0] || 'sonnet',
      missing: Boolean(payload.missing),
      providers: [{ id: 'claude', label: 'Claude Code · Anthropic', models, active: true }],
      reasoning
    };
  }

  if (backend === 'agy') {
    activeDeviceId = deviceId;
    const dir = await remoteDir(device, osName);
    await uploadFile(device, osName, path.join(AGENT_SRC, 'probe-models.js'), dir + '/probe-models.js');
    const runScript = osName === 'windows'
      ? [
        "$ErrorActionPreference='SilentlyContinue'",
        "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)",
        "$dir = Join-Path $env:USERPROFILE '" + REMOTE_DIR_NAME + "'",
        "$n=(Get-Command node.exe -ErrorAction SilentlyContinue).Source",
        "if(-not $n){$c=Join-Path $env:LOCALAPPDATA 'hermes\\node\\node.exe';if(Test-Path -LiteralPath $c){$n=$c}}",
        "if(-not $n){$c=Join-Path $env:LOCALAPPDATA 'Programs\\DeepSeek Harness\\resources\\runtime\\node\\node.exe';if(Test-Path -LiteralPath $c){$n=$c}}",
        "& $n (Join-Path $dir 'probe-models.js') agy"
      ].join('\n')
      : [
        POSIX_PATH_EXPORT,
        "dir=\"$HOME/" + REMOTE_DIR_NAME + "\"",
        "node_bin=$(command -v node 2>/dev/null || true)",
        "if [ -z \"$node_bin\" ] && [ -x \"$HOME/.hermes/node/bin/node\" ]; then node_bin=\"$HOME/.hermes/node/bin/node\"; fi",
        "if [ -z \"$node_bin\" ] && [ -x /opt/homebrew/bin/node ]; then node_bin=/opt/homebrew/bin/node; fi",
        "if [ -z \"$node_bin\" ] && [ -x /usr/local/bin/node ]; then node_bin=/usr/local/bin/node; fi",
        "\"$node_bin\" \"$dir/probe-models.js\" agy"
      ].join('\n');

    const runAgyProbe = async () => {
      const result = await bridge({ op: 'exec', deviceId, os: osName, script: runScript, timeoutMs: 90000 });
      const line = String(result.stdout || '').split(/\r?\n/).map(item => item.trim())
        .filter(item => item.startsWith('SMAC_MODELS ')).pop();
      let parsed = { models: [], modelLabels: {}, missing: false, error: '' };
      if (line) {
        try { parsed = JSON.parse(line.slice('SMAC_MODELS '.length)); } catch { }
      }
      return parsed;
    };

    let payload = await runAgyProbe();
    let autoSyncedCli = false;
    // 如果客机安装了 Antigravity 桌面端（或桌面端已登录订阅）但尚未安装 agy CLI，
    // 自动静默安装官方 CLI 并再次通过桌面交互会话同步共享密钥链订阅。
    if (payload.missing && (payload.desktopInstalled || payload.desktopLoggedIn)) {
      try {
        await ensureAgy(device, osName);
        envCache.delete(deviceId);
        payload = await runAgyProbe();
        autoSyncedCli = !payload.missing;
      } catch { }
    }

    const rawModels = Array.isArray(payload.models) ? payload.models : (payload.models ? [payload.models] : []);
    const models = Array.from(new Set(rawModels.map(String).filter(Boolean)));
    const reasoning = {};
    models.forEach(slug => {
      reasoning[slug] = { levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: '', fast: false };
    });
    const accountHint = String(payload.accountHint || '').trim();
    const desktopLoggedIn = Boolean(payload.desktopLoggedIn);
    let errText = '';
    if (!models.length && !payload.missing) {
      if (desktopLoggedIn && /sign in|not logged/i.test(String(payload.error || ''))) {
        errText = '客机 Antigravity 桌面端已登录' + (accountHint ? '（' + accountHint + '）' : '')
          + '，但 agy 刷新令牌或拉取模型失败（请检查客机代理/外网连通性，或在客机打开一次 Antigravity 后点「刷新」）。';
      } else if (/sign in|not logged/i.test(String(payload.error || ''))) {
        errText = '客机 Antigravity 尚未登录（请在客机登录 Antigravity 桌面端或 CLI，或在下方绑定 GEMINI_API_KEY）。';
      } else {
        errText = payload.error || '远端 agy 没有返回模型列表（可能尚未登录或网络受限）。';
      }
    }
    const provLabel = 'Gemini · Antigravity'
      + (models.length
        ? (desktopLoggedIn
          ? ('（已同步桌面端订阅' + (accountHint ? ' · ' + accountHint : '') + '）')
          : '（已登录订阅）')
        : '');
    return {
      backend: 'agy',
      active: 'agy',
      defaultProvider: 'agy',
      defaultModel: models[0] || '',
      missing: Boolean(payload.missing),
      desktopInstalled: Boolean(payload.desktopInstalled),
      desktopLoggedIn,
      accountHint,
      autoSyncedCli,
      error: errText,
      providers: [{ id: 'agy', label: provLabel, models, active: true }],
      modelLabels: payload.modelLabels && typeof payload.modelLabels === 'object' ? payload.modelLabels : {},
      reasoning
    };
  }

  if (backend === 'opencode') {
    return {
      backend: 'opencode',
      active: 'opencode',
      defaultProvider: 'opencode',
      defaultModel: 'default',
      missing: false,
      providers: [{ id: 'opencode', label: 'OpenCode CLI', models: ['default'], active: true }]
    };
  }

  const script = osName === 'windows'
    ? [
      "$ErrorActionPreference='SilentlyContinue'",
      "$h = Join-Path $env:LOCALAPPDATA 'hermes'",
      "$authPath = Join-Path $h 'auth.json'",
      "$cachePath = Join-Path $h 'provider_models_cache.json'",
      "$active = ''",
      "if (Test-Path -LiteralPath $authPath) { $a = Get-Content -LiteralPath $authPath -Raw -Encoding UTF8 | ConvertFrom-Json; if ($a) { $active = [string]$a.active_provider } }",
      "$providers = @()",
      "if (Test-Path -LiteralPath $cachePath) { $c = Get-Content -LiteralPath $cachePath -Raw -Encoding UTF8 | ConvertFrom-Json; if ($c) { foreach ($p in $c.PSObject.Properties) { $models = @(); if ($p.Value -and $p.Value.models) { $models = @($p.Value.models | ForEach-Object { [string]$_ }) }; $providers += [pscustomobject]@{ id = [string]$p.Name; models = $models } } } }",
      "$out = [pscustomobject]@{ active = $active; providers = @($providers) }",
      "'SMAC_MODELS ' + ($out | ConvertTo-Json -Depth 6 -Compress)"
    ].join('\n')
    : [
      POSIX_PATH_EXPORT,
      "node_bin=$(command -v node 2>/dev/null || true)",
      "if [ -z \"$node_bin\" ] && [ -x \"$HOME/.hermes/node/bin/node\" ]; then node_bin=\"$HOME/.hermes/node/bin/node\"; fi",
      "if [ -z \"$node_bin\" ] && [ -x /opt/homebrew/bin/node ]; then node_bin=/opt/homebrew/bin/node; fi",
      "if [ -z \"$node_bin\" ] && [ -x /usr/local/bin/node ]; then node_bin=/usr/local/bin/node; fi",
      "\"$node_bin\" -e \"const fs=require('fs'),p=process.env.HOME+'/.hermes';let a={},c={};try{a=JSON.parse(fs.readFileSync(p+'/auth.json','utf8'))}catch(e){};try{c=JSON.parse(fs.readFileSync(p+'/provider_models_cache.json','utf8'))}catch(e){};const providers=Object.keys(c||{}).map(k=>({id:k,models:Array.isArray(c[k]&&c[k].models)?c[k].models:[]}));console.log('SMAC_MODELS '+JSON.stringify({active:(a&&a.active_provider)||'',providers}))\""
    ].join('\n');
  const result = await bridge({ op: 'exec', deviceId, os: osName, script, timeoutMs: 60000 });
  const text = String(result.stdout || '');
  const line = text.split(/\r?\n/).map(item => item.trim()).filter(item => item.startsWith('SMAC_MODELS ')).pop();
  if (!line) { throw new Error('无法读取远端 Hermes 模型目录'); }
  let payload = null;
  try { payload = JSON.parse(line.slice('SMAC_MODELS '.length)); }
  catch { throw new Error('远端模型目录格式错误'); }
  return normalizeModels(payload);
}

module.exports = {
  start, stop, publicState, optionsForDevice, modelsForDevice,
  publicCredentials, saveCredentials, detectEnvForDevice
};
