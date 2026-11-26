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

function readAgentCreds() {
  const data = readJson(path.join(HOME, '.smac-agent', 'credentials.json')) || {};
  const wb = data.workbuddy && typeof data.workbuddy === 'object' ? data.workbuddy : {};
  const qoder = data.qoder && typeof data.qoder === 'object' ? data.qoder : {};
  return {
    workbuddy: {
      apiKey: String(wb.apiKey || '').trim(),
      authToken: String(wb.authToken || '').trim()
    },
    qoder: {
      patCn: String(qoder.patCn || '').trim(),
      patGlobal: String(qoder.patGlobal || '').trim()
    }
  };
}

function compareSemverDescLocal(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return String(b || '').localeCompare(String(a || ''));
}

function winCandidateRootsLocal() {
  const userName = path.basename(HOME);
  const roots = [];
  const add = p => { if (p && !roots.includes(p)) roots.push(p); };
  add(LOCAL_APP);
  add(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'));
  add(process.env.ProgramFiles || 'C:\\Program Files');
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    add(path.join(drive, 'Users', userName, 'AppData', 'Local'));
    add(path.join(drive, 'Program Files'));
  }
  return roots;
}

function findBinOnPath(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (!IS_WIN) {
    for (const extra of ['/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local', 'bin'), path.join(HOME, '.qoder', 'bin', 'qodercli'), path.join(HOME, '.qoder-cn', 'bin', 'qoderclicn')]) {
      if (!dirs.includes(extra)) dirs.push(extra);
    }
  }
  for (const d of dirs) {
    for (const n of names) {
      const f = path.join(d, n);
      try { if (fs.statSync(f).isFile()) return f; } catch { }
    }
  }
  return '';
}

function findWorkBuddyEditionsLocal() {
  const editions = [];
  const checkEdition = (id, label, isCn, macNames, winRelDirs, dataDirName) => {
    let cliPath = '';
    if (IS_MAC) {
      for (const nm of macNames) {
        for (const base of ['/Applications', path.join(HOME, 'Applications')]) {
          const p = path.join(base, nm + '.app', 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy-lite-wb.mjs');
          if (fs.existsSync(p)) { cliPath = p; break; }
        }
        if (cliPath) break;
      }
    } else if (IS_WIN) {
      for (const root of winCandidateRootsLocal()) {
        for (const rel of winRelDirs) {
          const p = path.join(root, rel, 'resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy-lite-wb.mjs');
          if (fs.existsSync(p)) { cliPath = p; break; }
        }
        if (cliPath) break;
      }
    }
    const dataDir = path.join(HOME, dataDirName);
    const customList = readJson(path.join(dataDir, 'models.json'));
    const customModels = Array.isArray(customList)
      ? customList.filter(m => m && m.id).map(m => ({ id: 'custom-local:' + String(m.id), name: String(m.name || m.id) }))
      : [];
    let desktopLoggedIn = false;
    try {
      const entries = fs.readdirSync(path.join(dataDir, 'storage'));
      desktopLoggedIn = entries.some(e => /^user-/i.test(e));
    } catch { }
    if (cliPath) {
      editions.push({ id, label, isCn, cliPath, dataDir, customModels, desktopLoggedIn });
    }
  };
  checkEdition('workbuddy-cn', 'WorkBuddy CN（国内版）', true, ['WorkBuddy', 'WorkBuddy CN'], ['Programs\\WorkBuddy', 'WorkBuddy'], '.workbuddy');
  checkEdition('workbuddy-global', 'WorkBuddy AI（国际版）', false, ['WorkBuddy AI', 'WorkBuddyAI'], ['Programs\\WorkBuddyAI', 'Programs\\WorkBuddy AI', 'WorkBuddyAI', 'WorkBuddy AI'], '.workbuddy-ai');

  const standalone = findBinOnPath(IS_WIN ? ['codebuddy.cmd', 'codebuddy.exe'] : ['codebuddy', 'cbc']);
  if (!editions.length && standalone) {
    editions.push({
      id: 'codebuddy-cli',
      label: 'CodeBuddy CLI',
      isCn: false,
      cliPath: standalone,
      dataDir: path.join(HOME, '.codebuddy'),
      customModels: [],
      desktopLoggedIn: false
    });
  }
  return editions;
}

function parseWorkBuddyModelsFromHelp(helpText) {
  const m = /Currently supported:\s*\(([^)]+)\)/i.exec(String(helpText || ''));
  if (!m || !m[1]) return [];
  return Array.from(new Set(m[1].split(',').map(s => s.trim()).filter(Boolean)));
}

