'use strict';

// SSH bridge: lets the PowerShell sync/send engine talk to devices saved by the
// web console. Password devices can therefore take part in background sync and
// "send to desktop" without putting a password on a command line.
//
// Usage: node ssh-bridge.js  (JSON request on stdin, JSON result on stdout)
// Request: { op: 'exec'|'upload'|'upload-tree'|'download'|'probe',
//            deviceId, os?: 'windows'|'posix'|'auto', script?, local?, remote?,
//            timeoutMs? }
// The device (and its saved password / key path) is read from
// %USERPROFILE%\.smac\devices.json. Passwords are never accepted on argv.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

let ssh2 = null;
try { ssh2 = require('ssh2'); } catch { }
const sshDial = require('./ssh-dial');

const USER_HOME = process.env.USERPROFILE || os.homedir();
const DEVICES_FILE = path.join(USER_HOME, '.smac', 'devices.json');
const MAX_OUTPUT = 64 * 1024 * 1024;

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function fail(message, extra) {
  emit(Object.assign({ ok: false, error: message }, extra || {}));
  process.exit(0);
}

function readStdin() {
  return new Promise(resolve => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      text += chunk;
      if (text.length > 8 * 1024 * 1024) {
        fail('请求体过大');
      }
    });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', error => fail('读取请求失败: ' + error.message));
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readDevice(deviceId) {
  const data = readJson(DEVICES_FILE);
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.devices) ? data.devices : []);
  const wanted = String(deviceId || '').trim();
  const device = list.find(item => item && (item.id === wanted || item.name === wanted));
  if (!device) fail('设备不存在或已被删除');
  return device;
}

function fingerprintOf(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function networkError(error) {
  return sshDial.isNetworkError(error);
}

function connectDevice(device, connectTimeoutMs) {
  return sshDial.connect(device, { connectTimeoutMs });
}

function execOn(conn, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('远端命令超时'));
    }, timeoutMs || 180000);

    conn.exec(command, (error, stream) => {
      if (error) {
        clearTimeout(timer);
        settled = true;
        reject(error);
        return;
      }
      let stdout = '';
      let stderr = '';
      stream.on('data', chunk => {
        stdout += chunk.toString('utf8');
        if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT);
      });
      stream.stderr.on('data', chunk => {
        stderr += chunk.toString('utf8');
        if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT);
      });
      stream.on('close', code => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({ code: Number.isFinite(code) ? code : 0, stdout, stderr });
      });
      stream.on('error', streamError => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(streamError);
      });
    });
  });
}

function detectOs(conn) {
  // Default shell varies (cmd, PowerShell, Git Bash). `uname` is the cheapest
  // discriminator: Git Bash reports MINGW/MSYS/CYGWIN, real Unix reports the
  // kernel name, and cmd just fails fast. Fall back to a PowerShell probe
  // (shell-agnostic because it runs via -EncodedCommand) to catch cmd/PowerShell.
  return execOn(conn, 'uname -s 2>/dev/null || echo unknown', 8000)
    .then(info => {
      const text = String(info.stdout || '').trim().split(/\r?\n/)[0] || '';
      if (/MINGW|MSYS|CYGWIN/i.test(text)) return 'windows';
      if (/linux/i.test(text)) return 'linux';
      if (/darwin/i.test(text)) return 'macos';
      if (/bsd/i.test(text)) return 'bsd';
      const check = windowsCommand("if ($env:OS -eq 'Windows_NT') { 'SMAC_OS_WINDOWS' }");
      return execOn(conn, check, 15000)
        .then(result => (/SMAC_OS_WINDOWS/.test(result.stdout) ? 'windows' : 'posix'))
        .catch(() => 'posix');
    })
    .catch(() => 'posix');
}

function posixCommand(script) {
  const b64 = Buffer.from(String(script || ''), 'utf8').toString('base64');
  return 'echo ' + b64 + ' | openssl base64 -d -A | sh';
}

function windowsCommand(script) {
  const b64 = Buffer.from(String(script || ''), 'utf16le').toString('base64');
  return 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + b64;
}

// Some Windows OpenSSH SFTP servers mangle non-ASCII file names (the request
// can come back as SSH_FX_NO_SUCH_FILE even though the folder exists). For
// those names we move bytes through an ASCII-only temp path over SFTP and let
// PowerShell - whose Unicode handling is reliable - do the final rename.
function hasNonAscii(text) {
  return /[^\x00-\x7F]/.test(String(text || ''));
}

