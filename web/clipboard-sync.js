'use strict';

// Multi-device cross-platform clipboard sync engine for smac.
// Works on Windows, macOS, and Linux Hosts, syncing text & PNG images
// bidirectionally between Local Host and any user-selected subset of SSH devices
// (Windows / macOS / Linux) over ssh-bridge.js (LAN -> Tailscale -> ZeroTier).

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const remote = require('./remote');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const USER_HOME = process.env.USERPROFILE || os.homedir();
const DATA_DIR = path.join(USER_HOME, '.smac');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CLIP_STATUS_FILE = path.join(DATA_DIR, 'clip-status.json');
const CLIP_STATE_FILE = path.join(DATA_DIR, 'clipboard-multi-state.json');
const CLIP_LOG = path.join(DATA_DIR, 'clip.log');
const BRIDGE = path.join(__dirname, 'ssh-bridge.js');
const CACHE_DIR = path.join(os.tmpdir(), 'smac-clip-host-' + process.pid);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const WIN_AGENT_VERSION = '2026-11-23-v1';

const deviceOsCache = new Map(); // deviceId -> { osName: 'windows'|'macos'|'linux', at }
const localCache = { winSeq: null, macCc: null, item: null };
const remoteChangeCache = new Map(); // deviceId -> { token: string, item: object }

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  return CACHE_DIR;
}

function cleanupCache() {
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch { }
}

process.on('exit', cleanupCache);

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
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      if (fs.existsSync(CLIP_LOG) && fs.statSync(CLIP_LOG).size > 2 * 1024 * 1024) {
        fs.renameSync(CLIP_LOG, CLIP_LOG + '.1');
      }
    } catch { }
    fs.appendFileSync(CLIP_LOG, stamp() + ' | ' + line + '\n', 'utf8');
  } catch { }
}

