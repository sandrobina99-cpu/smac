'use strict';

// Cross-platform (macOS / Linux) pure Node.js Host Engine for smac.
// Provides 100% feature parity with smac.ps1 on Windows:
// - Bidirectional three-way folder sync over ssh2/SFTP (with conflict preservation & safe trash)
// - Send files/folders to target Guest desktop + remote desktop listing
// - Clipboard bidirectional sync (pbpaste/pbcopy <-> Windows/macOS remote clipboard)
// - Background sync/clip daemons + macOS LaunchAgent login auto-start
// - Native macOS Finder dialogs (osascript) & reveal in Finder (open)

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const remote = require('./remote');
const clipboardSync = require('./clipboard-sync');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
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
const BRIDGE = path.join(__dirname, 'ssh-bridge.js');
const LAUNCH_AGENTS_DIR = path.join(USER_HOME, 'Library', 'LaunchAgents');
const SYNC_PLIST = path.join(LAUNCH_AGENTS_DIR, 'com.smac.sync.plist');
const CLIP_PLIST = path.join(LAUNCH_AGENTS_DIR, 'com.smac.clip.plist');

const IGNORE_NAMES = new Set([
  '.DS_Store', 'Thumbs.db', 'desktop.ini', '.Spotlight-V100', '.Trashes',
  '.fseventsd', '$RECYCLE.BIN', 'System Volume Information', '.smac-trash'
]);

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

function safeName(name) {
  const cleaned = String(name || '').replace(/[^\p{L}\p{N}_.\-]/gu, '_');
  return cleaned || 'sync';
}

function expandHome(value) {
  const text = String(value || '').trim();
  if (text === '~') return USER_HOME;
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(USER_HOME, text.slice(2));
  return text;
}

function stamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function appendLog(file, line) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(file, stamp() + ' | ' + line + '\n', 'utf8');
  } catch { }
}

