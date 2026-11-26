'use strict';

// Cross-platform ZeroTier One mesh manager for smac (Windows / macOS / Linux).
// Network ID is user-configured per host in ~/.smac/config.json (empty by default).
// Supports:
//  - Local ZeroTier detection, status, Node ID & assigned IP inspection
//  - One-click local join (with optional ZeroTier One download/install hints)
//  - One-click remote Guest check / silent install / join via ssh-bridge.js
//  - Automatic device host/fallbackHost update in ~/.smac/devices.json

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const USER_HOME = process.env.USERPROFILE || os.homedir();
const DATA_DIR = path.join(USER_HOME, '.smac');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const BRIDGE = path.join(__dirname, 'ssh-bridge.js');

const DEFAULT_NETWORK_ID = '';
const DOWNLOAD_URL = 'https://www.zerotier.com/download/';

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

function normalizeNetworkId(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return '';
  if (!/^[0-9a-f]{16}$/.test(text)) return '';
  return text;
}

function getConfiguredNetworkId() {
  const cfg = readJson(CONFIG_FILE) || {};
  const saved = normalizeNetworkId(cfg.zerotierNetworkId);
  return saved || DEFAULT_NETWORK_ID;
}

function saveNetworkId(raw) {
  const nwid = normalizeNetworkId(raw);
  if (!nwid) {
    throw new Error('ZeroTier 组号格式无效，应为 16 位十六进制字符（可在 my.zerotier.com 创建网络获取）');
  }
  const cfg = readJson(CONFIG_FILE) || {};
  cfg.zerotierNetworkId = nwid;
  writeJson(CONFIG_FILE, cfg);
  return nwid;
}

function findLocalCli() {
  if (IS_WIN) {
    const exeCandidates = [
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'ZeroTier', 'One', 'zerotier-one_x64.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ZeroTier', 'One', 'zerotier-one_x64.exe'),
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'ZeroTier', 'One', 'zerotier-one_x64.exe')
    ];
    for (const p of exeCandidates) {
      if (fs.existsSync(p)) return { kind: 'exe', path: p };
    }
    const batCandidates = [
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'ZeroTier', 'One', 'zerotier-cli.bat'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ZeroTier', 'One', 'zerotier-cli.bat'),
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'ZeroTier', 'One', 'zerotier-cli.bat')
    ];
    for (const p of batCandidates) {
      if (fs.existsSync(p)) return { kind: 'bat', path: p };
    }
    const w = spawnSync('where.exe', ['zerotier-cli'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    if (w.status === 0 && w.stdout) {
      const first = w.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
      if (first && fs.existsSync(first)) {
        return { kind: /\.bat$/i.test(first) ? 'bat' : 'exe', path: first };
      }
    }
    return null;
  }

  const posixCandidates = [
    '/usr/local/bin/zerotier-cli',
    '/opt/homebrew/bin/zerotier-cli',
    '/usr/sbin/zerotier-cli',
    '/usr/bin/zerotier-cli',
    '/Applications/ZeroTier.app/Contents/MacOS/zerotier-cli'
  ];
  for (const p of posixCandidates) {
    if (fs.existsSync(p)) return { kind: 'posix', path: p };
  }
  const w = spawnSync('sh', ['-c', 'command -v zerotier-cli 2>/dev/null'], { encoding: 'utf8', timeout: 3000 });
  if (w.status === 0 && w.stdout) {
    const first = w.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (first && fs.existsSync(first)) return { kind: 'posix', path: first };
  }
  return null;
}