function normalizeText(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function textSig(text) {
  const norm = normalizeText(text);
  return 'text:' + sha256Buf(Buffer.from(norm, 'utf8'));
}

function imageSig(buf) {
  return 'image:' + sha256Buf(buf);
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function readConfig() {
  return readJson(CONFIG_FILE) || {};
}

function getSelectedDeviceIds(config) {
  const cfg = config || readConfig();
  const devices = remote.listDevices();
  const validIds = new Set(devices.map(d => d.id));
  if (Array.isArray(cfg.clipboardDeviceIds)) {
    return cfg.clipboardDeviceIds.map(id => String(id || '').trim()).filter(id => validIds.has(id));
  }
  if (!devices.length) return [];
  if (cfg.defaultDeviceId && validIds.has(cfg.defaultDeviceId)) return [cfg.defaultDeviceId];
  if (cfg.lanHost || cfg.host) {
    const match = devices.find(d => d.host === cfg.lanHost || d.host === cfg.host || d.fallbackHost === cfg.host);
    if (match) return [match.id];
  }
  return [devices[0].id];
}

function resolveSelectedDevices(config) {
  const devices = remote.listDevices();
  const byId = new Map(devices.map(d => [d.id, d]));
  return getSelectedDeviceIds(config).map(id => byId.get(id)).filter(Boolean);
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
      catch { reject(new Error('SSH 返回格式错误')); return; }
      if (!payload.ok) {
        reject(new Error(String(payload.error || payload.stderr || payload.stdout || 'SSH 操作失败').trim()));
        return;
      }
      resolve(payload);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

// ---------- Local clipboard (Windows / macOS / Linux) ----------

function runWinStaPs(scriptText, timeoutMs = 8000) {
  const enc = Buffer.from(scriptText, 'utf16le').toString('base64');
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const res = spawnSync(ps, ['-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  return { ok: res.status === 0, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

function readLocalWin() {
  ensureCacheDir();
  const txtFile = path.join(CACHE_DIR, 'local-out.txt');
  const pngFile = path.join(CACHE_DIR, 'local-out.png');
  const prevSeq = Number.isFinite(localCache.winSeq) ? localCache.winSeq : -1;
  const ps = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)",
    "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class SmacWinClip { [DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber(); }' -ErrorAction SilentlyContinue",
    "$seq = [uint32][SmacWinClip]::GetClipboardSequenceNumber()",
    "if ($seq -eq " + prevSeq + ") { 'SMAC_CLIP ' + (@{ unchanged=$true; seq=$seq } | ConvertTo-Json -Compress); exit 0 }",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$txtPath = '" + txtFile.replace(/'/g, "''") + "'",
    "$pngPath = '" + pngFile.replace(/'/g, "''") + "'",
    "if ([Windows.Forms.Clipboard]::ContainsText()) {",
    "  $t = [Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText)",
    "  if ([string]::IsNullOrEmpty($t)) { 'SMAC_CLIP ' + (@{ kind='empty'; seq=$seq } | ConvertTo-Json -Compress); exit 0 }",
    "  [IO.File]::WriteAllText($txtPath, $t, (New-Object Text.UTF8Encoding($false)))",
    "  'SMAC_CLIP ' + (@{ kind='text'; seq=$seq; length=$t.Length } | ConvertTo-Json -Compress); exit 0",
    "}",
    "if ([Windows.Forms.Clipboard]::ContainsImage()) {",
    "  $img = [Windows.Forms.Clipboard]::GetImage()",
    "  if ($null -ne $img) {",
    "    try { $img.Save($pngPath, [Drawing.Imaging.ImageFormat]::Png) } finally { $img.Dispose() }",
    "    $sz = (Get-Item -LiteralPath $pngPath).Length",
    "    'SMAC_CLIP ' + (@{ kind='image'; seq=$seq; size=$sz } | ConvertTo-Json -Compress); exit 0",
    "  }",
    "}",
    "'SMAC_CLIP ' + (@{ kind='empty'; seq=$seq } | ConvertTo-Json -Compress)"
  ].join('\n');

  const res = runWinStaPs(ps, 10000);
  const line = res.stdout.split(/\r?\n/).map(s => s.trim()).find(s => s.startsWith('SMAC_CLIP '));
  if (!line) return { kind: 'empty', sig: '', length: 0, size: 0 };
  const meta = JSON.parse(line.slice('SMAC_CLIP '.length));
  if (meta.unchanged && localCache.item) {
    return Object.assign({}, localCache.item, { fresh: false });
  }
  localCache.winSeq = meta.seq;
  if (meta.kind === 'text' && fs.existsSync(txtFile)) {
    const text = normalizeText(fs.readFileSync(txtFile, 'utf8'));
    const item = { kind: 'text', text, sig: textSig(text), length: text.length, size: Buffer.byteLength(text, 'utf8'), fresh: true };
    localCache.item = item;
    return item;
  }
  if (meta.kind === 'image' && fs.existsSync(pngFile)) {
    const sz = fs.statSync(pngFile).size;
    if (sz > MAX_IMAGE_BYTES) {
      const item = { kind: 'empty', sig: '', length: 0, size: sz, skippedLarge: true };
      localCache.item = item;
      return item;
    }
    const pngBuffer = fs.readFileSync(pngFile);
    const item = { kind: 'image', pngBuffer, sig: imageSig(pngBuffer), length: 0, size: pngBuffer.length, fresh: true };
    localCache.item = item;
    return item;
  }
  const empty = { kind: 'empty', sig: '', length: 0, size: 0, fresh: false };
  localCache.item = empty;
  return empty;
}

function writeLocalWin(item) {
  ensureCacheDir();
  if (item.kind === 'text') {
    const inFile = path.join(CACHE_DIR, 'local-in.txt');
    fs.writeFileSync(inFile, String(item.text || '').replace(/\r?\n/g, '\r\n'), 'utf8');
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class SmacWinClip { [DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber(); }' -ErrorAction SilentlyContinue",
      "$t = [IO.File]::ReadAllText('" + inFile.replace(/'/g, "''") + "', [Text.Encoding]::UTF8)",
      "[Windows.Forms.Clipboard]::SetText($t, [Windows.Forms.TextDataFormat]::UnicodeText)",
      "'SMAC_SEQ ' + [uint32][SmacWinClip]::GetClipboardSequenceNumber()"
    ].join('\n');
    const r = runWinStaPs(ps, 10000);
    const m = /SMAC_SEQ\s+(\d+)/.exec(r.stdout);
    if (m) localCache.winSeq = Number(m[1]);
    localCache.item = Object.assign({}, item, { fresh: false });
    return;
  }
  if (item.kind === 'image' && item.pngBuffer) {
    const inFile = path.join(CACHE_DIR, 'local-in.png');
    fs.writeFileSync(inFile, item.pngBuffer);
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class SmacWinClip { [DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber(); }' -ErrorAction SilentlyContinue",
      "$src = [Drawing.Image]::FromFile('" + inFile.replace(/'/g, "''") + "')",
      "try { $bmp = New-Object Drawing.Bitmap($src); try { [Windows.Forms.Clipboard]::SetImage($bmp) } finally { $bmp.Dispose() } } finally { $src.Dispose() }",
      "'SMAC_SEQ ' + [uint32][SmacWinClip]::GetClipboardSequenceNumber()"
    ].join('\n');
    const r = runWinStaPs(ps, 12000);
    const m = /SMAC_SEQ\s+(\d+)/.exec(r.stdout);
    if (m) localCache.winSeq = Number(m[1]);
    localCache.item = Object.assign({}, item, { fresh: false });
  }
}

const MAC_PROBE_OSA = [
  'use framework "AppKit"',
  'use framework "Foundation"',
  'on run',
  '  set pb to current application\'s NSPasteboard\'s generalPasteboard()',
  '  set cc to (pb\'s changeCount()) as integer',
  '  set ts to pb\'s types()',
  '  set outText to ""',
  '  if ts is not missing value then',
  '    repeat with x in (ts as list)',
  '      set outText to outText & (x as text) & ","',
  '    end repeat',
  '  end if',
  '  return (cc as text) & "|" & outText',
  'end run'
].join('\n');

const MAC_EXPORT_IMG_OSA = [
  'use framework "AppKit"',
  'use framework "Foundation"',
  'on run argv',
  '  set outPath to item 1 of argv',
  '  set pb to current application\'s NSPasteboard\'s generalPasteboard()',
  '  set cc to (pb\'s changeCount()) as integer',
  '  set pngD to pb\'s dataForType:"public.png"',
  '  if pngD is not missing value then',
  '    if pngD\'s writeToFile:outPath atomically:true then return "OK|" & (cc as text)',
  '    return "FAIL|" & (cc as text)',
  '  end if',
  '  set srcD to pb\'s dataForType:"public.tiff"',
  '  if srcD is missing value then set srcD to pb\'s dataForType:"public.jpeg"',
  '  if srcD is missing value then return "NONE|" & (cc as text)',
  '  set rep to current application\'s NSBitmapImageRep\'s imageRepWithData:srcD',
  '  if rep is missing value then return "NONE|" & (cc as text)',
  '  set outD to rep\'s representationUsingType:(current application\'s NSPNGFileType) |properties|:(current application\'s NSDictionary\'s dictionary())',
  '  if outD\'s writeToFile:outPath atomically:true then return "OK|" & (cc as text)',
  '  return "FAIL|" & (cc as text)',
  'end run'
].join('\n');

const MAC_SET_IMG_OSA = [
  'use framework "AppKit"',
  'use framework "Foundation"',
  'on run argv',
  '  set inPath to item 1 of argv',
  '  set pb to current application\'s NSPasteboard\'s generalPasteboard()',
  '  set pngD to current application\'s NSData\'s dataWithContentsOfFile:inPath',
  '  if pngD is missing value then return "NODATA|0"',
  '  set rep to current application\'s NSBitmapImageRep\'s imageRepWithData:pngD',
  '  if rep is missing value then return "NOREP|0"',
  '  set tiffD to rep\'s TIFFRepresentation()',
  '  pb\'s clearContents()',
  '  set ok1 to pb\'s setData:pngD forType:"public.png"',
  '  pb\'s setData:tiffD forType:"public.tiff"',
  '  set cc to (pb\'s changeCount()) as integer',
  '  if ok1 then return "OK|" & (cc as text)',
  '  return "FAIL|" & (cc as text)',
  'end run'
].join('\n');

function readLocalMac() {
  ensureCacheDir();
  const pr = spawnSync('osascript', ['-e', MAC_PROBE_OSA], { encoding: 'utf8', timeout: 4000 });
  const raw = String(pr.stdout || '').trim();
  const idx = raw.indexOf('|');
  const cc = idx >= 0 ? parseInt(raw.slice(0, idx), 10) : NaN;
  const types = idx >= 0 ? raw.slice(idx + 1) : '';
  if (Number.isFinite(cc) && cc === localCache.macCc && localCache.item) {
    return Object.assign({}, localCache.item, { fresh: false });
  }
  localCache.macCc = Number.isFinite(cc) ? cc : null;

  const hasText = /utf8-plain-text|utf16-plain-text|NSStringPboardType/i.test(types) || !types;
  if (hasText) {
    const r = spawnSync('pbpaste', [], { encoding: 'utf8', timeout: 4000, maxBuffer: 8 * 1024 * 1024 });
    if (r.status === 0 && r.stdout && r.stdout.length > 0) {
      const text = normalizeText(r.stdout);
      const item = { kind: 'text', text, sig: textSig(text), length: text.length, size: Buffer.byteLength(text, 'utf8'), fresh: true };
      localCache.item = item;
      return item;
    }
  }

  const hasImage = /public\.png|public\.tiff|public\.jpeg|NSTIFFPboardType/i.test(types);
  if (hasImage) {
    const pngFile = path.join(CACHE_DIR, 'local-mac.png');
    try { fs.rmSync(pngFile, { force: true }); } catch { }
    const er = spawnSync('osascript', ['-e', MAC_EXPORT_IMG_OSA, pngFile], { encoding: 'utf8', timeout: 8000 });
    if (/^OK\|/.test(String(er.stdout || '').trim()) && fs.existsSync(pngFile)) {
      const sz = fs.statSync(pngFile).size;
      if (sz <= MAX_IMAGE_BYTES) {
        const pngBuffer = fs.readFileSync(pngFile);
        const item = { kind: 'image', pngBuffer, sig: imageSig(pngBuffer), length: 0, size: pngBuffer.length, fresh: true };
        localCache.item = item;
        return item;
      }
    }
  }
  const empty = { kind: 'empty', sig: '', length: 0, size: 0, fresh: false };
  localCache.item = empty;
  return empty;
}

function writeLocalMac(item) {
  ensureCacheDir();
  if (item.kind === 'text') {
    spawnSync('pbcopy', [], { input: normalizeText(item.text), encoding: 'utf8', timeout: 4000 });
    const pr = spawnSync('osascript', ['-e', MAC_PROBE_OSA], { encoding: 'utf8', timeout: 3000 });
    const m = /^(\d+)\|/.exec(String(pr.stdout || '').trim());
    if (m) localCache.macCc = Number(m[1]);
    localCache.item = Object.assign({}, item, { fresh: false });
    return;
  }
  if (item.kind === 'image' && item.pngBuffer) {
    const inFile = path.join(CACHE_DIR, 'local-mac-in.png');
    fs.writeFileSync(inFile, item.pngBuffer);
    const sr = spawnSync('osascript', ['-e', MAC_SET_IMG_OSA, inFile], { encoding: 'utf8', timeout: 8000 });
    const m = /^OK\|(\d+)/.exec(String(sr.stdout || '').trim());
    if (m) localCache.macCc = Number(m[1]);
    localCache.item = Object.assign({}, item, { fresh: false });
  }
}

function readLocalLinux() {
  for (const [cmd, args] of [['wl-paste', ['--no-newline']], ['xclip', ['-o', '-selection', 'clipboard']], ['xsel', ['-ob']]]) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
    if (r.status === 0 && r.stdout && r.stdout.length > 0) {
      const text = normalizeText(r.stdout);
      return { kind: 'text', text, sig: textSig(text), length: text.length, size: Buffer.byteLength(text, 'utf8'), fresh: true };
    }
  }
  return { kind: 'empty', sig: '', length: 0, size: 0, fresh: false };
}

function writeLocalLinux(item) {
  if (item.kind !== 'text') return;
  for (const [cmd, args] of [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['-ib']]]) {
    const r = spawnSync(cmd, args, { input: normalizeText(item.text), encoding: 'utf8', timeout: 3000 });
    if (r.status === 0) return;
  }
}

function readLocalItem() {
  if (IS_WIN) return readLocalWin();
  if (IS_MAC) return readLocalMac();
  return readLocalLinux();
}

function writeLocalItem(item) {
  if (IS_WIN) return writeLocalWin(item);
  if (IS_MAC) return writeLocalMac(item);
  return writeLocalLinux(item);
}

// ---------- Remote OS detection ----------

async function detectRemoteOs(device) {
  const cached = deviceOsCache.get(device.id);
  if (cached && Date.now() - cached.at < 300000) return cached.osName;
  const known = String(device.os || '').toLowerCase();
  if (known.includes('win')) {
    deviceOsCache.set(device.id, { osName: 'windows', at: Date.now() });
    return 'windows';
  }
  if (known.includes('mac') || known.includes('darwin')) {
    deviceOsCache.set(device.id, { osName: 'macos', at: Date.now() });
    return 'macos';
  }
  const probe = await bridge({ op: 'probe', deviceId: device.id, connectTimeoutMs: 6000, timeoutMs: 12000 }, 16000);
  let osName = 'linux';
  if (probe.os === 'windows') {
    osName = 'windows';
  } else {
    const u = await bridge({ op: 'exec', deviceId: device.id, os: 'posix', script: 'uname -s 2>/dev/null || echo Linux', connectTimeoutMs: 6000, timeoutMs: 10000 }, 14000);
    osName = /darwin/i.test(String(u.stdout || '')) ? 'macos' : 'linux';
  }
  deviceOsCache.set(device.id, { osName, at: Date.now() });
  return osName;
}

// ---------- Remote macOS clipboard ----------

async function readRemoteMac(device) {
  ensureCacheDir();
  const prev = remoteChangeCache.get(device.id);
  const prevCc = prev && prev.token ? prev.token : '';
  const probeB64 = Buffer.from(MAC_PROBE_OSA, 'utf8').toString('base64');
  const exportB64 = Buffer.from(MAC_EXPORT_IMG_OSA, 'utf8').toString('base64');
  const script = [
    'P_OSA=$(mktemp /tmp/smac-cp.XXXXXX)',
    'printf "%s" ' + JSON.stringify(probeB64) + ' | base64 -d > "$P_OSA"',
    'INFO=$(osascript "$P_OSA" 2>/dev/null || true)',
    'rm -f "$P_OSA"',
    'CC="${INFO%%|*}"',
    'TYPES="${INFO#*|}"',
    'if [ -n "$CC" ] && [ "$CC" = ' + JSON.stringify(prevCc) + ' ]; then echo "SMAC_RCLIP_UNCHANGED|$CC"; exit 0; fi',
    'if echo "$TYPES" | grep -qiE "utf8-plain-text|utf16-plain-text|NSStringPboardType" || [ -z "$TYPES" ]; then',
    '  TXT=$(pbpaste 2>/dev/null || true)',
    '  if [ -n "$TXT" ]; then',
    '    B64=$(printf "%s" "$TXT" | base64 | tr -d "\\r\\n")',
    '    if [ "${#B64}" -le 262144 ]; then',
    '      echo "SMAC_RCLIP_TEXT|$CC|$B64"',
    '    else',
    '      TF="/tmp/smac-rclip-out-$$.txt"',
    '      printf "%s" "$TXT" > "$TF"',
    '      echo "SMAC_RCLIP_TEXT_FILE|$CC|$TF"',
    '    fi',
    '    exit 0',
    '  fi',
    'fi',
    'if echo "$TYPES" | grep -qiE "public\\.png|public\\.tiff|public\\.jpeg|NSTIFFPboardType"; then',
    '  E_OSA=$(mktemp /tmp/smac-ce.XXXXXX)',
    '  IMG="/tmp/smac-rclip-out-$$.png"',
    '  printf "%s" ' + JSON.stringify(exportB64) + ' | base64 -d > "$E_OSA"',
    '  ER=$(osascript "$E_OSA" "$IMG" 2>/dev/null || true)',
    '  rm -f "$E_OSA"',
    '  if echo "$ER" | grep -q "^OK|" && [ -f "$IMG" ]; then',
    '    SZ=$(stat -f "%z" "$IMG" 2>/dev/null || wc -c < "$IMG")',
    '    echo "SMAC_RCLIP_IMG_FILE|$CC|$SZ|$IMG"',
    '    exit 0',
    '  fi',
    '  rm -f "$IMG"',
    'fi',
    'echo "SMAC_RCLIP_EMPTY|$CC"'
  ].join('\n');

  const res = await bridge({ op: 'exec', deviceId: device.id, os: 'posix', script, connectTimeoutMs: 6000, timeoutMs: 14000 }, 18000);
  const lines = String(res.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const hit = lines.find(l => l.startsWith('SMAC_RCLIP_')) || 'SMAC_RCLIP_EMPTY|';
  const parts = hit.split('|');
  const tag = parts[0];
  const cc = parts[1] || '';

  if (tag === 'SMAC_RCLIP_UNCHANGED' && prev && prev.item) {
    return Object.assign({}, prev.item, { fresh: false });
  }
  if (tag === 'SMAC_RCLIP_TEXT') {
    const text = normalizeText(Buffer.from(parts.slice(2).join('|'), 'base64').toString('utf8'));
    const item = { kind: 'text', text, sig: textSig(text), length: text.length, size: Buffer.byteLength(text, 'utf8'), fresh: true };
    remoteChangeCache.set(device.id, { token: cc, item });
    return item;
  }
  if (tag === 'SMAC_RCLIP_TEXT_FILE') {
    const remotePath = parts.slice(2).join('|');
    const localTmp = path.join(CACHE_DIR, 'rmac-' + device.id.slice(0, 8) + '.txt');
    try {
      await bridge({ op: 'download', deviceId: device.id, os: 'posix', remote: remotePath, local: localTmp, timeoutMs: 25000 }, 30000);
      const text = normalizeText(fs.readFileSync(localTmp, 'utf8'));
      const item = { kind: 'text', text, sig: textSig(text), length: text.length, size: Buffer.byteLength(text, 'utf8'), fresh: true };
      remoteChangeCache.set(device.id, { token: cc, item });
      return item;
    } finally {
      bridge({ op: 'exec', deviceId: device.id, os: 'posix', script: 'rm -f ' + JSON.stringify(remotePath), timeoutMs: 8000 }, 10000).catch(() => { });
      try { fs.rmSync(localTmp, { force: true }); } catch { }
    }
  }
  if (tag === 'SMAC_RCLIP_IMG_FILE') {
    const sz = Number(parts[2]) || 0;
    const remotePath = parts.slice(3).join('|');
    const localTmp = path.join(CACHE_DIR, 'rmac-' + device.id.slice(0, 8) + '.png');
    try {
      if (sz > MAX_IMAGE_BYTES) {
        const skipped = { kind: 'empty', sig: '', length: 0, size: sz, skippedLarge: true };
        remoteChangeCache.set(device.id, { token: cc, item: skipped });
        return skipped;
      }
      await bridge({ op: 'download', deviceId: device.id, os: 'posix', remote: remotePath, local: localTmp, timeoutMs: 45000 }, 50000);
      const pngBuffer = fs.readFileSync(localTmp);
      const item = { kind: 'image', pngBuffer, sig: imageSig(pngBuffer), length: 0, size: pngBuffer.length, fresh: true };
      remoteChangeCache.set(device.id, { token: cc, item });
      return item;
    } finally {
      bridge({ op: 'exec', deviceId: device.id, os: 'posix', script: 'rm -f ' + JSON.stringify(remotePath), timeoutMs: 8000 }, 10000).catch(() => { });
      try { fs.rmSync(localTmp, { force: true }); } catch { }
    }
  }
  const empty = { kind: 'empty', sig: '', length: 0, size: 0, fresh: false };
  remoteChangeCache.set(device.id, { token: cc, item: empty });
  return empty;
}

async function writeRemoteMac(device, item) {
  ensureCacheDir();
  const probeB64 = Buffer.from(MAC_PROBE_OSA, 'utf8').toString('base64');
  if (item.kind === 'text') {
    const norm = normalizeText(item.text);
    const b64 = Buffer.from(norm, 'utf8').toString('base64');
    if (b64.length <= 32768) {
      const script = [
        'printf "%s" ' + JSON.stringify(b64) + ' | base64 -d | pbcopy',
        'P_OSA=$(mktemp /tmp/smac-cp.XXXXXX); printf "%s" ' + JSON.stringify(probeB64) + ' | base64 -d > "$P_OSA"; INFO=$(osascript "$P_OSA" 2>/dev/null || true); rm -f "$P_OSA"',
        'echo "SMAC_WCLIP_OK|${INFO%%|*}"'
      ].join('\n');
      const res = await bridge({ op: 'exec', deviceId: device.id, os: 'posix', script, timeoutMs: 14000 }, 18000);
      const m = /SMAC_WCLIP_OK\|(\d*)/.exec(String(res.stdout || ''));
      remoteChangeCache.set(device.id, { token: m ? m[1] : '', item: Object.assign({}, item, { fresh: false }) });
      return;
    }
    const localTmp = path.join(CACHE_DIR, 'wmac-' + crypto.randomBytes(3).toString('hex') + '.txt');
    const remoteTmp = '/tmp/smac-wclip-' + crypto.randomBytes(3).toString('hex') + '.txt';
    fs.writeFileSync(localTmp, norm, 'utf8');
    try {
      await bridge({ op: 'upload', deviceId: device.id, os: 'posix', local: localTmp, remote: remoteTmp, timeoutMs: 30000 }, 35000);
      const script = [
        'pbcopy < ' + JSON.stringify(remoteTmp) + '; rm -f ' + JSON.stringify(remoteTmp),
        'P_OSA=$(mktemp /tmp/smac-cp.XXXXXX); printf "%s" ' + JSON.stringify(probeB64) + ' | base64 -d > "$P_OSA"; INFO=$(osascript "$P_OSA" 2>/dev/null || true); rm -f "$P_OSA"',
        'echo "SMAC_WCLIP_OK|${INFO%%|*}"'
      ].join('\n');
      const res = await bridge({ op: 'exec', deviceId: device.id, os: 'posix', script, timeoutMs: 14000 }, 18000);
      const m = /SMAC_WCLIP_OK\|(\d*)/.exec(String(res.stdout || ''));
      remoteChangeCache.set(device.id, { token: m ? m[1] : '', item: Object.assign({}, item, { fresh: false }) });
    } finally {
      try { fs.rmSync(localTmp, { force: true }); } catch { }
    }
    return;
  }
  if (item.kind === 'image' && item.pngBuffer) {
    const localTmp = path.join(CACHE_DIR, 'wmac-' + crypto.randomBytes(3).toString('hex') + '.png');
    const remoteTmp = '/tmp/smac-wclip-' + crypto.randomBytes(3).toString('hex') + '.png';
    fs.writeFileSync(localTmp, item.pngBuffer);
    const setB64 = Buffer.from(MAC_SET_IMG_OSA, 'utf8').toString('base64');
    try {
      await bridge({ op: 'upload', deviceId: device.id, os: 'posix', local: localTmp, remote: remoteTmp, timeoutMs: 45000 }, 50000);
      const script = [
        'S_OSA=$(mktemp /tmp/smac-cs.XXXXXX); printf "%s" ' + JSON.stringify(setB64) + ' | base64 -d > "$S_OSA"',
        'SR=$(osascript "$S_OSA" ' + JSON.stringify(remoteTmp) + ' 2>/dev/null || true)',
        'rm -f "$S_OSA" ' + JSON.stringify(remoteTmp),
        'echo "SMAC_WCLIP_OK|${SR#*|}"'
      ].join('\n');
      const res = await bridge({ op: 'exec', deviceId: device.id, os: 'posix', script, timeoutMs: 20000 }, 24000);
      const m = /SMAC_WCLIP_OK\|(\d*)/.exec(String(res.stdout || ''));
      remoteChangeCache.set(device.id, { token: m ? m[1] : '', item: Object.assign({}, item, { fresh: false }) });
    } finally {
      try { fs.rmSync(localTmp, { force: true }); } catch { }
    }
  }
}

// ---------- Remote Windows clipboard (Interactive Session 1+ Agent!) ----------

function buildRemoteWindowsAgentPs() {
  return [
    '# smac remote Windows interactive clipboard agent (' + WIN_AGENT_VERSION + ')',
    '$ErrorActionPreference = "SilentlyContinue"',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    'Add-Type -TypeDefinition @"',
    'using System.Runtime.InteropServices;',
    'public class SmacClipNative { [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber(); }',
    '"@',
    '$base = Join-Path $env:USERPROFILE ".smac-guest\\clip-bridge"',
    '$outDir = Join-Path $base "out"',
    '$inDir  = Join-Path $base "in"',
    'New-Item -ItemType Directory -Force -Path $outDir, $inDir | Out-Null',
    '$pidFile  = Join-Path $base "agent.pid"',
    '$pollFile = Join-Path $base "poll.ts"',
    '$metaFile = Join-Path $outDir "meta.json"',
    '$txtOut   = Join-Path $outDir "text.txt"',
    '$pngOut   = Join-Path $outDir "image.png"',
    '$reqFile  = Join-Path $inDir "req.json"',
    '$ackFile  = Join-Path $inDir "ack.json"',
    '$utf8NoBom = New-Object Text.UTF8Encoding($false)',
    '[IO.File]::WriteAllText($pidFile, [string]$PID, $utf8NoBom)',
    'function Get-Sha256Hex([byte[]]$bytes) {',
    '  $sha = [Security.Cryptography.SHA256]::Create()',
    '  try { ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLower() } finally { $sha.Dispose() }',
    '}',
    'function Write-Meta($obj) {',
    '  $tmp = $metaFile + ".tmp"',
    '  [IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Compress), $utf8NoBom)',
    '  Move-Item -LiteralPath $tmp -Destination $metaFile -Force',
    '}',
    '$lastSeq = [int64]-1',
    '$lastBeat = [DateTime]::UtcNow',
    'while ($true) {',
    '  try {',
    '    if (Test-Path -LiteralPath $reqFile) {',
    '      $req = Get-Content -LiteralPath $reqFile -Raw -Encoding UTF8 | ConvertFrom-Json',
    '      Remove-Item -LiteralPath $reqFile -Force -ErrorAction SilentlyContinue',
    '      $ok = $false; $err = ""',
    '      try {',
    '        if ($req.kind -eq "text") {',
    '          $srcTxt = Join-Path $inDir "in.txt"',
    '          if (Test-Path -LiteralPath $srcTxt) {',
    '            $t = [IO.File]::ReadAllText($srcTxt, $utf8NoBom)',
    '            [Windows.Forms.Clipboard]::SetText($t, [Windows.Forms.TextDataFormat]::UnicodeText)',
    '            $ok = $true',
    '          }',
    '        } elseif ($req.kind -eq "image") {',
    '          $srcPng = Join-Path $inDir "in.png"',
    '          if (Test-Path -LiteralPath $srcPng) {',
    '            $img = [Drawing.Image]::FromFile($srcPng)',
    '            try { $bmp = New-Object Drawing.Bitmap($img); try { [Windows.Forms.Clipboard]::SetImage($bmp); $ok = $true } finally { $bmp.Dispose() } } finally { $img.Dispose() }',
    '          }',
    '        }',
    '      } catch { $err = $_.Exception.Message }',
    '      $curSeq = [uint32][SmacClipNative]::GetClipboardSequenceNumber()',
    '      if ($ok) {',
    '        $lastSeq = [int64]$curSeq',
    '        Write-Meta @{ version="' + WIN_AGENT_VERSION + '"; seq=$curSeq; kind=[string]$req.kind; sig=[string]$req.sig; length=[int]$req.length; size=[int64]$req.size; updatedAt=(Get-Date).ToString("o") }',
    '      }',
    '      [IO.File]::WriteAllText($ackFile, (@{ id=[string]$req.id; ok=$ok; seq=$curSeq; error=$err } | ConvertTo-Json -Compress), $utf8NoBom)',
    '    }',
    '    $seq = [int64][uint32][SmacClipNative]::GetClipboardSequenceNumber()',
    '    if ($seq -ne $lastSeq) {',
    '      $lastSeq = $seq',
    '      if ([Windows.Forms.Clipboard]::ContainsText()) {',
    '        $raw = [Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText)',
    '        if ([string]::IsNullOrEmpty($raw)) {',
    '          Write-Meta @{ version="' + WIN_AGENT_VERSION + '"; seq=$seq; kind="empty"; sig=""; length=0; size=0; updatedAt=(Get-Date).ToString("o") }',
    '        } else {',
    '          $norm = $raw.Replace("`r`n", "`n").Replace("`r", "`n")',
    '          $bytes = $utf8NoBom.GetBytes($norm)',
    '          $sig = "text:" + (Get-Sha256Hex $bytes)',
    '          [IO.File]::WriteAllBytes($txtOut + ".tmp", $bytes)',
    '          Move-Item -LiteralPath ($txtOut + ".tmp") -Destination $txtOut -Force',
    '          Write-Meta @{ version="' + WIN_AGENT_VERSION + '"; seq=$seq; kind="text"; sig=$sig; length=$norm.Length; size=$bytes.Length; updatedAt=(Get-Date).ToString("o") }',
    '        }',
    '      } elseif ([Windows.Forms.Clipboard]::ContainsImage()) {',
    '        $img = [Windows.Forms.Clipboard]::GetImage()',
    '        if ($null -ne $img) {',
    '          try { $img.Save($pngOut + ".tmp", [Drawing.Imaging.ImageFormat]::Png) } finally { $img.Dispose() }',
    '          $sz = (Get-Item -LiteralPath ($pngOut + ".tmp")).Length',
    '          if ($sz -le ' + MAX_IMAGE_BYTES + ') {',
    '            Move-Item -LiteralPath ($pngOut + ".tmp") -Destination $pngOut -Force',
    '            $bytes = [IO.File]::ReadAllBytes($pngOut)',
    '            $sig = "image:" + (Get-Sha256Hex $bytes)',
    '            Write-Meta @{ version="' + WIN_AGENT_VERSION + '"; seq=$seq; kind="image"; sig=$sig; length=0; size=$sz; updatedAt=(Get-Date).ToString("o") }',
    '          } else {',
    '            Remove-Item -LiteralPath ($pngOut + ".tmp") -Force -ErrorAction SilentlyContinue',
    '            Write-Meta @{ version="' + WIN_AGENT_VERSION + '"; seq=$seq; kind="empty"; sig=""; length=0; size=$sz; skippedLarge=$true; updatedAt=(Get-Date).ToString("o") }',
    '          }',
    '        }',
    '      } else {',
    '        Write-Meta @{ version="' + WIN_AGENT_VERSION + '"; seq=$seq; kind="empty"; sig=""; length=0; size=0; updatedAt=(Get-Date).ToString("o") }',
    '      }',
    '    }',
    '    if (([DateTime]::UtcNow - $lastBeat).TotalSeconds -ge 8) {',
    '      $lastBeat = [DateTime]::UtcNow',
    '      [IO.File]::WriteAllText($pidFile, [string]$PID, $utf8NoBom)',
    '      if (Test-Path -LiteralPath $pollFile) {',
    '        $age = ([DateTime]::UtcNow - (Get-Item -LiteralPath $pollFile).LastWriteTimeUtc).TotalSeconds',
    '        if ($age -gt 480) { break }',
    '      }',
    '    }',
    '  } catch { }',
    '  Start-Sleep -Milliseconds 220',
    '}',
    'Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue'
  ].join('\r\n');
}

function buildEnsureWinAgentSnippet() {
  const agentB64 = Buffer.from(buildRemoteWindowsAgentPs(), 'utf8').toString('base64');
  return [
    '$base = Join-Path $env:USERPROFILE ".smac-guest\\clip-bridge"',
    '$outDir = Join-Path $base "out"; $inDir = Join-Path $base "in"',
    'New-Item -ItemType Directory -Force -Path $outDir, $inDir | Out-Null',
    '$verFile = Join-Path $base "version.txt"',
    '$psFile  = Join-Path $base "clip-agent.ps1"',
    '$vbsFile = Join-Path $base "clip-agent.vbs"',
    '$pidFile = Join-Path $base "agent.pid"',
    '$pollFile = Join-Path $base "poll.ts"',
    '$utf8 = New-Object Text.UTF8Encoding($false)',
    '[IO.File]::WriteAllText($pollFile, (Get-Date).ToString("o"), $utf8)',
    '$curVer = if (Test-Path -LiteralPath $verFile) { (Get-Content -LiteralPath $verFile -Raw).Trim() } else { "" }',
    '$alive = $false',
    'if (Test-Path -LiteralPath $pidFile) {',
    '  $p = 0; [void][int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$p)',
    '  if ($p -gt 0 -and (Get-Process -Id $p -ErrorAction SilentlyContinue)) { $alive = $true }',
    '}',
    'if ($curVer -ne "' + WIN_AGENT_VERSION + '" -or -not (Test-Path -LiteralPath $psFile) -or -not (Test-Path -LiteralPath $vbsFile)) {',
    '  if ($alive -and $p -gt 0) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; $alive = $false }',
    '  [IO.File]::WriteAllBytes($psFile, [Convert]::FromBase64String("' + agentB64 + '"))',
    '  $vbs = "Set sh = CreateObject(`"WScript.Shell`")`r`nsh.Run `"powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"`"" + $psFile + "`"`"`", 0, False`r`n"',
    '  [IO.File]::WriteAllText($vbsFile, $vbs, $utf8)',
    '  [IO.File]::WriteAllText($verFile, "' + WIN_AGENT_VERSION + '", $utf8)',
    '}',
    'if (-not $alive) {',
    '  $taskName = "SmacClipHelper"',
    '  $wscript = Join-Path $env:WINDIR "System32\\wscript.exe"',
    '  try {',
    '    $action = New-ScheduledTaskAction -Execute $wscript -Argument ("`"" + $vbsFile + "`"")',
    '    $principal = New-ScheduledTaskPrincipal -UserId ($env:USERDOMAIN + "\\" + $env:USERNAME) -LogonType Interactive -RunLevel Limited',
    '    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew',
    '    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null',
    '    Start-ScheduledTask -TaskName $taskName',
    '  } catch {',
    '    & schtasks.exe /Create /TN $taskName /TR ("`"" + $wscript + "`" `"" + $vbsFile + "`"") /SC ONCE /ST 00:00 /F 2>&1 | Out-Null',
    '    & schtasks.exe /Run /TN $taskName 2>&1 | Out-Null',
    '  }',
    '  for ($i=0; $i -lt 20; $i++) {',
    '    Start-Sleep -Milliseconds 180',
    '    if (Test-Path -LiteralPath (Join-Path $outDir "meta.json")) { break }',
    '  }',
    '}'
  ].join('\n');
}

async function readRemoteWindows(device) {
  ensureCacheDir();
  const prev = remoteChangeCache.get(device.id);
  const prevSig = prev && prev.token ? prev.token : '';
  const ps = [
    "$ErrorActionPreference='SilentlyContinue'",
    "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)",
    buildEnsureWinAgentSnippet(),
    '$metaFile = Join-Path $outDir "meta.json"',
    'if (-not (Test-Path -LiteralPath $metaFile)) { "SMAC_WCLIP_UNAVAILABLE"; exit 0 }',
    '$m = Get-Content -LiteralPath $metaFile -Raw -Encoding UTF8 | ConvertFrom-Json',
    'if ([string]$m.sig -eq "' + prevSig.replace(/"/g, '') + '" -and "' + prevSig.replace(/"/g, '') + '" -ne "") { "SMAC_WCLIP_UNCHANGED"; exit 0 }',
    '$txtOut = Join-Path $outDir "text.txt"; $pngOut = Join-Path $outDir "image.png"',
    'if ([string]$m.kind -eq "text" -and (Test-Path -LiteralPath $txtOut)) {',
    '  $sz = (Get-Item -LiteralPath $txtOut).Length',
    '  if ($sz -le 196608) {',
    '    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($txtOut))',
    '    "SMAC_WCLIP_TEXT|" + [string]$m.sig + "|" + $b64',
    '  } else {',
    '    "SMAC_WCLIP_TEXT_FILE|" + [string]$m.sig + "|" + $txtOut.Replace("\\", "/")',
    '  }',
    '  exit 0',
    '}',
    'if ([string]$m.kind -eq "image" -and (Test-Path -LiteralPath $pngOut)) {',
    '  $sz = (Get-Item -LiteralPath $pngOut).Length',
    '  "SMAC_WCLIP_IMG_FILE|" + [string]$m.sig + "|" + $sz + "|" + $pngOut.Replace("\\", "/")',
    '  exit 0',
    '}',
    '"SMAC_WCLIP_EMPTY"'
  ].join('\n');

  const res = await bridge({ op: 'exec', deviceId: device.id, os: 'windows', script: ps, connectTimeoutMs: 7000, timeoutMs: 20000 }, 24000);
  const lines = String(res.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const hit = lines.find(l => l.startsWith('SMAC_WCLIP_')) || 'SMAC_WCLIP_UNAVAILABLE';
  if (hit === 'SMAC_WCLIP_UNAVAILABLE') {
    throw new Error('远端 Windows 交互桌面未登录，无法访问桌面剪贴板');
  }
  if (hit === 'SMAC_WCLIP_UNCHANGED' && prev && prev.item) {
    return Object.assign({}, prev.item, { fresh: false });
  }
  const parts = hit.split('|');
  const tag = parts[0];
  if (tag === 'SMAC_WCLIP_TEXT') {
    const text = normalizeText(Buffer.from(parts.slice(2).join('|'), 'base64').toString('utf8'));
    const item = { kind: 'text', text, sig: textSig(text), length: text.length, size: Buffer.byteLength(text, 'utf8'), fresh: true };
    remoteChangeCache.set(device.id, { token: item.sig, item });
    return item;
  }
  if (tag === 'SMAC_WCLIP_TEXT_FILE') {
    const remotePath = parts.slice(2).join('|');
    const localTmp = path.join(CACHE_DIR, 'rwin-' + device.id.slice(0, 8) + '.txt');
    try {
      await bridge({ op: 'download', deviceId: device.id, os: 'windows', remote: remotePath, local: localTmp, timeoutMs: 30000 }, 35000);
      const text = normalizeText(fs.readFileSync(localTmp, 'utf8'));
      const item = { kind: 'text', text, sig: textSig(text), length: text.length, size: Buffer.byteLength(text, 'utf8'), fresh: true };
      remoteChangeCache.set(device.id, { token: item.sig, item });
      return item;
    } finally {
      try { fs.rmSync(localTmp, { force: true }); } catch { }
    }
  }
  if (tag === 'SMAC_WCLIP_IMG_FILE') {
    const sz = Number(parts[2]) || 0;
    const remotePath = parts.slice(3).join('|');
    const localTmp = path.join(CACHE_DIR, 'rwin-' + device.id.slice(0, 8) + '.png');
    try {
      if (sz > MAX_IMAGE_BYTES) {
        const skipped = { kind: 'empty', sig: '', length: 0, size: sz, skippedLarge: true };
        remoteChangeCache.set(device.id, { token: '', item: skipped });
        return skipped;
      }
      await bridge({ op: 'download', deviceId: device.id, os: 'windows', remote: remotePath, local: localTmp, timeoutMs: 45000 }, 50000);
      const pngBuffer = fs.readFileSync(localTmp);
      const item = { kind: 'image', pngBuffer, sig: imageSig(pngBuffer), length: 0, size: pngBuffer.length, fresh: true };
      remoteChangeCache.set(device.id, { token: item.sig, item });
      return item;
    } finally {
      try { fs.rmSync(localTmp, { force: true }); } catch { }
    }
  }
  const empty = { kind: 'empty', sig: '', length: 0, size: 0, fresh: false };
  remoteChangeCache.set(device.id, { token: '', item: empty });
  return empty;
}

async function writeRemoteWindows(device, item) {
  ensureCacheDir();
  const reqId = crypto.randomBytes(4).toString('hex');
  if (item.kind === 'text') {
    const text = String(item.text || '').replace(/\r?\n/g, '\r\n');
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    if (b64.length <= 24576) {
      const ps = [
        "$ErrorActionPreference='SilentlyContinue'",
        "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)",
        buildEnsureWinAgentSnippet(),
        '[IO.File]::WriteAllBytes((Join-Path $inDir "in.txt"), [Convert]::FromBase64String("' + b64 + '"))',
        '$req = @{ id="' + reqId + '"; kind="text"; sig="' + item.sig + '"; length=' + item.length + '; size=' + item.size + ' } | ConvertTo-Json -Compress',
        '[IO.File]::WriteAllText((Join-Path $inDir "req.json.tmp"), $req, $utf8)',
        'Move-Item -LiteralPath (Join-Path $inDir "req.json.tmp") -Destination (Join-Path $inDir "req.json") -Force',
        '$ackFile = Join-Path $inDir "ack.json"',
        'for ($i=0; $i -lt 15; $i++) { Start-Sleep -Milliseconds 180; if (Test-Path -LiteralPath $ackFile) { $a = Get-Content -LiteralPath $ackFile -Raw; if ($a -like "*' + reqId + '*") { "SMAC_WIN_ACK " + $a; exit 0 } } }',
        '"SMAC_WIN_ACK_TIMEOUT"'
      ].join('\n');
      await bridge({ op: 'exec', deviceId: device.id, os: 'windows', script: ps, timeoutMs: 20000 }, 24000);
      remoteChangeCache.set(device.id, { token: item.sig, item: Object.assign({}, item, { fresh: false }) });
      return;
    }
    const localTmp = path.join(CACHE_DIR, 'wwin-' + reqId + '.txt');
    fs.writeFileSync(localTmp, text, 'utf8');
    try {
      const homeRes = await bridge({ op: 'exec', deviceId: device.id, os: 'windows', script: 'Write-Output $env:USERPROFILE', timeoutMs: 12000 }, 15000);
      const rHome = String(homeRes.stdout || '').trim().split(/\r?\n/).pop().replace(/\\/g, '/').replace(/\/+$/, '');
      const rInTxt = rHome + '/.smac-guest/clip-bridge/in/in.txt';
      await bridge({ op: 'upload', deviceId: device.id, os: 'windows', local: localTmp, remote: rInTxt, timeoutMs: 30000 }, 35000);
      const ps = [
        "$ErrorActionPreference='SilentlyContinue'",
        buildEnsureWinAgentSnippet(),
        '$req = @{ id="' + reqId + '"; kind="text"; sig="' + item.sig + '"; length=' + item.length + '; size=' + item.size + ' } | ConvertTo-Json -Compress',
        '[IO.File]::WriteAllText((Join-Path $inDir "req.json.tmp"), $req, $utf8)',
        'Move-Item -LiteralPath (Join-Path $inDir "req.json.tmp") -Destination (Join-Path $inDir "req.json") -Force',
        '$ackFile = Join-Path $inDir "ack.json"',
        'for ($i=0; $i -lt 15; $i++) { Start-Sleep -Milliseconds 180; if (Test-Path -LiteralPath $ackFile) { $a = Get-Content -LiteralPath $ackFile -Raw; if ($a -like "*' + reqId + '*") { "SMAC_WIN_ACK " + $a; exit 0 } } }'
      ].join('\n');
      await bridge({ op: 'exec', deviceId: device.id, os: 'windows', script: ps, timeoutMs: 20000 }, 24000);
      remoteChangeCache.set(device.id, { token: item.sig, item: Object.assign({}, item, { fresh: false }) });
    } finally {
      try { fs.rmSync(localTmp, { force: true }); } catch { }
    }
    return;
  }

  if (item.kind === 'image' && item.pngBuffer) {
    const localTmp = path.join(CACHE_DIR, 'wwin-' + reqId + '.png');
    fs.writeFileSync(localTmp, item.pngBuffer);
    try {
      const homeRes = await bridge({ op: 'exec', deviceId: device.id, os: 'windows', script: 'Write-Output $env:USERPROFILE', timeoutMs: 12000 }, 15000);
      const rHome = String(homeRes.stdout || '').trim().split(/\r?\n/).pop().replace(/\\/g, '/').replace(/\/+$/, '');
      const rInPng = rHome + '/.smac-guest/clip-bridge/in/in.png';
      await bridge({ op: 'upload', deviceId: device.id, os: 'windows', local: localTmp, remote: rInPng, timeoutMs: 45000 }, 50000);
      const ps = [
        "$ErrorActionPreference='SilentlyContinue'",
        buildEnsureWinAgentSnippet(),
        '$req = @{ id="' + reqId + '"; kind="image"; sig="' + item.sig + '"; length=0; size=' + item.size + ' } | ConvertTo-Json -Compress',
        '[IO.File]::WriteAllText((Join-Path $inDir "req.json.tmp"), $req, $utf8)',
        'Move-Item -LiteralPath (Join-Path $inDir "req.json.tmp") -Destination (Join-Path $inDir "req.json") -Force',
        '$ackFile = Join-Path $inDir "ack.json"',
        'for ($i=0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 200; if (Test-Path -LiteralPath $ackFile) { $a = Get-Content -LiteralPath $ackFile -Raw; if ($a -like "*' + reqId + '*") { "SMAC_WIN_ACK " + $a; exit 0 } } }'
      ].join('\n');
      await bridge({ op: 'exec', deviceId: device.id, os: 'windows', script: ps, timeoutMs: 25000 }, 30000);
      remoteChangeCache.set(device.id, { token: item.sig, item: Object.assign({}, item, { fresh: false }) });
    } finally {
      try { fs.rmSync(localTmp, { force: true }); } catch { }
    }
  }
}

// ---------- Remote Linux clipboard ----------

async function readRemoteLinux(device) {
  const script = 't=$(wl-paste --no-newline 2>/dev/null || DISPLAY=${DISPLAY:-:0} xclip -o -selection clipboard 2>/dev/null || DISPLAY=${DISPLAY:-:0} xsel -ob 2>/dev/null || true); if [ -n "$t" ]; then printf "SMAC_LCLIP_TEXT|%s\\n" "$(printf "%s" "$t" | base64 | tr -d "\\r\\n")"; else echo SMAC_LCLIP_EMPTY; fi';
  const res = await bridge({ op: 'exec', deviceId: device.id, os: 'posix', script, connectTimeoutMs: 6000, timeoutMs: 12000 }, 16000);
  const line = String(res.stdout || '').split(/\r?\n/).map(s => s.trim()).find(s => s.startsWith('SMAC_LCLIP_')) || 'SMAC_LCLIP_EMPTY';
  if (line.startsWith('SMAC_LCLIP_TEXT|')) {
    const text = normalizeText(Buffer.from(line.slice('SMAC_LCLIP_TEXT|'.length), 'base64').toString('utf8'));
    return { kind: 'text', text, sig: textSig(text), length: text.length, size: Buffer.byteLength(text, 'utf8'), fresh: true };
  }
  return { kind: 'empty', sig: '', length: 0, size: 0, fresh: false };
}

async function writeRemoteLinux(device, item) {
  if (item.kind !== 'text') return;
  const b64 = Buffer.from(normalizeText(item.text), 'utf8').toString('base64');
  const script = 'printf "%s" ' + JSON.stringify(b64) + ' | base64 -d | (wl-copy 2>/dev/null || DISPLAY=${DISPLAY:-:0} xclip -selection clipboard 2>/dev/null || DISPLAY=${DISPLAY:-:0} xsel -ib 2>/dev/null || true)';
  await bridge({ op: 'exec', deviceId: device.id, os: 'posix', script, timeoutMs: 12000 }, 16000);
}

async function readRemoteDevice(device) {
  const osName = await detectRemoteOs(device);
  let item;
  if (osName === 'windows') item = await readRemoteWindows(device);
  else if (osName === 'macos') item = await readRemoteMac(device);
  else item = await readRemoteLinux(device);
  return { osName, item };
}

async function writeRemoteDevice(device, osName, item) {
  if (osName === 'windows') return writeRemoteWindows(device, item);
  if (osName === 'macos') return writeRemoteMac(device, item);
  return writeRemoteLinux(device, item);
}

// ---------- Multi-device hub-and-spoke sync cycle ----------

function readClipState() {
  const s = readJson(CLIP_STATE_FILE);
  if (s && typeof s === 'object') {
    if (!s.devices || typeof s.devices !== 'object') s.devices = {};
    return s;
  }
  return { localSig: '', localKind: 'empty', devices: {}, lastSyncAt: '', lastDirection: '', lastKind: '', lastLength: 0, lastSize: 0 };
}

function saveClipState(state) {
  writeJson(CLIP_STATE_FILE, state);
}

async function syncOnce() {
  const cfg = readConfig();
  const targets = resolveSelectedDevices(cfg);
  const state = readClipState();
  const intervalSeconds = Math.max(1, Number(cfg.clipboardIntervalSeconds) || 2);

  if (!targets.length) {
    const status = {
      running: true,
      intervalSeconds,
      devices: [],
      macOnline: true,
      allOffline: false,
      lastSyncAt: state.lastSyncAt || '',
      lastDirection: state.lastDirection || '',
      lastKind: state.lastKind || '',
      lastLength: state.lastLength || 0,
      lastSize: state.lastSize || 0,
      lastError: '请先勾选至少 1 台同步设备',
      updatedAt: new Date().toISOString()
    };
    writeJson(CLIP_STATUS_FILE, status);
    return { ok: false, output: '请先在剪贴板同步面板勾选至少 1 台要同步的设备' };
  }

  let localItem;
  try {
    localItem = readLocalItem();
  } catch (err) {
    return { ok: false, output: '读取本机剪贴板失败: ' + (err && err.message ? err.message : err) };
  }

  const polls = await Promise.all(targets.map(async device => {
    try {
      const { osName, item } = await readRemoteDevice(device);
      return { device, osName, online: true, item, error: '' };
    } catch (err) {
      return { device, osName: String(device.os || ''), online: false, item: null, error: String(err && err.message ? err.message : err) };
    }
  }));

  const onlinePolls = polls.filter(p => p.online);
  const devStatus = polls.map(p => ({
    id: p.device.id,
    name: p.device.name,
    os: p.device.os || p.osName,
    online: p.online,
    error: p.error
  }));

  if (!onlinePolls.length) {
    const errMsg = polls.map(p => p.device.name + ': ' + p.error).join('；');
    writeJson(CLIP_STATUS_FILE, {
      running: true,
      intervalSeconds,
      devices: devStatus,
      macOnline: false,
      allOffline: true,
      lastSyncAt: state.lastSyncAt || '',
      lastDirection: state.lastDirection || '',
      lastKind: state.lastKind || '',
      lastLength: state.lastLength || 0,
      lastSize: state.lastSize || 0,
      lastError: errMsg,
      updatedAt: new Date().toISOString()
    });
    return { ok: false, output: '所选设备均不可达：' + errMsg };
  }

  const localSig = localItem.sig || '';
  const localChanged = Boolean(localItem.kind !== 'empty' && localSig && (localSig !== state.localSig || localItem.fresh));

  // Find first online remote device whose clipboard genuinely changed since its last known baseline
  let changedRemote = null;
  for (const p of onlinePolls) {
    const prevDevSig = (state.devices[p.device.id] && state.devices[p.device.id].sig) || '';
    const rSig = (p.item && p.item.sig) || '';
    if (p.item && p.item.kind !== 'empty' && rSig && rSig !== localSig && rSig !== prevDevSig) {
      changedRemote = p;
      break;
    }
  }

  let direction = '';
  let syncedKind = '';
  let syncedLength = 0;
  let syncedSize = 0;
  let action = 'none';

  if (localChanged) {
    // Push local -> all online targets whose sig differs
    const pushed = [];
    for (const p of onlinePolls) {
      const rSig = (p.item && p.item.sig) || '';
      if (rSig === localSig) {
        state.devices[p.device.id] = { sig: localSig, kind: localItem.kind };
        continue;
      }
      if (localItem.kind === 'image' && p.osName === 'linux') continue;
      try {
        await writeRemoteDevice(p.device, p.osName, localItem);
        state.devices[p.device.id] = { sig: localSig, kind: localItem.kind };
        pushed.push(p.device.name);
      } catch (err) {
        const entry = devStatus.find(d => d.id === p.device.id);
        if (entry) entry.error = String(err && err.message ? err.message : err);
      }
    }
    state.localSig = localSig;
    state.localKind = localItem.kind;
    if (pushed.length) {
      action = 'push';
      direction = '本机 → ' + pushed.join('、');
      syncedKind = localItem.kind;
      syncedLength = localItem.length || 0;
      syncedSize = localItem.size || 0;
      const detail = syncedKind === 'image' ? ('图片 ' + formatBytes(syncedSize)) : (syncedLength + ' 字符');
      appendLog('PUSH | ' + syncedKind + ' | ' + detail + ' | ' + direction);
    }
  } else if (changedRemote) {
    // Pull changedRemote -> Local AND fanout -> all other online targets
    const srcItem = changedRemote.item;
    const srcSig = srcItem.sig;
    writeLocalItem(srcItem);
    state.localSig = srcSig;
    state.localKind = srcItem.kind;
    state.devices[changedRemote.device.id] = { sig: srcSig, kind: srcItem.kind };
    const receivers = ['本机'];
    for (const p of onlinePolls) {
      if (p.device.id === changedRemote.device.id) continue;
      const rSig = (p.item && p.item.sig) || '';
      if (rSig === srcSig) {
        state.devices[p.device.id] = { sig: srcSig, kind: srcItem.kind };
        continue;
      }
      if (srcItem.kind === 'image' && p.osName === 'linux') continue;
      try {
        await writeRemoteDevice(p.device, p.osName, srcItem);
        state.devices[p.device.id] = { sig: srcSig, kind: srcItem.kind };
        receivers.push(p.device.name);
      } catch (err) {
        const entry = devStatus.find(d => d.id === p.device.id);
        if (entry) entry.error = String(err && err.message ? err.message : err);
      }
    }
    action = 'pull';
    direction = changedRemote.device.name + ' → ' + receivers.join('、');
    syncedKind = srcItem.kind;
    syncedLength = srcItem.length || 0;
    syncedSize = srcItem.size || 0;
    const detail = syncedKind === 'image' ? ('图片 ' + formatBytes(syncedSize)) : (syncedLength + ' 字符');
    appendLog('PULL | ' + syncedKind + ' | ' + detail + ' | ' + direction);
  } else {
    // Absorb baselines cleanly
    if (localSig) {
      state.localSig = localSig;
      state.localKind = localItem.kind;
    }
    for (const p of onlinePolls) {
      if (p.item && p.item.sig) {
        state.devices[p.device.id] = { sig: p.item.sig, kind: p.item.kind };
      }
    }
  }

  if (action !== 'none') {
    state.lastSyncAt = new Date().toISOString();
    state.lastDirection = direction;
    state.lastKind = syncedKind;
    state.lastLength = syncedLength;
    state.lastSize = syncedSize;
  }
  saveClipState(state);

  const anyOnline = onlinePolls.length > 0;
  writeJson(CLIP_STATUS_FILE, {
    running: true,
    intervalSeconds,
    devices: devStatus,
    macOnline: anyOnline,
    allOffline: !anyOnline,
    lastSyncAt: state.lastSyncAt || '',
    lastDirection: state.lastDirection || '',
    lastKind: state.lastKind || '',
    lastLength: state.lastLength || 0,
    lastSize: state.lastSize || 0,
    lastError: devStatus.filter(d => !d.online).map(d => d.name + ' 离线').join('、'),
    updatedAt: new Date().toISOString()
  });

  if (action === 'none') {
    return { ok: true, output: '所选设备剪贴板已一致，无需同步（' + onlinePolls.map(p => p.device.name).join('、') + '）' };
  }
  const detail = syncedKind === 'image' ? ('图片 ' + formatBytes(syncedSize)) : (syncedLength + ' 字符');
  return { ok: true, output: '剪贴板已同步：' + direction + '（' + detail + '）' };
}

module.exports = {
  getSelectedDeviceIds,
  resolveSelectedDevices,
  syncOnce,
  cleanupCache
};