function probeWorkBuddy() {
  const editions = findWorkBuddyEditionsLocal();
  if (!editions.length) {
    return {
      backend: 'workbuddy',
      active: '',
      defaultProvider: '',
      defaultModel: '',
      missing: true,
      error: '客机未检测到 WorkBuddy（CN / 国际版）或 CodeBuddy CLI。',
      providers: [],
      modelLabels: {},
      reasoning: {}
    };
  }
  const creds = readAgentCreds().workbuddy;
  const hasBoundCred = Boolean(creds.apiKey || creds.authToken);
  const modelLabels = {};
  const reasoning = {};
  const providers = editions.map((ed, idx) => {
    const env = Object.assign({}, process.env, {
      PATH: (IS_WIN ? '' : '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:') + String(process.env.PATH || ''),
      CODEBUDDY_CONFIG_DIR: ed.dataDir,
      WORKBUDDY_CONFIG_DIR: ed.dataDir,
      CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1',
      NO_COLOR: '1'
    });
    if (ed.isCn) env.CODEBUDDY_CN = '1';
    let parsed = [];
    try {
      const cmd = /\.(?:c|m)?js$/i.test(ed.cliPath) ? process.execPath : ed.cliPath;
      const args = /\.(?:c|m)?js$/i.test(ed.cliPath) ? [ed.cliPath, '--help'] : ['--help'];
      const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
      parsed = parseWorkBuddyModelsFromHelp(String((r && r.stdout) || '') + '\n' + String((r && r.stderr) || ''));
    } catch { }
    const customIds = ed.customModels.map(m => m.id);
    const cloudIds = parsed.filter(id => !id.startsWith('custom-local:'));
    // 若未绑定云端 CLI 凭据且存在自定义模型，优先把免额外登录的自定义模型排在最前
    const ordered = (!hasBoundCred && customIds.length)
      ? Array.from(new Set(customIds.concat(cloudIds)))
      : Array.from(new Set(cloudIds.concat(customIds)));
    if (!ordered.length) ordered.push('auto');

    for (const cm of ed.customModels) {
      modelLabels[cm.id] = cm.name + '（桌面端自定义 · 免额外登录）';
    }
    for (const cid of cloudIds) {
      if (!modelLabels[cid]) {
        modelLabels[cid] = cid === 'auto'
          ? 'auto（WorkBuddy 云端自动路由）'
          : (cid + '（' + (ed.isCn ? 'WorkBuddy CN 云端' : 'WorkBuddy AI 云端') + '）');
      }
    }
    for (const slug of ordered) {
      reasoning[slug] = { levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: '', fast: false };
    }
    const statusHint = hasBoundCred
      ? ' · 已绑定令牌'
      : (ed.customModels.length ? ' · 自定义模型可用' : (ed.desktopLoggedIn ? ' · 桌面端已登录' : ''));
    return {
      id: ed.id,
      label: ed.label + statusHint,
      models: ordered,
      active: idx === 0
    };
  });

  const chosen = providers[0];
  const anyCustom = editions.some(e => e.customModels.length > 0);
  const note = (!hasBoundCred && !anyCustom)
    ? 'WorkBuddy 桌面端登录态受系统安全存储隔离：调用云端订阅额度请在客机终端执行 codebuddy /login，或在下方绑定 CODEBUDDY_AUTH_TOKEN / API Key。'
    : '';
  return {
    backend: 'workbuddy',
    active: chosen.id,
    defaultProvider: chosen.id,
    defaultModel: chosen.models[0] || 'auto',
    missing: false,
    error: note,
    providers,
    modelLabels,
    reasoning
  };
}

