'use strict';

// Lightweight guest-side model probe invoked by host agent-manager.js over SSH.
// Supports: node probe-models.js codex | dsh
// Never prints raw auth tokens; only returns masked emails, plan types, and live model lists.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const HOME = os.homedir();
const LOCAL_APP = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const REAL_HERMES_HOME = process.env.SMAC_REAL_HERMES_HOME
  || (IS_WIN ? path.join(LOCAL_APP, 'hermes') : path.join(HOME, '.hermes'));
const REASONING_LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const crypto = require('crypto');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return null; }
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function decodeJwt(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    const raw = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch { return null; }
}

function maskEmail(value) {
  const text = String(value || '').trim();
  const at = text.indexOf('@');
  if (at <= 1) return text;
  return text.slice(0, 2) + '***' + text.slice(at);
}

function findCodexExe() {
  const tools = path.join(HOME, '.smac-agent', 'tools');
  const candidates = [];
  if (IS_WIN) {
    candidates.push(path.join(tools, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'));
    try {
      const scope = path.join(tools, 'node_modules', '@openai');
      for (const name of fs.readdirSync(scope)) {
        if (!name.startsWith('codex')) continue;
        const vendor = path.join(scope, name, 'vendor');
        for (const plat of fs.readdirSync(vendor)) {
          candidates.push(path.join(vendor, plat, 'bin', 'codex.exe'));
        }
      }
    } catch { }
  } else {
    candidates.push(path.join(tools, 'node_modules', '.bin', 'codex'));
    candidates.push('/usr/local/bin/codex', '/opt/homebrew/bin/codex');
  }
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { }
  }
  const names = IS_WIN ? ['codex.exe'] : ['codex'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const f = path.join(dir, n);
      try { if (fs.statSync(f).isFile()) return f; } catch { }
    }
  }
  return '';
}

function discoverCodexSources() {
  const sources = [];
  const nativeFile = path.join(HOME, '.codex', 'auth.json');
  const native = readJson(nativeFile);
  if (native && ((native.tokens && native.tokens.access_token) || native.OPENAI_API_KEY)) {
    const tokens = native.tokens || {};
    const jwt = decodeJwt(tokens.access_token) || {};
    const authClaim = jwt['https://api.openai.com/auth'] || {};
    const profClaim = jwt['https://api.openai.com/profile'] || {};
    const plan = String(authClaim.chatgpt_plan_type || (native.OPENAI_API_KEY ? 'api-key' : '')).toLowerCase();
    const email = maskEmail(profClaim.email || '');
    const accountId = String(tokens.account_id || authClaim.chatgpt_account_id || authClaim.account_id || '');
    const tag = [plan, email].filter(Boolean).join(' · ');
    sources.push({
      id: 'codex-native',
      label: 'Codex 本地登录' + (tag ? ' (' + tag + ')' : ''),
      plan,
      email,
      accountId,
      mtime: mtimeOf(nativeFile),
      accessToken: tokens.access_token || '',
      cacheFiles: [
        path.join(HOME, '.codex', 'models_cache.json'),
        path.join(HOME, '.smac-agent', 'codex-home-native', 'models_cache.json')
      ]
    });
  }

  const hermesFile = path.join(REAL_HERMES_HOME, 'auth.json');
  const hermes = readJson(hermesFile);
  const entry = hermes && hermes.providers && hermes.providers['openai-codex'];
  const hTokens = entry && entry.tokens;
  if (hTokens && hTokens.access_token && hTokens.refresh_token) {
    const jwt = decodeJwt(hTokens.access_token) || {};
    const authClaim = jwt['https://api.openai.com/auth'] || {};
    const profClaim = jwt['https://api.openai.com/profile'] || {};
    const plan = String(authClaim.chatgpt_plan_type || '').toLowerCase();
    const email = maskEmail(profClaim.email || '');
    const accountId = String(authClaim.chatgpt_account_id || authClaim.account_id || '');
    const tag = [plan, email].filter(Boolean).join(' · ');
    sources.push({
      id: 'codex-hermes',
      label: 'Hermes 账号复用' + (tag ? ' (' + tag + ')' : ''),
      plan,
      email,
      accountId,
      mtime: mtimeOf(hermesFile),
      accessToken: hTokens.access_token || '',
      cacheFiles: [
        path.join(HOME, '.smac-agent', 'codex-home-hermes', 'models_cache.json'),
        path.join(HOME, '.smac-agent', 'codex-home', 'models_cache.json')
      ]
    });
  }

  sources.sort((a, b) => (b.mtime - a.mtime) || (a.id === 'codex-native' ? -1 : 1));
  return sources;
}