function readPid(file) {
  try {
    const v = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(v) ? v : 0;
  } catch { return 0; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readConfig() {
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

function saveConfig(cfg) {
  writeJson(CONFIG_FILE, cfg);
}

function resolveDefaultDevice(config) {
  const devices = remote.listDevices();
  if (!devices.length) return null;
  if (config.defaultDeviceId) {
    const found = devices.find(d => d.id === config.defaultDeviceId);
    if (found) return found;
  }
  if (config.host || config.lanHost) {
    const match = devices.find(d => d.host === config.lanHost || d.host === config.host || d.fallbackHost === config.host);
    if (match) return match;
  }
  return devices[0];
}

function resolveDeviceById(deviceId) {
  const devices = remote.listDevices();
  const id = String(deviceId || '').trim();
  if (id) {
    return devices.find(d => d.id === id || d.name === id) || null;
  }
  return resolveDefaultDevice(readConfig());
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
    }, Number(timeoutMs) || 180000);
    child.stdout.on('data', chunk => { out += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { err += chunk.toString('utf8'); });
    child.on('error', error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const line = out.split(/\r?\n/).map(t => t.trim()).filter(Boolean).pop();
      if (!line) { reject(new Error(err.trim() || 'SSH 桥接无输出')); return; }
      let payload;
      try { payload = JSON.parse(line); }
      catch { reject(new Error('SSH 桥接返回格式错误')); return; }
      if (!payload.ok) {
        reject(new Error(String(payload.error || payload.stderr || payload.stdout || 'SSH 操作失败').trim()));
        return;
      }
      resolve(payload);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function shouldIgnore(name) {
  if (!name) return true;
  if (IGNORE_NAMES.has(name)) return true;
  if (name.startsWith('~$') || name.startsWith('._') || name.includes('.smac-tmp-') || name.startsWith('.smac-')) return true;
  if (name.endsWith('.crdownload') || name.endsWith('.part') || name.endsWith('.tmp')) return true;
  return false;
}

function scanLocalDir(rootDir) {
  const map = new Map();
  if (!fs.existsSync(rootDir)) return map;
  const walk = (dir, relBase, depth) => {
    if (depth > 24) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (shouldIgnore(ent.name)) continue;
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      const rel = relBase ? relBase + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        walk(full, rel, depth + 1);
      } else if (ent.isFile()) {
        try {
          const st = fs.statSync(full);
          map.set(rel, { size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
        } catch { }
      }
    }
  };
  walk(rootDir, '', 0);
  return map;
}

async function resolveRemoteDirPath(deviceId, osName, rawRemotePath) {
  let target = String(rawRemotePath || '').trim().replace(/\\/g, '/');
  if (!target) return '';
  if (osName === 'windows') {
    if (target === '~' || target.startsWith('~/')) {
      const sub = target.slice(2);
      const res = await bridge({
        op: 'exec', deviceId, os: 'windows',
        script: "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $p = Join-Path $env:USERPROFILE '" + sub.replace(/'/g, "''") + "'; $p.Replace('\\','/')",
        timeoutMs: 30000
      });
      return String(res.stdout || '').trim().split(/\r?\n/).pop().replace(/\/+$/, '');
    }
    return target.replace(/\/+$/, '');
  }
  if (target === '~' || target.startsWith('~/')) {
    const sub = target.slice(2);
    const res = await bridge({
      op: 'exec', deviceId, os: 'posix',
      script: 'printf "%s\\n" "$HOME"',
      timeoutMs: 30000
    });
    const home = String(res.stdout || '').trim().split(/\r?\n/).pop().replace(/\/+$/, '');
    return sub ? home + '/' + sub.replace(/^\/+/, '') : home;
  }
  return target.replace(/\/+$/, '');
}

async function scanRemoteDir(deviceId, osName, remoteRoot) {
  const safeRoot = String(remoteRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
  let res;
  if (osName === 'windows') {
    const ps = [
      "$ErrorActionPreference='SilentlyContinue'",
      "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)",
      "$root = '" + safeRoot.replace(/'/g, "''") + "'",
      "if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Force -Path $root | Out-Null; 'SMAC_SCAN []'; exit 0 }",
      "$rootNorm = (Get-Item -LiteralPath $root -Force).FullName.TrimEnd('\\','/')",
      "$items = @()",
      "Get-ChildItem -LiteralPath $rootNorm -Recurse -File -Force | ForEach-Object {",
      "  $rel = $_.FullName.Substring($rootNorm.Length).TrimStart('\\','/').Replace('\\','/')",
      "  $epoch = [int64](New-TimeSpan -Start (Get-Date '1970-01-01Z') -End $_.LastWriteTimeUtc).TotalSeconds",
      "  $items += ($rel + \"`t\" + $_.Length + \"`t\" + $epoch)",
      "}",
      "'SMAC_SCAN_B64 ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($items -join \"`n\")))"
    ].join('\n');
    res = await bridge({ op: 'exec', deviceId, os: 'windows', script: ps, timeoutMs: 120000 });
  } else {
    const py = [
      'import os, sys, base64',
      'root = sys.argv[1]',
      'os.makedirs(root, exist_ok=True)',
      'lines = []',
      'for dp, dns, fns in os.walk(root):',
      '    dns[:] = [d for d in dns if d not in (".Spotlight-V100",".Trashes",".fseventsd",".smac-trash") and not d.startswith(".smac-")]',
      '    for fn in fns:',
      '        full = os.path.join(dp, fn)',
      '        if os.path.islink(full): continue',
      '        try:',
      '            st = os.stat(full)',
      '            rel = os.path.relpath(full, root).replace(os.sep, "/")',
      '            lines.append(f"{rel}\\t{st.st_size}\\t{int(st.st_mtime)}")',
      '        except Exception: pass',
      'print("SMAC_SCAN_B64 " + base64.b64encode("\\n".join(lines).encode("utf-8")).decode("ascii"))'
    ].join('\n');
    const sh = 'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; python3 -c ' + JSON.stringify(py) + ' ' + JSON.stringify(safeRoot);
    res = await bridge({ op: 'exec', deviceId, os: 'posix', script: sh, timeoutMs: 120000 });
  }
  const map = new Map();
  const out = String(res.stdout || '');
  const line = out.split(/\r?\n/).map(s => s.trim()).find(s => s.startsWith('SMAC_SCAN_B64 '));
  if (!line) return map;
  const decoded = Buffer.from(line.slice('SMAC_SCAN_B64 '.length), 'base64').toString('utf8');
  for (const row of decoded.split(/\r?\n/)) {
    if (!row) continue;
    const parts = row.split('\t');
    if (parts.length < 3) continue;
    const rel = parts[0];
    const base = rel.split('/').pop();
    if (shouldIgnore(base)) continue;
    if (rel.split('/').some(seg => IGNORE_NAMES.has(seg))) continue;
    map.set(rel, { size: Number(parts[1]) || 0, mtime: Number(parts[2]) || 0 });
  }
  return map;
}

function trashLocalFile(fullPath) {
  try {
    if (!fs.existsSync(fullPath)) return;
    const trashDir = IS_MAC ? path.join(USER_HOME, '.Trash') : path.join(DATA_DIR, 'trash');
    fs.mkdirSync(trashDir, { recursive: true });
    const base = path.basename(fullPath);
    let dest = path.join(trashDir, base);
    if (fs.existsSync(dest)) {
      const ext = path.extname(base);
      const stem = path.basename(base, ext);
      dest = path.join(trashDir, stem + '-' + Date.now() + ext);
    }
    try { fs.renameSync(fullPath, dest); }
    catch {
      fs.copyFileSync(fullPath, dest);
      fs.rmSync(fullPath, { force: true });
    }
  } catch { }
}

async function trashRemoteFile(deviceId, osName, remoteRoot, rel) {
  const full = remoteRoot.replace(/\/+$/, '') + '/' + rel;
  if (osName === 'windows') {
    const trashDir = remoteRoot.replace(/\/+$/, '') + '/.smac-trash';
    const ps = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$src = '" + full.replace(/'/g, "''") + "'",
      "if (Test-Path -LiteralPath $src) {",
      "  $td = '" + trashDir.replace(/'/g, "''") + "'",
      "  New-Item -ItemType Directory -Force -Path $td | Out-Null",
      "  $dst = Join-Path $td ((Get-Date -Format 'yyyyMMddHHmmss') + '_' + [IO.Path]::GetFileName($src))",
      "  Move-Item -LiteralPath $src -Destination $dst -Force",
      "}",
      "'SMAC_OK'"
    ].join('\n');
    await bridge({ op: 'exec', deviceId, os: 'windows', script: ps, timeoutMs: 30000 });
  } else {
    const sh = 'src=' + JSON.stringify(full) + '; if [ -f "$src" ]; then mkdir -p "$HOME/.Trash"; mv "$src" "$HOME/.Trash/$(date +%s)_$(basename "$src")" 2>/dev/null || rm -f "$src"; fi; echo SMAC_OK';
    await bridge({ op: 'exec', deviceId, os: 'posix', script: sh, timeoutMs: 30000 });
  }
}

function conflictPath(rel, tag) {
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel);
  const ext = path.posix.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  const d = new Date();
  const ts = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0')
    + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0');
  const next = stem + '.conflict-' + tag + '-' + ts + ext;
  return dir === '.' ? next : dir + '/' + next;
}

async function syncOnePair(pair, onLog) {
  const logLine = text => {
    appendLog(SYNC_LOG, text);
    if (onLog) onLog(text);
  };
  const device = resolveDeviceById(pair.deviceId);
  if (!device) {
    throw new Error('同步目录 ' + pair.name + ' 对应的远程设备不存在');
  }
  const localRoot = expandHome(pair.local);
  fs.mkdirSync(localRoot, { recursive: true });

  const probe = await bridge({ op: 'probe', deviceId: device.id, timeoutMs: 30000 });
  const osName = probe.os === 'windows' ? 'windows' : 'posix';
  const remoteRoot = await resolveRemoteDirPath(device.id, osName, pair.remote);

  const stateFile = path.join(DATA_DIR, 'sync-state-' + safeName(pair.name) + '.json');
  const prevState = readJson(stateFile);
  const prevFiles = (prevState && prevState.files && typeof prevState.files === 'object') ? prevState.files : {};
  const isFirstRun = Object.keys(prevFiles).length === 0;

  const localMap = scanLocalDir(localRoot);
  const remoteMap = await scanRemoteDir(device.id, osName, remoteRoot);

  const allKeys = new Set([...localMap.keys(), ...remoteMap.keys(), ...Object.keys(prevFiles)]);
  const nextFiles = {};
  let uploaded = 0;
  let downloaded = 0;
  let deleted = 0;
  let conflicts = 0;
  let errors = 0;
  const propagateDeletes = pair.propagateDeletes !== false;

  const unchangedLocal = (cur, prev) => cur && prev && cur.size === Number(prev.ls) && Math.abs(cur.mtime - Number(prev.lt)) <= 2;
  const unchangedRemote = (cur, prev) => cur && prev && cur.size === Number(prev.rs) && Math.abs(cur.mtime - Number(prev.rt)) <= 2;

  for (const rel of allKeys) {
    const loc = localMap.get(rel) || null;
    const rem = remoteMap.get(rel) || null;
    const prev = prevFiles[rel] || null;
    const localFull = path.join(localRoot, ...rel.split('/'));
    const remoteFull = remoteRoot + '/' + rel;

    try {
      if (loc && rem) {
        // Both sides exist
        if (prev) {
          const lSame = unchangedLocal(loc, prev);
          const rSame = unchangedRemote(rem, prev);
          if (lSame && rSame) {
            nextFiles[rel] = { ls: loc.size, lt: loc.mtime, rs: rem.size, rt: rem.mtime };
          } else if (!lSame && rSame) {
            await bridge({ op: 'upload', deviceId: device.id, os: osName, local: localFull, remote: remoteFull, timeoutMs: 300000 });
            uploaded += 1;
            const nowSec = Math.floor(Date.now() / 1000);
            nextFiles[rel] = { ls: loc.size, lt: loc.mtime, rs: loc.size, rt: nowSec };
            logLine('UP | ' + pair.name + ' | ' + rel);
          } else if (lSame && !rSame) {
            await bridge({ op: 'download', deviceId: device.id, os: osName, remote: remoteFull, local: localFull, timeoutMs: 300000 });
            const st = fs.statSync(localFull);
            downloaded += 1;
            nextFiles[rel] = { ls: st.size, lt: Math.floor(st.mtimeMs / 1000), rs: rem.size, rt: rem.mtime };
            logLine('DOWN | ' + pair.name + ' | ' + rel);
          } else if (loc.size === rem.size && Math.abs(loc.mtime - rem.mtime) <= 3) {
            nextFiles[rel] = { ls: loc.size, lt: loc.mtime, rs: rem.size, rt: rem.mtime };
          } else {
            // Both modified: preserve remote copy as conflict file and upload local copy
            const cRel = conflictPath(rel, device.name || 'remote');
            const cLocal = path.join(localRoot, ...cRel.split('/'));
            await bridge({ op: 'download', deviceId: device.id, os: osName, remote: remoteFull, local: cLocal, timeoutMs: 300000 });
            await bridge({ op: 'upload', deviceId: device.id, os: osName, local: localFull, remote: remoteFull, timeoutMs: 300000 });
            conflicts += 1;
            const nowSec = Math.floor(Date.now() / 1000);
            nextFiles[rel] = { ls: loc.size, lt: loc.mtime, rs: loc.size, rt: nowSec };
            logLine('CONFLICT | ' + pair.name + ' | ' + rel + ' -> ' + cRel);
          }
        } else {
          // First sync / untracked on both sides
          if (loc.size === rem.size && (isFirstRun || Math.abs(loc.mtime - rem.mtime) <= 5)) {
            nextFiles[rel] = { ls: loc.size, lt: loc.mtime, rs: rem.size, rt: rem.mtime };
          } else if (loc.mtime >= rem.mtime) {
            await bridge({ op: 'upload', deviceId: device.id, os: osName, local: localFull, remote: remoteFull, timeoutMs: 300000 });
            uploaded += 1;
            const nowSec = Math.floor(Date.now() / 1000);
            nextFiles[rel] = { ls: loc.size, lt: loc.mtime, rs: loc.size, rt: nowSec };
            logLine('UP | ' + pair.name + ' | ' + rel);
          } else {
            await bridge({ op: 'download', deviceId: device.id, os: osName, remote: remoteFull, local: localFull, timeoutMs: 300000 });
            const st = fs.statSync(localFull);
            downloaded += 1;
            nextFiles[rel] = { ls: st.size, lt: Math.floor(st.mtimeMs / 1000), rs: rem.size, rt: rem.mtime };
            logLine('DOWN | ' + pair.name + ' | ' + rel);
          }
        }
      } else if (loc && !rem) {
        if (prev && propagateDeletes && unchangedLocal(loc, prev)) {
          trashLocalFile(localFull);
          deleted += 1;
          logLine('DEL-LOCAL | ' + pair.name + ' | ' + rel);
        } else {
          await bridge({ op: 'upload', deviceId: device.id, os: osName, local: localFull, remote: remoteFull, timeoutMs: 300000 });
          uploaded += 1;
          const nowSec = Math.floor(Date.now() / 1000);
          nextFiles[rel] = { ls: loc.size, lt: loc.mtime, rs: loc.size, rt: nowSec };
          logLine('UP | ' + pair.name + ' | ' + rel);
        }
      } else if (!loc && rem) {
        if (prev && propagateDeletes && unchangedRemote(rem, prev)) {
          await trashRemoteFile(device.id, osName, remoteRoot, rel);
          deleted += 1;
          logLine('DEL-REMOTE | ' + pair.name + ' | ' + rel);
        } else {
          await bridge({ op: 'download', deviceId: device.id, os: osName, remote: remoteFull, local: localFull, timeoutMs: 300000 });
          const st = fs.statSync(localFull);
          downloaded += 1;
          nextFiles[rel] = { ls: st.size, lt: Math.floor(st.mtimeMs / 1000), rs: rem.size, rt: rem.mtime };
          logLine('DOWN | ' + pair.name + ' | ' + rel);
        }
      }
    } catch (err) {
      errors += 1;
      logLine('ERR | ' + pair.name + ' | ' + rel + ' | ' + (err && err.message ? err.message : err));
      if (prev) nextFiles[rel] = prev;
    }
  }

  // Refresh final remote timestamps if we uploaded files, or save state cleanly
  writeJson(stateFile, {
    pair: pair.name,
    updatedAt: new Date().toISOString(),
    files: nextFiles
  });
  return {
    name: pair.name,
    device: device.name,
    host: probe.host,
    tracked: Object.keys(nextFiles).length,
    uploaded,
    downloaded,
    deleted,
    conflicts,
    errors
  };
}

async function syncNow(pairName, onLog) {
  const cfg = readConfig();
  const pairs = cfg.syncPairs.filter(p => p && p.name && p.enabled !== false && (!pairName || p.name === pairName));
  const startedAt = new Date().toISOString();
  const summary = {
    lastRunAt: startedAt,
    host: '',
    uploaded: 0,
    downloaded: 0,
    deleted: 0,
    conflicts: 0,
    errors: 0,
    offline: false,
    pairs: []
  };
  const lines = [];
  for (const pair of pairs) {
    try {
      const r = await syncOnePair(pair, onLog);
      summary.host = summary.host || r.host;
      summary.uploaded += r.uploaded;
      summary.downloaded += r.downloaded;
      summary.deleted += r.deleted;
      summary.conflicts += r.conflicts;
      summary.errors += r.errors;
      summary.pairs.push(r);
      const msg = '[OK] ' + pair.name + ' (' + r.device + '): 上传 ' + r.uploaded + ', 下载 ' + r.downloaded + ', 删除 ' + r.deleted + ', 追踪 ' + r.tracked;
      lines.push(msg);
      if (onLog) onLog(msg);
    } catch (err) {
      summary.errors += 1;
      const msg = '[X] ' + pair.name + ' 同步失败: ' + (err && err.message ? err.message : err);
      lines.push(msg);
      appendLog(SYNC_LOG, msg);
      if (onLog) onLog(msg);
    }
  }
  summary.lastRunAt = new Date().toISOString();
  writeJson(STATUS_FILE, summary);
  return { ok: summary.errors === 0, output: lines.join('\n') || '没有启用的同步文件夹', summary };
}

function addSyncPair({ local, remote: remotePath, name, deviceId }) {
  const cfg = readConfig();
  const resolvedLocal = expandHome(local);
  const folderName = path.basename(resolvedLocal.replace(/[\\/]+$/, '')) || 'sync';
  const targetName = String(name || folderName).trim();
  const dev = resolveDeviceById(deviceId);
  if (!dev) {
    return { ok: false, output: '请先在「远程设备 · 客机」里添加或接入至少一台远程设备' };
  }
  if (cfg.syncPairs.some(p => p && p.name === targetName)) {
    return { ok: false, output: '已存在同名同步文件夹: ' + targetName };
  }
  cfg.syncPairs.push({
    name: targetName,
    local: resolvedLocal,
    remote: String(remotePath || '').trim().replace(/\\/g, '/'),
    deviceId: dev.id,
    enabled: true,
    propagateDeletes: true
  });
  saveConfig(cfg);
  return { ok: true, output: '已添加同步文件夹 ' + targetName + ' (' + dev.name + ')' };
}

function removeSyncPair(name) {
  const cfg = readConfig();
  const before = cfg.syncPairs.length;
  cfg.syncPairs = cfg.syncPairs.filter(p => p && p.name !== name);
  if (cfg.syncPairs.length === before) return { ok: false, output: '未找到同步文件夹: ' + name };
  saveConfig(cfg);
  try { fs.rmSync(path.join(DATA_DIR, 'sync-state-' + safeName(name) + '.json'), { force: true }); } catch { }
  return { ok: true, output: '已移除同步文件夹 ' + name };
}

function enableSyncPair(name, enabled) {
  const cfg = readConfig();
  const pair = cfg.syncPairs.find(p => p && p.name === name);
  if (!pair) return { ok: false, output: '未找到同步文件夹: ' + name };
  pair.enabled = enabled !== false;
  saveConfig(cfg);
  return { ok: true, output: (pair.enabled ? '已启用 ' : '已暂停 ') + name };
}

function setConfigValue(key, value) {
  const cfg = readConfig();
  if (key === 'syncIntervalSeconds') cfg.syncIntervalSeconds = Number(value) || 20;
  else if (key === 'clipboardIntervalSeconds') cfg.clipboardIntervalSeconds = Number(value) || 2;
  else if (key === 'syncRemoteDir') cfg.syncRemoteDir = String(value || '~/Documents').trim();
  else if (key === 'remoteDir') cfg.remoteDir = String(value || '~/Desktop').trim();
  else return { ok: false, output: '不支持的配置项: ' + key };
  saveConfig(cfg);
  return { ok: true, output: '已保存设置 ' + key };
}

async function sendItems(pathsList, deviceId, onLog) {
  const device = resolveDeviceById(deviceId);
  if (!device) return { ok: false, output: '未找到目标设备，请先添加或接入设备' };
  const probe = await bridge({ op: 'probe', deviceId: device.id, timeoutMs: 30000 });
  const osName = probe.os === 'windows' ? 'windows' : 'posix';
  const desktopDir = await resolveRemoteDirPath(device.id, osName, '~/Desktop');
  const lines = [];
  let okCount = 0;
  let failCount = 0;

  for (const raw of pathsList) {
    const full = expandHome(raw);
    const base = path.basename(full.replace(/[\\/]+$/, ''));
    const target = desktopDir.replace(/\/+$/, '') + '/' + base;
    try {
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        const res = await bridge({ op: 'upload-tree', deviceId: device.id, os: osName, local: full, remote: target, timeoutMs: 3600000 });
        okCount += 1;
        const msg = '[OK] 已发送文件夹 ' + base + ' (' + (res.files || 0) + ' 个文件) -> ' + device.name + ':' + target;
        lines.push(msg);
        appendLog(HISTORY_LOG, 'OK | dir | ' + full + ' -> ' + device.name + ':' + target);
        if (onLog) onLog(msg);
      } else {
        await bridge({ op: 'upload', deviceId: device.id, os: osName, local: full, remote: target, timeoutMs: 3600000 });
        okCount += 1;
        const msg = '[OK] 已发送文件 ' + base + ' -> ' + device.name + ':' + target;
        lines.push(msg);
        appendLog(HISTORY_LOG, 'OK | file | ' + full + ' -> ' + device.name + ':' + target);
        if (onLog) onLog(msg);
      }
    } catch (err) {
      failCount += 1;
      const msg = '[X] 发送失败 ' + base + ': ' + (err && err.message ? err.message : err);
      lines.push(msg);
      appendLog(HISTORY_LOG, 'FAIL | ' + full + ' | ' + (err && err.message ? err.message : err));
      if (onLog) onLog(msg);
    }
  }
  return { ok: failCount === 0, output: lines.join('\n') };
}

async function remoteList(deviceId) {
  const device = resolveDeviceById(deviceId);
  if (!device) return { ok: false, output: '未找到目标设备' };
  const probe = await bridge({ op: 'probe', deviceId: device.id, timeoutMs: 30000 });
  const osName = probe.os === 'windows' ? 'windows' : 'posix';
  const desktopDir = await resolveRemoteDirPath(device.id, osName, '~/Desktop');
  if (osName === 'windows') {
    const ps = [
      "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)",
      "$d = '" + desktopDir.replace(/'/g, "''") + "'",
      "if (Test-Path -LiteralPath $d) { Get-ChildItem -LiteralPath $d | Format-Table Mode, Length, LastWriteTime, Name -AutoSize | Out-String -Width 160 } else { '(目录为空)' }"
    ].join('\n');
    const res = await bridge({ op: 'exec', deviceId: device.id, os: 'windows', script: ps, timeoutMs: 30000 });
    return { ok: true, output: device.name + ':' + desktopDir + '\n\n' + String(res.stdout || '').trim() };
  }
  const res = await bridge({
    op: 'exec', deviceId: device.id, os: 'posix',
    script: 'if [ -d ' + JSON.stringify(desktopDir) + ' ]; then ls -lh ' + JSON.stringify(desktopDir) + '; else echo "(目录为空)"; fi',
    timeoutMs: 30000
  });
  return { ok: true, output: device.name + ':' + desktopDir + '\n\n' + String(res.stdout || '').trim() };
}

// ---------- daemons & macOS LaunchAgents ----------

function startDaemon(kind) {
  const isClip = kind === 'clip';
  const pidFile = isClip ? CLIP_PID : WATCH_PID;
  const stopFile = path.join(DATA_DIR, isClip ? 'clip.stop' : 'watch.stop');
  const script = path.join(__dirname, isClip ? 'clip-daemon.js' : 'sync-daemon.js');
  const existing = readPid(pidFile);
  if (pidAlive(existing)) {
    return { ok: true, output: (isClip ? '剪贴板' : '同步') + '守护已在运行 (PID ' + existing + ')' };
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { fs.rmSync(stopFile, { force: true }); } catch { }
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid), 'ascii');
  return { ok: true, output: (isClip ? '剪贴板同步' : '文件同步') + '服务已启动' };
}

function stopDaemon(kind) {
  const isClip = kind === 'clip';
  const pidFile = isClip ? CLIP_PID : WATCH_PID;
  const stopFile = path.join(DATA_DIR, isClip ? 'clip.stop' : 'watch.stop');
  const pid = readPid(pidFile);
  try { fs.writeFileSync(stopFile, 'stop', 'ascii'); } catch { }
  if (pid && pidAlive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { }
    if (IS_WIN) {
      try { spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 4000 }); } catch { }
    }
  }
  try { fs.rmSync(pidFile, { force: true }); } catch { }
  return { ok: true, output: (isClip ? '剪贴板同步' : '文件同步') + '服务已停止' };
}

function buildPlist(label, scriptPath, logPath) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '  <key>Label</key><string>' + label + '</string>',
    '  <key>ProgramArguments</key><array>',
    '    <string>' + process.execPath + '</string>',
    '    <string>' + scriptPath + '</string>',
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>StandardOutPath</key><string>' + logPath + '</string>',
    '  <key>StandardErrorPath</key><string>' + logPath + '</string>',
    '</dict></plist>'
  ].join('\n');
}