function findQoderEditionsLocal() {
  const editions = [];
  const inspectOne = (isCn) => {
    const id = isCn ? 'qoder-cn' : 'qoder-global';
    const dataDir = path.join(HOME, isCn ? '.qoder-cn' : '.qoder');
    const cliName = isCn ? 'qoderclicn' : 'qodercli';
    const pkgName = isCn ? 'qoder-cn-agent-sdk' : 'qoder-agent-sdk';
    const relTail = path.join('app.asar.unpacked', 'node_modules', '@qoder-ai', pkgName, 'dist', '_worker', 'qoder-worker-runtime.obf.mjs');

    let standalone = '';
    const standCands = IS_WIN
      ? [path.join(dataDir, 'bin', cliName, cliName + '.exe'), path.join(HOME, '.local', 'bin', cliName + '.exe')]
      : [path.join(HOME, '.local', 'bin', cliName), path.join(dataDir, 'bin', cliName, cliName), '/opt/homebrew/bin/' + cliName, '/usr/local/bin/' + cliName];
    for (const c of standCands) {
      if (fs.existsSync(c)) { standalone = c; break; }
    }
    if (!standalone) standalone = findBinOnPath(IS_WIN ? [cliName + '.exe', cliName + '.cmd'] : [cliName]);

    let worker = '';
    let runner = '';
    if (IS_MAC) {
      const appName = isCn ? 'Qoder CN' : 'Qoder';
      for (const base of ['/Applications', path.join(HOME, 'Applications')]) {
        const w = path.join(base, appName + '.app', 'Contents', 'Resources', relTail);
        if (fs.existsSync(w)) {
          worker = w;
          const r = path.join(base, appName + '.app', 'Contents', 'MacOS', appName);
          if (fs.existsSync(r)) runner = r;
          break;
        }
      }
    } else if (IS_WIN) {
      const relDirs = isCn ? ['Programs\\Qoder CN', 'Qoder CN'] : ['Programs\\Qoder', 'Qoder'];
      const exeName = isCn ? 'Qoder CN.exe' : 'Qoder.exe';
      for (const root of winCandidateRootsLocal()) {
        for (const rel of relDirs) {
          const dir = path.join(root, rel);
          const vDir = path.join(dir, '.qoder-versions');
          if (fs.existsSync(vDir)) {
            try {
              const vers = fs.readdirSync(vDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(compareSemverDescLocal);
              for (const v of vers) {
                const w = path.join(vDir, v, 'resources', relTail);
                if (fs.existsSync(w)) {
                  worker = w;
                  const r = path.join(vDir, v, exeName);
                  runner = fs.existsSync(r) ? r : (fs.existsSync(path.join(dir, exeName)) ? path.join(dir, exeName) : '');
                  break;
                }
              }
            } catch { }
          }
          if (!worker) {
            const w2 = path.join(dir, 'resources', relTail);
            if (fs.existsSync(w2)) {
              worker = w2;
              if (fs.existsSync(path.join(dir, exeName))) runner = path.join(dir, exeName);
            }
          }
          if (worker) break;
        }
        if (worker) break;
      }
    }

    if (!standalone && !worker) return;
    const statusJson = readJson(path.join(dataDir, '.qoder-app-status.json'));
    const desktopLoggedIn = Boolean(statusJson && statusJson.logged_in);
    const accountHint = statusJson ? (statusJson.email ? maskEmail(statusJson.email) : String(statusJson.name || '').trim()) : '';
    editions.push({
      id,
      isCn,
      label: isCn ? 'Qoder CN（国内版）' : 'Qoder（国际版）',
      dataDir,
      standalone,
      worker,
      runner,
      desktopLoggedIn,
      accountHint
    });
  };
  inspectOne(true);
  inspectOne(false);
  return editions;
}

function parseQoderModelsOutput(text) {
  const models = [];
  const labels = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const t = rawLine.trim();
    if (!t || /^(not logged|available|usage|error|version|account|─|═|-+$)/i.test(t)) continue;
    const m = /^[*•\-\s]*([A-Za-z0-9][A-Za-z0-9._:/-]{1,80})(?:\s{2,}|\s+[—–-]\s+|\t+)(.+)$/.exec(t);
    if (m && m[1]) {
      models.push(m[1]);
      labels[m[1]] = m[2].trim();
    } else if (/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,60}$/.test(t) && !/^\d+$/.test(t)) {
      models.push(t);
    }
  }
  return { models: Array.from(new Set(models)), labels };
}