function hasNonAsciiBase(remotePath) {
  return hasNonAscii(String(remotePath || '').replace(/\\/g, '/').split('/').pop());
}

function psQuote(text) {
  return "'" + String(text || '').replace(/'/g, "''") + "'";
}

async function windowsRun(conn, script, timeoutMs) {
  const result = await execOn(conn, windowsCommand(script), timeoutMs || 600000);
  const out = String(result.stdout || '');
  if (!/SMAC_OK/.test(out)) {
    const detail = out.replace(/SMAC_OK[\s\S]*$/, '').replace(/SMAC_ERR\s*/, '').trim();
    throw new Error(detail || String(result.stderr || '').trim() || '远端操作失败');
  }
  return out;
}

async function windowsEnsureDir(conn, dir) {
  await windowsRun(conn, "$ErrorActionPreference='Stop'\ntry { [IO.Directory]::CreateDirectory(" + psQuote(dir) + ") | Out-Null; 'SMAC_OK' } catch { 'SMAC_ERR ' + $_.Exception.Message }", 60000);
}

function sftpOpen(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((error, sftp) => {
      if (error) reject(error);
      else resolve(sftp);
    });
  });
}

function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

function dirPrefixes(remotePath) {
  const text = String(remotePath || '').replace(/\\/g, '/');
  const parts = [];
  const normalized = text.replace(/\/+$/, '');
  if (!normalized) return parts;
  if (normalized.startsWith('/')) {
    for (let i = 1; i < normalized.length; i += 1) {
      if (normalized[i] === '/') parts.push(normalized.slice(0, i));
    }
  } else {
    // Windows form: C:/Users/name/dir
    const segments = normalized.split('/');
    let current = segments.shift();
    for (const segment of segments) {
      current += '/' + segment;
      parts.push(current);
    }
  }
  if (normalized.length) parts.push(normalized);
  return parts;
}

async function mkdirp(sftp, remotePath) {
  const prefixes = dirPrefixes(remotePath);
  for (const dir of prefixes) {
    try {
      await sftpCall(sftp, 'mkdir', dir, { mode: 0o755 });
    } catch (error) {
      const code = Number(error && error.code);
      // 4 = failure (usually already exists); 11 = SSH_FX_BAD_MESSAGE on some servers
      if (code !== 4 && code !== 11 && code !== 2) {
        try {
          const stat = await sftpCall(sftp, 'stat', dir);
          if (stat && stat.isDirectory && stat.isDirectory()) continue;
        } catch { }
      }
    }
  }
}

async function replaceRename(sftp, from, to) {
  try {
    await sftpCall(sftp, 'rename', from, to);
    return;
  } catch (error) {
    try { await sftpCall(sftp, 'unlink', to); } catch { }
    await sftpCall(sftp, 'rename', from, to);
  }
}

async function uploadOne(conn, sftp, local, remote, osName) {
  const windows = osName === 'windows';
  const parent = path.posix.dirname(remote);
  if (windows && hasNonAscii(parent)) {
    await windowsEnsureDir(conn, parent);
  } else {
    await mkdirp(sftp, parent);
  }

  if (windows && hasNonAsciiBase(remote)) {
    const asciiTemp = parent.replace(/\/+$/, '') + '/smac-up-' + crypto.randomBytes(6).toString('hex') + '.tmp';
    await sftpCall(sftp, 'fastPut', local, asciiTemp);
    try {
      await windowsRun(conn, "$ErrorActionPreference='Stop'\ntry { [IO.File]::Copy(" + psQuote(asciiTemp) + ", " + psQuote(remote) + ", $true); [IO.File]::Delete(" + psQuote(asciiTemp) + "); 'SMAC_OK' } catch { 'SMAC_ERR ' + $_.Exception.Message }");
    } catch (error) {
      try { await sftpCall(sftp, 'unlink', asciiTemp); } catch { }
      throw error;
    }
    return;
  }

  const temp = remote + '.smac-tmp-' + crypto.randomBytes(4).toString('hex');
  await sftpCall(sftp, 'fastPut', local, temp);
  try {
    await replaceRename(sftp, temp, remote);
  } catch (error) {
    try { await sftpCall(sftp, 'unlink', temp); } catch { }
    throw error;
  }
}

function walkLocal(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

async function doUploadTree(conn, sftp, localRoot, remoteRoot, osName) {
  const root = path.resolve(localRoot);
  const files = walkLocal(root);
  let uploaded = 0;
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    await uploadOne(conn, sftp, file, remoteRoot.replace(/\/+$/, '') + '/' + relative, osName);
    uploaded += 1;
  }
  return uploaded;
}