function setAutoStart(kind, install) {
  const isClip = kind === 'clip';
  const plist = isClip ? CLIP_PLIST : SYNC_PLIST;
  const label = isClip ? 'com.smac.clip' : 'com.smac.sync';
  const script = path.join(__dirname, isClip ? 'clip-daemon.js' : 'sync-daemon.js');
  const log = isClip ? CLIP_LOG : SYNC_LOG;
  if (!IS_MAC) {
    return install ? startDaemon(kind) : stopDaemon(kind);
  }
  if (install) {
    fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
    fs.writeFileSync(plist, buildPlist(label, script, log), 'utf8');
    spawnSync('launchctl', ['unload', plist], { stdio: 'ignore' });
    spawnSync('launchctl', ['load', plist], { stdio: 'ignore' });
    return { ok: true, output: '已启用 macOS 开机自启 (' + label + ')' };
  }
  spawnSync('launchctl', ['unload', plist], { stdio: 'ignore' });
  try { fs.rmSync(plist, { force: true }); } catch { }
  stopDaemon(kind);
  return { ok: true, output: '已取消 macOS 开机自启' };
}

function hasAutoStart(kind) {
  if (!IS_MAC) return false;
  return fs.existsSync(kind === 'clip' ? CLIP_PLIST : SYNC_PLIST);
}

