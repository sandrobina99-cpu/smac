'use strict';

// smac remote agent server. Runs on the remote SSH machine, binds to 127.0.0.1
// only, and executes that machine's own Hermes Agent (using its local login /
// quota) with a restricted toolset and the allowed sync-folder roots.
//
// Usage: node agent-server.js [--port 8799]
//
// The page is a chat UI. Each turn is one `hermes chat --query-file ...` run in
// the selected sync folder; a named Hermes session keeps the conversation
// context between turns. stdout is parsed into an "activity" part (tool calls /
// diffs) and the final framed answer, then streamed to the browser over SSE.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const guestEnv = require('./guest-env');

const IS_WIN = process.platform === 'win32';
const DIR = process.env.SMAC_AGENT_DIR
  ? path.resolve(process.env.SMAC_AGENT_DIR)
  : path.join(os.homedir(), '.smac-agent');
const ROOTS_FILE = path.join(DIR, 'roots.json');
const HOME = path.join(DIR, 'home');
const SERVER_FILE = path.join(DIR, 'server.json');
const LOG_DIR = path.join(DIR, 'logs');
const TURN_DIR = path.join(DIR, 'turns');
const UPLOAD_DIR = path.join(DIR, 'uploads');
// Conversation transcripts live on the remote machine so every browser gets
// the same history, and past sessions survive "新对话" / a page reload.
const HISTORY_DIR = path.join(DIR, 'history');
const HISTORY_FILES_MAX = 300;
const HISTORY_MSGS_MAX = 600;
const HISTORY_ACTIVITY_MAX = 16000;
const GUARD = path.join(__dirname, 'path-guard.js');
const CODEX_HOME_DIR = path.join(DIR, 'codex-home');
// The built-in image generation tool writes here; the page may preview these
// files read-only, but they never become part of the writable sync roots.
const CODEX_GENERATED_DIR = path.join(CODEX_HOME_DIR, 'generated_images');
const CODEX_SESSIONS = path.join(DIR, 'codex-sessions.json');
const CODEX_HOOK = path.join(__dirname, 'codex-hook.js');
const MCP_SERVER = path.join(__dirname, 'smac-mcp.js');
const CREDENTIALS_FILE = path.join(DIR, 'credentials.json');
const CLAUDE_SESSIONS = path.join(DIR, 'claude-sessions.json');
const AGY_SESSIONS = path.join(DIR, 'agy-sessions.json');
const DSH_SESSIONS = path.join(DIR, 'dsh-sessions.json');
const CLAUDE_MCP_FILE = path.join(DIR, 'claude-mcp.json');
const AGY_KEY_MARKER = path.join(DIR, 'agy-key-mode.json');
const AGY_SETTINGS = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
const AGY_MCP_CONFIG = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
const BACKEND_IDS = ['dsh', 'hermes', 'codex', 'claude', 'agy', 'opencode'];
const BACKEND_SET = new Set(BACKEND_IDS);
const BACKEND_LABELS = {
  dsh: 'DeepSeek Harness',
  hermes: 'Hermes Agent',
  codex: 'Codex CLI',
  claude: 'Claude Code',
  agy: 'Gemini · Antigravity',
  opencode: 'OpenCode CLI'
};
const REAL_HERMES_HOME = process.env.SMAC_HERMES_HOME
  || (IS_WIN
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes')
    : path.join(os.homedir(), '.hermes'));

const HOST = '127.0.0.1';
const BASE_PORT = 8799;
const MAX_PROMPT = 16000;
const MAX_BODY = 64 * 1024 * 1024;
const MAX_UPLOAD = 16 * 1024 * 1024;
const MAX_FILE_UPLOAD = 40 * 1024 * 1024;
const MAX_FILE = 80 * 1024 * 1024;
const MAX_RAW = 300 * 1024;
const KEEP_UPLOAD_MS = 7 * 24 * 3600 * 1000;
const REASONING_LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const BROWSE_SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '$RECYCLE.BIN', 'System Volume Information', '__pycache__']);

let PORT = BASE_PORT;
let TOKEN = '';
let server = null;
let turn = null;
let runningChild = null;
let authState = null;
let codexAuthState = null;
const codexModelsCache = { at: 0, data: null };
const agyModelsCache = { at: 0, data: null };
const claudeAuthCache = { at: 0, data: null };
let eventSeq = 0;
const sseClients = new Set();
const startedAt = new Date().toISOString();

function log(text) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'agent.log'),
      '[' + new Date().toISOString() + '] ' + text + '\n', 'utf8');
  } catch { }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function normalizeBackend(value) {
  const id = String(value || '').trim().toLowerCase();
  return BACKEND_SET.has(id) ? id : 'hermes';
}

function backendLabel(value) {
  return BACKEND_LABELS[normalizeBackend(value)] || BACKEND_LABELS.hermes;
}

// Access-style binding: the console stores the keys locally and uploads them
// only when the remote agent is started. They are injected into the backend
// CLI process environment and never returned by any API.
function loadCredentials() {
  const data = readJson(CREDENTIALS_FILE) || {};
  const claude = data.claude && typeof data.claude === 'object' ? data.claude : {};
  const agy = data.agy && typeof data.agy === 'object' ? data.agy : {};
  return {
    claude: {
      apiKey: String(claude.apiKey || '').trim(),
      oauthToken: String(claude.oauthToken || '').trim(),
      baseUrl: String(claude.baseUrl || '').trim()
    },
    agy: {
      apiKey: String(agy.apiKey || '').trim(),
      baseUrl: String(agy.baseUrl || '').trim()
    }
  };
}

function credentialStatus() {
  const creds = loadCredentials();
  return {
    claude: { bound: Boolean(creds.claude.apiKey || creds.claude.oauthToken), baseUrl: Boolean(creds.claude.baseUrl) },
    agy: { bound: Boolean(creds.agy.apiKey), baseUrl: Boolean(creds.agy.baseUrl) }
  };
}

function expandHome(value) {
  const text = String(value || '').trim();
  if (!text) { return ''; }
  if (text === '~') { return os.homedir(); }
  if (/^~[\\/]/.test(text)) { return path.join(os.homedir(), text.slice(2)); }
  return text;
}

function normalizeForCompare(value) {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return IS_WIN ? resolved.toLowerCase() : resolved;
}

function isUnder(child, parent) {
  const a = normalizeForCompare(child);
  const b = normalizeForCompare(parent);
  return a === b || a.startsWith(b + path.sep);
}

function isForbiddenRoot(full) {
  const resolved = path.resolve(full);
  const parsed = path.parse(resolved);
  const home = path.resolve(os.homedir());
  if (normalizeForCompare(resolved) === normalizeForCompare(parsed.root)) { return '不能使用磁盘根目录'; }
  if (normalizeForCompare(resolved) === normalizeForCompare(home)) { return '不能使用整个用户目录'; }
  const parent = path.dirname(home);
  if (normalizeForCompare(resolved) === normalizeForCompare(parent)) { return '目录范围过大'; }
  if (normalizeForCompare(home).startsWith(normalizeForCompare(resolved) + path.sep)) { return '目录范围过大'; }
  return '';
}

function loadRoots() {
  const data = readJson(ROOTS_FILE);
  const raw = data && Array.isArray(data.roots) ? data.roots : (Array.isArray(data) ? data : []);
  const roots = [];
  const problems = [];
  for (const item of raw) {
    const original = item && typeof item === 'object' ? item.path : item;
    const label = item && typeof item === 'object' && item.label ? String(item.label) : '';
    let full = expandHome(String(original || ''));
    if (!full) { continue; }
    if (!path.isAbsolute(full)) { problems.push('不是绝对路径: ' + full); continue; }
    full = path.resolve(full);
    const forbidden = isForbiddenRoot(full);
    if (forbidden) { problems.push(forbidden + ': ' + full); continue; }
    try { fs.mkdirSync(full, { recursive: true }); }
    catch (error) { problems.push('无法创建或访问 ' + full + ': ' + error.message); continue; }
    if (!roots.some(root => normalizeForCompare(root.path) === normalizeForCompare(full))) {
      roots.push({ label: label || path.basename(full) || full, path: full });
    }
  }
  return {
    device: data && data.device ? String(data.device) : '',
    roots,
    problems,
    backend: normalizeBackend(data && data.backend),
    provider: data && data.provider ? String(data.provider) : '',
    model: data && data.model ? String(data.model) : '',
    timeoutSeconds: Math.min(Math.max(Number(data && data.timeoutSeconds) || 900, 60), 7200)
  };
}

function findHermes() {
  const candidates = [];
  if (process.env.SMAC_HERMES_EXE) { candidates.push(process.env.SMAC_HERMES_EXE); }
  if (IS_WIN) {
    candidates.push(path.join(REAL_HERMES_HOME, 'bin', 'hermes.exe'));
    candidates.push(path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'bin', 'hermes.exe'));
  } else {
    candidates.push(path.join(REAL_HERMES_HOME, 'bin', 'hermes'));
    candidates.push(path.join(os.homedir(), '.local', 'bin', 'hermes'));
    candidates.push('/usr/local/bin/hermes');
    candidates.push('/opt/homebrew/bin/hermes');
  }
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) { return candidate; } } catch { }
  }
  return '';
}

function findCodex() {
  const candidates = [];
  if (process.env.SMAC_CODEX_EXE) { candidates.push(process.env.SMAC_CODEX_EXE); }
  const tools = path.join(DIR, 'tools');
  if (IS_WIN) {
    candidates.push(path.join(tools, 'node_modules', '@openai', 'codex-win32-x64', 'vendor',
      'x86_64-pc-windows-msvc', 'bin', 'codex.exe'));
    try {
      const scope = path.join(tools, 'node_modules', '@openai');
      for (const name of fs.readdirSync(scope)) {
        if (!name.startsWith('codex')) { continue; }
        const vendor = path.join(scope, name, 'vendor');
        let platforms = [];
        try { platforms = fs.readdirSync(vendor); } catch { }
        for (const platform of platforms) {
          candidates.push(path.join(vendor, platform, 'bin', 'codex.exe'));
        }
      }
    } catch { }
  } else {
    candidates.push(path.join(tools, 'node_modules', '.bin', 'codex'));
    candidates.push('/usr/local/bin/codex');
    candidates.push('/opt/homebrew/bin/codex');
  }
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) { return candidate; } } catch { }
  }
  const names = IS_WIN ? ['codex.exe'] : ['codex'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      try { if (fs.statSync(file).isFile()) { return file; } } catch { }
    }
  }
  return '';
}

function findOnPath(names) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      try { if (fs.statSync(file).isFile()) { return file; } } catch { }
    }
  }
  return '';
}

// Claude Code: prefer the native single-file executable, then the npm package's
// cli.js (which is launched through the current Node runtime on every OS).
function findClaude() {
  const candidates = [];
  if (process.env.SMAC_CLAUDE_EXE) { candidates.push(process.env.SMAC_CLAUDE_EXE); }
  const tools = path.join(DIR, 'tools');
  if (IS_WIN) {
    candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude.exe'));
    candidates.push(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Programs', 'claude', 'claude.exe'));
  } else {
    candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude'));
    candidates.push('/opt/homebrew/bin/claude');
    candidates.push('/usr/local/bin/claude');
  }
  candidates.push(path.join(tools, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'));
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) { return candidate; } } catch { }
  }
  const fromPath = findOnPath(IS_WIN ? ['claude.exe', 'claude.cmd'] : ['claude']);
  if (fromPath) { return fromPath; }
  const cliJs = path.join(tools, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  try { if (fs.statSync(cliJs).isFile()) { return cliJs; } } catch { }
  return '';
}

function findAgy() {
  const candidates = [];
  if (process.env.SMAC_AGY_EXE) { candidates.push(process.env.SMAC_AGY_EXE); }
  const install = path.join(DIR, 'tools', 'antigravity');
  if (IS_WIN) {
    candidates.push(path.join(os.homedir(), '.gemini', 'bin', 'agy.exe'));
    candidates.push(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'agy', 'bin', 'agy.exe'));
    candidates.push(path.join(os.homedir(), '.local', 'bin', 'agy.exe'));
    candidates.push(path.join(install, 'agy.exe'));
    candidates.push(path.join(install, 'bin', 'agy.exe'));
  } else {
    candidates.push(path.join(os.homedir(), '.gemini', 'bin', 'agy'));
    candidates.push(path.join(os.homedir(), '.local', 'bin', 'agy'));
    candidates.push('/opt/homebrew/bin/agy');
    candidates.push('/usr/local/bin/agy');
    candidates.push(path.join(install, 'agy'));
    candidates.push(path.join(install, 'bin', 'agy'));
  }
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) { return candidate; } } catch { }
  }
  return findOnPath(IS_WIN ? ['agy.exe', 'agy.cmd'] : ['agy']);
}

function findOpencode() {
  const candidates = [];
  if (process.env.SMAC_OPENCODE_EXE) { candidates.push(process.env.SMAC_OPENCODE_EXE); }
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  if (IS_WIN) {
    candidates.push(path.join(localAppData, 'OpenCode', 'opencode-cli.exe'));
    candidates.push(path.join(localAppData, 'Programs', '@opencode-aidesktop', 'opencode-cli.exe'));
    candidates.push(path.join(os.homedir(), '.opencode', 'bin', 'opencode.exe'));
  } else {
    candidates.push(path.join(os.homedir(), '.opencode', 'bin', 'opencode'));
    candidates.push(path.join(os.homedir(), '.local', 'bin', 'opencode'));
    candidates.push('/opt/homebrew/bin/opencode');
    candidates.push('/usr/local/bin/opencode');
  }
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) { return candidate; } } catch { }
  }
  return findOnPath(IS_WIN ? ['opencode-cli.exe', 'opencode.exe', 'opencode.cmd'] : ['opencode', 'opencode-cli']);
}