function runLocalCli(cli, args, timeoutMs = 8000) {
  if (!cli) return { ok: false, status: -1, stdout: '', stderr: 'ZeroTier CLI 未安装' };
  let res;
  if (cli.kind === 'exe') {
    res = spawnSync(cli.path, ['-q', ...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  } else if (cli.kind === 'bat') {
    res = spawnSync('cmd.exe', ['/d', '/s', '/c', '"' + cli.path + '" ' + args.join(' ')], {
      encoding: 'utf8', timeout: timeoutMs, windowsHide: true
    });
  } else {
    res = spawnSync(cli.path, args, { encoding: 'utf8', timeout: timeoutMs });
  }
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function firstIpv4FromAssigned(list) {
  const arr = Array.isArray(list) ? list : String(list || '').split(',');
  for (const item of arr) {
    const ip = String(item || '').trim().split('/')[0].trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  }
  return '';
}

function parseListNetworks(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) {
        return arr.map(n => {
          const assigned = Array.isArray(n.assignedAddresses) ? n.assignedAddresses : [];
          return {
            nwid: String(n.nwid || n.id || '').toLowerCase(),
            name: String(n.name || ''),
            mac: String(n.mac || ''),
            status: String(n.status || 'UNKNOWN'),
            type: String(n.type || ''),
            dev: String(n.portDeviceName || ''),
            ips: assigned,
            ipv4: firstIpv4FromAssigned(assigned)
          };
        }).filter(n => n.nwid);
      }
    } catch { }
  }

  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /<nwid>/i.test(trimmed)) continue;
    const m = /^200\s+listnetworks\s+([0-9a-f]{16})\s+(.*?)\s+([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/i.exec(trimmed);
    if (!m) continue;
    const rawIps = m[7].trim() === '-' ? [] : m[7].trim().split(',').map(s => s.trim()).filter(Boolean);
    out.push({
      nwid: m[1].toLowerCase(),
      name: m[2].trim(),
      mac: m[3],
      status: m[4],
      type: m[5],
      dev: m[6],
      ips: rawIps,
      ipv4: firstIpv4FromAssigned(rawIps)
    });
  }
  return out;
}

function parseInfo(rawText) {
  const text = String(rawText || '').trim();
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      return {
        nodeId: String(obj.address || '').toLowerCase(),
        version: String(obj.version || ''),
        online: Boolean(obj.online)
      };
    } catch { }
  }
  const m = /200\s+info\s+([0-9a-f]{10})\s+(\S+)\s+(\S+)/i.exec(text);
  if (m) {
    return {
      nodeId: m[1].toLowerCase(),
      version: m[2],
      online: /^online$/i.test(m[3])
    };
  }
  return { nodeId: '', version: '', online: false };
}