// ---------- clipboard sync (multi-device text & image via clipboard-sync.js) ----------

async function clipNow() {
  return clipboardSync.syncOnce();
}

// ---------- native macOS pickers & reveal ----------

function runOsascript(script) {
  return new Promise(resolve => {
    const child = spawn('osascript', ['-e', script]);
    let out = '';
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.on('close', code => resolve({ ok: code === 0, out: out.trim() }));
    child.on('error', () => resolve({ ok: false, out: '' }));
  });
}

async function pickFolder() {
  if (!IS_MAC) return { ok: false, path: '' };
  const r = await runOsascript('POSIX path of (choose folder with prompt "选择要同步的文件夹")');
  return { ok: r.ok, path: r.out.replace(/\/+$/, '') };
}

async function pickFile() {
  if (!IS_MAC) return { ok: false, files: [] };
  const script = 'set fs to choose file with prompt "选择要发送的文件" with multiple selections allowed\nset out to ""\nrepeat with f in fs\nset out to out & (POSIX path of f) & linefeed\nend repeat\nreturn out';
  const r = await runOsascript(script);
  const files = r.out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return { ok: r.ok, files };
}

async function pickKey() {
  if (!IS_MAC) return { ok: false, path: '' };
  const sshDir = path.join(USER_HOME, '.ssh');
  const script = 'POSIX path of (choose file with prompt "选择 SSH 私钥文件" default location (POSIX file "' + sshDir.replace(/"/g, '\\"') + '") with invisibles)';
  const r = await runOsascript(script);
  return { ok: r.ok, path: r.out };
}

function revealPath(target) {
  if (IS_MAC) {
    spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

module.exports = {
  readConfig,
  saveConfig,
  resolveDefaultDevice,
  syncNow,
  addSyncPair,
  removeSyncPair,
  enableSyncPair,
  setConfigValue,
  sendItems,
  remoteList,
  startDaemon,
  stopDaemon,
  setAutoStart,
  hasAutoStart,
  clipNow,
  pickFolder,
  pickFile,
  pickKey,
  revealPath
};