function probeQoder() {
  const editions = findQoderEditionsLocal();
  if (!editions.length) {
    return {
      backend: 'qoder',
      active: '',
      defaultProvider: '',
      defaultModel: '',
      missing: true,
      error: '客机未检测到 Qoder（国内版 CN 或国际版）。',
      providers: [],
      modelLabels: {},
      reasoning: {}
    };
  }
  const creds = readAgentCreds().qoder;
  const proxyEnv = detectSystemProxyEnv();
  const modelLabels = {};
  const reasoning = {};
  const authWarnings = [];

  const providers = editions.map((ed, idx) => {
    const pat = ed.isCn ? creds.patCn : creds.patGlobal;
    const env = Object.assign({}, process.env, proxyEnv, {
      PATH: (IS_WIN ? '' : '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:') + String(process.env.PATH || ''),
      QODER_CONFIG_DIR: ed.dataDir,
      NO_COLOR: '1'
    });
    if (pat) {
      env.QODER_PERSONAL_ACCESS_TOKEN = pat;
      env.QODER_PAT = pat;
    }
    let cmd = '';
    let args = [];
    if (ed.standalone) {
      cmd = ed.standalone;
      args = ['--list-models'];
    } else {
      cmd = ed.runner || process.execPath;
      if (ed.runner) env.ELECTRON_RUN_AS_NODE = '1';
      args = [ed.worker, '--list-models'];
    }
    let out = '';
    try {
      const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
      out = String((r && r.stdout) || '') + '\n' + String((r && r.stderr) || '');
    } catch { }
    const notLoggedIn = /not logged in|please run.*login|authentication required/i.test(out);
    const parsed = notLoggedIn ? { models: [], labels: {} } : parseQoderModelsOutput(out);
    const models = parsed.models.length ? parsed.models : ['auto'];
    Object.assign(modelLabels, parsed.labels);
    if (!modelLabels.auto) modelLabels.auto = 'auto（Qoder 自动选择模型）';
    for (const slug of models) {
      reasoning[slug] = { levels: ['low', 'medium', 'high'], defaultLevel: '', fast: false };
    }
    const hintParts = [];
    if (pat) hintParts.push('已绑定 PAT');
    else if (!notLoggedIn && parsed.models.length) hintParts.push('CLI 已登录');
    else if (ed.desktopLoggedIn) hintParts.push('桌面端已登录' + (ed.accountHint ? ' · ' + ed.accountHint : '') + ' · 需 CLI 登录或 PAT');
    else hintParts.push('未登录 CLI');
    if (notLoggedIn) {
      authWarnings.push((ed.isCn ? 'Qoder CN' : 'Qoder 国际版') + ' 需先在客机终端完成一次 CLI 登录或在下方绑定 PAT');
    }
    return {
      id: ed.id,
      label: ed.label + (hintParts.length ? '（' + hintParts.join(' / ') + '）' : ''),
      models,
      active: idx === 0,
      cliAuthenticated: !notLoggedIn
    };
  });

  const authed = providers.find(p => p.cliAuthenticated);
  const chosen = authed || providers[0];
  return {
    backend: 'qoder',
    active: chosen.id,
    defaultProvider: chosen.id,
    defaultModel: chosen.models[0] || 'auto',
    missing: false,
    error: (!authed && authWarnings.length)
      ? ('Qoder 桌面端凭据受系统安全存储隔离：' + authWarnings.join('；') + '（同账号同额度，支持 SSH 链接授权或 PAT 绑定）。')
      : '',
    providers,
    modelLabels,
    reasoning
  };
}

(async () => {
  const mode = String(process.argv[2] || '').toLowerCase();
  const payload = mode === 'dsh' ? probeDsh()
    : (mode === 'agy' ? probeAgy()
      : (mode === 'workbuddy' ? probeWorkBuddy()
        : (mode === 'qoder' ? probeQoder() : await probeCodex())));
  console.log('SMAC_MODELS ' + JSON.stringify(payload));
})().catch(err => {
  console.log('SMAC_MODELS ' + JSON.stringify({ error: String((err && err.message) || err), providers: [] }));
});