function getLocalStatus(overrideNetworkId) {
  const networkId = normalizeNetworkId(overrideNetworkId) || getConfiguredNetworkId();
  const centralUrl = networkId ? ('https://my.zerotier.com/network/' + networkId) : 'https://my.zerotier.com/';
  const cli = findLocalCli();
  if (!cli) {
    return {
      ok: true,
      installed: false,
      cliPath: '',
      nodeId: '',
      version: '',
      online: false,
      networkId,
      joined: false,
      status: 'NOT_INSTALLED',
      networkName: '',
      ip: '',
      networks: [],
      centralUrl,
      downloadUrl: DOWNLOAD_URL
    };
  }

  let infoRes = runLocalCli(cli, ['-j', 'info']);
  if (!infoRes.ok || !infoRes.stdout.trim()) infoRes = runLocalCli(cli, ['info']);
  const info = parseInfo(infoRes.stdout);

  let netRes = runLocalCli(cli, ['-j', 'listnetworks']);
  if (!netRes.ok || !netRes.stdout.trim()) netRes = runLocalCli(cli, ['listnetworks']);
  const networks = parseListNetworks(netRes.stdout);

  const authError = /401|authtoken|permission|access denied|cannot open/i.test((infoRes.stderr || '') + ' ' + (netRes.stderr || ''));
  const target = networkId ? (networks.find(n => n.nwid === networkId) || null) : null;
  const computedStatus = authError
    ? 'NEED_PERMISSION'
    : (!networkId ? 'UNCONFIGURED' : (target ? target.status : 'NOT_JOINED'));

  return {
    ok: true,
    installed: true,
    cliPath: cli.path,
    nodeId: info.nodeId,
    version: info.version,
    online: info.online,
    networkId,
    joined: Boolean(target),
    status: computedStatus,
    networkName: target ? target.name : '',
    ip: target ? target.ipv4 : '',
    networks,
    centralUrl,
    downloadUrl: DOWNLOAD_URL,
    permissionHint: authError
      ? (IS_WIN ? '需要管理员权限访问 ZeroTier 服务（或以管理员启动控制台）' : '请确认当前用户可访问 ZeroTier 服务')
      : ''
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function joinLocal(rawNetworkId) {
  const candidate = normalizeNetworkId(rawNetworkId) || getConfiguredNetworkId();
  if (!candidate) {
    throw new Error('请先输入你的 16 位 ZeroTier 组号（可在 my.zerotier.com 创建网络获取）');
  }
  const networkId = saveNetworkId(candidate);
  const cli = findLocalCli();
  if (!cli) {
    return Object.assign(getLocalStatus(networkId), {
      ok: false,
      notInstalled: true,
      error: '本机尚未安装 ZeroTier One，请先下载安装后再点击一键入组。'
    });
  }

  const joinRes = runLocalCli(cli, ['join', networkId], 12000);
  if (!joinRes.ok && !/200\s+join\s+OK/i.test(joinRes.stdout)) {
    const detail = (joinRes.stderr || joinRes.stdout || '').trim();
    return Object.assign(getLocalStatus(networkId), {
      ok: false,
      error: detail || '加入 ZeroTier 组失败，请检查 ZeroTier 服务状态与权限'
    });
  }

  let status = getLocalStatus(networkId);
  for (let i = 0; i < 4; i += 1) {
    if (status.status === 'OK' && status.ip) break;
    await sleep(900);
    status = getLocalStatus(networkId);
  }

  let message = '';
  if (status.status === 'OK' && status.ip) {
    message = '本机已接入 ZeroTier 组 ' + networkId + '，内网穿透 IP：' + status.ip;
  } else if (status.status === 'ACCESS_DENIED') {
    message = '已发送入组请求（本机节点 ID：' + (status.nodeId || '未知') + '），请在 ZeroTier 网页控制台勾选 Auth 授权该节点后点击刷新。';
  } else {
    message = '已加入 ZeroTier 组 ' + networkId + '（当前状态：' + status.status + '），稍候几秒点击刷新即可看到分配的 IP。';
  }
  return Object.assign(status, { ok: true, message });
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
    }, Number(timeoutMs) || 90000);
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', e => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    child.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const line = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop();
      if (!line) { reject(new Error(err.trim() || 'SSH 桥接无输出')); return; }
      try {
        const payload = JSON.parse(line);
        if (!payload.ok) reject(new Error(String(payload.error || 'SSH 操作失败')));
        else resolve(payload);
      } catch {
        reject(new Error('SSH 返回格式错误'));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function updateDeviceZerotierInfo(deviceId, info, preferZerotier) {
  const raw = readJson(DEVICES_FILE);
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.devices) ? raw.devices : []);
  const idx = list.findIndex(d => d && d.id === deviceId);
  if (idx < 0) return null;
  const dev = list[idx];
  if (info.nodeId) dev.zerotierNodeId = info.nodeId;
  if (info.status) dev.zerotierStatus = info.status;
  if (info.networkId) dev.zerotierNetworkId = info.networkId;
  if (info.ip) {
    dev.zerotierIp = info.ip;
    // ssh-dial 自动按「局域网 -> Tailscale -> ZeroTier」顺序尝试 [host, fallbackHost, zerotierIp]，
    // 因此保留已有的局域网 host 与 Tailscale fallbackHost，只在两者都缺失时才补写 host。
    if (!String(dev.host || '').trim()) {
      dev.host = info.ip;
    } else if (preferZerotier && String(dev.host || '').trim() !== info.ip) {
      if (!dev.fallbackHost) dev.fallbackHost = dev.host;
      dev.host = info.ip;
    }
  }
  dev.updatedAt = new Date().toISOString();
  writeJson(DEVICES_FILE, { version: 1, devices: list });
  return dev;
}