function listOpencodeModels() {
  const exe = findOpencode();
  if (!exe) {
    return {
      backend: 'opencode',
      active: 'opencode',
      defaultProvider: 'opencode',
      defaultModel: '',
      missing: true,
      providers: []
    };
  }
  let models = ['default'];
  try {
    const res = spawnSync(exe, ['models'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (res.status === 0 && res.stdout) {
      const parsed = res.stdout.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#') && !/\s{2,}/.test(s));
      if (parsed.length) models = Array.from(new Set(parsed));
    }
  } catch { }
  return {
    backend: 'opencode',
    active: 'opencode',
    defaultProvider: 'opencode',
    defaultModel: models[0] || 'default',
    missing: false,
    providers: [{ id: 'opencode', label: 'OpenCode CLI', models, active: true }]
  };
}

function findDsh() {
  const candidates = [];
  if (process.env.SMAC_DSH_EXE) { candidates.push(process.env.SMAC_DSH_EXE); }
  const home = os.homedir();
  const userName = path.basename(home);
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    candidates.push(path.join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
    for (const drive of ['C:', 'D:', 'E:', 'F:']) {
      candidates.push(path.join(drive, 'Users', userName, 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
      candidates.push(path.join(drive, 'Program Files', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
    }
  } else {
    candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh');
    candidates.push(path.join(home, 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'));
    candidates.push('/usr/local/bin/dsh');
  }
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) { return candidate; } } catch { }
  }
  return findOnPath(IS_WIN ? ['dsh.cmd', 'dsh.exe'] : ['dsh']);
}

function parseDshDesktopPatch() {
  const home = os.homedir();
  const patchFile = path.join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
  const credFile = path.join(home, '.dsh', '.credentials.yaml');
  let hasAccountToken = false;
  let defaultProvider = 'deepseek-account';
  let defaultModel = 'deepseek-flash';
  const customProviders = [];
  let rawPiAiBlock = '';

  try {
    if (fs.existsSync(credFile)) {
      const credText = fs.readFileSync(credFile, 'utf8');
      hasAccountToken = /deepseek-account-platform\/default/.test(credText);
    }
  } catch { }

  try {
    if (fs.existsSync(patchFile)) {
      const text = fs.readFileSync(patchFile, 'utf8');
      const defProvMatch = text.match(/id:\s*agent-default-model[\s\S]*?provider:\s*([^\r\n#]+)/);
      const defModMatch = text.match(/id:\s*agent-default-model[\s\S]*?model:\s*([^\r\n#]+)/);
      if (defProvMatch) defaultProvider = defProvMatch[1].trim().replace(/^["']|["']$/g, '');
      if (defModMatch) defaultModel = defModMatch[1].trim().replace(/^["']|["']$/g, '');

      // 提取 - id: llm-pi-ai 块，保留客机桌面端配置的第三方提供商（如 siliconflow 等）
      const idx = text.indexOf('- id: llm-pi-ai');
      if (idx >= 0) {
        const rest = text.slice(idx);
        const nextTop = rest.slice(15).search(/\r?\n-\s+id:\s+/);
        rawPiAiBlock = nextTop >= 0 ? rest.slice(0, 15 + nextTop) : rest;

        // 解析自定义 provider 及其模型列表
        const lines = rawPiAiBlock.split(/\r?\n/);
        let currentProv = null;
        for (const line of lines) {
          const provMatch = line.match(/^ {6}([a-zA-Z0-9_.-]+):\s*$/);
          if (provMatch) {
            currentProv = { id: provMatch[1], models: [] };
            customProviders.push(currentProv);
            continue;
          }
          if (currentProv) {
            const modMatch = line.match(/^ {10}-\s+id:\s+(.+)$/);
            if (modMatch) {
              const mId = modMatch[1].trim().replace(/^["']|["']$/g, '');
              if (mId && !currentProv.models.includes(mId)) currentProv.models.push(mId);
            }
          }
        }
      }
    }
  } catch { }

  return {
    hasAccountToken,
    defaultProvider,
    defaultModel,
    customProviders,
    rawPiAiBlock
  };
}

function listDshModels() {
  const exe = findDsh();
  if (!exe) {
    return {
      backend: 'dsh',
      active: 'deepseek-account',
      defaultProvider: 'deepseek-account',
      defaultModel: 'deepseek-flash',
      missing: true,
      providers: []
    };
  }
  const info = parseDshDesktopPatch();
  const providers = [
    {
      id: 'deepseek-account',
      label: 'DeepSeek · 桌面端账号订阅',
      models: ['deepseek-flash', 'deepseek-chat', 'deepseek-reasoner'],
      active: info.defaultProvider === 'deepseek-account' || info.hasAccountToken
    }
  ];
  for (const cp of info.customProviders) {
    if (cp.id && cp.models.length) {
      providers.push({
        id: cp.id,
        label: 'DeepSeek Harness · ' + cp.id,
        models: cp.models,
        active: info.defaultProvider === cp.id
      });
    }
  }
  const activeProv = providers.find(p => p.id === info.defaultProvider) || providers[0];
  const defaultModel = activeProv.models.includes(info.defaultModel)
    ? info.defaultModel
    : (activeProv.models[0] || 'deepseek-flash');

  return {
    backend: 'dsh',
    active: activeProv.id,
    defaultProvider: activeProv.id,
    defaultModel,
    missing: false,
    error: (!info.hasAccountToken && !info.customProviders.length)
      ? '客机 DeepSeek Harness 尚未登录账号或配置模型，请先在客机登录一次 DeepSeek Harness。'
      : '',
    providers
  };
}

function prepareDshPatch(provider, model) {
  const info = parseDshDesktopPatch();
  const chosenProvider = String(provider || info.defaultProvider || 'deepseek-account').trim();
  const chosenModel = String(model || info.defaultModel || 'deepseek-flash').trim();
  const platformLiteral = IS_WIN ? 'win32' : (process.platform === 'darwin' ? 'darwin' : 'null');

  const lines = [
    '- id: authorization',
    '  name: "@deepseek-ai/dsh-authorization"',
    '  disabled: false',
    '- id: credentials',
    '  name: "@deepseek-ai/dsh-credentials-local"',
    '  disabled: false',
    '- id: deepseek-account',
    '  name: "@deepseek-ai/dsh-deepseek-account"',
    '  disabled: false',
    '  config:',
    '    desktopPlatform: ' + platformLiteral,
    '- id: tool-pwsh',
    '  name: "@deepseek-ai/dsh-tool-pwsh"',
    '  disabled: true',
    '- id: tool-bash',
    '  name: "@deepseek-ai/dsh-tool-bash"',
    '  disabled: true',
    '- id: tool-jobs',
    '  name: "@deepseek-ai/dsh-tool-jobs"',
    '  disabled: true',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: ' + JSON.stringify(chosenProvider),
    '    model: ' + JSON.stringify(chosenModel)
  ];
  if (info.rawPiAiBlock) {
    lines.push(info.rawPiAiBlock.trimEnd());
  }
  const patchFile = path.join(DIR, 'dsh-headless-patch.yml');
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(patchFile, lines.join('\n') + '\n', 'utf8');
  return { patchFile, provider: chosenProvider, model: chosenModel };
}

function dshSessionFor(sessionName) {
  const map = readJson(DSH_SESSIONS);
  if (!map || typeof map !== 'object') return '';
  return typeof map[sessionName] === 'string' ? map[sessionName] : '';
}

function saveDshSession(sessionName, sessionId) {
  if (!sessionName || !sessionId) return;
  const map = readJson(DSH_SESSIONS) || {};
  map[sessionName] = sessionId;
  writeJson(DSH_SESSIONS, map);
}

// npm-installed CLIs are .js entry points; Windows .cmd shims need cmd.exe.
function executableSpec(exe, args) {
  const list = Array.isArray(args) ? args.slice() : [];
  if (/\.(?:c|m)?js$/i.test(exe)) {
    return { command: process.execPath, args: [exe].concat(list), windowsVerbatimArguments: false };
  }
  if (IS_WIN && /\.(cmd|bat)$/i.test(exe)) {
    const quote = value => '"' + String(value).replace(/"/g, '""') + '"';
    const line = [exe].concat(list).map(quote).join(' ');
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', '"' + line + '"'],
      windowsVerbatimArguments: true
    };
  }
  return { command: exe, args: list, windowsVerbatimArguments: false };
}

function decodeJwt(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) { return null; }
    const raw = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function maskEmail(value) {
  const text = String(value || '').trim();
  const at = text.indexOf('@');
  if (at <= 1) { return text; }
  return text.slice(0, 2) + '***' + text.slice(at);
}

function codexHomeFor(sourceId) {
  if (sourceId === 'codex-native') { return path.join(DIR, 'codex-home-native'); }
  if (sourceId === 'codex-hermes') { return path.join(DIR, 'codex-home-hermes'); }
  return CODEX_HOME_DIR;
}

// Discover all ChatGPT / Codex login sources on the Guest machine:
// 1. Official Codex CLI / Desktop login (~/.codex/auth.json)
// 2. Hermes Agent ChatGPT login (%LOCALAPPDATA%/hermes/auth.json or ~/.hermes/auth.json)
// Sorted by most recently modified first so switching accounts on the Guest
// immediately takes effect.
function discoverCodexAuthSources() {
  const sources = [];
  const nativeFile = path.join(os.homedir(), '.codex', 'auth.json');
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
      kind: 'native',
      file: nativeFile,
      cacheFile: path.join(os.homedir(), '.codex', 'models_cache.json'),
      mtime: mtimeOf(nativeFile),
      plan,
      email,
      accountId,
      label: 'Codex 本地登录' + (tag ? ' (' + tag + ')' : ''),
      apiKey: native.OPENAI_API_KEY || null,
      authMode: native.auth_mode || 'chatgpt',
      tokens: {
        id_token: tokens.id_token || tokens.access_token || '',
        access_token: tokens.access_token || '',
        refresh_token: tokens.refresh_token || '',
        account_id: accountId
      },
      lastRefresh: String(native.last_refresh || '')
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
      kind: 'hermes',
      file: hermesFile,
      cacheFile: '',
      mtime: mtimeOf(hermesFile),
      plan,
      email,
      accountId,
      label: 'Hermes 账号复用' + (tag ? ' (' + tag + ')' : ''),
      apiKey: null,
      authMode: 'chatgpt',
      tokens: {
        id_token: hTokens.id_token || hTokens.access_token,
        access_token: hTokens.access_token,
        refresh_token: hTokens.refresh_token,
        account_id: accountId
      },
      lastRefresh: String(entry.last_refresh || '')
    });
  }

  sources.sort((a, b) => (b.mtime - a.mtime) || (a.id === 'codex-native' ? -1 : 1));
  return sources;
}

function chooseCodexSource(preferredId) {
  const sources = discoverCodexAuthSources();
  if (!sources.length) { return null; }
  if (preferredId && preferredId !== 'codex') {
    const exact = sources.find(item => item.id === preferredId);
    if (exact) { return exact; }
  }
  return sources[0];
}

// Sync the selected Codex auth source into an isolated CODEX_HOME directory.
// If the account or subscription plan changed (e.g. Free -> Plus), delete the
// stale models_cache.json immediately so old models cannot linger.
function prepareCodexAuth(sourceId) {
  const src = chooseCodexSource(sourceId);
  if (!src) {
    return { error: '客机未检测到 Codex 或 Hermes 的 ChatGPT 登录；请先在客机执行 codex login 或通过 Hermes 登录。' };
  }
  const homeDir = codexHomeFor(src.id);
  const codexFile = path.join(homeDir, 'auth.json');
  const existing = readJson(codexFile) || {};
  const existingTok = existing.tokens || {};
  const prevJwt = decodeJwt(existingTok.access_token) || {};
  const prevPlan = String(((prevJwt['https://api.openai.com/auth'] || {}).chatgpt_plan_type) || '').toLowerCase();
  const prevAccount = String(existingTok.account_id || ((prevJwt['https://api.openai.com/auth'] || {}).chatgpt_account_id) || '');
  const accountChanged = Boolean(
    (src.accountId && prevAccount && src.accountId !== prevAccount)
    || (src.plan && prevPlan && src.plan !== prevPlan)
    || (src.tokens.access_token && existingTok.access_token !== src.tokens.access_token)
  );
  const codexMtime = mtimeOf(codexFile);
  if (codexMtime && !accountChanged && src.mtime <= codexMtime + 2000) {
    codexAuthState = { source: src, homeDir, codexFile, codexMtimeAtPrepare: codexMtime };
    return { source: src, homeDir };
  }
  const auth = {
    auth_mode: src.authMode || 'chatgpt',
    OPENAI_API_KEY: src.apiKey || null,
    tokens: {
      id_token: src.tokens.id_token || existingTok.id_token || src.tokens.access_token,
      access_token: src.tokens.access_token,
      refresh_token: src.tokens.refresh_token,
      account_id: src.accountId || existingTok.account_id || ''
    },
    last_refresh: src.lastRefresh || existing.last_refresh || new Date().toISOString()
  };
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(codexFile, JSON.stringify(auth, null, 2), 'utf8');
  if (accountChanged) {
    try { fs.rmSync(path.join(homeDir, 'models_cache.json'), { force: true }); } catch { }
    codexModelsCache.at = 0;
    codexModelsCache.data = null;
  }
  codexAuthState = { source: src, homeDir, codexFile, codexMtimeAtPrepare: mtimeOf(codexFile) };
  return { source: src, homeDir };
}

// If Codex rotated the OAuth token during a turn, keep the originating auth
// file (~/.codex/auth.json or Hermes auth.json) in sync.
function persistCodexAuth() {
  const state = codexAuthState;
  if (!state || !state.source) { return; }
  const mtime = mtimeOf(state.codexFile);
  if (!mtime || mtime <= state.codexMtimeAtPrepare) { return; }
  try {
    const codex = readJson(state.codexFile);
    const tokens = codex && codex.tokens;
    if (!tokens || !tokens.access_token || !tokens.refresh_token) { return; }
    if (state.source.kind === 'native') {
      const native = readJson(state.source.file);
      if (!native || !native.tokens) { return; }
      const prevAccount = String(native.tokens.account_id || '');
      const curAccount = String(tokens.account_id || '');
      if (prevAccount && curAccount && prevAccount !== curAccount) { return; }
      native.tokens.access_token = tokens.access_token;
      native.tokens.refresh_token = tokens.refresh_token;
      if (tokens.id_token) { native.tokens.id_token = tokens.id_token; }
      native.last_refresh = String(codex.last_refresh || new Date().toISOString());
      const tmp = state.source.file + '.smac-' + crypto.randomBytes(4).toString('hex');
      fs.writeFileSync(tmp, JSON.stringify(native, null, 2), 'utf8');
      fs.renameSync(tmp, state.source.file);
      state.codexMtimeAtPrepare = mtimeOf(state.codexFile);
      log('codex auth refreshed; copied tokens back to ~/.codex/auth.json');
      return;
    }
    const hermes = readJson(state.source.file);
    const entry = hermes && hermes.providers && hermes.providers['openai-codex'];
    const pool = hermes && hermes.credential_pool && hermes.credential_pool['openai-codex'];
    if (!entry && !pool) { return; }
    const stamp = String(codex.last_refresh || new Date().toISOString());
    if (entry && entry.tokens) {
      entry.tokens.access_token = tokens.access_token;
      entry.tokens.refresh_token = tokens.refresh_token;
      entry.last_refresh = stamp;
    }
    if (pool) {
      pool.access_token = tokens.access_token;
      pool.refresh_token = tokens.refresh_token;
      pool.last_refresh = stamp;
    }
    hermes.updated_at = new Date().toISOString();
    const tmp = state.source.file + '.smac-' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(tmp, JSON.stringify(hermes, null, 2), 'utf8');
    fs.renameSync(tmp, state.source.file);
    state.codexMtimeAtPrepare = mtimeOf(state.codexFile);
    log('codex auth refreshed; copied tokens back to Hermes auth.json');
  } catch (error) {
    log('codex auth copy-back failed: ' + error.message);
  }
}

function prepareCodexHome(rootPath, sourceId) {
  try {
    const authRes = prepareCodexAuth(sourceId);
    if (authRes.error) { return { error: authRes.error }; }
    const homeDir = authRes.homeDir;
    fs.mkdirSync(homeDir, { recursive: true });
    const config = loadRoots();
    const cwd = rootPath || (config.roots[0] && config.roots[0].path) || os.homedir();
    const args = [MCP_SERVER, '--roots', ROOTS_FILE, '--cwd', cwd].map(value => JSON.stringify(value)).join(', ');
    const toml = [
      '# managed by smac agent-server; do not edit by hand',
      'approval_policy = "never"',
      'suppress_unstable_features_warning = true',
      '',
      '[mcp_servers.smac]',
      'command = ' + JSON.stringify(process.execPath),
      'args = [' + args + ']',
      'tool_timeout_sec = 120',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(homeDir, 'config.toml'), toml, 'utf8');
    const hookCommand = JSON.stringify(process.execPath) + ' ' + JSON.stringify(CODEX_HOOK);
    const hooks = {
      hooks: {
        PreToolUse: [
          { matcher: '.*', hooks: [{ type: 'command', command: hookCommand, timeout: 15 }] }
        ]
      }
    };
    fs.writeFileSync(path.join(homeDir, 'hooks.json'), JSON.stringify(hooks, null, 2), 'utf8');
    return { source: authRes.source, homeDir };
  } catch (error) {
    return { error: '准备 Codex 配置失败: ' + error.message };
  }
}

function loadCodexSessions() {
  const data = readJson(CODEX_SESSIONS);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function codexThreadFor(sessionName, sourceId) {
  const entry = loadCodexSessions()[sessionName];
  if (!entry || !entry.threadId) { return ''; }
  if (sourceId && entry.sourceId && entry.sourceId !== sourceId) { return ''; }
  return String(entry.threadId);
}

function saveCodexThread(sessionName, threadId, sourceId) {
  if (!sessionName || !threadId) { return; }
  try {
    const map = loadCodexSessions();
    map[sessionName] = {
      threadId: String(threadId),
      sourceId: String(sourceId || ''),
      updatedAt: new Date().toISOString()
    };
    const keys = Object.keys(map);
    if (keys.length > 200) {
      keys.sort((a, b) => String((map[b] && map[b].updatedAt) || '').localeCompare(String((map[a] && map[a].updatedAt) || '')))
        .slice(0, keys.length - 150)
        .forEach(key => { delete map[key]; });
    }
    writeJson(CODEX_SESSIONS, map);
  } catch (error) {
    log('save codex session failed: ' + error.message);
  }
}

function parseCodexCatalog(rawList, reasoningOut) {
  const raw = Array.isArray(rawList) ? rawList : [];
  const models = raw
    .filter(item => item && item.slug && (!item.visibility || item.visibility === 'list'))
    .sort((a, b) => (Number(a.priority) || 999) - (Number(b.priority) || 999))
    .map(item => String(item.slug));
  raw.forEach(item => {
    if (!item || !item.slug) { return; }
    const levels = Array.isArray(item.supported_reasoning_levels)
      ? item.supported_reasoning_levels
        .map(level => String((level && level.effort) || level || '').toLowerCase())
        .filter(level => REASONING_LEVELS.has(level))
      : [];
    const tiers = Array.isArray(item.additional_speed_tiers) ? item.additional_speed_tiers.map(String) : [];
    const fast = tiers.indexOf('fast') >= 0
      || (Array.isArray(item.service_tiers) && item.service_tiers.some(tier => tier && tier.id === 'priority'));
    reasoningOut[String(item.slug)] = {
      levels,
      defaultLevel: String(item.default_reasoning_level || '').toLowerCase(),
      fast
    };
  });
  return Array.from(new Set(models));
}

async function fetchLiveCodexModels(src) {
  if (!src || !src.tokens || !src.tokens.access_token) { return null; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const headers = {
      Authorization: 'Bearer ' + src.tokens.access_token,
      'User-Agent': 'codex_cli_rs/0.171.0'
    };
    if (src.accountId) { headers['ChatGPT-Account-Id'] = src.accountId; }
    const res = await fetch('https://chatgpt.com/backend-api/codex/models?client_version=0.171.0', {
      headers,
      signal: controller.signal
    });
    if (!res.ok) { return null; }
    const json = await res.json();
    if (json && Array.isArray(json.models) && json.models.length) {
      return json.models;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function listCodexModels(forceRefresh) {
  const sources = discoverCodexAuthSources();
  const fp = sources.map(s => [s.id, s.accountId, s.plan, s.mtime].join(':')).join('|');
  const now = Date.now();
  if (!forceRefresh && codexModelsCache.data && codexModelsCache.fp === fp && now - codexModelsCache.at < 2 * 60 * 1000) {
    return codexModelsCache.data;
  }
  const exe = findCodex();
  if (!exe) {
    return {
      backend: 'codex', active: '', defaultProvider: '', defaultModel: '', missing: true,
      error: '客机尚未安装 Codex CLI。', providers: [], reasoning: {}
    };
  }
  if (!sources.length) {
    return {
      backend: 'codex', active: '', defaultProvider: '', defaultModel: '', missing: false,
      error: '客机未检测到 Codex 或 Hermes 的 ChatGPT 登录。', providers: [], reasoning: {}
    };
  }

  const reasoning = {};
  const providers = await Promise.all(sources.map(async (src, i) => {
    let rawModels = await fetchLiveCodexModels(src);
    if (!rawModels && src.cacheFile) {
      const cached = readJson(src.cacheFile);
      if (cached && Array.isArray(cached.models) && cached.models.length) {
        rawModels = cached.models;
      }
    }
    if (!rawModels) {
      const homeCache = readJson(path.join(codexHomeFor(src.id), 'models_cache.json'));
      if (homeCache && Array.isArray(homeCache.models) && homeCache.models.length) {
        rawModels = homeCache.models;
      }
    }
    if (!rawModels) {
      try {
        prepareCodexAuth(src.id);
        const result = spawnSync(exe, ['debug', 'models'], {
          env: Object.assign({}, process.env, { CODEX_HOME: codexHomeFor(src.id), NO_COLOR: '1' }),
          timeout: 20000,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024
        });
        const stdout = String((result && result.stdout) || '');
        const start = stdout.indexOf('{"models"');
        if (start >= 0) {
          let json = null;
          try { json = JSON.parse(stdout.slice(start)); }
          catch {
            const end = stdout.lastIndexOf('}');
            try { json = JSON.parse(stdout.slice(start, end + 1)); } catch { }
          }
          if (json && Array.isArray(json.models)) { rawModels = json.models; }
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
  const payload = {
    backend: 'codex',
    active: chosen ? chosen.id : '',
    defaultProvider: chosen ? chosen.id : '',
    defaultModel: (chosen && chosen.models[0]) || '',
    missing: false,
    error: (chosen && chosen.models.length) ? '' : '未能读取 Codex 模型列表，请检查客机网络或重新登录。',
    providers,
    reasoning
  };
  codexModelsCache.at = now;
  codexModelsCache.fp = fp;
  codexModelsCache.data = payload;
  return payload;
}

/* ---------------- Claude Code / Antigravity backends ---------------- */

function loadSessionMap(file) {
  const data = readJson(file);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function sessionValueFor(file, sessionName) {
  const entry = loadSessionMap(file)[sessionName];
  return entry && entry.sessionId ? String(entry.sessionId) : '';
}

function saveSessionValue(file, sessionName, sessionId) {
  if (!sessionName || !sessionId) { return; }
  try {
    const map = loadSessionMap(file);
    map[sessionName] = { sessionId: String(sessionId), updatedAt: new Date().toISOString() };
    const keys = Object.keys(map);
    if (keys.length > 200) {
      keys.sort((a, b) => String((map[b] && map[b].updatedAt) || '').localeCompare(String((map[a] && map[a].updatedAt) || '')))
        .slice(0, keys.length - 150)
        .forEach(key => { delete map[key]; });
    }
    writeJson(file, map);
  } catch (error) {
    log('save session map failed: ' + error.message);
  }
}

function claudeSessionFor(name) { return sessionValueFor(CLAUDE_SESSIONS, name); }
function saveClaudeSession(name, id) { saveSessionValue(CLAUDE_SESSIONS, name, id); }
function agySessionFor(name) { return sessionValueFor(AGY_SESSIONS, name); }
function saveAgySession(name, id) { saveSessionValue(AGY_SESSIONS, name, id); }

// The smac MCP server is the only tool boundary. Claude's built-in tools are
// disabled with --tools "" and only mcp__smac__* is pre-approved, so a headless
// run can read/write nothing outside the selected sync roots.
function prepareClaudeMcp(rootPath) {
  try {
    const config = loadRoots();
    const cwd = rootPath || (config.roots[0] && config.roots[0].path) || os.homedir();
    const payload = {
      mcpServers: {
        smac: {
          type: 'stdio',
          command: process.execPath,
          args: [MCP_SERVER, '--roots', ROOTS_FILE, '--cwd', cwd],
          env: { SMAC_AGENT_ROOTS: JSON.stringify(config.roots.map(item => item.path)) }
        }
      }
    };
    writeJson(CLAUDE_MCP_FILE, payload);
    return { file: CLAUDE_MCP_FILE };
  } catch (error) {
    return { error: '准备 Claude MCP 配置失败: ' + error.message };
  }
}

// Antigravity reads a global MCP config plus its own permission rules. Merge
// instead of overwrite so the remote user's other servers keep working.
function prepareAgyConfig(rootPath) {
  try {
    const config = loadRoots();
    const cwd = rootPath || (config.roots[0] && config.roots[0].path) || os.homedir();
    const mcp = readJson(AGY_MCP_CONFIG);
    const nextMcp = mcp && typeof mcp === 'object' && !Array.isArray(mcp) ? mcp : {};
    if (!nextMcp.mcpServers || typeof nextMcp.mcpServers !== 'object' || Array.isArray(nextMcp.mcpServers)) {
      nextMcp.mcpServers = {};
    }
    nextMcp.mcpServers.smac = {
      command: process.execPath,
      args: [MCP_SERVER, '--roots', ROOTS_FILE, '--cwd', cwd],
      env: { SMAC_AGENT_ROOTS: JSON.stringify(config.roots.map(item => item.path)) }
    };
    writeJson(AGY_MCP_CONFIG, nextMcp);

    const creds = loadCredentials().agy;
    const settings = readJson(AGY_SETTINGS);
    const next = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
    let changed = false;
    if (!next.permissions || typeof next.permissions !== 'object' || Array.isArray(next.permissions)) {
      next.permissions = {};
    }
    if (!Array.isArray(next.permissions.allow)) { next.permissions.allow = []; }
    if (!next.permissions.allow.includes('mcp(smac/*)')) {
      next.permissions.allow.push('mcp(smac/*)');
      changed = true;
    }
    const marker = readJson(AGY_KEY_MARKER);
    if (creds.apiKey) {
      if (!marker) {
        writeJson(AGY_KEY_MARKER, {
          previousProvider: typeof next.modelProvider === 'string' ? next.modelProvider : '',
          at: new Date().toISOString()
        });
      }
      if (next.modelProvider !== 'gemini') {
        next.modelProvider = 'gemini';
        changed = true;
      }
    } else if (marker) {
      // The key binding was removed: put the user's previous auth mode back.
      if (next.modelProvider === 'gemini') {
        if (marker.previousProvider) { next.modelProvider = String(marker.previousProvider); }
        else { delete next.modelProvider; }
        changed = true;
      }
      try { fs.rmSync(AGY_KEY_MARKER, { force: true }); } catch { }
    }
    if (changed) { writeJson(AGY_SETTINGS, next); }
    return {};
  } catch (error) {
    return { error: '准备 Antigravity 配置失败: ' + error.message };
  }
}

function listClaudeModels() {
  const exe = findClaude();
  const models = ['sonnet', 'opus', 'haiku'];
  const reasoning = {};
  models.forEach(slug => {
    reasoning[slug] = { levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: '', fast: false };
  });
  return {
    backend: 'claude',
    active: 'claude',
    defaultProvider: 'claude',
    defaultModel: 'sonnet',
    missing: !exe,
    providers: [{ id: 'claude', label: 'Claude Code · Anthropic', models, active: true }],
    reasoning
  };
}

const systemProxyCache = { at: 0, env: {} };

function detectSystemProxyEnv() {
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
    return {};
  }
  const now = Date.now();
  if (now - systemProxyCache.at < 60000) { return systemProxyCache.env; }
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
          let hostPort = ((mHttps && mHttps[1]) || (mHttp && mHttp[1]) || raw.split(';')[0] || '').trim();
          if (hostPort) {
            if (!/^https?:\/\//i.test(hostPort)) { hostPort = 'http://' + hostPort; }
            found.HTTP_PROXY = hostPort;
            found.HTTPS_PROXY = hostPort;
            found.http_proxy = hostPort;
            found.https_proxy = hostPort;
          }
        }
      }
    } else if (process.platform === 'darwin') {
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
  systemProxyCache.at = now;
  systemProxyCache.env = found;
  return found;
}

function detectAntigravityDesktopMeta() {
  const home = os.homedir();
  let desktopLoggedIn = false;
  let accountHint = '';
  const storageFile = IS_WIN
    ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Antigravity', 'app_storage.json')
    : (process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Antigravity', 'app_storage.json')
      : path.join(home, '.config', 'Antigravity', 'app_storage.json'));
  const data = readJson(storageFile);
  if (data && typeof data === 'object') {
    const user = String(data['agy.onboarding.lastLoginUsername'] || '').trim();
    if (user) {
      desktopLoggedIn = true;
      const at = user.indexOf('@');
      accountHint = at > 2 ? (user.slice(0, 2) + '***' + user.slice(at)) : user;
    }
  }
  if (!desktopLoggedIn) {
    try {
      if (fs.statSync(path.join(home, '.gemini', 'antigravity', 'antigravity_state.pbtxt')).isFile()) {
        desktopLoggedIn = true;
      }
    } catch { }
  }
  return { desktopLoggedIn, accountHint };
}

function cleanAgyEnv(extra) {
  const basePath = String(process.env.PATH || '');
  const extraPaths = IS_WIN ? [] : [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.gemini', 'bin'),
    path.join(os.homedir(), '.local', 'bin')
  ];
  const mergedPath = extraPaths.length
    ? Array.from(new Set(extraPaths.concat(basePath.split(path.delimiter).filter(Boolean)))).join(path.delimiter)
    : basePath;
  const env = Object.assign({}, process.env, detectSystemProxyEnv(), {
    PATH: mergedPath,
    NO_COLOR: '1',
    TERM: 'dumb',
    PYTHONUTF8: '1'
  }, extra || {});
  // Strip SSH session markers so agy uses the local OS keyring instead of
  // falling back to empty file-based SSH token storage.
  delete env.SSH_CONNECTION;
  delete env.SSH_CLIENT;
  delete env.SSH_TTY;
  return env;
}

function runMacAquaAgyModels(exe, env) {
  if (process.platform !== 'darwin') { return null; }
  const id = crypto.randomBytes(4).toString('hex');
  const base = path.join(os.tmpdir(), 'smac-agy-m-' + id);
  const shFile = base + '.sh';
  const outFile = base + '.out';
  const doneFile = base + '.done';
  const plistFile = base + '.plist';
  const label = 'com.smac.agyprobe.' + id;
  try {
    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '';
    if (!uid) { return null; }
    const envLines = [
      '#!/bin/sh',
      'export HOME=' + JSON.stringify(os.homedir()),
      'export PATH=' + JSON.stringify(env.PATH || process.env.PATH || '/usr/bin:/bin'),
      'unset SSH_CONNECTION SSH_CLIENT SSH_TTY'
    ];
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL']) {
      if (env[k]) { envLines.push('export ' + k + '=' + JSON.stringify(String(env[k]))); }
    }
    envLines.push(JSON.stringify(exe) + ' models > ' + JSON.stringify(outFile) + ' 2>&1');
    envLines.push('echo DONE > ' + JSON.stringify(doneFile));
    fs.writeFileSync(shFile, envLines.join('\n') + '\n', { mode: 0o700 });
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
    if (boot.status !== 0) { return null; }
    const deadline = Date.now() + 16000;
    while (Date.now() < deadline) {
      if (fs.existsSync(doneFile)) { break; }
      spawnSync('/bin/sleep', ['0.4'], { timeout: 2000 });
    }
    spawnSync('launchctl', ['bootout', 'gui/' + uid + '/' + label], { timeout: 5000 });
    if (fs.existsSync(outFile)) {
      return fs.readFileSync(outFile, 'utf8');
    }
  } catch { }
  finally {
    for (const f of [shFile, outFile, doneFile, plistFile]) {
      try { fs.rmSync(f, { force: true }); } catch { }
    }
  }
  return null;
}

function parseAgyModelsText(rawText) {
  const models = [];
  const modelLabels = {};
  let errLine = '';
  String(rawText || '').split(/\r?\n/).forEach(line => {
    const raw = line.replace(/\r$/, '');
    const text = raw.trim();
    if (!text || /^(fetching|usage|available models)\b/i.test(text)) { return; }
    if (/^error:/i.test(text)) { errLine = text; return; }
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\t+|\s{2,})(.+?)\s*$/.exec(raw);
    if (match && match[1] && !/^\d+$/.test(match[1])) {
      models.push(match[1]);
      modelLabels[match[1]] = match[2].trim();
    }
  });
  return { unique: Array.from(new Set(models)), modelLabels, errLine };
}

function listAgyModels(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && agyModelsCache.data && now - agyModelsCache.at < 60 * 1000) { return agyModelsCache.data; }
  const desktopMeta = detectAntigravityDesktopMeta();
  const empty = {
    backend: 'agy', active: 'agy', defaultProvider: 'agy', defaultModel: '',
    providers: [{ id: 'agy', label: 'Gemini · Antigravity', models: [], active: true }],
    modelLabels: {},
    reasoning: {}
  };
  const exe = findAgy();
  if (!exe) {
    empty.missing = true;
    empty.error = '客机尚未安装 Gemini / Antigravity CLI。';
    agyModelsCache.at = now;
    agyModelsCache.data = empty;
    return empty;
  }
  const creds = loadCredentials().agy;
  const extraEnv = {};
  if (creds.apiKey) { extraEnv.GEMINI_API_KEY = creds.apiKey; }
  if (creds.baseUrl) { extraEnv.GOOGLE_GEMINI_BASE_URL = creds.baseUrl; }
  const env = cleanAgyEnv(extraEnv);

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    const spec = executableSpec(exe, ['models']);
    const result = spawnSync(spec.command, spec.args, {
      env,
      timeout: 25000,
      windowsHide: true,
      windowsVerbatimArguments: Boolean(spec.windowsVerbatimArguments),
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024
    });
    stdout = String((result && result.stdout) || '');
    stderr = String((result && result.stderr) || '');
    exitCode = result && typeof result.status === 'number' ? result.status : 0;
  } catch {
    empty.error = '无法读取 Antigravity 模型目录';
    agyModelsCache.at = now;
    agyModelsCache.data = empty;
    return empty;
  }
  let parsed = parseAgyModelsText(stdout);
  // Defense-in-depth on macOS: if agent-server fell back to non-Aqua nohup and
  // Keychain access returned exit status 36, probe inside the user's Aqua session.
  if (!parsed.unique.length && process.platform === 'darwin' && /exit status 36|sign in|keyring/i.test(stderr + '\n' + stdout)) {
    const aquaOut = runMacAquaAgyModels(exe, env);
    if (aquaOut) {
      parsed = parseAgyModelsText(aquaOut);
      if (!parsed.unique.length && !stderr) { stderr = aquaOut; }
    }
  }
  const { unique, modelLabels } = parsed;
  const reasoning = {};
  unique.forEach(slug => {
    reasoning[slug] = { levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: '', fast: false };
  });
  let errText = '';
  if (!unique.length) {
    const errLine = parsed.errLine
      || stderr.split(/\r?\n/).map(s => s.trim()).filter(s => s && !/^fetching/i.test(s)).pop()
      || '';
    if (desktopMeta.desktopLoggedIn && /sign in|not logged/i.test(errLine)) {
      errText = '客机 Antigravity 桌面端已登录' + (desktopMeta.accountHint ? '（' + desktopMeta.accountHint + '）' : '')
        + '，但 agy 刷新令牌或拉取模型失败（请检查客机代理/外网连通性，或在客机打开一次 Antigravity 后点刷新）。';
    } else if (/sign in|not logged/i.test(errLine)) {
      errText = '客机 Antigravity CLI 尚未登录（请在客机登录 Antigravity 桌面端或 CLI，或在控制台绑定 GEMINI_API_KEY）。';
    } else {
      errText = errLine || ('远端 agy 没有返回模型列表（退出码 ' + exitCode + '）。');
    }
  }
  const provLabel = 'Gemini · Antigravity'
    + (unique.length
      ? (desktopMeta.desktopLoggedIn
        ? ('（已同步桌面端订阅' + (desktopMeta.accountHint ? ' · ' + desktopMeta.accountHint : '') + '）')
        : '（已登录订阅）')
      : '');
  const payload = {
    backend: 'agy',
    active: 'agy',
    defaultProvider: 'agy',
    defaultModel: unique[0] || '',
    missing: false,
    error: errText,
    providers: [{ id: 'agy', label: provLabel, models: unique, active: true }],
    modelLabels,
    reasoning
  };
  agyModelsCache.at = now;
  agyModelsCache.data = payload;
  return payload;
}

function claudeAuthState() {
  const exe = findClaude();
  if (!exe) {
    return { installed: false, ready: false, error: '远端没有安装 Claude Code CLI；启动时会自动安装。' };
  }
  const creds = loadCredentials().claude;
  if (creds.apiKey || creds.oauthToken) {
    return { installed: true, ready: true, bound: true, error: '' };
  }
  const now = Date.now();
  if (claudeAuthCache.data && now - claudeAuthCache.at < 5 * 60 * 1000) { return claudeAuthCache.data; }
  let state = { installed: true, ready: false, bound: false, error: 'Claude Code 尚未登录：请在控制台绑定访问密钥，或在远端执行 claude auth login。' };
  try {
    const spec = executableSpec(exe, ['auth', 'status']);
    const result = spawnSync(spec.command, spec.args, {
      env: Object.assign({}, process.env, { NO_COLOR: '1' }),
      timeout: 15000,
      windowsHide: true,
      windowsVerbatimArguments: Boolean(spec.windowsVerbatimArguments),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    });
    const text = String((result && result.stdout) || '').trim();
    const start = text.indexOf('{');
    let json = null;
    if (start >= 0) {
      try { json = JSON.parse(text.slice(start)); } catch { }
    }
    if (json && json.loggedIn) {
      state = { installed: true, ready: true, bound: false, method: String(json.authMethod || ''), error: '' };
    } else if (json) {
      state.method = String(json.authMethod || '');
    }
  } catch { }
  claudeAuthCache.at = now;
  claudeAuthCache.data = state;
  return state;
}

function agyAuthState() {
  const exe = findAgy();
  if (!exe) {
    return { installed: false, ready: false, error: '远端没有安装 Gemini / Antigravity CLI；启动时会自动安装。' };
  }
  const creds = loadCredentials().agy;
  if (creds.apiKey) {
    return { installed: true, ready: true, bound: true, error: '' };
  }
  // Account credentials live in the OS keyring, so they cannot be checked with
  // a file test. Headless agy reports the real auth error when the turn starts.
  return { installed: true, ready: true, bound: false, error: '' };
}

function activeProvider() {
  const auth = readJson(path.join(REAL_HERMES_HOME, 'auth.json'));
  return auth && auth.active_provider ? String(auth.active_provider) : '';
}

function providerCache() {
  const cache = readJson(path.join(REAL_HERMES_HOME, 'provider_models_cache.json'));
  return cache && typeof cache === 'object' ? cache : {};
}

function defaultModel(provider) {
  const cache = providerCache();
  if (cache && provider && cache[provider] && Array.isArray(cache[provider].models) && cache[provider].models.length) {
    return String(cache[provider].models[0]);
  }
  return '';
}

function providerLabel(id) {
  const text = String(id || '');
  if (text.startsWith('custom:')) {
    const rest = text.slice('custom:'.length).replace(/#.*$/, '');
    return '自定义 · ' + rest;
  }
  return text;
}

function listModels() {
  const cache = providerCache();
  const active = activeProvider();
  const ids = Object.keys(cache);
  if (active && !ids.includes(active)) { ids.unshift(active); }
  const providers = ids.map(id => {
    const entry = cache[id] || {};
    const models = Array.isArray(entry.models) ? entry.models.map(String).filter(Boolean) : [];
    if (!models.length && id === active) {
      const fallback = defaultModel(id);
      if (fallback) { models.push(fallback); }
    }
    return { id, label: providerLabel(id), models: Array.from(new Set(models)), active: id === active };
  }).filter(item => item.models.length || item.active);
  providers.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || a.id.localeCompare(b.id));
  const chosen = providers.find(item => item.active) || providers[0] || { id: '', models: [] };
  return {
    active,
    defaultProvider: chosen.id || '',
    defaultModel: chosen.models[0] || '',
    providers
  };
}

function writeAgentConfig() {
  fs.mkdirSync(HOME, { recursive: true });
  const command = JSON.stringify(process.execPath) + ' ' + JSON.stringify(GUARD);
  const yaml = [
    'hooks_auto_accept: true',
    'hooks:',
    '  pre_tool_call:',
    '    - command: ' + JSON.stringify(command),
    '      timeout: 30',
    '      fail_closed: true',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(HOME, 'config.yaml'), yaml, 'utf8');
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function sameInode(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.ino && sa.ino === sb.ino && sa.dev === sb.dev;
  } catch { return false; }
}

// 把远端真实登录的 auth.json 复制/硬链接到隔离的 agent home，
// 让 agent 使用这台机器自己的额度，而不改用户原有的 Hermes 配置。
function prepareAuth() {
  const real = path.join(REAL_HERMES_HOME, 'auth.json');
  const copy = path.join(HOME, 'auth.json');
  fs.mkdirSync(HOME, { recursive: true });
  if (!fs.existsSync(real)) {
    authState = null;
    return '未找到远端 Hermes 登录文件: ' + real;
  }
  const realMtime = mtimeOf(real);
  const copyMtime = mtimeOf(copy);
  if (copyMtime && realMtime <= copyMtime + 2000) {
    authState = { real, copy, realMtime, agentMtimeAtCopy: copyMtime };
    return '';
  }
  try { fs.rmSync(copy, { force: true }); } catch { }
  let linked = false;
  try { fs.linkSync(real, copy); linked = true; } catch { }
  if (!linked) {
    fs.copyFileSync(real, copy);
    if (!IS_WIN) { try { fs.chmodSync(copy, 0o600); } catch { } }
  }
  authState = { real, copy, realMtime, agentMtimeAtCopy: mtimeOf(copy), linked };
  return '';
}

function persistAuth() {
  if (!authState) { return; }
  const { real, copy, realMtime, agentMtimeAtCopy } = authState;
  if (sameInode(real, copy)) { return; }
  const agentMtime = mtimeOf(copy);
  if (!agentMtime || agentMtime <= agentMtimeAtCopy) { return; }
  if (mtimeOf(real) > realMtime + 2000) { return; }
  try {
    const tmp = real + '.smac-' + crypto.randomBytes(4).toString('hex');
    fs.copyFileSync(copy, tmp);
    fs.renameSync(tmp, real);
    authState.realMtime = mtimeOf(real);
    authState.agentMtimeAtCopy = mtimeOf(copy);
    log('auth.json refreshed by agent; copied back to real Hermes home');
  } catch (error) {
    log('auth copy-back failed: ' + error.message);
  }
}

function killTree(child) {
  if (!child || child.killed) { return; }
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { } }, 2500).unref();
    }
  } catch { }
}

// strip-ansi compatible enough for Hermes' SGR / OSC output.
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function stripAnsi(text) {
  return String(text || '').replace(ANSI_RE, '');
}

function publicTurnOf(value) {
  const t = value;
  if (!t) { return null; }
  return {
    id: t.id,
    status: t.status,
    prompt: t.prompt,
    sessionName: t.sessionName,
    sessionId: t.sessionId,
    root: t.root,
    rootLabel: t.rootLabel,
    backend: t.backend || 'hermes',
    provider: t.provider,
    model: t.model,
    image: t.image,
    workdir: t.workdir || '',
    workdirPath: t.workdirPath || '',
    reasoning: t.reasoning || '',
    fast: Boolean(t.fast),
    images: Array.isArray(t.images) ? t.images.slice(0, 12) : [],
    usage: t.usage || null,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    durationMs: t.durationMs,
    exitCode: t.exitCode,
    answer: t.answer,
    activity: t.activity,
    error: t.error,
    note: t.note || ''
  };
}

function publicTurn() {
  return publicTurnOf(turn);
}

function emit(event, target) {
  const t = target || turn;
  if (!t) { return; }
  const payload = Object.assign({ seq: ++eventSeq, turnId: t.id }, event);
  t.events.push(payload);
  if (t.events.length > 6000) { t.events.splice(0, 2000); }
  const data = 'data: ' + JSON.stringify(payload) + '\n\n';
  for (const res of sseClients) {
    try { res.write(data); } catch { }
  }
}

// Hermes' rich one-shot output:
//   Query: ... / Initializing agent... / ───── / tool activity / ╭─ ⚕ Hermes ─╮ answer ╰─╯
// The chat UI wants the activity and the answer separately, streamed.
function createParser(target) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let mode = 'preamble';
  let answerTail = '';

  function emitAnswer(text) {
    if (!text || target.status !== 'running') { return; }
    target.answer += text;
    emit({ type: 'answer', text }, target);
  }

  function emitActivity(text) {
    if (!text || target.status !== 'running') { return; }
    target.activity += text;
    emit({ type: 'activity', text }, target);
  }

  function handleLine(rawLine) {
    let line = rawLine;
    if (line.endsWith('\r')) { line = line.slice(0, -1); }
    const clean = stripAnsi(line);
    const trimmed = clean.trim();
    if (mode === 'preamble') {
      if (/^─{10,}$/.test(trimmed)) { mode = 'activity'; }
      return;
    }
    if (mode === 'activity') {
      if (/^╭.*Hermes.*╮$/.test(trimmed)) {
        mode = 'answer';
        answerTail = '';
        return;
      }
      emitActivity(clean + '\n');
      return;
    }
    if (mode === 'answer') {
      if (/^╰─{3,}╯$/.test(trimmed)) {
        mode = 'finished';
        answerTail = '';
        return;
      }
      emitAnswer(clean + '\n');
    }
  }

  function consumeMessage(text) {
    pending += text;
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      handleLine(line);
    }
    if (mode === 'answer' && pending) {
      // Stream the partial line for responsiveness, but hold back a possible
      // closing border (it starts with ╰) and ANSI escape tails.
      if (!/^[\u001B]*[╰─]/.test(pending)) {
        const clean = stripAnsi(pending);
        emitAnswer(clean);
        answerTail = clean;
        pending = '';
      }
    }
  }

  return {
    push(chunk) {
      const text = decoder.write(chunk);
      target.raw += text;
      if (target.raw.length > MAX_RAW) { target.raw = target.raw.slice(-MAX_RAW); }
      consumeMessage(text);
    },
    flush() {
      const rest = decoder.end();
      if (rest) { consumeMessage(rest); }
      if (pending) { handleLine(pending); pending = ''; }
    }
  };
}

// Codex prints CLI notices (for example about bypassing hook trust) through the
// same channel as errors. They are not failures; keep them out of turn.error.
function isCodexNotice(message) {
  const text = String(message || '');
  return /--dangerously-bypass|Enabled hooks may run without review|^warn(ing)?:/i.test(text);
}

// Codex emits one JSON object per line (JSONL): thread.started, item.started /
// item.completed (agent_message, reasoning, command_execution, file_change,
// mcp_tool_call), turn.completed with token usage.
function createCodexParser(target) {
  const decoder = new StringDecoder('utf8');
  let pending = '';

  function emitAnswer(text) {
    if (!text || target.status !== 'running') { return; }
    target.answer += text;
    emit({ type: 'answer', text }, target);
  }

  function emitActivity(text) {
    if (!text || target.status !== 'running') { return; }
    target.activity += text;
    emit({ type: 'activity', text }, target);
  }

  function handleEvent(event) {
    const type = String((event && event.type) || '');
    if (type === 'thread.started') {
      const threadId = String(event.thread_id || '');
      if (threadId) {
        target.sessionId = threadId;
        saveCodexThread(target.sessionName, threadId, target.provider);
      }
      return;
    }
    if (type === 'item.started' || type === 'item.completed') {
      const item = event.item || {};
      const kind = String(item.type || '');
      if (kind === 'agent_message') {
        if (type === 'item.completed') {
          const text = String(item.text || '');
          if (text) { emitAnswer((target.answer ? '\n\n' : '') + text); }
        }
        return;
      }
      if (kind === 'reasoning') {
        if (type === 'item.completed') {
          const text = String(item.text || item.summary || '').trim();
          if (text) {
            const first = text.split('\n').find(line => line.trim()) || '';
            emitActivity('· 思考: ' + first.trim().slice(0, 200) + '\n');
          }
        }
        return;
      }
      if (kind === 'mcp_tool_call') {
        if (type !== 'item.completed') { return; }
        const tool = String(item.tool || '').trim() || 'tool';
        const server = String(item.server || '').trim();
        const name = server ? server + '.' + tool : tool;
        const args = item.arguments && typeof item.arguments === 'object' ? item.arguments : {};
        const argText = Object.keys(args).slice(0, 3).map(key => {
          let value = args[key];
          if (value && typeof value === 'object') { value = JSON.stringify(value); }
          value = String(value == null ? '' : value).replace(/\s+/g, ' ');
          return key + '=' + (value.length > 60 ? value.slice(0, 60) + '…' : value);
        }).join(', ');
        const failure = item.error ? String(item.error.message || item.error) : '';
        if (failure) {
          emitActivity('! ' + name + '(' + argText + ') 失败: ' + failure.replace(/\s+/g, ' ').slice(0, 200) + '\n');
          return;
        }
        let summary = '';
        if (item.result && Array.isArray(item.result.content)) {
          const textPart = item.result.content.find(part => part && part.type === 'text' && part.text);
          if (textPart) {
            summary = String(textPart.text).replace(/\s+/g, ' ').trim();
          } else if (item.result.content.some(part => part && part.type === 'image')) {
            summary = '[图片]';
          }
        }
        if (summary.length > 120) { summary = summary.slice(0, 120) + '…'; }
        emitActivity('┊ ' + name + '(' + argText + ')' + (summary ? ' → ' + summary : '') + '\n');
        return;
      }
      if (kind === 'command_execution') {
        if (type === 'item.completed') {
          const command = String(item.command || '').trim();
          const code = item.exit_code == null ? '' : ' (exit ' + item.exit_code + ')';
          emitActivity('┊ $ ' + command + code + '\n');
        }
        return;
      }
      if (kind === 'file_change') {
        if (type === 'item.completed') {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          changes.forEach(change => {
            const action = change.kind === 'add' ? '新增' : change.kind === 'delete' ? '删除' : '修改';
            emitActivity('┊ ' + action + ' ' + String(change.path || '') + '\n');
          });
        }
        return;
      }
      if (kind === 'error') {
        const message = String(item.message || item.text || '').trim();
        if (message && !isCodexNotice(message)) {
          target.error = message;
          emitActivity('! ' + message + '\n');
        }
      }
      return;
    }
    if (type === 'error') {
      const message = String(event.message || '').trim();
      if (message && !isCodexNotice(message)) {
        target.error = message;
        emitActivity('! ' + message + '\n');
      }
      return;
    }
    if (type === 'turn.failed') {
      const message = String((event.error && (event.error.message || event.error)) || event.message || '').trim();
      if (message) {
        target.error = message;
        emitActivity('! ' + message + '\n');
      }
      return;
    }
    if (type === 'turn.completed') {
      const usage = event.usage || {};
      const input = Number(usage.input_tokens) || 0;
      const output = Number(usage.output_tokens) || 0;
      target.usage = {
        input,
        output,
        cached: Number(usage.cached_input_tokens) || 0,
        reasoning: Number(usage.reasoning_output_tokens) || 0
      };
      if (input || output) {
        emitActivity('· tokens ' + input + ' 输入 / ' + output + ' 输出\n');
      }
    }
  }

  function handleLine(line) {
    const text = line.trim();
    if (!text) { return; }
    let event = null;
    try { event = JSON.parse(text); } catch { }
    if (event) { handleEvent(event); }
    else { emitActivity(text + '\n'); }
  }

  return {
    push(chunk) {
      const text = decoder.write(chunk);
      target.raw += text;
      if (target.raw.length > MAX_RAW) { target.raw = target.raw.slice(-MAX_RAW); }
      pending += text;
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        handleLine(line);
      }
    },
    flush() {
      const rest = decoder.end();
      if (rest) { pending += rest; }
      if (pending) { handleLine(pending); pending = ''; }
    }
  };
}


// Claude Code stream-json: system/init, stream_event (partial text deltas),
// assistant (tool_use), user (tool_result), result (answer + usage + cost).
function createClaudeParser(target) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let sawDelta = false;
  const toolNames = new Map();

  function emitAnswer(text) {
    if (!text || target.status !== 'running') { return; }
    target.answer += text;
    emit({ type: 'answer', text }, target);
  }

  function emitActivity(text) {
    if (!text || target.status !== 'running') { return; }
    target.activity += text;
    emit({ type: 'activity', text }, target);
  }

  function summarize(value, max) {
    let text = value;
    if (text && typeof text === 'object') { text = JSON.stringify(text); }
    text = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const limit = max || 140;
    return text.length > limit ? text.slice(0, limit) + '…' : text;
  }

  function toolActivity(block) {
    const raw = String(block.name || 'tool');
    const short = raw.replace(/^mcp__/, '').replace(/^smac__/, 'smac.');
    const input = block.input && typeof block.input === 'object' ? block.input : {};
    const argText = Object.keys(input).slice(0, 3).map(key =>
      key + '=' + summarize(input[key], 60)).join(', ');
    toolNames.set(String(block.id || ''), short);
    emitActivity('┊ ' + short + '(' + argText + ')\n');
  }

  function handleEvent(event) {
    const type = String((event && event.type) || '');
    if (type === 'system') {
      const subtype = String(event.subtype || '');
      if (event.session_id) {
        target.sessionId = String(event.session_id);
        saveClaudeSession(target.sessionName, target.sessionId);
      }
      if (subtype === 'init') {
        const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers : [];
        servers.forEach(server => {
          if (!server || server.name !== 'smac') { return; }
          const status = String(server.status || '');
          if (status && status !== 'connected') {
            emitActivity('! smac 文件工具未连接: ' + status + '\n');
          }
        });
      } else if (subtype === 'api_retry') {
        emitActivity('· 接口重试中…\n');
      } else if (subtype === 'permission_denied') {
        emitActivity('! 权限拒绝: ' + summarize(event.tool_name || event.message || '') + '\n');
      }
      return;
    }
    if (type === 'stream_event') {
      const inner = event.event || {};
      if (String(inner.type || '') === 'content_block_delta') {
        const delta = inner.delta || {};
        if (String(delta.type || '') === 'text_delta' && delta.text) {
          sawDelta = true;
          emitAnswer(String(delta.text));
        }
      }
      return;
    }
    if (type === 'assistant') {
      const content = event.message && Array.isArray(event.message.content) ? event.message.content : [];
      content.forEach(block => {
        if (!block || typeof block !== 'object') { return; }
        if (block.type === 'tool_use') { toolActivity(block); }
        else if (block.type === 'text' && block.text && !sawDelta) { emitAnswer(String(block.text)); }
      });
      return;
    }
    if (type === 'user') {
      const content = event.message && Array.isArray(event.message.content) ? event.message.content : [];
      content.forEach(block => {
        if (!block || block.type !== 'tool_result') { return; }
        const name = toolNames.get(String(block.tool_use_id || '')) || 'tool';
        if (block.is_error) {
          emitActivity('! ' + name + ' 失败: ' + summarize(block.content) + '\n');
          return;
        }
        const parts = Array.isArray(block.content) ? block.content : [];
        const textPart = parts.find(part => part && part.type === 'text' && part.text);
        const image = parts.some(part => part && part.type === 'image');
        const summaryText = summarize(textPart ? textPart.text : (image ? '[图片]' : ''));
        if (summaryText) { emitActivity('┊ ' + name + ' → ' + summaryText + '\n'); }
      });
      return;
    }
    if (type === 'result') {
      if (event.session_id) {
        target.sessionId = String(event.session_id);
        saveClaudeSession(target.sessionName, target.sessionId);
      }
      const answer = String(event.result || event.response || '').trim();
      if (answer && !target.answer.trim()) { emitAnswer(answer); }
      const usage = event.usage || {};
      const input = Number(usage.input_tokens || usage.inputTokens) || 0;
      const output = Number(usage.output_tokens || usage.outputTokens) || 0;
      target.usage = {
        input,
        output,
        cached: Number(usage.cache_read_input_tokens || 0) || 0,
        reasoning: 0
      };
      const cost = Number(event.total_cost_usd);
      if (Number.isFinite(cost) && cost > 0) { target.usage.costUsd = Math.round(cost * 10000) / 10000; }
      if (input || output) {
        emitActivity('· tokens ' + input + ' 输入 / ' + output + ' 输出'
          + (target.usage.costUsd ? ' · $' + target.usage.costUsd : '') + '\n');
      }
      const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
      denials.slice(0, 5).forEach(denial => {
        emitActivity('! 权限拒绝: ' + summarize(denial && (denial.tool_name || denial.tool || denial.message)) + '\n');
      });
      const subtype = String(event.subtype || '');
      if (subtype && subtype !== 'success' && event.is_error) {
        target.error = String(event.result || 'Claude 执行失败').slice(0, 500);
      }
      return;
    }
    if (type === 'error') {
      const message = summarize(event.message || event.error || '', 400);
      if (message) {
        target.error = message;
        emitActivity('! ' + message + '\n');
      }
    }
  }

  function handleLine(line) {
    const text = line.trim();
    if (!text) { return; }
    let event = null;
    try { event = JSON.parse(text); } catch { }
    if (event) { handleEvent(event); }
    else { emitActivity(text + '\n'); }
  }

  return {
    push(chunk) {
      const text = decoder.write(chunk);
      target.raw += text;
      if (target.raw.length > MAX_RAW) { target.raw = target.raw.slice(-MAX_RAW); }
      pending += text;
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        handleLine(line);
      }
    },
    flush() {
      const rest = decoder.end();
      if (rest) { pending += rest; }
      if (pending) { handleLine(pending); pending = ''; }
    }
  };
}

// Antigravity stream-json: init, step_update (text_delta / tool_info), result.
function createAgyParser(target) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let deltaStep = -1;

  function emitAnswer(text) {
    if (!text || target.status !== 'running') { return; }
    target.answer += text;
    emit({ type: 'answer', text }, target);
  }

  function emitActivity(text) {
    if (!text || target.status !== 'running') { return; }
    target.activity += text;
    emit({ type: 'activity', text }, target);
  }

  function summarize(value, max) {
    let text = value;
    if (text && typeof text === 'object') { text = JSON.stringify(text); }
    text = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const limit = max || 140;
    return text.length > limit ? text.slice(0, limit) + '…' : text;
  }

  function handleEvent(event) {
    const kind = String((event && event.event) || '');
    if (kind === 'init') {
      const init = event.init || {};
      const conversationId = String(event.conversation_id || (init && init.conversation_id) || '');
      if (conversationId) {
        target.sessionId = conversationId;
        saveAgySession(target.sessionName, conversationId);
      }
      const mode = String(init.permission_mode || '');
      if (mode) { emitActivity('· 权限模式 ' + mode + '\n'); }
      return;
    }
    if (kind === 'step_update') {
      const step = event.step_update || {};
      if (step.text_delta) {
        const index = Number(step.step_index);
        // A streaming step sends ACTIVE deltas and then a DONE event that may
        // repeat the full text; skip that duplicate.
        const done = String(step.state || '') === 'DONE';
        if (!(done && index === deltaStep)) {
          emitAnswer(String(step.text_delta));
        }
        if (!done) { deltaStep = index; }
      }
      if (String(step.step_type || '') === 'tool' && String(step.state || '') === 'DONE') {
        const info = step.tool_info || {};
        const name = String(step.tool_name || info.name || 'tool').replace(/^mcp__/, '').replace(/^smac__/, 'smac.');
        const params = info.parameters && typeof info.parameters === 'object' ? info.parameters : {};
        const argText = Object.keys(params).slice(0, 3).map(key =>
          key + '=' + summarize(params[key], 60)).join(', ');
        const failure = info.error ? summarize(info.error.message || info.error, 200) : '';
        if (failure) {
          emitActivity('! ' + name + '(' + argText + ') 失败: ' + failure + '\n');
        } else {
          const output = summarize(info.output || '', 120);
          emitActivity('┊ ' + name + '(' + argText + ')' + (output ? ' → ' + output : '') + '\n');
        }
      }
      return;
    }
    if (kind === 'result') {
      const result = event.result || {};
      const conversationId = String(result.conversation_id || '');
      if (conversationId) {
        target.sessionId = conversationId;
        saveAgySession(target.sessionName, conversationId);
      }
      const response = String(result.response || '').trim();
      if (response && !target.answer.trim()) { emitAnswer(response); }
      const usage = result.usage || {};
      target.usage = {
        input: Number(usage.input_tokens) || 0,
        output: Number(usage.output_tokens) || 0,
        cached: Number(usage.cache_read_tokens) || 0,
        reasoning: Number(usage.thinking_tokens) || 0
      };
      if (target.usage.input || target.usage.output) {
        emitActivity('· tokens ' + target.usage.input + ' 输入 / ' + target.usage.output + ' 输出\n');
      }
      const status = String(result.status || '');
      if (result.error && status !== 'SUCCESS') {
        target.error = summarize(result.error, 500);
        emitActivity('! ' + target.error + '\n');
      } else if (status && status !== 'SUCCESS' && status !== 'CANCELED' && status !== 'INTERRUPTED') {
        target.error = 'Antigravity 运行状态: ' + status;
      }
      return;
    }
    if (kind === 'error') {
      const message = summarize(event.message || event.error || '', 400);
      if (message) {
        target.error = message;
        emitActivity('! ' + message + '\n');
      }
    }
  }

  function handleLine(line) {
    const text = line.trim();
    if (!text) { return; }
    let event = null;
    try { event = JSON.parse(text); } catch { }
    if (event) { handleEvent(event); }
    else { emitActivity(text + '\n'); }
  }

  return {
    push(chunk) {
      const text = decoder.write(chunk);
      target.raw += text;
      if (target.raw.length > MAX_RAW) { target.raw = target.raw.slice(-MAX_RAW); }
      pending += text;
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        handleLine(line);
      }
    },
    flush() {
      const rest = decoder.end();
      if (rest) { pending += rest; }
      if (pending) { handleLine(pending); pending = ''; }
    }
  };
}

function newTurnId() {
  return crypto.randomBytes(6).toString('hex');
}

function sanitizeSession(value) {
  const text = String(value || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80);
  return text || ('smac-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex'));
}

/* ---------------- conversation history ---------------- */

function historyFileFor(sessionName) {
  const name = String(sessionName || '');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) { return ''; }
  return path.join(HISTORY_DIR, name + '.json');
}

function historyTitle(prompt) {
  const text = String(prompt || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`_~[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 60) || '新对话';
}

function readSessionRecord(sessionName) {
  const file = historyFileFor(sessionName);
  if (!file) { return null; }
  const data = readJson(file);
  if (!data || typeof data !== 'object' || !Array.isArray(data.messages)) { return null; }
  if (!data.sessionName) { data.sessionName = String(sessionName); }
  return data;
}

function writeSessionRecord(record) {
  const file = historyFileFor(record && record.sessionName);
  if (!file) { return; }
  try {
    if (record.messages.length > HISTORY_MSGS_MAX) {
      record.messages = record.messages.slice(-HISTORY_MSGS_MAX);
    }
    record.updatedAt = new Date().toISOString();
    writeJson(file, record);
  } catch (error) {
    log('save history failed: ' + error.message);
  }
}

// Called when a turn starts: the user's message is stored immediately so the
// session (and its title) exists even if the browser closes mid-turn.
function beginHistoryTurn(t) {
  try {
    const now = new Date().toISOString();
    const record = readSessionRecord(t.sessionName) || {
      sessionName: t.sessionName,
      title: '',
      createdAt: now,
      messages: []
    };
    if (!record.title) { record.title = historyTitle(t.prompt); }
    record.root = t.root;
    record.rootLabel = t.rootLabel;
    record.workdir = t.workdir || '';
    record.workdirPath = t.workdirPath || '';
    record.backend = t.backend || 'hermes';
    record.provider = t.provider || '';
    record.model = t.model || '';
    record.reasoning = t.reasoning || '';
    record.fast = Boolean(t.fast);
    record.messages.push({
      role: 'user',
      text: t.prompt,
      prompt: t.prompt,
      image: t.image || '',
      turnId: t.id,
      at: t.startedAt || now
    });
    writeSessionRecord(record);
  } catch (error) {
    log('begin history failed: ' + error.message);
  }
}

// Called once the turn has a final status. Upserts the assistant entry so a
// cancelled / interrupted turn keeps the partial answer that was streamed.
function finishHistoryTurn(t) {
  if (!t || t.historySaved) { return; }
  t.historySaved = true;
  try {
    const now = new Date().toISOString();
    const record = readSessionRecord(t.sessionName) || {
      sessionName: t.sessionName,
      title: historyTitle(t.prompt),
      createdAt: t.startedAt || now,
      messages: []
    };
    if (!record.title) { record.title = historyTitle(t.prompt); }
    record.root = t.root;
    record.rootLabel = t.rootLabel;
    record.workdir = t.workdir || record.workdir || '';
    record.workdirPath = t.workdirPath || record.workdirPath || '';
    record.backend = t.backend || record.backend || 'hermes';
    record.provider = t.provider || record.provider || '';
    record.model = t.model || record.model || '';
    record.reasoning = t.reasoning || record.reasoning || '';
    record.fast = Boolean(t.fast);
    const entry = {
      role: 'assistant',
      turnId: t.id,
      text: String(t.answer || '').replace(/\s+$/, ''),
      activity: String(t.activity || '').replace(/\s+$/, '').slice(-HISTORY_ACTIVITY_MAX),
      status: t.status || 'done',
      error: t.status === 'error' ? (t.error || '执行失败') : '',
      backend: t.backend || 'hermes',
      provider: t.provider || '',
      model: t.model || '',
      workdir: t.workdir || '',
      reasoning: t.reasoning || '',
      fast: Boolean(t.fast),
      images: Array.isArray(t.images) ? t.images.slice(0, 12) : [],
      usage: t.usage || null,
      durationMs: t.durationMs == null ? null : t.durationMs,
      endedAt: t.endedAt || now,
      at: Date.parse(t.endedAt || now) || Date.now()
    };
    const index = record.messages.findIndex(item => item.role === 'assistant' && item.turnId === t.id);
    if (index >= 0) { record.messages[index] = entry; }
    else { record.messages.push(entry); }
    writeSessionRecord(record);
  } catch (error) {
    log('finish history failed: ' + error.message);
  }
}

function cleanSessionTitle(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

// Only the title field changes; the file name (sessionName) stays the same so
// backend session maps (codex thread / claude session / agy conversation) keep
// working. File mtime is restored so renaming does not reorder the list.
function renameSessionRecord(sessionName, value) {
  const file = historyFileFor(sessionName);
  if (!file) { return { error: '会话名无效' }; }
  const record = readSessionRecord(sessionName);
  if (!record) { return { error: '没有找到该会话记录' }; }
  const title = cleanSessionTitle(value);
  if (!title) { return { error: '标题不能为空' }; }
  let stat = null;
  try { stat = fs.statSync(file); } catch { }
  record.title = title;
  try {
    writeJson(file, record);
    if (stat) { try { fs.utimesSync(file, stat.atime, stat.mtime); } catch { } }
  } catch (error) {
    return { error: '保存标题失败: ' + error.message };
  }
  return { title };
}

function deleteSessionRecord(sessionName) {
  const file = historyFileFor(sessionName);
  if (!file) { return { error: '会话名无效' }; }
  if (!fs.existsSync(file)) { return { error: '没有找到该会话记录' }; }
  try { fs.rmSync(file, { force: true }); }
  catch (error) { return { error: '删除失败: ' + error.message }; }
  // Drop stale backend resume mappings as well, otherwise a future conversation
  // that happens to reuse the name would resume the deleted one.
  for (const mapFile of [CODEX_SESSIONS, CLAUDE_SESSIONS, AGY_SESSIONS]) {
    try {
      const map = loadSessionMap(mapFile);
      if (Object.prototype.hasOwnProperty.call(map, sessionName)) {
        delete map[sessionName];
        writeJson(mapFile, map);
      }
    } catch { }
  }
  return { ok: true };
}

function listSessionSummaries() {
  let names = [];
  try { names = fs.readdirSync(HISTORY_DIR).filter(name => name.endsWith('.json')); }
  catch { return []; }
  const files = names.map(name => {
    const file = path.join(HISTORY_DIR, name);
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { }
    return { file, mtime };
  }).filter(item => item.mtime > 0)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 200);
  const sessions = [];
  for (const item of files) {
    const data = readJson(item.file);
    if (!data || !data.sessionName) { continue; }
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const firstUser = messages.find(message => message.role === 'user');
    const lastAssistant = messages.slice().reverse().find(message => message.role === 'assistant' && message.text);
    const running = Boolean(turn && turn.status === 'running' && turn.sessionName === data.sessionName);
    sessions.push({
      sessionName: String(data.sessionName),
      title: String(data.title || (firstUser && (firstUser.prompt || firstUser.text)) || '新对话').slice(0, 80),
      backend: normalizeBackend(data.backend),
      rootLabel: String(data.rootLabel || ''),
      workdir: String(data.workdir || ''),
      messageCount: messages.length,
      preview: lastAssistant ? String(lastAssistant.text).replace(/\s+/g, ' ').slice(0, 80) : '',
      createdAt: data.createdAt || '',
      updatedAt: data.updatedAt || new Date(item.mtime).toISOString(),
      running
    });
  }
  return sessions;
}

function cleanupHistory() {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const files = fs.readdirSync(HISTORY_DIR).filter(name => name.endsWith('.json')).map(name => {
      const file = path.join(HISTORY_DIR, name);
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch { }
      return { file, mtime };
    }).filter(item => item.mtime > 0).sort((a, b) => b.mtime - a.mtime);
    for (const item of files.slice(HISTORY_FILES_MAX)) { fs.rmSync(item.file, { force: true }); }
  } catch { }
}

function normalizeReasoning(value) {
  const level = String(value || '').trim().toLowerCase();
  return REASONING_LEVELS.has(level) ? level : '';
}

function findRootByValue(value) {
  const roots = loadRoots().roots;
  const wanted = normalizeForCompare(String(value || ''));
  if (!wanted) { return roots[0] || null; }
  return roots.find(root => normalizeForCompare(root.path) === wanted) || null;
}

// A workspace is a subfolder of the selected sync root. The path is resolved
// through realpath so symlinks or `..` cannot escape the root.
function resolveWorkdir(rootPath, rel) {
  let base = '';
  try { base = fs.realpathSync(rootPath); } catch { return { error: '同步目录不存在：' + rootPath }; }
  const clean = String(rel || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!clean) { return { path: base, rel: '' }; }
  const segments = clean.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    return { error: '工作区路径无效：' + clean };
  }
  const target = path.resolve(base, clean);
  if (!isUnder(target, base)) { return { error: '工作区不在当前同步目录内：' + clean }; }
  let real = '';
  try { real = fs.realpathSync(target); } catch { return { error: '工作区不存在：' + clean }; }
  if (!isUnder(real, base)) { return { error: '工作区不在当前同步目录内：' + clean }; }
  let stat = null;
  try { stat = fs.statSync(real); } catch { return { error: '工作区无法读取：' + clean }; }
  if (!stat.isDirectory()) { return { error: '工作区不是文件夹：' + clean }; }
  return { path: real, rel: path.relative(base, real).replace(/\\/g, '/') };
}

function listWorkdirs(root, rel) {
  const work = resolveWorkdir(root.path, rel);
  if (work.error) { return { error: work.error }; }
  const dirs = [];
  let truncated = false;
  try {
    const entries = fs.readdirSync(work.path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const entry of entries) {
      if (!entry.isDirectory()) { continue; }
      if (BROWSE_SKIP_DIRS.has(entry.name)) { continue; }
      if (dirs.length >= 400) { truncated = true; break; }
      dirs.push({ name: entry.name, path: work.rel ? work.rel + '/' + entry.name : entry.name });
    }
  } catch (error) {
    return { error: '读取目录失败: ' + error.message };
  }
  const parent = work.rel ? (work.rel.lastIndexOf('/') >= 0 ? work.rel.slice(0, work.rel.lastIndexOf('/')) : '') : null;
  return { path: work.rel, parent, dirs, truncated };
}

function createWorkdir(root, rel, name) {
  let clean = String(name || '').trim();
  if (!clean) { return { error: '请输入文件夹名称' }; }
  if (clean.length > 80) { return { error: '文件夹名称过长（最多 80 字）' }; }
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(clean)) { return { error: '文件夹名称不能包含 \\ / : * ? " < > |' }; }
  if (clean === '.' || clean === '..') { return { error: '文件夹名称无效' }; }
  if (/[. ]$/.test(clean)) { return { error: '文件夹名称不能以点或空格结尾' }; }
  const work = resolveWorkdir(root.path, rel);
  if (work.error) { return { error: work.error }; }
  const target = path.join(work.path, clean);
  if (!isUnder(target, work.path)) { return { error: '文件夹不在当前同步目录内' }; }
  if (fs.existsSync(target)) { return { error: '同名文件或文件夹已存在' }; }
  try { fs.mkdirSync(target); }
  catch (error) { return { error: '新建文件夹失败: ' + error.message }; }
  return { path: work.rel ? work.rel + '/' + clean : clean };
}

function imageExtOk(file) {
  return IMAGE_EXTENSIONS.has(path.extname(String(file || '')).toLowerCase());
}

function noteImageCandidate(target, value) {
  if (!target || !value) { return; }
  if (!target.imageCandidates) { target.imageCandidates = []; }
  if (target.imageCandidates.length >= 40) { return; }
  const text = typeof value === 'string' ? value : String(value);
  if (!imageExtOk(text)) { return; }
  if (target.imageCandidates.indexOf(text) < 0) { target.imageCandidates.push(text); }
}

// Returns raw path-looking strings; existence and root checks happen later.
function extractImageCandidates(text) {
  const source = String(text || '');
  const out = [];
  const patterns = [
    /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g,
    /(["'`])([^"'`\n]+?\.(?:png|jpe?g|gif|webp|bmp|svg))\1/gi,
    /[A-Za-z]:[\\/][^\s"'`<>|)]+?\.(?:png|jpe?g|gif|webp|bmp|svg)/gi,
    /(?<![\w:])[\\/][^\s"'`<>|)]+?\.(?:png|jpe?g|gif|webp|bmp|svg)/gi,
    /(?:[\w.\-\u4e00-\u9fa5]+[\\/])+[\w.\-\u4e00-\u9fa5]+?\.(?:png|jpe?g|gif|webp|bmp|svg)/gi,
    /(?<![\w.\-\u4e00-\u9fa5])[\w.\-\u4e00-\u9fa5]+?\.(?:png|jpe?g|gif|webp|bmp|svg)/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      const value = String((match[2] || match[1] || match[0]) || '').trim();
      if (value && out.indexOf(value) < 0) { out.push(value); }
      if (out.length >= 40) { return out; }
    }
  }
  return out;
}

function resolveImageCandidate(value, bases, roots) {
  let raw = String(value || '').trim().replace(/^<|>$/g, '').replace(/[),.;:!?]+$/, '');
  if (!raw) { return ''; }
  if (/^file:\/\//i.test(raw)) {
    try { raw = decodeURIComponent(raw.slice(7)); } catch { raw = raw.slice(7); }
    if (/^\/[A-Za-z]:/.test(raw)) { raw = raw.slice(1); }
  }
  if (/^(https?:|data:|blob:)/i.test(raw)) { return ''; }
  raw = expandHome(raw);
  const candidates = [];
  if (path.isAbsolute(raw)) { candidates.push(raw); }
  else {
    for (const base of bases) {
      if (base) { candidates.push(path.resolve(base, raw)); }
    }
  }
  for (const candidate of candidates) {
    if (!imageExtOk(candidate)) { continue; }
    let real = '';
    try { real = fs.realpathSync(candidate); } catch { continue; }
    let stat = null;
    try { stat = fs.statSync(real); } catch { continue; }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE) { continue; }
    const allowed = roots.some(root => isUnder(real, root.path)) || isUnder(real, CODEX_GENERATED_DIR);
    if (!allowed) { continue; }
    return real;
  }
  return '';
}

// Walks a folder with a small entry budget so a huge synced directory cannot
// stall the turn. Only recently written image files are kept.
function scanRecentImages(dir, sinceMs, limit) {
  const found = [];
  const stack = [{ dir, depth: 0 }];
  let seen = 0;
  const budget = 2500;
  while (stack.length && seen < budget && found.length < limit) {
    const item = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(item.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      seen += 1;
      if (seen > budget) { break; }
      const full = path.join(item.dir, entry.name);
      if (entry.isDirectory()) {
        if (item.depth >= 4) { continue; }
        if (BROWSE_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) { continue; }
        stack.push({ dir: full, depth: item.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !imageExtOk(entry.name)) { continue; }
      let stat = null;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE || stat.mtimeMs < sinceMs) { continue; }
      found.push({ path: full, mtime: stat.mtimeMs });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.map(item => item.path);
}

function discoverTurnImages(t) {
  const config = loadRoots();
  const roots = config.roots;
  const bases = [t.workdirPath, t.root].filter(Boolean);
  const text = String(t.answer || '') + '\n' + String(t.activity || '');
  const candidates = extractImageCandidates(text).concat(t.imageCandidates || []);
  const images = [];
  const add = value => {
    const real = resolveImageCandidate(value, bases, roots);
    if (real && images.indexOf(real) < 0) { images.push(real); }
  };
  candidates.forEach(add);

  const started = Date.parse(t.startedAt) || Date.now();
  const since = started - 3000;
  // Codex's built-in image generation saves under its own home, never in the
  // user's sync folder; its output is read-only but should be previewable.
  scanRecentImages(CODEX_GENERATED_DIR, since, 8).forEach(add);

  const likelyImage = images.length > 0
    || /图片|图像|插画|海报|封面|绘制|画一|画好|生成.{0,6}图|imagegen|\b(?:png|jpe?g|gif|webp|bmp|svg)\b/i.test(text);
  if (likelyImage) {
    const dirs = [t.workdirPath || t.root];
    if (t.root && (!t.workdirPath || normalizeForCompare(t.workdirPath) !== normalizeForCompare(t.root))) {
      dirs.push(t.root);
    }
    for (const dir of dirs) {
      if (!dir) { continue; }
      scanRecentImages(dir, since, 8).forEach(add);
    }
  }
  t.images = images.slice(0, 12);
  return t.images;
}

function startTurn(body) {
  if (turn && turn.status === 'running') {
    return { code: 409, error: '上一轮还在运行，请先停止或等待完成。' };
  }
  const prompt = String(body.prompt || '').trim();
  if (!prompt) { return { code: 400, error: '请输入内容。' }; }
  if (prompt.length > MAX_PROMPT) { return { code: 400, error: `内容过长（最多 ${MAX_PROMPT} 字）。` }; }

  const config = loadRoots();
  if (config.roots.length === 0) {
    return { code: 400, error: '没有可用的同步目录：' + (config.problems.join('; ') || '请先在控制台选择目录') };
  }
  const wanted = normalizeForCompare(String(body.root || ''));
  const root = config.roots.find(item => normalizeForCompare(item.path) === wanted) || config.roots[0];
  const work = resolveWorkdir(root.path, body.workdir);
  if (work.error) { return { code: 400, error: work.error }; }
  const reasoning = normalizeReasoning(body.reasoning);
  const fast = Boolean(body.fast);

  let image = String(body.image || '').trim();
  if (image) {
    let resolved = '';
    try { resolved = fs.realpathSync(image); } catch { resolved = ''; }
    if (!resolved || !isUnder(resolved, UPLOAD_DIR)) {
      return { code: 400, error: '图片路径无效（只接受本次上传的图片）。' };
    }
    image = resolved;
  }

  // Host-uploaded files saved inside current workspace (_smac_uploads/)
  const attachedFiles = [];
  if (Array.isArray(body.files)) {
    for (const item of body.files.slice(0, 12)) {
      const rawPath = String((item && (item.path || item.relPath)) || item || '').trim();
      if (!rawPath) continue;
      const candidate = path.isAbsolute(rawPath) ? rawPath : path.join(work.path, rawPath);
      let resolved = '';
      try { resolved = fs.realpathSync(candidate); } catch { resolved = ''; }
      if (!resolved || !isUnder(resolved, root.path)) continue;
      const rel = path.relative(work.path, resolved).replace(/\\/g, '/');
      let size = Number(item && item.size) || 0;
      if (!size) { try { size = fs.statSync(resolved).size; } catch { } }
      attachedFiles.push({
        name: String((item && item.name) || path.basename(resolved)),
        relPath: rel,
        path: resolved,
        size
      });
    }
  }

  let effectivePrompt = prompt;
  if (attachedFiles.length) {
    const fmtSize = bytes => {
      if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
      return bytes + ' B';
    };
    const header = '[主机上传的文件（已保存到当前工作区，请使用文件工具直接读取分析）]\n'
      + attachedFiles.map(f => `- ${f.name} → ${f.relPath} (${fmtSize(f.size)})`).join('\n');
    effectivePrompt = header + '\n\n' + prompt;
  }

  if (image && config.backend !== 'hermes' && config.backend !== 'codex') {
    return { code: 400, error: backendLabel(config.backend) + ' 后端暂不支持原生图片通道；请以文件方式上传或切换 Codex / Hermes。' };
  }
  if (config.backend === 'dsh') {
    return startDshTurn({ prompt: effectivePrompt, displayPrompt: prompt, config, root, work, reasoning, body });
  }
  if (config.backend === 'codex') {
    return startCodexTurn({ prompt: effectivePrompt, displayPrompt: prompt, image, config, root, work, reasoning, fast, body });
  }
  if (config.backend === 'claude') {
    return startClaudeTurn({ prompt: effectivePrompt, displayPrompt: prompt, image, config, root, work, reasoning, body });
  }
  if (config.backend === 'agy') {
    return startAgyTurn({ prompt: effectivePrompt, displayPrompt: prompt, image, config, root, work, reasoning, body });
  }
  if (config.backend === 'opencode') {
    return startOpencodeTurn({ prompt: effectivePrompt, displayPrompt: prompt, config, root, work, body });
  }

  const hermes = findHermes();
  if (!hermes) {
    return { code: 400, error: '远端没有找到 Hermes（需要先安装并登录 Hermes / Codex）。' };
  }

  const authError = prepareAuth();
  if (authError) { return { code: 400, error: authError }; }

  const provider = String(body.provider || config.provider || activeProvider() || '').trim().slice(0, 120);
  let model = String(body.model || config.model || '').trim().slice(0, 160);
  if (!model && provider) { model = defaultModel(provider); }
  const sessionName = sanitizeSession(body.sessionName);

  const id = newTurnId();
  const turnDir = path.join(TURN_DIR, id);
  fs.mkdirSync(turnDir, { recursive: true });
  const promptFile = path.join(turnDir, 'prompt.txt');
  fs.writeFileSync(promptFile, effectivePrompt, 'utf8');

  const args = [
    'chat',
    '--query-file', promptFile,
    '--in', work.path,
    '-t', 'file,todo',
    '-c', sessionName,
    '--create-if-missing'
  ];
  if (image) { args.push('--image', image); }
  if (provider) { args.push('--provider', provider); }
  if (model) { args.push('-m', model); }
  if (reasoning) { args.push('--reasoning', reasoning); }

  const env = Object.assign({}, process.env, {
    HERMES_HOME: HOME,
    // Hermes 的 cwd 消费者优先读 TERMINAL_CWD，而不是进程 cwd；显式指向本次允许目录，
    // 否则相对路径可能落到用户主目录（被写保护拒绝）。
    TERMINAL_CWD: work.path,
    HERMES_WRITE_SAFE_ROOT: config.roots.map(item => item.path).join(path.delimiter),
    SMAC_AGENT_ROOTS: JSON.stringify(config.roots.map(item => item.path)),
    HERMES_ACCEPT_HOOKS: '1',
    HERMES_NO_UPDATE_CHECK: '1',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    NO_COLOR: '1',
    TERM: 'dumb'
  });

  const thisTurn = {
    id,
    status: 'running',
    prompt,
    sessionName,
    sessionId: '',
    root: root.path,
    rootLabel: root.label,
    workdir: work.rel,
    workdirPath: work.path,
    backend: 'hermes',
    provider,
    model,
    reasoning,
    fast: false,
    image,
    images: [],
    imageCandidates: [],
    usage: null,
    startedAt: new Date().toISOString(),
    endedAt: '',
    durationMs: null,
    exitCode: null,
    answer: '',
    activity: '',
    raw: '',
    error: '',
    note: '',
    historySaved: false,
    events: []
  };
  turn = thisTurn;
  eventSeq = 0;
  beginHistoryTurn(thisTurn);
  const parser = createParser(thisTurn);
  log('turn ' + id + ' start root=' + root.path + ' workdir=' + (work.rel || '.') + ' provider=' + provider
    + ' model=' + model + ' reasoning=' + (reasoning || 'auto') + ' image=' + (image ? 'yes' : 'no'));

  let child;
  try {
    child = spawn(hermes, args, {
      cwd: work.path,
      env,
      windowsHide: true,
      detached: !IS_WIN,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    thisTurn.status = 'error';
    thisTurn.endedAt = new Date().toISOString();
    thisTurn.error = '启动 Hermes 失败: ' + error.message;
    finishHistoryTurn(thisTurn);
    emit({ type: 'done', turn: publicTurnOf(thisTurn) }, thisTurn);
    return { code: 500, error: thisTurn.error };
  }
  runningChild = child;
  emit({ type: 'state', turn: publicTurnOf(thisTurn) }, thisTurn);

  const timer = setTimeout(() => {
    if (thisTurn.status !== 'running') { return; }
    thisTurn.error = `任务超时（${config.timeoutSeconds} 秒），已终止。`;
    killTree(child);
  }, config.timeoutSeconds * 1000);
  timer.unref();

  child.stdout.on('data', chunk => parser.push(chunk));
  child.stderr.on('data', chunk => {
    thisTurn.raw += chunk.toString('utf8');
    if (thisTurn.raw.length > MAX_RAW) { thisTurn.raw = thisTurn.raw.slice(-MAX_RAW); }
  });
  child.on('error', error => {
    if (thisTurn.status !== 'running') { return; }
    thisTurn.status = 'error';
    thisTurn.endedAt = new Date().toISOString();
    thisTurn.error = '运行 Hermes 失败: ' + error.message;
    clearTimeout(timer);
  });
  child.on('close', code => {
    clearTimeout(timer);
    if (runningChild === child) { runningChild = null; }
    try { parser.flush(); } catch { }
    persistAuth();
    if (thisTurn.status !== 'running') {
      // Cancelled / interrupted: the partial transcript was saved then.
      finishHistoryTurn(thisTurn);
      return;
    }
    thisTurn.exitCode = code;
    thisTurn.endedAt = new Date().toISOString();
    thisTurn.durationMs = Date.parse(thisTurn.endedAt) - Date.parse(thisTurn.startedAt);
    thisTurn.answer = thisTurn.answer.replace(/\s+$/, '');
    thisTurn.activity = thisTurn.activity.replace(/\s+$/, '');
    const sessionMatch = /Session:\s*(\S+)/.exec(stripAnsi(thisTurn.raw));
    if (sessionMatch) { thisTurn.sessionId = sessionMatch[1]; }
    if (thisTurn.error) { thisTurn.status = 'error'; }
    else if (code === 0) { thisTurn.status = 'done'; }
    else { thisTurn.status = 'error'; thisTurn.error = 'Hermes 退出码 ' + code; }
    if (thisTurn.status === 'done' && !thisTurn.answer) {
      thisTurn.status = 'error';
      thisTurn.error = 'Hermes 没有返回可显示的回复。';
    }
    log('turn ' + thisTurn.id + ' ' + thisTurn.status + ' code=' + code + ' ms=' + thisTurn.durationMs);
    discoverTurnImages(thisTurn);
    finishHistoryTurn(thisTurn);
    emit({ type: 'done', turn: publicTurnOf(thisTurn) }, thisTurn);
  });

  return { code: 200, turn: thisTurn };
}

// Codex backend: the CLI runs with its native shell disabled and every tool
// except the `smac` MCP file server denied by a PreToolUse hook. The MCP server
// enforces the same sync-root limits as the Hermes backend.
function startCodexTurn(options) {
  const { prompt, displayPrompt, image, config, root, work, reasoning, fast, body } = options;
  const codex = findCodex();
  if (!codex) {
    return { code: 400, error: '远端没有安装 Codex CLI；请先在控制台启动一次 Codex 后端（会自动安装），或手动装到 ~/.smac-agent/tools。' };
  }
  const requestedProvider = String(body.provider || config.provider || '').trim();
  const prepared = prepareCodexHome(work.path, requestedProvider);
  if (prepared.error) { return { code: 400, error: prepared.error }; }
  const source = prepared.source;
  let model = String(body.model || config.model || '').trim().slice(0, 160);
  if (!model && codexModelsCache.data && Array.isArray(codexModelsCache.data.providers)) {
    const prov = codexModelsCache.data.providers.find(p => p.id === source.id) || codexModelsCache.data.providers[0];
    if (prov && prov.models && prov.models.length) { model = prov.models[0]; }
  }

  const sessionName = sanitizeSession(body.sessionName);
  const threadId = codexThreadFor(sessionName, source.id);
  const id = newTurnId();
  const turnDir = path.join(TURN_DIR, id);
  fs.mkdirSync(turnDir, { recursive: true });
  fs.writeFileSync(path.join(turnDir, 'prompt.txt'), prompt, 'utf8');

  const args = threadId
    ? ['exec', 'resume', threadId, '--json', '--skip-git-repo-check', '--disable', 'shell_tool',
      '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust']
    : ['exec', '--json', '--skip-git-repo-check', '--disable', 'shell_tool',
      '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '-C', work.path];
  if (model) { args.push('-m', model); }
  if (reasoning) { args.push('-c', 'model_reasoning_effort="' + reasoning + '"'); }
  if (fast) { args.push('-c', 'service_tier="fast"', '-c', 'features.fast_mode=true'); }
  if (image) { args.push('-i', image); }
  args.push('-');

  const env = Object.assign({}, process.env, {
    CODEX_HOME: prepared.homeDir,
    NO_COLOR: '1',
    TERM: 'dumb',
    RUST_BACKTRACE: '0'
  });

  const thisTurn = {
    id,
    status: 'running',
    prompt: displayPrompt || prompt,
    sessionName,
    sessionId: threadId,
    root: root.path,
    rootLabel: root.label,
    workdir: work.rel,
    workdirPath: work.path,
    backend: 'codex',
    provider: source.id,
    model,
    reasoning,
    fast,
    image,
    images: [],
    imageCandidates: [],
    usage: null,
    startedAt: new Date().toISOString(),
    endedAt: '',
    durationMs: null,
    exitCode: null,
    answer: '',
    activity: '',
    raw: '',
    error: '',
    note: '',
    historySaved: false,
    events: []
  };
  turn = thisTurn;
  eventSeq = 0;
  beginHistoryTurn(thisTurn);
  const parser = createCodexParser(thisTurn);
  log('turn ' + id + ' start backend=codex root=' + root.path + ' workdir=' + (work.rel || '.')
    + ' model=' + (model || 'default') + ' reasoning=' + (reasoning || 'auto') + ' fast=' + (fast ? 'yes' : 'no')
    + ' resume=' + (threadId || 'no') + ' image=' + (image ? 'yes' : 'no'));

  let child;
  try {
    child = spawn(codex, args, {
      cwd: work.path,
      env,
      windowsHide: true,
      detached: !IS_WIN,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (error) {
    thisTurn.status = 'error';
    thisTurn.endedAt = new Date().toISOString();
    thisTurn.error = '启动 Codex 失败: ' + error.message;
    finishHistoryTurn(thisTurn);
    emit({ type: 'done', turn: publicTurnOf(thisTurn) }, thisTurn);
    return { code: 500, error: thisTurn.error };
  }
  runningChild = child;
  child.stdin.on('error', () => { });
  try { child.stdin.write(prompt + '\n'); child.stdin.end(); } catch { }
  emit({ type: 'state', turn: publicTurnOf(thisTurn) }, thisTurn);

  const timer = setTimeout(() => {
    if (thisTurn.status !== 'running') { return; }
    thisTurn.error = `任务超时（${config.timeoutSeconds} 秒），已终止。`;
    killTree(child);
  }, config.timeoutSeconds * 1000);
  timer.unref();

  child.stdout.on('data', chunk => parser.push(chunk));
  child.stderr.on('data', chunk => {
    thisTurn.raw += chunk.toString('utf8');
    if (thisTurn.raw.length > MAX_RAW) { thisTurn.raw = thisTurn.raw.slice(-MAX_RAW); }
  });
  child.on('error', error => {
    if (thisTurn.status !== 'running') { return; }
    thisTurn.status = 'error';
    thisTurn.endedAt = new Date().toISOString();
    thisTurn.error = '运行 Codex 失败: ' + error.message;
    clearTimeout(timer);
  });
  child.on('close', code => {
    clearTimeout(timer);
    if (runningChild === child) { runningChild = null; }
    try { parser.flush(); } catch { }
    persistCodexAuth();
    if (thisTurn.status !== 'running') {
      discoverTurnImages(thisTurn);
      finishHistoryTurn(thisTurn);
      return;
    }
    thisTurn.exitCode = code;
    thisTurn.endedAt = new Date().toISOString();
    thisTurn.durationMs = Date.parse(thisTurn.endedAt) - Date.parse(thisTurn.startedAt);
    thisTurn.answer = thisTurn.answer.trim();
    thisTurn.activity = thisTurn.activity.replace(/\s+$/, '');
    if (code === 0 && thisTurn.answer) {
      thisTurn.status = 'done';
      thisTurn.error = '';
    } else if (thisTurn.error) {
      thisTurn.status = 'error';
    } else if (code === 0) {
      thisTurn.status = 'error';
      thisTurn.error = 'Codex 没有返回可显示的回复。';
    } else {
      thisTurn.status = 'error';
      thisTurn.error = 'Codex 退出码 ' + code + (thisTurn.raw ? '：' + thisTurn.raw.trim().slice(-400) : '');
    }
    log('turn ' + thisTurn.id + ' ' + thisTurn.status + ' code=' + code + ' ms=' + thisTurn.durationMs
      + ' images=' + discoverTurnImages(thisTurn).length);
    finishHistoryTurn(thisTurn);
    emit({ type: 'done', turn: publicTurnOf(thisTurn) }, thisTurn);
  });

  return { code: 200, turn: thisTurn };
}

// Claude Code backend: built-in tools are disabled entirely; the model can
// only call the smac MCP server, which enforces the same sync-root limits.
function startClaudeTurn(options) {
  const { prompt, displayPrompt, image, config, root, work, reasoning, body } = options;
  const claude = findClaude();
  if (!claude) {
    return { code: 400, error: '远端没有安装 Claude Code CLI；请先在控制台用 Claude 后端启动一次（会自动安装），或手动装到 ~/.smac-agent/tools。' };
  }
  const creds = loadCredentials().claude;
  const auth = (creds.apiKey || creds.oauthToken) ? { ready: true } : claudeAuthState();
  if (!auth.ready) {
    return { code: 400, error: auth.error || 'Claude Code 尚未登录。' };
  }
  const prepared = prepareClaudeMcp(work.path);
  if (prepared.error) { return { code: 400, error: prepared.error }; }

  let model = String(body.model || config.model || '').trim().slice(0, 160);
  if (!model) { model = listClaudeModels().defaultModel || ''; }
  const sessionName = sanitizeSession(body.sessionName);
  const sessionId = claudeSessionFor(sessionName);
  const id = newTurnId();
  const turnDir = path.join(TURN_DIR, id);
  fs.mkdirSync(turnDir, { recursive: true });
  fs.writeFileSync(path.join(turnDir, 'prompt.txt'), prompt, 'utf8');

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--mcp-config', prepared.file, '--strict-mcp-config',
    '--tools', '', '--allowedTools', 'mcp__smac__*',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none'];
  if (sessionId) { args.push('--resume', sessionId); }
  if (model) { args.push('--model', model); }
  if (reasoning) { args.push('--effort', reasoning); }

  const env = Object.assign({}, process.env, {
    NO_COLOR: '1',
    TERM: 'dumb',
    PYTHONUTF8: '1'
  });
  if (creds.oauthToken) { env.CLAUDE_CODE_OAUTH_TOKEN = creds.oauthToken; }
  else if (creds.apiKey) { env.ANTHROPIC_API_KEY = creds.apiKey; }
  if (creds.baseUrl) { env.ANTHROPIC_BASE_URL = creds.baseUrl; }

  const thisTurn = {
    id,
    status: 'running',
    prompt: displayPrompt || prompt,
    sessionName,
    sessionId,
    root: root.path,
    rootLabel: root.label,
    workdir: work.rel,
    workdirPath: work.path,
    backend: 'claude',
    provider: 'claude',
    model,
    reasoning,
    fast: false,
    image: '',
    images: [],
    imageCandidates: [],
    usage: null,
    startedAt: new Date().toISOString(),
    endedAt: '',
    durationMs: null,
    exitCode: null,
    answer: '',
    activity: '',
    raw: '',
    error: '',
    note: '',
    historySaved: false,
    events: []
  };
  turn = thisTurn;
  eventSeq = 0;
  beginHistoryTurn(thisTurn);
  const parser = createClaudeParser(thisTurn);
  log('turn ' + id + ' start backend=claude root=' + root.path + ' workdir=' + (work.rel || '.')
    + ' model=' + (model || 'default') + ' reasoning=' + (reasoning || 'auto')
    + ' resume=' + (sessionId || 'no') + ' bound=' + (creds.apiKey || creds.oauthToken ? 'key' : 'login'));

  let child;
  const spec = executableSpec(claude, args);
  try {
    child = spawn(spec.command, spec.args, {
      cwd: work.path,
      env,
      windowsHide: true,
      windowsVerbatimArguments: Boolean(spec.windowsVerbatimArguments),
      detached: !IS_WIN,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (error) {
    thisTurn.status = 'error';
    thisTurn.endedAt = new Date().toISOString();
    thisTurn.error = '启动 Claude Code 失败: ' + error.message;
    finishHistoryTurn(thisTurn);
    emit({ type: 'done', turn: publicTurnOf(thisTurn) }, thisTurn);
    return { code: 500, error: thisTurn.error };
  }
  runningChild = child;
  child.stdin.on('error', () => { });
  try { child.stdin.write(prompt); child.stdin.end(); } catch { }
  emit({ type: 'state', turn: publicTurnOf(thisTurn) }, thisTurn);

  const timer = setTimeout(() => {
    if (thisTurn.status !== 'running') { return; }
    thisTurn.error = `任务超时（${config.timeoutSeconds} 秒），已终止。`;
    killTree(child);
  }, config.timeoutSeconds * 1000);
  timer.unref();

  child.stdout.on('data', chunk => parser.push(chunk));
  child.stderr.on('data', chunk => {
    thisTurn.raw += chunk.toString('utf8');
    if (thisTurn.raw.length > MAX_RAW) { thisTurn.raw = thisTurn.raw.slice(-MAX_RAW); }
  });
  child.on('error', error => {
    if (thisTurn.status !== 'running') { return; }
    thisTurn.status = 'error';
    thisTurn.endedAt = new Date().toISOString();
    thisTurn.error = '运行 Claude Code 失败: ' + error.message;
    clearTimeout(timer);
  });
  child.on('close', code => {
    clearTimeout(timer);
    if (runningChild === child) { runningChild = null; }
    try { parser.flush(); } catch { }
    if (thisTurn.status !== 'running') {
      discoverTurnImages(thisTurn);
      finishHistoryTurn(thisTurn);
      return;
    }
    thisTurn.exitCode = code;
    thisTurn.endedAt = new Date().toISOString();
    thisTurn.durationMs = Date.parse(thisTurn.endedAt) - Date.parse(thisTurn.startedAt);
    thisTurn.answer = thisTurn.answer.trim();
    thisTurn.activity = thisTurn.activity.replace(/\s+$/, '');
    if (code === 0 && thisTurn.answer) {
      thisTurn.status = 'done';
      thisTurn.error = '';
    } else if (thisTurn.error) {
      thisTurn.status = 'error';
    } else if (code === 0) {
      thisTurn.status = 'error';
      thisTurn.error = 'Claude Code 没有返回可显示的回复。';
    } else {
      thisTurn.status = 'error';
      thisTurn.error = 'Claude Code 退出码 ' + code + (thisTurn.raw ? '：' + thisTurn.raw.trim().slice(-400) : '');
    }
    log('turn ' + thisTurn.id + ' ' + thisTurn.status + ' code=' + code + ' ms=' + thisTurn.durationMs
      + ' images=' + discoverTurnImages(thisTurn).length);
    finishHistoryTurn(thisTurn);
    emit({ type: 'done', turn: publicTurnOf(thisTurn) }, thisTurn);
  });

  return { code: 200, turn: thisTurn };
}

// Antigravity backend: smac is registered in the global MCP config and the
// allow rule mcp(smac/*) pre-approves it. Other tools stay in request-review
// mode, where headless runs soft-deny anything that needs a human approval.
function startAgyTurn(options) {
  const { prompt, displayPrompt, image, config, root, work, reasoning, body } = options;
  const agy = findAgy();
  if (!agy) {
    return { code: 400, error: '远端没有安装 Gemini / Antigravity CLI；请先在控制台用该后端启动一次（会自动安装），或手动安装 agy。' };
  }
  const prepared = prepareAgyConfig(work.path);
  if (prepared.error) { return { code: 400, error: prepared.error }; }
  const creds = loadCredentials().agy;

  let model = String(body.model || config.model || '').trim().slice(0, 160);
  if (!model) { model = listAgyModels().defaultModel || ''; }
  const sessionName = sanitizeSession(body.sessionName);
  const sessionId = agySessionFor(sessionName);
  const id = newTurnId();
  const turnDir = path.join(TURN_DIR, id);
  fs.mkdirSync(turnDir, { recursive: true });
  fs.writeFileSync(path.join(turnDir, 'prompt.txt'), prompt, 'utf8');

  const args = ['-p', prompt, '--output-format', 'stream-json',
    '--print-timeout', String(Math.max(60, config.timeoutSeconds)) + 's'];
  if (!IS_WIN) { args.push('--sandbox'); }
  if (sessionId) { args.push('--conversation', sessionId); }
  if (model) { args.push('--model', model); }
  if (reasoning) { args.push('--effort', reasoning); }

  const extraEnv = {};
  if (creds.apiKey) { extraEnv.GEMINI_API_KEY = creds.apiKey; }
  if (creds.baseUrl) { extraEnv.GOOGLE_GEMINI_BASE_URL = creds.baseUrl; }
  const env = cleanAgyEnv(extraEnv);

  const thisTurn = {
    id,
    status: 'running',
    prompt: displayPrompt || prompt,
    sessionName,
    sessionId,
    root: root.path,
    rootLabel: root.label,
    workdir: work.rel,
    workdirPath: work.path,
    backend: 'agy',
    provider: 'agy',
    model,
    reasoning,
    fast: false,
    image: '',
    images: [],
    imageCandidates: [],
    usage: null,
    startedAt: new Date().toISOString(),
    endedAt: '',
    durationMs: null,
    exitCode: null,
    answer: '',
    activity: '',
    raw: '',
    error: '',
    note: '',
    historySaved: false,
    events: []
  };
  turn = thisTurn;
  eventSeq = 0;
  beginHistoryTurn(thisTurn);
  const parser = createAgyParser(thisTurn);
  log('turn ' + id + ' start backend=agy root=' + root.path + ' workdir=' + (work.rel || '.')
    + ' model=' + (model || 'default') + ' reasoning=' + (reasoning || 'auto')
    + ' resume=' + (sessionId || 'no') + ' bound=' + (creds.apiKey ? 'key' : 'login'));

  let child;
  const spec = executableSpec(agy, args);
  try {
    child = spawn(spec.command, spec.args, {
      cwd: work.path,
      env,
      windowsHide: true,
      windowsVerbatimArguments: Boolean(spec.windowsVerbatimArguments),
      detached: !IS_WIN,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    thisTurn.status = 'error';
    thisTurn.endedAt = new Date().toISOString();
    thisTurn.error = '启动 Antigravity 失败: ' + error.message;
    finishHistoryTurn(thisTurn);
    emit({ type: 'done', turn: publicTurnOf(thisTurn) }, thisTurn);
    return { code: 500, error: thisTurn.error };
  }
  runningChild = child;
  emit({ type: 'state', turn: publicTurnOf(thisTurn) }, thisTurn);

  const timer = setTimeout(() => {
    if (thisTurn.status !== 'running') { return; }
    thisTurn.error = `任务超时（${config.timeoutSeconds} 秒），已终止。`;
    killTree(child);
  }, config.timeoutSeconds * 1000);
  timer.unref();

  child.stdout.on('data', chunk => parser.push(chunk));
  child.stderr.on('data', chunk => {
    thisTurn.raw += chunk.toString('utf8');
    if (thisTurn.raw.length > MAX_RAW) { thisTurn.raw = thisTurn.raw.slice(-MAX_RAW); }
  });
  child.on('error', error => {
    if (thisTurn.status !== 'running') { return; }
    thisTurn.status = 'error';
    thisTurn.endedAt = new Date().toISOString();
    thisTurn.error = '运行 Antigravity 失败: ' + error.message;
    clearTimeout(timer);
  });
  child.on('close', code => {
    clearTimeout(timer);
    if (runningChild === child) { runningChild = null; }
    try { parser.flush(); } catch { }
    if (thisTurn.status !== 'running') {
      discoverTurnImages(thisTurn);
      finishHistoryTurn(thisTurn);
      return;
    }
    thisTurn.exitCode = code;
    thisTurn.endedAt = new Date().toISOString();
    thisTurn.durationMs = Date.parse(thisTurn.endedAt) - Date.parse(thisTurn.startedAt);
    thisTurn.answer = thisTurn.answer.trim();
    thisTurn.activity = thisTurn.activity.replace(/\s+$/, '');
    if (code === 0 && thisTurn.answer) {
      thisTurn.status = 'done';
      thisTurn.error = '';
    } else if (thisTurn.error) {
      thisTurn.status = 'error';
    } else if (code === 0) {
      thisTurn.status = 'error';
      thisTurn.error = 'Antigravity 没有返回可显示的回复。';
    } else {
      thisTurn.status = 'error';
      thisTurn.error = 'Antigravity 退出码 ' + code + (thisTurn.raw ? '：' + thisTurn.raw.trim().slice(-400) : '');
    }
    log('turn ' + thisTurn.id + ' ' + thisTurn.status + ' code=' + code + ' ms=' + thisTurn.durationMs
      + ' images=' + discoverTurnImages(thisTurn).length);
    finishHistoryTurn(thisTurn);
    emit({ type: 'done', turn: publicTurnOf(thisTurn) }, thisTurn);
  });

  return { code: 200, turn: thisTurn };
}

function cancelTurn() {
  if (!turn || turn.status !== 'running') { return { code: 200, cancelled: false, turn: publicTurn() }; }
  const t = turn;
  t.status = 'cancelled';
  t.error = '已由用户停止。';
  t.endedAt = new Date().toISOString();
  t.durationMs = Date.parse(t.endedAt) - Date.parse(t.startedAt);
  t.answer = String(t.answer || '').replace(/\s+$/, '');
  t.activity = String(t.activity || '').replace(/\s+$/, '');
  finishHistoryTurn(t);
  killTree(runningChild);
  emit({ type: 'done', turn: publicTurnOf(t) }, t);
  return { code: 200, cancelled: true, turn: publicTurnOf(t) };
}

function waitForChildExit(child, timeoutMs) {
  return new Promise(resolve => {
    if (!child || child.exitCode != null || child.signalCode) { resolve(); return; }
    let settled = false;
    const finish = () => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    child.once('close', finish);
    child.once('exit', finish);
    child.once('error', finish);
  });
}

// Stop the running turn but keep the partial answer, then let the caller start
// the next turn in the same session with the user's inserted message.
async function interruptTurn() {
  if (!turn || turn.status !== 'running') { return false; }
  const t = turn;
  const child = runningChild;
  t.status = 'interrupted';
  t.error = '';
  t.note = '已打断，正在处理新消息。';
  t.endedAt = new Date().toISOString();
  t.durationMs = Date.parse(t.endedAt) - Date.parse(t.startedAt);
  t.answer = String(t.answer || '').replace(/\s+$/, '');
  t.activity = String(t.activity || '').replace(/\s+$/, '');
  finishHistoryTurn(t);
  killTree(child);
  emit({ type: 'done', turn: publicTurnOf(t) }, t);
  await waitForChildExit(child, 4000);
  return true;
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.csv': 'text/plain; charset=utf-8'
};

function resolveInsideRoots(value) {
  let full = expandHome(String(value || '').trim());
  if (!full || !path.isAbsolute(full)) { return ''; }
  let real;
  try { real = fs.realpathSync(full); } catch { return ''; }
  const roots = loadRoots().roots;
  // Files generated by Codex's image tool live in its own home. They are only
  // ever served read-only for in-chat preview, never as writable agent roots.
  const allowed = roots.some(root => isUnder(real, root.path)) || isUnder(real, CODEX_GENERATED_DIR);
  if (!allowed) { return ''; }
  try {
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > MAX_FILE) { return ''; }
  } catch { return ''; }
  return real;
}

const RAW_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.log', '.js', '.mjs', '.cjs', '.ts', '.tsx',
  '.jsx', '.css', '.html', '.htm', '.xml', '.svg', '.yml', '.yaml', '.toml', '.ini', '.py',
  '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.sh', '.bat', '.ps1'
]);
const RAW_PREVIEW_LIMIT = 2 * 1024 * 1024;

function sendRawPreview(res, file, ext) {
  let stat;
  try { stat = fs.statSync(file); } catch { sendJson(res, 404, { error: '文件不可读' }); return; }
  if (stat.size > RAW_PREVIEW_LIMIT) {
    sendJson(res, 413, { error: '文件超过 2MB，无法内置预览，请下载后查看。' });
    return;
  }
  const text = ext === '.svg' || MIME[ext] || RAW_TEXT_EXTENSIONS.has(ext)
    ? fs.readFileSync(file, 'utf8') : null;
  // Sandboxed: previewed HTML/SVG must not be able to call back into the agent.
  const headers = {
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self' data:",
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, max-age=30'
  };
  if (text == null) {
    headers['Content-Type'] = 'application/octet-stream';
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    fs.createReadStream(file).on('error', () => { try { res.destroy(); } catch { } }).pipe(res);
    return;
  }
  const type = ext === '.svg' ? 'image/svg+xml; charset=utf-8'
    : ext === '.html' || ext === '.htm' ? 'text/html; charset=utf-8'
      : (MIME[ext] || 'text/plain; charset=utf-8');
  headers['Content-Type'] = type;
  headers['Content-Length'] = Buffer.byteLength(text);
  res.writeHead(200, headers);
  res.end(text);
}

// Uploaded images live outside the sync roots; history entries reference them by
// path, so the page needs a token-protected way to read them back.
function resolveInsideUploads(value) {
  const full = String(value || '').trim();
  if (!full || !path.isAbsolute(full)) { return ''; }
  let real;
  try { real = fs.realpathSync(full); } catch { return ''; }
  if (!isUnder(real, UPLOAD_DIR)) { return ''; }
  try {
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > MAX_FILE) { return ''; }
  } catch { return ''; }
  return real;
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, code, text, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        try { req.destroy(); } catch { }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) { resolve({}); return; }
      try { resolve(JSON.parse(text)); }
      catch (error) { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function tokenOk(req, url) {
  const header = String(req.headers['x-smac-token'] || '');
  const query = String(url.searchParams.get('token') || '');
  return Boolean(TOKEN) && (header === TOKEN || query === TOKEN);
}

function saveUpload(body) {
  const kind = String(body.kind || 'image').trim().toLowerCase();
  const rawName = String(body.name || (kind === 'file' ? 'upload.bin' : 'image.png')).trim();
  const safeName = path.basename(rawName).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(-140) || (kind === 'file' ? 'upload.bin' : 'image.png');
  let data = String(body.data || '');
  const match = /^data:([^;,]+)?;base64,(.*)$/s.exec(data);
  if (match) { data = match[2]; }
  const buffer = Buffer.from(data, 'base64');
  if (!buffer.length) { throw new Error('文件内容为空'); }

  if (kind === 'file') {
    if (buffer.length > MAX_FILE_UPLOAD) { throw new Error('单个文件不能超过 40MB'); }
    const config = loadRoots();
    if (!config.roots.length) { throw new Error('没有可用的同步目录'); }
    const wanted = normalizeForCompare(String(body.root || ''));
    const root = config.roots.find(item => normalizeForCompare(item.path) === wanted) || config.roots[0];
    const work = resolveWorkdir(root.path, body.workdir);
    if (work.error) { throw new Error(work.error); }
    const targetDir = path.join(work.path, '_smac_uploads');
    fs.mkdirSync(targetDir, { recursive: true });
    const ext = path.extname(safeName);
    const stem = path.basename(safeName, ext).slice(0, 90) || 'file';
    let finalName = stem + ext;
    let file = path.join(targetDir, finalName);
    let idx = 2;
    while (fs.existsSync(file) && idx < 200) {
      // Reuse exact same filename if content size matches & identical bytes; otherwise suffix -2, -3...
      try {
        const existing = fs.readFileSync(file);
        if (existing.length === buffer.length && existing.equals(buffer)) break;
      } catch { }
      finalName = stem + '-' + idx + ext;
      file = path.join(targetDir, finalName);
      idx += 1;
    }
    fs.writeFileSync(file, buffer);
    const relPath = '_smac_uploads/' + finalName;
    return { kind: 'file', path: file, relPath, name: finalName, size: buffer.length };
  }

  if (buffer.length > MAX_UPLOAD) { throw new Error('图片超过 16MB'); }
  const ext = path.extname(safeName).toLowerCase() || '.png';
  if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) {
    throw new Error('不支持的图片格式');
  }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const base = path.basename(safeName, path.extname(safeName)).slice(0, 60) || 'image';
  const file = path.join(UPLOAD_DIR, Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex') + '-' + base + ext);
  fs.writeFileSync(file, buffer);
  return { kind: 'image', path: file, name: path.basename(file), size: buffer.length };
}

function cleanupUploads() {
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    for (const name of fs.readdirSync(UPLOAD_DIR)) {
      const file = path.join(UPLOAD_DIR, name);
      const stat = fs.statSync(file);
      if (stat.isFile() && Date.now() - stat.mtimeMs > KEEP_UPLOAD_MS) { fs.rmSync(file, { force: true }); }
    }
  } catch { }
}

function cleanupTurns() {
  try {
    fs.mkdirSync(TURN_DIR, { recursive: true });
    const cutoff = Date.now() - KEEP_UPLOAD_MS;
    for (const name of fs.readdirSync(TURN_DIR)) {
      const dir = path.join(TURN_DIR, name);
      const stat = fs.statSync(dir);
      if (stat.isDirectory() && stat.mtimeMs < cutoff) { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  } catch { }
}

function serveUi(res, name) {
  const file = path.join(__dirname, name);
  let data;
  try { data = fs.readFileSync(file); }
  catch { sendText(res, 404, 'missing ' + name); return; }
  const type = name.endsWith('.css') ? 'text/css; charset=utf-8'
    : name.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : 'text/html; charset=utf-8';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function serveKatex(res, pathname) {
  const match = /^\/katex\/(katex\.min\.(?:js|css)|fonts\/[A-Za-z0-9_-]+\.woff2)$/.exec(String(pathname || ''));
  if (!match) { sendText(res, 404, 'not found'); return; }
  const file = path.join(__dirname, 'katex', match[1]);
  let data;
  try { data = fs.readFileSync(file); }
  catch { sendText(res, 404, 'missing katex asset'); return; }
  const type = match[1].endsWith('.css') ? 'text/css; charset=utf-8'
    : match[1].endsWith('.js') ? 'text/javascript; charset=utf-8'
      : 'font/woff2';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
  res.end(data);
}

function formatDshToolLine(msg) {
  const tool = String(msg.tool || 'tool');
  const input = msg.input && typeof msg.input === 'object' ? msg.input : {};
  const target = input.path || input.file_path || input.filePath || input.pattern || input.query || input.command || '';
  return '• ' + tool + (target ? ' ' + String(target).slice(0, 120) : '');
}

function startDshTurn(options) {
  const { prompt, displayPrompt, config, root, work, reasoning, body } = options;
  const dsh = findDsh();
  if (!dsh) {
    return { code: 400, error: '客机没有检测到 DeepSeek Harness（内置 dsh CLI）。' };
  }
  const modelsInfo = listDshModels();
  const provider = String(body.provider || config.provider || modelsInfo.defaultProvider || 'deepseek-account').trim();
  const model = String(body.model || config.model || modelsInfo.defaultModel || 'deepseek-flash').trim();
  const prepared = prepareDshPatch(provider, model);

  const sessionName = sanitizeSession(body.sessionName);
  const resumeId = dshSessionFor(sessionName);
  const id = newTurnId();
  const turnDir = path.join(TURN_DIR, id);
  fs.mkdirSync(turnDir, { recursive: true });
  fs.writeFileSync(path.join(turnDir, 'prompt.txt'), prompt, 'utf8');

  const args = [
    '--profile', 'headless',
    '--patch', prepared.patchFile,
    '--json',
    '--permission-mode', 'workspace-write',
    '--approval-policy', 'never'
  ];
  for (const r of config.roots) {
    if (r && r.path) { args.push('--add-dir', r.path); }
  }
  if (resumeId) {
    args.push('--session-id', resumeId);
  }
  args.push('-');

  const thisTurn = {
    id,
    status: 'running',
    prompt: displayPrompt || prompt,
    sessionName,
    sessionId: resumeId,
    root: root.path,
    rootLabel: root.label,
    workdir: work.rel,
    workdirPath: work.path,
    backend: 'dsh',
    provider: prepared.provider,
    model: prepared.model,
    reasoning: reasoning || '',
    fast: false,
    image: '',
    images: [],
    imageCandidates: [],
    usage: null,
    startedAt: new Date().toISOString(),
    endedAt: '',
    durationMs: null,
    exitCode: null,
    answer: '',
    activity: '',
    raw: '',
    error: '',
    note: '',
    historySaved: false,
    events: []
  };
  turn = thisTurn;
  eventSeq = 0;
  beginHistoryTurn(thisTurn);
  log('turn ' + id + ' start backend=dsh root=' + root.path + ' workdir=' + (work.rel || '.')
    + ' provider=' + prepared.provider + ' model=' + prepared.model + ' resume=' + (resumeId || 'no'));

  const spec = executableSpec(dsh, args);
  let child;
  try {
    child = spawn(spec.command, spec.args, {
      cwd: work.path,
      env: Object.assign({}, process.env, { NO_COLOR: '1', TERM: 'dumb', PYTHONUTF8: '1' }),
      windowsHide: true,
      windowsVerbatimArguments: Boolean(spec.windowsVerbatimArguments),
      detached: !IS_WIN,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    thisTurn.status = 'error';
    thisTurn.endedAt = new Date().toISOString();
    thisTurn.error = '启动 DeepSeek Harness CLI 失败: ' + err.message;
    finishHistoryTurn(thisTurn);
    emit({ type: 'done', turn: publicTurnOf(thisTurn) }, thisTurn);
    return { code: 500, error: thisTurn.error };
  }
  runningChild = child;
  child.stdin.on('error', () => { });
  try { child.stdin.write(prompt + '\n'); child.stdin.end(); } catch { }
  emit({ type: 'state', turn: publicTurnOf(thisTurn) }, thisTurn);

  const timer = setTimeout(() => {
    if (thisTurn.status !== 'running') return;
    thisTurn.error = `任务超时（${config.timeoutSeconds} 秒），已终止。`;
    killTree(child);
  }, config.timeoutSeconds * 1000);
  timer.unref();

  let stdoutBuf = '';
  const handleLine = line => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; }
    if (msg.type === 'session' && msg.sessionId) {
      thisTurn.sessionId = String(msg.sessionId);
      saveDshSession(sessionName, thisTurn.sessionId);
      return;
    }
    if (msg.type === 'tool_call') {
      const actLine = formatDshToolLine(msg) + '\n';
      thisTurn.activity += actLine;
      emit({ type: 'activity', text: actLine }, thisTurn);
      return;
    }
    if (msg.type === 'text' && typeof msg.text === 'string' && msg.text) {
      thisTurn.answer += msg.text;
      emit({ type: 'answer', text: msg.text }, thisTurn);
      return;
    }
    if (msg.type === 'status' && msg.phase === 'step_end' && msg.usage) {
      const u = msg.usage;
      const prev = thisTurn.usage || { input: 0, output: 0, cached: 0, reasoning: 0 };
      thisTurn.usage = {
        input: (prev.input || 0) + (Number(u.inputTokens) || 0),
        output: (prev.output || 0) + (Number(u.outputTokens) || 0),
        cached: (prev.cached || 0) + (Number(u.cacheReadTokens || u.cachedInputTokens) || 0),
        reasoning: (prev.reasoning || 0) + (Number(u.reasoningTokens) || 0)
      };
      return;
    }
    if (msg.type === 'final') {
      if (msg.sessionId) {
        thisTurn.sessionId = String(msg.sessionId);
        saveDshSession(sessionName, thisTurn.sessionId);
      }
      if (msg.text && !thisTurn.answer) {
        thisTurn.answer = String(msg.text);
        emit({ type: 'answer', text: thisTurn.answer }, thisTurn);
      }
      if (msg.reason && msg.reason.kind === 'error' && msg.reason.error) {
        thisTurn.error = String(msg.reason.error.message || 'DeepSeek Harness 执行失败');
      }
    }
  };

  child.stdout.on('data', chunk => {
    stdoutBuf += chunk.toString('utf8');
    const lines = stdoutBuf.split(/\r?\n/);
    stdoutBuf = lines.pop();
    lines.forEach(handleLine);
  });
  child.stderr.on('data', chunk => {
    thisTurn.raw += stripAnsi(chunk.toString('utf8'));
    if (thisTurn.raw.length > MAX_RAW) thisTurn.raw = thisTurn.raw.slice(-MAX_RAW);
  });
  child.on('close', code => {
    clearTimeout(timer);
    if (runningChild === child) runningChild = null;
    if (stdoutBuf.trim()) handleLine(stdoutBuf);
    if (thisTurn.status !== 'running') {
      finishHistoryTurn(thisTurn);
      return;
    }
    thisTurn.exitCode = code;
    thisTurn.endedAt = new Date().toISOString();
    thisTurn.durationMs = Date.parse(thisTurn.endedAt) - Date.parse(thisTurn.startedAt);
    thisTurn.answer = thisTurn.answer.trim();
    thisTurn.activity = thisTurn.activity.replace(/\s+$/, '');
    // 如果会话续接 ID 失效，清理缓存以便下次自动开新会话
    if (code !== 0 && resumeId && /unknown.*session|session.*not found/i.test(thisTurn.error + ' ' + thisTurn.raw)) {
      const map = readJson(DSH_SESSIONS) || {};
      delete map[sessionName];
      writeJson(DSH_SESSIONS, map);
    }
    if (code === 0 && thisTurn.answer && !thisTurn.error) {
      thisTurn.status = 'done';
    } else {
      thisTurn.status = 'error';
      thisTurn.error = thisTurn.error || ('DeepSeek Harness 退出码 ' + code + (thisTurn.raw ? ': ' + thisTurn.raw.trim().slice(-300) : ''));
    }
    discoverTurnImages(thisTurn);
    finishHistoryTurn(thisTurn);
    emit({ type: 'done', turn: publicTurnOf(thisTurn) }, thisTurn);
  });
  return { code: 200, turn: thisTurn };
}

function startOpencodeTurn(options) {
  const { prompt, displayPrompt, config, root, work, body } = options;
  const opencode = findOpencode();
  if (!opencode) {
    return { code: 400, error: '客机没有安装 OpenCode CLI。' };
  }
  const model = String(body.model || config.model || '').trim().slice(0, 160);
  const sessionName = sanitizeSession(body.sessionName);
  const id = newTurnId();
  const args = ['run'];
  if (model && model !== 'default') { args.push('--model', model); }
  args.push(prompt);

  const thisTurn = {
    id,
    status: 'running',
    prompt: displayPrompt || prompt,
    sessionName,
    sessionId: '',
    root: root.path,
    rootLabel: root.label,
    workdir: work.rel,
    workdirPath: work.path,
    backend: 'opencode',
    provider: 'opencode',
    model: model || 'default',
    reasoning: '',
    fast: false,
    image: '',
    images: [],
    imageCandidates: [],
    usage: null,
    startedAt: new Date().toISOString(),
    endedAt: '',
    durationMs: null,
    exitCode: null,
    answer: '',
    activity: '',
    raw: '',
    error: '',
    note: '',
    historySaved: false,
    events: []
  };
  turn = thisTurn;
  eventSeq = 0;
  beginHistoryTurn(thisTurn);
  const spec = executableSpec(opencode, args);
  let child;
  try {
    child = spawn(spec.command, spec.args, {
      cwd: work.path,
      env: Object.assign({}, process.env, { NO_COLOR: '1', TERM: 'dumb' }),
      windowsHide: true,
      windowsVerbatimArguments: Boolean(spec.windowsVerbatimArguments),
      detached: !IS_WIN,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    thisTurn.status = 'error';
    thisTurn.endedAt = new Date().toISOString();
    thisTurn.error = '启动 OpenCode CLI 失败: ' + err.message;
    finishHistoryTurn(thisTurn);
    emit({ type: 'done', turn: publicTurnOf(thisTurn) }, thisTurn);
    return { code: 500, error: thisTurn.error };
  }
  runningChild = child;
  emit({ type: 'state', turn: publicTurnOf(thisTurn) }, thisTurn);

  const timer = setTimeout(() => {
    if (thisTurn.status !== 'running') return;
    thisTurn.error = `任务超时（${config.timeoutSeconds} 秒），已终止。`;
    killTree(child);
  }, config.timeoutSeconds * 1000);
  timer.unref();

  child.stdout.on('data', chunk => {
    const text = stripAnsi(chunk.toString('utf8'));
    thisTurn.answer += text;
    emit({ type: 'answer', text }, thisTurn);
  });
  child.stderr.on('data', chunk => {
    thisTurn.raw += stripAnsi(chunk.toString('utf8'));
    if (thisTurn.raw.length > MAX_RAW) thisTurn.raw = thisTurn.raw.slice(-MAX_RAW);
  });
  child.on('close', code => {
    clearTimeout(timer);
    if (runningChild === child) runningChild = null;
    if (thisTurn.status !== 'running') {
      finishHistoryTurn(thisTurn);
      return;
    }
    thisTurn.exitCode = code;
    thisTurn.endedAt = new Date().toISOString();
    thisTurn.durationMs = Date.parse(thisTurn.endedAt) - Date.parse(thisTurn.startedAt);
    thisTurn.answer = thisTurn.answer.trim();
    if (code === 0 && thisTurn.answer) {
      thisTurn.status = 'done';
    } else {
      thisTurn.status = 'error';
      thisTurn.error = thisTurn.error || ('OpenCode 退出码 ' + code + (thisTurn.raw ? ': ' + thisTurn.raw.trim().slice(-300) : ''));
    }
    discoverTurnImages(thisTurn);
    finishHistoryTurn(thisTurn);
    emit({ type: 'done', turn: publicTurnOf(thisTurn) }, thisTurn);
  });
  return { code: 200, turn: thisTurn };
}

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); }
  catch { sendText(res, 400, 'bad url'); return; }

  const remote = String(req.socket.remoteAddress || '');
  if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) {
    sendText(res, 403, 'loopback only');
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    serveUi(res, 'ui.html');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/ui.css') { serveUi(res, 'ui.css'); return; }
  if (req.method === 'GET' && url.pathname === '/ui.js') { serveUi(res, 'ui.js'); return; }
  if (req.method === 'GET' && url.pathname.startsWith('/katex/')) { serveKatex(res, url.pathname); return; }

  if (!url.pathname.startsWith('/api/')) { sendText(res, 404, 'not found'); return; }
  if (!tokenOk(req, url)) { sendJson(res, 401, { error: 'token 无效' }); return; }

  if (req.method === 'GET' && url.pathname === '/api/env') {
    sendJson(res, 200, guestEnv.detectAll());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/info') {
    if (url.searchParams.get('health') === '1') {
      sendJson(res, 200, { ok: true, port: PORT, startedAt });
      return;
    }
    const refresh = url.searchParams.get('refresh') === '1';
    const config = loadRoots();
    const backend = config.backend;
    const models = backend === 'dsh' ? listDshModels()
      : backend === 'codex' ? await listCodexModels(refresh)
        : backend === 'claude' ? listClaudeModels()
          : backend === 'agy' ? listAgyModels(refresh)
            : backend === 'opencode' ? listOpencodeModels()
              : listModels();
    const dsh = findDsh();
    const hermes = findHermes();
    const codex = findCodex();
    const claude = findClaude();
    const agy = findAgy();
    const opencode = findOpencode();
    const claudeState = claude ? claudeAuthState() : { error: '远端没有安装 Claude Code CLI' };
    const agyState = agy
      ? (backend === 'agy' && models.error ? { error: models.error } : agyAuthState())
      : { error: '远端没有安装 Gemini / Antigravity CLI' };
    const codexPrepared = backend === 'codex' && codex
      ? prepareCodexHome(config.roots[0] && config.roots[0].path, config.provider)
      : { error: codex ? '' : '远端没有找到 Codex CLI' };
    const authError = backend === 'dsh' ? (dsh ? (models.error || '') : '远端没有安装 DeepSeek Harness')
      : backend === 'codex' ? (codexPrepared.error || models.error || '')
        : backend === 'claude' ? (claudeState.error || '')
          : backend === 'agy' ? (agyState.error || models.error || '')
            : backend === 'opencode' ? (opencode ? '' : '远端没有安装 OpenCode CLI')
              : prepareAuth();
    const validProviders = Array.isArray(models.providers) ? models.providers : [];
    const chosenProviderObj = validProviders.find(p => p.id === config.provider) || validProviders.find(p => p.id === models.defaultProvider) || validProviders[0];
    const resolvedProvider = chosenProviderObj ? chosenProviderObj.id : (models.defaultProvider || '');
    const validModels = chosenProviderObj && Array.isArray(chosenProviderObj.models) ? chosenProviderObj.models : [];
    const resolvedModel = (config.model && validModels.includes(config.model))
      ? config.model
      : (models.defaultModel || validModels[0] || '');
    sendJson(res, 200, {
      ok: true,
      device: config.device,
      port: PORT,
      roots: config.roots,
      problems: config.problems,
      backend,
      backends: {
        dsh: Boolean(dsh),
        hermes: Boolean(hermes),
        codex: Boolean(codex),
        claude: Boolean(claude),
        agy: Boolean(agy),
        opencode: Boolean(opencode)
      },
      provider: resolvedProvider,
      model: resolvedModel,
      defaultProvider: models.defaultProvider,
      defaultModel: models.defaultModel,
      dsh: Boolean(dsh),
      hermes: Boolean(hermes),
      codex: Boolean(codex),
      claude: Boolean(claude),
      agy: Boolean(agy),
      opencode: Boolean(opencode),
      authError,
      codexAuthError: codexPrepared.error || '',
      claudeAuthError: claudeState.error || '',
      agyAuthError: agyState.error || '',
      bound: credentialStatus(),
      busy: Boolean(turn && turn.status === 'running'),
      turn: publicTurn(),
      startedAt
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/models') {
    const want = String(url.searchParams.get('backend') || '');
    const refresh = url.searchParams.get('refresh') === '1';
    const backend = want ? normalizeBackend(want) : loadRoots().backend;
    if (refresh) {
      codexModelsCache.at = 0;
      agyModelsCache.at = 0;
      claudeAuthCache.at = 0;
    }
    sendJson(res, 200, backend === 'dsh' ? listDshModels()
      : backend === 'codex' ? await listCodexModels(refresh)
        : backend === 'claude' ? listClaudeModels()
          : backend === 'agy' ? listAgyModels(refresh)
            : backend === 'opencode' ? listOpencodeModels()
              : listModels());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/workdirs') {
    const root = findRootByValue(url.searchParams.get('root'));
    if (!root) { sendJson(res, 404, { error: '没有找到该同步目录' }); return; }
    const listing = listWorkdirs(root, url.searchParams.get('path'));
    if (listing.error) { sendJson(res, 400, { error: listing.error }); return; }
    sendJson(res, 200, Object.assign({ ok: true, root: root.path, rootLabel: root.label }, listing));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/mkdir') {
    const body = await readBody(req, 64 * 1024);
    const root = findRootByValue(body.root);
    if (!root) { sendJson(res, 404, { error: '没有找到该同步目录' }); return; }
    const made = createWorkdir(root, body.path, body.name);
    if (made.error) { sendJson(res, 400, { error: made.error }); return; }
    log('workdir created ' + made.path + ' under ' + root.path);
    sendJson(res, 200, { ok: true, path: made.path });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    sendJson(res, 200, { ok: true, sessions: listSessionSummaries() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    const name = String(url.searchParams.get('name') || '');
    if (!historyFileFor(name)) { sendJson(res, 400, { error: '会话名无效' }); return; }
    const record = readSessionRecord(name);
    if (!record) { sendJson(res, 404, { error: '没有找到该会话记录' }); return; }
    sendJson(res, 200, { ok: true, session: record });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/session/rename') {
    const body = await readBody(req, 16 * 1024);
    const name = String(body.name || '');
    if (turn && turn.status === 'running' && turn.sessionName === name) {
      sendJson(res, 409, { error: '该对话正在执行，请先停止任务再改名。' });
      return;
    }
    const result = renameSessionRecord(name, body.title);
    if (result.error) { sendJson(res, 400, { error: result.error }); return; }
    log('session renamed ' + name + ' -> ' + result.title);
    sendJson(res, 200, { ok: true, sessionName: name, title: result.title });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/session/delete') {
    const body = await readBody(req, 16 * 1024);
    const name = String(body.name || '');
    if (turn && turn.status === 'running' && turn.sessionName === name) {
      sendJson(res, 409, { error: '该对话正在执行，请先停止任务再删除。' });
      return;
    }
    const result = deleteSessionRecord(name);
    if (result.error) { sendJson(res, 400, { error: result.error }); return; }
    log('session deleted ' + name);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/backend') {
    if (turn && turn.status === 'running') {
      sendJson(res, 409, { error: '上一轮还在运行，请先停止或等待完成。' });
      return;
    }
    const body = await readBody(req, 64 * 1024);
    const backend = normalizeBackend(body.backend);
    const rootPath = (loadRoots().roots[0] || {}).path;
    if (backend === 'dsh') {
      if (!findDsh()) {
        sendJson(res, 400, { error: '远端没有安装 DeepSeek Harness。' });
        return;
      }
    } else if (backend === 'codex') {
      if (!findCodex()) {
        sendJson(res, 400, { error: '远端没有安装 Codex CLI。' });
        return;
      }
      const prepared = prepareCodexHome(rootPath);
      if (prepared.error) { sendJson(res, 400, { error: prepared.error }); return; }
    } else if (backend === 'claude') {
      if (!findClaude()) {
        sendJson(res, 400, { error: '远端没有安装 Claude Code CLI。' });
        return;
      }
      const prepared = prepareClaudeMcp(rootPath);
      if (prepared.error) { sendJson(res, 400, { error: prepared.error }); return; }
    } else if (backend === 'agy') {
      if (!findAgy()) {
        sendJson(res, 400, { error: '远端没有安装 Gemini / Antigravity CLI。' });
        return;
      }
      const prepared = prepareAgyConfig(rootPath);
      if (prepared.error) { sendJson(res, 400, { error: prepared.error }); return; }
    } else if (backend === 'opencode') {
      if (!findOpencode()) {
        sendJson(res, 400, { error: '远端没有安装 OpenCode CLI。' });
        return;
      }
    }
    try {
      const data = readJson(ROOTS_FILE) || {};
      data.backend = backend;
      data.provider = '';
      data.model = '';
      writeJson(ROOTS_FILE, data);
    } catch (error) {
      sendJson(res, 500, { error: '写入后端设置失败: ' + error.message });
      return;
    }
    log('backend switched to ' + backend);
    sendJson(res, 200, {
      ok: true,
      backend,
      models: backend === 'dsh' ? listDshModels()
        : backend === 'codex' ? await listCodexModels(true)
          : backend === 'claude' ? listClaudeModels()
            : backend === 'agy' ? listAgyModels(true)
              : backend === 'opencode' ? listOpencodeModels()
                : listModels()
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 1500\n\n');
    // 先发一份当前快照，再接收增量。页面重连/刷新时不用重放全部事件，
    // 尚未完成的回合也能直接恢复到最新状态。
    res.write('data: ' + JSON.stringify({
      seq: eventSeq,
      type: 'state',
      turn: turn ? publicTurn() : null,
      turnId: turn ? turn.id : ''
    }) + '\n\n');
    sseClients.add(res);
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { } }, 15000);
    heartbeat.unref();
    req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/file') {
    const file = resolveInsideRoots(url.searchParams.get('path'))
      || resolveInsideUploads(url.searchParams.get('path'));
    if (!file) { sendJson(res, 404, { error: '文件不存在或不在允许目录内' }); return; }
    let stat;
    try { stat = fs.statSync(file); } catch { sendJson(res, 404, { error: '文件不可读' }); return; }
    const ext = path.extname(file).toLowerCase();
    if (url.searchParams.get('raw') === '1' || RAW_TEXT_EXTENSIONS.has(ext)) {
      sendRawPreview(res, file, ext);
      return;
    }
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'private, max-age=30',
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(file).on('error', () => { try { res.destroy(); } catch { } }).pipe(res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const body = await readBody(req, 1024 * 1024);
    // "打断并插入": stop the running turn (keeping its partial answer) so the
    // new message can continue in the same session.
    if (body.interrupt && turn && turn.status === 'running') {
      const prompt = String(body.prompt || '').trim();
      if (!prompt) { sendJson(res, 400, { error: '请输入内容。' }); return; }
      if (prompt.length > MAX_PROMPT) {
        sendJson(res, 400, { error: `内容过长（最多 ${MAX_PROMPT} 字）。` });
        return;
      }
      await interruptTurn();
    }
    const result = startTurn(body);
    if (result.code !== 200) { sendJson(res, result.code, { error: result.error }); return; }
    sendJson(res, 200, { ok: true, turn: publicTurn() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/run') {
    const body = await readBody(req, 1024 * 1024);
    const result = startTurn(body);
    if (result.code !== 200) { sendJson(res, result.code, { error: result.error }); return; }
    sendJson(res, 200, { ok: true, turn: publicTurn(), job: publicTurn() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/job') {
    sendJson(res, 200, { ok: true, job: publicTurn(), turn: publicTurn() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/cancel') {
    sendJson(res, 200, Object.assign({ ok: true }, cancelTurn()));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/upload') {
    const body = await readBody(req, MAX_BODY);
    const saved = saveUpload(body);
    sendJson(res, 200, Object.assign({ ok: true }, saved));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/shutdown') {
    sendJson(res, 200, { ok: true });
    setTimeout(() => { try { server.close(); } catch { } process.exit(0); }, 120);
    return;
  }

  sendJson(res, 404, { error: '未知接口' });
}

function main() {
  const argPort = process.argv.indexOf('--port');
  if (argPort > -1) { PORT = Number(process.argv[argPort + 1]) || BASE_PORT; }

  // Stale state from a previous instance must not be mistaken for a live server.
  try { fs.rmSync(SERVER_FILE, { force: true }); } catch { }
  cleanupUploads();
  cleanupTurns();
  cleanupHistory();
  writeAgentConfig();

  TOKEN = crypto.randomBytes(24).toString('hex');
  const writeServer = port => {
    writeJson(SERVER_FILE, {
      pid: process.pid,
      port,
      token: TOKEN,
      startedAt: new Date().toISOString()
    });
  };

  const listen = (port, triesLeft) => {
    server = http.createServer((req, res) => {
      handle(req, res).catch(error => {
        try { sendJson(res, 500, { error: String((error && error.message) || error) }); } catch { }
      });
    });
    server.once('error', error => {
      if (error && error.code === 'EADDRINUSE' && triesLeft > 0) {
        log('port ' + port + ' in use, trying ' + (port + 1));
        try { server.close(); } catch { }
        listen(port + 1, triesLeft - 1);
        return;
      }
      log('listen failed: ' + error.message);
      process.exit(1);
    });
    server.listen(port, HOST, () => {
      PORT = port;
      writeServer(port);
      log('listening on ' + HOST + ':' + port);
      console.log('SMAC_AGENT_LISTENING ' + port);
    });
  };
  listen(PORT, 8);

  const shutdown = () => {
    try {
      if (turn && turn.status === 'running') {
        turn.status = 'interrupted';
        turn.note = '远端 Agent 服务已停止。';
        turn.endedAt = new Date().toISOString();
        turn.durationMs = Date.parse(turn.endedAt) - Date.parse(turn.startedAt);
        finishHistoryTurn(turn);
      }
    } catch { }
    try { if (runningChild) { killTree(runningChild); } } catch { }
    try { fs.rmSync(SERVER_FILE, { force: true }); } catch { }
    try { server.close(); } catch { }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => { try { fs.rmSync(SERVER_FILE, { force: true }); } catch { } });
}

main();