function parseCodexCatalog(rawList, reasoningOut) {
  const raw = Array.isArray(rawList) ? rawList : [];
  const models = raw
    .filter(item => item && item.slug && (!item.visibility || item.visibility === 'list'))
    .sort((a, b) => (Number(a.priority) || 999) - (Number(b.priority) || 999))
    .map(item => String(item.slug));
  raw.forEach(item => {
    if (!item || !item.slug) return;
    const levels = Array.isArray(item.supported_reasoning_levels)
      ? item.supported_reasoning_levels
        .map(l => String((l && l.effort) || l || '').toLowerCase())
        .filter(l => REASONING_LEVELS.has(l))
      : [];
    const tiers = Array.isArray(item.additional_speed_tiers) ? item.additional_speed_tiers.map(String) : [];
    const fast = tiers.includes('fast')
      || (Array.isArray(item.service_tiers) && item.service_tiers.some(t => t && t.id === 'priority'));
    reasoningOut[String(item.slug)] = {
      levels,
      defaultLevel: String(item.default_reasoning_level || '').toLowerCase(),
      fast
    };
  });
  return Array.from(new Set(models));
}

async function fetchLiveCodexModels(src) {
  if (!src.accessToken) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const headers = {
      Authorization: 'Bearer ' + src.accessToken,
      'User-Agent': 'codex_cli_rs/0.171.0'
    };
    if (src.accountId) headers['ChatGPT-Account-Id'] = src.accountId;
    const res = await fetch('https://chatgpt.com/backend-api/codex/models?client_version=0.171.0', {
      headers,
      signal: controller.signal
    });
    if (!res.ok) return null;
    const json = await res.json();
    return (json && Array.isArray(json.models) && json.models.length) ? json.models : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probeCodex() {
  const exe = findCodexExe();
  const sources = discoverCodexSources();
  if (!exe) {
    return {
      backend: 'codex', active: '', defaultProvider: '', defaultModel: '',
      missing: true, error: '', providers: [], reasoning: {}
    };
  }
  if (!sources.length) {
    return {
      backend: 'codex', active: '', defaultProvider: '', defaultModel: '',
      missing: false, error: '客机未检测到 Codex 或 Hermes 的 ChatGPT 登录。', providers: [], reasoning: {}
    };
  }
  const reasoning = {};
  const providers = await Promise.all(sources.map(async (src, i) => {
    let rawModels = await fetchLiveCodexModels(src);
    if (!rawModels) {
      for (const cf of src.cacheFiles) {
        const cached = readJson(cf);
        if (cached && Array.isArray(cached.models) && cached.models.length) {
          rawModels = cached.models;
          break;
        }
      }
    }
    if (!rawModels) {
      try {
        const r = spawnSync(exe, ['debug', 'models'], {
          env: Object.assign({}, process.env, { NO_COLOR: '1' }),
          timeout: 15000,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024
        });
        const stdout = String((r && r.stdout) || '');
        const s = stdout.indexOf('{"models"');
        if (s >= 0) {
          const j = JSON.parse(stdout.slice(s, stdout.lastIndexOf('}') + 1));
          if (j && Array.isArray(j.models)) rawModels = j.models;
        }
      } catch { }
    }
    const models = parseCodexCatalog(rawModels, reasoning);
    return {
      id: src.id,
      label: src.label,
      plan: src.plan || '',
      email: src.email || '',
      models,
      active: i === 0
    };
  }));
  const chosen = providers.find(p => p.models.length) || providers[0];
  return {
    backend: 'codex',
    active: chosen ? chosen.id : '',
    defaultProvider: chosen ? chosen.id : '',
    defaultModel: (chosen && chosen.models[0]) || '',
    missing: false,
    error: (chosen && chosen.models.length) ? '' : '无法读取 Codex 模型目录',
    providers,
    reasoning
  };
}

function probeDsh() {
  const c1 = path.join(LOCAL_APP, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  const c2 = path.join(process.env.ProgramFiles || '', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  const c3 = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
  const ok = fs.existsSync(c1) || fs.existsSync(c2) || fs.existsSync(c3);
  let acc = false;
  try { acc = /deepseek-account/.test(fs.readFileSync(path.join(HOME, '.dsh', '.credentials.yaml'), 'utf8')); } catch { }
  let ap = 'deepseek-account';
  let dm = 'deepseek-flash';
  const cp = [];
  try {
    const r = fs.readFileSync(path.join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8');
    const m1 = r.match(/id:\s*agent-default-model[\s\S]*?provider:\s*([^\r\n#]+)/);
    if (m1) ap = m1[1].trim().replace(/^['"]|['"]$/g, '');
    const m2 = r.match(/id:\s*agent-default-model[\s\S]*?model:\s*([^\r\n#]+)/);
    if (m2) dm = m2[1].trim().replace(/^['"]|['"]$/g, '');
    const idx = r.indexOf('- id: llm-pi-ai');
    if (idx >= 0) {
      const rest = r.slice(idx);
      const nt = rest.slice(15).search(/\r?\n-\s+id:\s+/);
      const blk = nt >= 0 ? rest.slice(0, 15 + nt) : rest;
      let cur = null;
      for (const l of blk.split(/\r?\n/)) {
        const pm = l.match(/^ {6}([a-zA-Z0-9_.-]+):\s*$/);
        if (pm) {
          cur = { id: pm[1], label: 'DeepSeek Harness · ' + pm[1], models: [], active: ap === pm[1] };
          cp.push(cur);
          continue;
        }
        const mm = cur && l.match(/^ {10}-\s+id:\s+(.+)$/);
        if (mm) {
          const id = mm[1].trim().replace(/^['"]|['"]$/g, '');
          if (id && !cur.models.includes(id)) cur.models.push(id);
        }
      }
    }
  } catch { }
  const providers = [
    {
      id: 'deepseek-account',
      label: 'DeepSeek Harness 官方订阅' + (acc ? '（已登录）' : ''),
      models: ['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner'],
      active: ap === 'deepseek-account'
    },
    ...cp.filter(x => x.models.length)
  ];
  return {
    backend: 'dsh',
    missing: !ok,
    active: ap,
    defaultProvider: ap,
    defaultModel: dm,
    providers
  };
}

function findAgyExe() {
  const dir = path.join(HOME, '.smac-agent', 'tools', 'antigravity');
  const cands = IS_WIN
    ? [
      path.join(HOME, '.gemini', 'bin', 'agy.exe'),
      path.join(LOCAL_APP, 'agy', 'bin', 'agy.exe'),
      path.join(HOME, '.local', 'bin', 'agy.exe'),
      path.join(dir, 'agy.exe'),
      path.join(dir, 'bin', 'agy.exe')
    ]
    : [
      path.join(HOME, '.gemini', 'bin', 'agy'),
      path.join(HOME, '.local', 'bin', 'agy'),
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy',
      path.join(dir, 'agy'),
      path.join(dir, 'bin', 'agy')
    ];
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return c; } catch { }
  }
  const names = IS_WIN ? ['agy.exe', 'agy.cmd'] : ['agy'];
  for (const p of String(process.env.PATH || '').split(path.delimiter)) {
    if (!p) continue;
    for (const n of names) {
      const f = path.join(p, n);
      try { if (fs.statSync(f).isFile()) return f; } catch { }
    }
  }
  return '';
}

function detectSystemProxyEnv() {
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
    return {};
  }
  const found = {};
  try {
    if (IS_WIN) {
      const q = spawnSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'], {
        encoding: 'utf8', timeout: 3000, windowsHide: true
      });
      if (/0x1\b/i.test(String(q.stdout || ''))) {
        const s = spawnSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'], {
          encoding: 'utf8', timeout: 3000, windowsHide: true
        });
        const m = /ProxyServer\s+REG_\w+\s+(.+)/i.exec(String(s.stdout || ''));
        if (m && m[1]) {
          const raw = m[1].trim();
          const mHttps = /https=([^;]+)/i.exec(raw);
          const mHttp = /http=([^;]+)/i.exec(raw);
          let hp = ((mHttps && mHttps[1]) || (mHttp && mHttp[1]) || raw.split(';')[0] || '').trim();
          if (hp) {
            if (!/^https?:\/\//i.test(hp)) hp = 'http://' + hp;
            found.HTTP_PROXY = hp;
            found.HTTPS_PROXY = hp;
            found.http_proxy = hp;
            found.https_proxy = hp;
          }
        }
      }
    } else if (IS_MAC) {
      const q = spawnSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 });
      const text = String(q.stdout || '');
      const getVal = key => {
        const m = new RegExp('^\\s*' + key + '\\s*:\\s*(\\S+)', 'm').exec(text);
        return m ? m[1].trim() : '';
      };
      if (getVal('HTTPSEnable') === '1' && getVal('HTTPSProxy') && getVal('HTTPSPort')) {
        const url = 'http://' + getVal('HTTPSProxy') + ':' + getVal('HTTPSPort');
        found.HTTPS_PROXY = url;
        found.https_proxy = url;
      }
      if (getVal('HTTPEnable') === '1' && getVal('HTTPProxy') && getVal('HTTPPort')) {
        const url = 'http://' + getVal('HTTPProxy') + ':' + getVal('HTTPPort');
        found.HTTP_PROXY = url;
        found.http_proxy = url;
      }
    }
  } catch { }
  return found;
}

function detectAgyDesktopMeta() {
  const desktopInstalled = IS_WIN
    ? (fs.existsSync(path.join(LOCAL_APP, 'Programs', 'Antigravity', 'Antigravity.exe'))
      || fs.existsSync(path.join(LOCAL_APP, 'Programs', 'antigravity', 'Antigravity.exe')))
    : (IS_MAC
      ? (fs.existsSync('/Applications/Antigravity.app') || fs.existsSync(path.join(HOME, 'Applications', 'Antigravity.app')))
      : false);
  let desktopLoggedIn = false;
  let accountHint = '';
  const storageFile = IS_WIN
    ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Antigravity', 'app_storage.json')
    : (IS_MAC
      ? path.join(HOME, 'Library', 'Application Support', 'Antigravity', 'app_storage.json')
      : path.join(HOME, '.config', 'Antigravity', 'app_storage.json'));
  const data = readJson(storageFile);
  if (data && typeof data === 'object') {
    const u = String(data['agy.onboarding.lastLoginUsername'] || '').trim();
    if (u) {
      desktopLoggedIn = true;
      accountHint = maskEmail(u);
    }
  }
  if (!desktopLoggedIn && fs.existsSync(path.join(HOME, '.gemini', 'antigravity', 'antigravity_state.pbtxt'))) {
    desktopLoggedIn = true;
  }
  return { desktopInstalled, desktopLoggedIn, accountHint };
}

function parseAgyOutput(rawText) {
  const models = [];
  const modelLabels = {};
  let errLine = '';
  for (const rawLine of String(rawText || '').split(/\r?\n/)) {
    const raw = rawLine.replace(/\r$/, '');
    const t = raw.trim();
    if (!t || /^(Fetching|Usage|Available models)\b/i.test(t)) continue;
    if (/^Error:/i.test(t)) { errLine = t; continue; }
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\t+|\s{2,})(.+?)\s*$/.exec(raw);
    if (m && m[1] && !/^\d+$/.test(m[1])) {
      models.push(m[1]);
      modelLabels[m[1]] = m[2].trim();
    }
  }
  return { models: Array.from(new Set(models)), modelLabels, error: errLine };
}

function runAgyModelsInteractive(exe, proxyEnv) {
  if (IS_WIN) {
    const dir = path.join(HOME, '.smac-agent');
    fs.mkdirSync(dir, { recursive: true });
    const tag = crypto.randomBytes(3).toString('hex');
    const outFile = path.join(dir, 'agy-m-' + tag + '.tmp');
    const cmdFile = path.join(dir, 'run-agy-m-' + tag + '.cmd');
    const vbsFile = path.join(dir, 'run-agy-m-' + tag + '.vbs');
    let raw = '';
    try {
      const lines = [
        '@echo off',
        'set SSH_CONNECTION=',
        'set SSH_CLIENT=',
        'set SSH_TTY='
      ];
      if (proxyEnv.HTTP_PROXY) lines.push('set HTTP_PROXY=' + proxyEnv.HTTP_PROXY);
      if (proxyEnv.HTTPS_PROXY) lines.push('set HTTPS_PROXY=' + proxyEnv.HTTPS_PROXY);
      lines.push('"' + exe + '" models > "' + outFile + '" 2>&1');
      fs.writeFileSync(cmdFile, lines.join('\r\n') + '\r\n', 'utf8');
      const vbs = 'CreateObject("WScript.Shell").Run """" & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\\' + path.basename(cmdFile) + '""", 0, True';
      fs.writeFileSync(vbsFile, vbs, 'ascii');
      const ps = [
        "$ErrorActionPreference='SilentlyContinue'",
        "$tn = 'SmacAgyModels'; $uid = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
        "$act = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('\"' + '" + vbsFile.replace(/'/g, "''") + "' + '\"')",
        "$pri = New-ScheduledTaskPrincipal -UserId $uid -LogonType Interactive -RunLevel Limited",
        "$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden",
        "Register-ScheduledTask -TaskName $tn -Action $act -Principal $pri -Settings $set -Force | Out-Null",
        "Start-ScheduledTask -TaskName $tn",
        "for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 400; if ((Get-ScheduledTask -TaskName $tn).State -ne 'Running') { break } }",
        "Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue | Out-Null"
      ].join('\n');
      spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
        encoding: 'utf8', timeout: 25000, windowsHide: true
      });
      if (fs.existsSync(outFile)) raw = fs.readFileSync(outFile, 'utf8');
    } catch { }
    finally {
      for (const f of [outFile, cmdFile, vbsFile]) {
        try { fs.rmSync(f, { force: true }); } catch { }
      }
    }
    if (!raw) {
      const env = Object.assign({}, process.env, proxyEnv, { NO_COLOR: '1' });
      delete env.SSH_CONNECTION; delete env.SSH_CLIENT; delete env.SSH_TTY;
      const r = spawnSync(exe, ['models'], { env, encoding: 'utf8', timeout: 20000, windowsHide: true });
      raw = String((r && r.stdout) || '') + '\n' + String((r && r.stderr) || '');
    }
    return raw;
  }

  if (IS_MAC) {
    const id = crypto.randomBytes(4).toString('hex');
    const base = path.join(os.tmpdir(), 'smac-agy-m-' + id);
    const shFile = base + '.sh';
    const outFile = base + '.out';
    const doneFile = base + '.done';
    const plistFile = base + '.plist';
    const label = 'com.smac.agyprobe.' + id;
    let raw = '';
    try {
      const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '';
      if (uid) {
        const shLines = [
          '#!/bin/sh',
          'export HOME=' + JSON.stringify(HOME),
          'export PATH=' + JSON.stringify('/opt/homebrew/bin:/usr/local/bin:' + path.join(HOME, '.gemini', 'bin') + ':' + path.join(HOME, '.local', 'bin') + ':/usr/bin:/bin'),
          'unset SSH_CONNECTION SSH_CLIENT SSH_TTY'
        ];
        for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
          if (proxyEnv[k]) shLines.push('export ' + k + '=' + JSON.stringify(proxyEnv[k]));
        }
        shLines.push(JSON.stringify(exe) + ' models > ' + JSON.stringify(outFile) + ' 2>&1');
        shLines.push('echo DONE > ' + JSON.stringify(doneFile));
        fs.writeFileSync(shFile, shLines.join('\n') + '\n', { mode: 0o700 });
        const plist = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
          '<plist version="1.0"><dict>',
          '<key>Label</key><string>' + label + '</string>',
          '<key>LimitLoadToSessionType</key><string>Aqua</string>',
          '<key>RunAtLoad</key><true/>',
          '<key>ProgramArguments</key><array><string>/bin/sh</string><string>' + shFile + '</string></array>',
          '</dict></plist>'
        ].join('\n');
        fs.writeFileSync(plistFile, plist, 'utf8');
        spawnSync('launchctl', ['bootout', 'gui/' + uid + '/' + label], { timeout: 5000 });
        const boot = spawnSync('launchctl', ['bootstrap', 'gui/' + uid, plistFile], { timeout: 8000 });
        if (boot.status === 0) {
          const deadline = Date.now() + 16000;
          while (Date.now() < deadline) {
            if (fs.existsSync(doneFile)) break;
            spawnSync('/bin/sleep', ['0.4'], { timeout: 2000 });
          }
          spawnSync('launchctl', ['bootout', 'gui/' + uid + '/' + label], { timeout: 5000 });
          if (fs.existsSync(outFile)) raw = fs.readFileSync(outFile, 'utf8');
        }
      }
    } catch { }
    finally {
      for (const f of [shFile, outFile, doneFile, plistFile]) {
        try { fs.rmSync(f, { force: true }); } catch { }
      }
    }
    if (raw) return raw;
  }

  const env = Object.assign({}, process.env, proxyEnv, { NO_COLOR: '1' });
  delete env.SSH_CONNECTION; delete env.SSH_CLIENT; delete env.SSH_TTY;
  const r = spawnSync(exe, ['models'], { env, encoding: 'utf8', timeout: 20000, windowsHide: true });
  return String((r && r.stdout) || '') + '\n' + String((r && r.stderr) || '');
}

function probeAgy() {
  const meta = detectAgyDesktopMeta();
  const exe = findAgyExe();
  if (!exe) {
    return {
      backend: 'agy',
      models: [],
      modelLabels: {},
      missing: true,
      error: '',
      desktopInstalled: meta.desktopInstalled,
      desktopLoggedIn: meta.desktopLoggedIn,
      accountHint: meta.accountHint,
      exe: ''
    };
  }
  const proxyEnv = detectSystemProxyEnv();
  const raw = runAgyModelsInteractive(exe, proxyEnv);
  const parsed = parseAgyOutput(raw);
  return {
    backend: 'agy',
    models: parsed.models,
    modelLabels: parsed.modelLabels,
    missing: false,
    error: parsed.error,
    desktopInstalled: meta.desktopInstalled,
    desktopLoggedIn: meta.desktopLoggedIn,
    accountHint: meta.accountHint,
    exe
  };
}

(async () => {
  const mode = String(process.argv[2] || '').toLowerCase();
  const payload = mode === 'dsh' ? probeDsh()
    : (mode === 'agy' ? probeAgy() : await probeCodex());
  console.log('SMAC_MODELS ' + JSON.stringify(payload));
})().catch(err => {
  console.log('SMAC_MODELS ' + JSON.stringify({ error: String((err && err.message) || err), providers: [] }));
});