async function remoteJoinDevice(deviceId, rawNetworkId, opts) {
  const options = opts || {};
  const networkId = normalizeNetworkId(rawNetworkId) || getConfiguredNetworkId();
  if (!networkId) {
    throw new Error('请先在上方 ZeroTier 栏输入并保存你自己的 16 位 ZeroTier 组号');
  }
  const autoInstall = options.autoInstall !== false;
  const centralUrl = 'https://my.zerotier.com/network/' + networkId;

  const probe = await bridge({ op: 'probe', deviceId, timeoutMs: 25000 }, 30000);
  const osName = probe.os === 'windows' ? 'windows' : 'posix';

  let script;
  if (osName === 'windows') {
    script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)",
      "$nwid = '" + networkId + "'",
      "$autoInstall = " + (autoInstall ? '$true' : '$false'),
      "function Find-ZT {",
      "  foreach ($p in @('C:\\Program Files (x86)\\ZeroTier\\One\\zerotier-one_x64.exe','C:\\Program Files\\ZeroTier\\One\\zerotier-one_x64.exe','C:\\ProgramData\\ZeroTier\\One\\zerotier-one_x64.exe')) {",
      "    if (Test-Path -LiteralPath $p) { return $p }",
      "  }",
      "  return ''",
      "}",
      "$zt = Find-ZT",
      "$installedNow = $false; $installErr = ''",
      "if (-not $zt -and $autoInstall) {",
      "  try {",
      "    $wg = (Get-Command winget.exe -ErrorAction SilentlyContinue).Source",
      "    if ($wg) { & $wg install --id ZeroTier.ZeroTierOne -e --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null }",
      "    $zt = Find-ZT",
      "    if (-not $zt) {",
      "      $msi = Join-Path $env:TEMP 'ZeroTierOne.msi'",
      "      Invoke-WebRequest -UseBasicParsing -Uri 'https://download.zerotier.com/dist/ZeroTier%20One.msi' -OutFile $msi -TimeoutSec 60",
      "      $p = Start-Process msiexec.exe -ArgumentList @('/i', $msi, '/qn', '/norestart') -Wait -PassThru",
      "      if ($p.ExitCode -eq 0 -or $p.ExitCode -eq 3010) { $installedNow = $true } else { $installErr = 'msiexec exit ' + $p.ExitCode }",
      "      Start-Sleep -Seconds 3",
      "      $zt = Find-ZT",
      "    } else { $installedNow = $true }",
      "  } catch { $installErr = $_.Exception.Message }",
      "}",
      "if (-not $zt) {",
      "  $out = @{ ok=$false; installed=$false; status='NOT_INSTALLED'; networkId=$nwid; error=($(if($installErr){'自动安装 ZeroTier 失败: ' + $installErr}else{'客机未安装 ZeroTier One'})) }",
      "  'SMAC_ZT_RESULT ' + ($out | ConvertTo-Json -Compress); exit 0",
      "}",
      "$svc = Get-Service -Name 'ZeroTierOneService' -ErrorAction SilentlyContinue",
      "if ($svc -and $svc.Status -ne 'Running') { try { Start-Service -Name 'ZeroTierOneService' } catch { }; Start-Sleep -Seconds 2 }",
      "& $zt -q join $nwid 2>&1 | Out-Null",
      "$nodeId=''; $online=$false; $status='NOT_JOINED'; $netName=''; $ip=''",
      "for ($i=0; $i -lt 5; $i++) {",
      "  $infoRaw = (& $zt -q info 2>&1 | Out-String)",
      "  if ($infoRaw -match '200\\s+info\\s+([0-9a-f]{10})\\s+\\S+\\s+(\\S+)') { $nodeId=$Matches[1].ToLower(); $online=($Matches[2] -ieq 'ONLINE') }",
      "  $netsRaw = (& $zt -q -j listnetworks 2>&1 | Out-String).Trim()",
      "  if ($netsRaw.StartsWith('[')) {",
      "    try {",
      "      $arr = $netsRaw | ConvertFrom-Json",
      "      $hit = @($arr | Where-Object { ([string]$_.nwid).ToLower() -eq $nwid -or ([string]$_.id).ToLower() -eq $nwid }) | Select-Object -First 1",
      "      if ($hit) {",
      "        $status = [string]$hit.status; $netName = [string]$hit.name",
      "        foreach ($a in @($hit.assignedAddresses)) { $cand = ([string]$a).Split('/')[0]; if ($cand -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$') { $ip = $cand; break } }",
      "      }",
      "    } catch { }",
      "  }",
      "  if ($status -eq 'OK' -and $ip) { break }",
      "  Start-Sleep -Milliseconds 900",
      "}",
      "$out = @{ ok=$true; installed=$true; installedNow=$installedNow; nodeId=$nodeId; online=$online; networkId=$nwid; status=$status; networkName=$netName; ip=$ip }",
      "'SMAC_ZT_RESULT ' + ($out | ConvertTo-Json -Compress)"
    ].join('\n');
  } else {
    script = [
      'export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/sbin:/Applications/ZeroTier.app/Contents/MacOS:$PATH"',
      'NWID="' + networkId + '"',
      'ZT=$(command -v zerotier-cli 2>/dev/null || true)',
      'INSTALLED_NOW=0',
      'if [ -z "$ZT" ] && [ "' + (autoInstall ? '1' : '0') + '" = "1" ]; then',
      '  if command -v brew >/dev/null 2>&1; then brew install --cask zerotier-one >/dev/null 2>&1 || true; fi',
      '  ZT=$(command -v zerotier-cli 2>/dev/null || true)',
      '  [ -n "$ZT" ] && INSTALLED_NOW=1',
      'fi',
      'if [ -z "$ZT" ]; then echo \'SMAC_ZT_RESULT {"ok":false,"installed":false,"status":"NOT_INSTALLED","networkId":"' + networkId + '","error":"远端未安装 ZeroTier One"}\'; exit 0; fi',
      '"$ZT" join "$NWID" >/dev/null 2>&1 || true',
      'sleep 2',
      'INFO_OUT=$("$ZT" info 2>&1 || true)',
      'NETS_OUT=$("$ZT" -j listnetworks 2>&1 || "$ZT" listnetworks 2>&1 || true)',
      'node -e \'const info=process.argv[1],nets=process.argv[2],nwid=process.argv[3],instNow=process.argv[4]==="1";let nodeId="",online=false;const im=/200\\s+info\\s+([0-9a-f]{10})\\s+\\S+\\s+(\\S+)/i.exec(info);if(im){nodeId=im[1].toLowerCase();online=/online/i.test(im[2]);}let status="NOT_JOINED",netName="",ip="";try{const arr=JSON.parse(nets);const hit=(arr||[]).find(x=>String(x.nwid||x.id||"").toLowerCase()===nwid);if(hit){status=String(hit.status||"");netName=String(hit.name||"");for(const a of (hit.assignedAddresses||[])){const c=String(a).split("/")[0];if(/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(c)){ip=c;break;}}}}catch{for(const l of nets.split(/\\r?\\n/)){const m=/^200\\s+listnetworks\\s+([0-9a-f]{16})\\s+(.*?)\\s+[0-9a-f:]{17}\\s+(\\S+)\\s+\\S+\\s+\\S+\\s+(.+)$/i.exec(l.trim());if(m&&m[1].toLowerCase()===nwid){netName=m[2].trim();status=m[3];for(const a of m[4].split(",")){const c=a.trim().split("/")[0];if(/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(c)){ip=c;break;}}}}}console.log("SMAC_ZT_RESULT "+JSON.stringify({ok:true,installed:true,installedNow:instNow,nodeId,online,networkId:nwid,status,networkName:netName,ip}));\' "$INFO_OUT" "$NETS_OUT" "$NWID" "$INSTALLED_NOW"'
    ].join('\n');
  }

  const res = await bridge({ op: 'exec', deviceId, os: osName, script, timeoutMs: 120000 }, 130000);
  const line = String(res.stdout || '').split(/\r?\n/).map(s => s.trim()).find(s => s.startsWith('SMAC_ZT_RESULT '));
  if (!line) {
    throw new Error('远端 ZeroTier 探测未返回有效结果');
  }
  const parsed = JSON.parse(line.slice('SMAC_ZT_RESULT '.length));
  if (parsed.ok) {
    updateDeviceZerotierInfo(deviceId, parsed, Boolean(options.preferZerotier));
  }

  let message = '';
  if (!parsed.installed) {
    message = parsed.error || '远端未安装 ZeroTier One，请先在客机安装 ZeroTier 或用客机安装包一键安装。';
  } else if (parsed.status === 'OK' && parsed.ip) {
    message = '客机已接入同组 ZeroTier (' + networkId + ')，分配 IP：' + parsed.ip + '，已自动更新设备连接地址！';
  } else if (parsed.status === 'ACCESS_DENIED') {
    message = '客机已请求入组（节点 ID：' + (parsed.nodeId || '未知') + '），请在 ZeroTier 控制台勾选 Auth 授权后再次点击即可自动回填 IP。';
  } else {
    message = '客机已执行入组（状态：' + (parsed.status || 'UNKNOWN') + '，节点 ID：' + (parsed.nodeId || '未知') + '）。';
  }

  return Object.assign(parsed, { centralUrl, message });
}

module.exports = {
  DEFAULT_NETWORK_ID,
  DOWNLOAD_URL,
  normalizeNetworkId,
  getConfiguredNetworkId,
  saveNetworkId,
  getLocalStatus,
  joinLocal,
  remoteJoinDevice,
  updateDeviceZerotierInfo
};