async function downloadOne(conn, sftp, remote, local, osName) {
  await fsp.mkdir(path.dirname(local), { recursive: true });
  const temp = local + '.smac-tmp-' + crypto.randomBytes(4).toString('hex');
  if (osName === 'windows' && hasNonAsciiBase(remote)) {
    const parent = path.posix.dirname(remote);
    const asciiTemp = parent.replace(/\/+$/, '') + '/smac-down-' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      await windowsRun(conn, "$ErrorActionPreference='Stop'\ntry { [IO.File]::Copy(" + psQuote(remote) + ", " + psQuote(asciiTemp) + ", $true); 'SMAC_OK' } catch { 'SMAC_ERR ' + $_.Exception.Message }");
      await sftpCall(sftp, 'fastGet', asciiTemp, temp);
    } finally {
      try {
        await windowsRun(conn, "try { [IO.File]::Delete(" + psQuote(asciiTemp) + "); 'SMAC_OK' } catch { 'SMAC_OK' }", 60000);
      } catch { }
    }
  } else {
    await sftpCall(sftp, 'fastGet', remote, temp);
  }
  await fsp.rename(temp, local);
}

async function main() {
  let raw = '';
  const requestFile = process.argv[2];
  if (requestFile) {
    try {
      raw = fs.readFileSync(requestFile, 'utf8');
    } catch (error) {
      fail('读取请求文件失败: ' + error.message);
      return;
    }
  } else {
    raw = await readStdin();
  }
  let request;
  try {
    request = JSON.parse(raw || '{}');
  } catch {
    fail('请求格式错误');
    return;
  }

  const device = readDevice(request.deviceId);
  const started = Date.now();
  let connected;
  try {
    connected = await connectDevice(device, request.connectTimeoutMs);
  } catch (error) {
    fail(String(error && error.message ? error.message : error), {
      online: false,
      unreachable: networkError(error),
      host: device.host,
      ms: Date.now() - started
    });
    return;
  }

  const { conn, host, fingerprint } = connected;
  const base = { host, fingerprint, ms: Date.now() - started };
  const timeoutMs = Number(request.timeoutMs) || 180000;

  try {
    const op = String(request.op || 'exec');
    if (op === 'probe') {
      const osName = await detectOs(conn);
      const probe = await execOn(conn, osName === 'windows' ? 'echo SMAC_PROBE_OK' : 'echo SMAC_PROBE_OK', 8000);
      emit(Object.assign({ ok: probe.code === 0 && /SMAC_PROBE_OK/.test(probe.stdout), online: true, os: osName }, base));
      return;
    }

    let osName = String(request.os || '').toLowerCase();
    if (osName !== 'windows' && osName !== 'posix') osName = await detectOs(conn);

    if (op === 'exec') {
      const command = osName === 'windows' ? windowsCommand(request.script) : posixCommand(request.script);
      const result = await execOn(conn, command, timeoutMs);
      emit(Object.assign({ ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr, os: osName }, base));
      return;
    }

    const sftp = await sftpOpen(conn);
    if (op === 'upload') {
      await uploadOne(conn, sftp, String(request.local || ''), String(request.remote || ''), osName);
      emit(Object.assign({ ok: true, os: osName }, base));
      return;
    }
    if (op === 'upload-batch') {
      const files = Array.isArray(request.files) ? request.files : [];
      for (const item of files) {
        if (!item || !item.local || !item.remote) continue;
        await uploadOne(conn, sftp, String(item.local), String(item.remote), osName);
      }
      emit(Object.assign({ ok: true, os: osName, files: files.length }, base));
      return;
    }
    if (op === 'upload-tree') {
      const count = await doUploadTree(conn, sftp, String(request.local || ''), String(request.remote || ''), osName);
      emit(Object.assign({ ok: true, os: osName, files: count }, base));
      return;
    }
    if (op === 'download') {
      await downloadOne(conn, sftp, String(request.remote || ''), String(request.local || ''), osName);
      emit(Object.assign({ ok: true, os: osName }, base));
      return;
    }
    fail('未知操作: ' + op);
  } catch (error) {
    fail(String(error && error.message ? error.message : error), base);
  } finally {
    try { conn.end(); } catch { }
    try { if (connected && connected.jumpConn) connected.jumpConn.end(); } catch { }
  }
}

main().catch(error => fail(String(error && error.message ? error.message : error)));
