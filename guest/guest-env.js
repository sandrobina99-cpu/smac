'use strict';

// smac 客机端环境探测器（CLI 环境 + Desktop 桌面端环境 + 本机网络与账户信息）
// 零第三方依赖，可直接在客机安装时执行（node guest-env.js --json），
// 也可被 agent-server.js 直接 require('./guest-env') 调用。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function safeStat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function isFile(file) {
  const st = safeStat(file);
  return Boolean(st && st.isFile());
}

function isDir(dir) {
  const st = safeStat(dir);
  return Boolean(st && st.isDirectory());
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function whichSync(cmd) {
  if (!cmd) return '';
  if (IS_WIN) {
    const res = spawnSync('where.exe', [cmd], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (res.status === 0 && res.stdout) {
      const first = res.stdout.split(/\r?\n/).map(s => s.trim()).find(s => s && isFile(s));
      if (first) return first;
    }
    return '';
  }
  const extraPath = '/opt/homebrew/bin:/usr/local/bin:$HOME/.gemini/bin:$HOME/.local/bin:$HOME/.hermes/node/bin:$PATH';
  const res = spawnSync('sh', ['-c', 'export PATH="' + extraPath + '"; command -v ' + cmd + ' 2>/dev/null'], { encoding: 'utf8', timeout: 5000 });
  if (res.status === 0 && res.stdout) {
    const first = res.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (first && isFile(first)) return first;
  }
  return '';
}

function maskAccountEmail(value) {
  const text = String(value || '').trim();
  const at = text.indexOf('@');
  if (at > 2) return text.slice(0, 2) + '***' + text.slice(at);
  return text;
}

function detectAntigravityAuth(home) {
  let desktopLoggedIn = false;
  let accountHint = '';
  const storageCandidates = IS_WIN
    ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Antigravity', 'app_storage.json')]
    : (IS_MAC
      ? [path.join(home, 'Library', 'Application Support', 'Antigravity', 'app_storage.json')]
      : [path.join(home, '.config', 'Antigravity', 'app_storage.json')]);
  for (const file of storageCandidates) {
    const data = readJsonSafe(file);
    if (data && typeof data === 'object') {
      const user = String(data['agy.onboarding.lastLoginUsername'] || '').trim();
      if (user) {
        desktopLoggedIn = true;
        accountHint = maskAccountEmail(user);
        break;
      }
    }
  }
  if (!desktopLoggedIn && isFile(path.join(home, '.gemini', 'antigravity', 'antigravity_state.pbtxt'))) {
    desktopLoggedIn = true;
  }
  const cliHasAuth = isFile(path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'))
    || isFile(path.join(home, '.gemini', 'oauth_creds.json'))
    || isFile(path.join(home, '.gemini', 'google_accounts.json'));
  if (!accountHint && isFile(path.join(home, '.gemini', 'google_accounts.json'))) {
    const ga = readJsonSafe(path.join(home, '.gemini', 'google_accounts.json'));
    const active = ga && (ga.active || (Array.isArray(ga.old) && ga.old[0]));
    if (typeof active === 'string' && active.trim()) {
      accountHint = maskAccountEmail(active);
    }
  }
  return {
    desktopLoggedIn,
    cliHasAuth,
    authenticated: desktopLoggedIn || cliHasAuth,
    accountHint
  };
}

function findFileRecursive(rootDir, fileName, maxDepth = 4) {
  if (!isDir(rootDir)) return '';
  const target = IS_WIN ? fileName.toLowerCase() : fileName;
  const walk = (dir, depth) => {
    if (depth > maxDepth) return '';
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
    for (const entry of entries) {
      const name = IS_WIN ? entry.name.toLowerCase() : entry.name;
      if (entry.isFile() && name === target) {
        return path.join(dir, entry.name);
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const found = walk(path.join(dir, entry.name), depth + 1);
        if (found) return found;
      }
    }
    return '';
  };
  return walk(rootDir, 0);
}

function detectNetworkAndMachine() {
  const home = os.homedir();
  const interfaces = os.networkInterfaces() || {};
  const lanIps = [];
  const tailscaleIps = [];
  const zerotierIps = [];
  const meshIps = [];
  const publicIps = [];

  for (const [ifName, list] of Object.entries(interfaces)) {
    const isZtIf = /zerotier|\bzt|\bfeth\d/i.test(String(ifName || ''));
    const isMeshIf = isZtIf || /tailscale|wireguard|\bwg\d/i.test(String(ifName || ''));
    for (const item of (list || [])) {
      if (!item || item.internal || item.family !== 'IPv4') continue;
      const ip = String(item.address || '').trim();
      if (!ip || ip.startsWith('169.254.')) continue;
      const parts = ip.split('.').map(Number);
      // Skip Clash / Mihomo fake-IP TUN range (198.18.0.0/15)
      if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) continue;
      const isTailscale = parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
      const isPrivate = (parts[0] === 192 && parts[1] === 168)
        || parts[0] === 10
        || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
      if (isTailscale) {
        if (!tailscaleIps.includes(ip)) tailscaleIps.push(ip);
        if (!meshIps.includes(ip)) meshIps.push(ip);
      } else if (isZtIf) {
        if (!zerotierIps.includes(ip)) zerotierIps.push(ip);
        if (!meshIps.includes(ip)) meshIps.push(ip);
      } else if (isMeshIf) {
        if (!meshIps.includes(ip)) meshIps.push(ip);
      } else if (isPrivate) {
        if (!lanIps.includes(ip)) lanIps.push(ip);
      } else {
        if (!publicIps.includes(ip)) publicIps.push(ip);
      }
    }
  }

  // 优先排序真实局域网 IP（192.168.x.x 且非 .1 虚拟网关地址优先）
  lanIps.sort((a, b) => {
    const score = ip => {
      let s = 0;
      if (ip.startsWith('192.168.')) s += 20;
      else if (ip.startsWith('10.')) s += 10;
      else if (ip.startsWith('172.')) s += 15;
      if (!ip.endsWith('.1')) s += 5;
      return s;
    };
    return score(b) - score(a);
  });

  let sshPort = 22;
  const sshdConfig = IS_WIN
    ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'ssh', 'sshd_config')
    : '/etc/ssh/sshd_config';
  try {
    if (isFile(sshdConfig)) {
      const lines = fs.readFileSync(sshdConfig, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const m = line.match(/^\s*Port\s+(\d+)/i);
        if (m) { sshPort = Number(m[1]) || 22; break; }
      }
    }
  } catch { }

  let user = '';
  try { user = os.userInfo().username; } catch { }
  if (!user) user = process.env.USERNAME || process.env.USER || '';

  const primaryIp = lanIps[0] || meshIps[0] || publicIps[0] || '';
  const fallbackIp = (meshIps[0] && meshIps[0] !== primaryIp)
    ? meshIps[0]
    : ((publicIps[0] && publicIps[0] !== primaryIp) ? publicIps[0] : (lanIps[1] || ''));

  return {
    hostname: os.hostname(),
    platform: IS_WIN ? 'windows' : (IS_MAC ? 'macos' : 'linux'),
    osLabel: IS_WIN ? 'Windows' : (IS_MAC ? 'macOS' : 'Linux'),
    arch: os.arch(),
    user,
    home,
    desktopDir: path.join(home, 'Desktop'),
    documentsDir: path.join(home, 'Documents'),
    lanIps,
    tailscaleIps,
    zerotierIps,
    meshIps,
    publicIps,
    primaryIp,
    fallbackIp,
    sshPort
  };
}

function detectCliEnvironments() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const agentTools = path.join(home, '.smac-agent', 'tools');

  // 1. Hermes Agent
  const hermesCandidates = IS_WIN
    ? [
        path.join(localAppData, 'hermes', 'bin', 'hermes.exe'),
        path.join(localAppData, 'hermes', 'hermes.exe'),
        path.join(home, '.hermes', 'bin', 'hermes.exe')
      ]
    : [
        path.join(home, '.hermes', 'bin', 'hermes'),
        path.join(home, '.local', 'bin', 'hermes'),
        '/usr/local/bin/hermes'
      ];
  let hermesPath = hermesCandidates.find(isFile) || whichSync(IS_WIN ? 'hermes.exe' : 'hermes');
  const hermesHome = IS_WIN ? path.join(localAppData, 'hermes') : path.join(home, '.hermes');
  const hermesAuth = readJsonSafe(path.join(hermesHome, 'auth.json'));
  const hermesProvider = hermesAuth && hermesAuth.active_provider ? String(hermesAuth.active_provider) : '';

  // 2. Codex CLI
  let codexPath = whichSync(IS_WIN ? 'codex.exe' : 'codex');
  if (!codexPath) {
    codexPath = IS_WIN
      ? findFileRecursive(path.join(agentTools, 'node_modules'), 'codex.exe', 5)
      : (isFile(path.join(agentTools, 'node_modules', '.bin', 'codex')) ? path.join(agentTools, 'node_modules', '.bin', 'codex') : '');
  }
  const codexAuth = isFile(path.join(home, '.codex', 'auth.json')) || Boolean(hermesAuth);

  // 3. Claude Code CLI
  const claudeCandidates = IS_WIN
    ? [
        path.join(agentTools, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
        path.join(home, '.local', 'bin', 'claude.exe')
      ]
    : [
        path.join(agentTools, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
        path.join(home, '.local', 'bin', 'claude'),
        '/usr/local/bin/claude'
      ];
  const claudePath = claudeCandidates.find(isFile) || whichSync(IS_WIN ? 'claude.exe' : 'claude');

  // 4. Gemini / Antigravity CLI（优先检查与桌面端同源的官方路径）
  const agyDir = path.join(agentTools, 'antigravity');
  const agyCandidates = IS_WIN
    ? [
        path.join(home, '.gemini', 'bin', 'agy.exe'),
        path.join(localAppData, 'agy', 'bin', 'agy.exe'),
        path.join(home, '.local', 'bin', 'agy.exe'),
        path.join(agyDir, 'agy.exe'),
        path.join(agyDir, 'bin', 'agy.exe')
      ]
    : [
        path.join(home, '.gemini', 'bin', 'agy'),
        path.join(home, '.local', 'bin', 'agy'),
        '/opt/homebrew/bin/agy',
        '/usr/local/bin/agy',
        path.join(agyDir, 'agy'),
        path.join(agyDir, 'bin', 'agy')
      ];
  let agyPath = agyCandidates.find(isFile) || whichSync(IS_WIN ? 'agy.exe' : 'agy');
  if (!agyPath && IS_WIN) {
    agyPath = findFileRecursive(agyDir, 'agy.exe', 3);
  }
  const agyAuth = detectAntigravityAuth(home);

  // 5. OpenCode CLI
  const opencodeCandidates = IS_WIN
    ? [
        path.join(localAppData, 'OpenCode', 'opencode-cli.exe'),
        path.join(localAppData, 'Programs', '@opencode-aidesktop', 'opencode-cli.exe'),
        path.join(home, '.opencode', 'bin', 'opencode.exe')
      ]
    : [
        path.join(home, '.opencode', 'bin', 'opencode'),
        path.join(home, '.local', 'bin', 'opencode'),
        '/usr/local/bin/opencode'
      ];
  const opencodePath = opencodeCandidates.find(isFile) || whichSync(IS_WIN ? 'opencode-cli.exe' : 'opencode') || whichSync(IS_WIN ? 'opencode.exe' : 'opencode');

  // 6. DeepSeek Harness (dsh 内置无头 CLI，复用桌面端登录与订阅)
  const dshCandidates = IS_WIN
    ? candidateRootsWindows().map(r => path.join(r, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))
    : [
        '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
        path.join(home, 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'),
        '/usr/local/bin/dsh'
      ];
  const dshPath = dshCandidates.find(isFile) || whichSync(IS_WIN ? 'dsh.cmd' : 'dsh');
  const dshCredFile = path.join(home, '.dsh', '.credentials.yaml');
  let dshHasAuth = false;
  try {
    if (isFile(dshCredFile)) {
      const credText = fs.readFileSync(dshCredFile, 'utf8');
      dshHasAuth = /deepseek-account-platform\/default|API_KEY/i.test(credText);
    }
  } catch { }

  return [
    {
      id: 'dsh',
      name: 'DeepSeek Harness',
      vendor: 'DeepSeek',
      installed: Boolean(dshPath),
      autoInstall: false,
      ready: Boolean(dshPath),
      authenticated: dshHasAuth,
      provider: dshHasAuth ? 'deepseek-account' : '',
      path: dshPath || '',
      badge: dshPath ? (dshHasAuth ? '已安装 · 已登录订阅' : '已安装') : '未安装',
      description: dshPath
        ? '后台静默调用 DeepSeek Harness 内置 dsh 引擎，直接复用客机桌面端账号与模型配置，零弹窗不打扰客机'
        : '客机未检测到 DeepSeek Harness'
    },
    {
      id: 'hermes',
      name: 'Hermes Agent',
      vendor: 'Nous Research',
      installed: Boolean(hermesPath),
      autoInstall: false,
      ready: Boolean(hermesPath),
      authenticated: Boolean(hermesProvider),
      provider: hermesProvider,
      path: hermesPath || '',
      badge: hermesPath ? (hermesProvider ? '已安装 · 已登录' : '已安装') : '未安装',
      description: hermesPath
        ? ('使用客机 Hermes CLI' + (hermesProvider ? '（当前登录: ' + hermesProvider + '）' : ''))
        : '客机尚未安装 Hermes Agent'
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      vendor: 'OpenAI',
      installed: Boolean(codexPath),
      autoInstall: true,
      ready: true,
      authenticated: codexAuth,
      path: codexPath || '',
      badge: codexPath ? '已安装' : '可自动安装',
      description: codexPath
        ? '已就绪，复用客机 ChatGPT / Hermes 登录状态'
        : '首次选择时自动安装至 .smac-agent/tools 并复用登录'
    },
    {
      id: 'claude',
      name: 'Claude Code',
      vendor: 'Anthropic',
      installed: Boolean(claudePath),
      autoInstall: true,
      ready: true,
      path: claudePath || '',
      badge: claudePath ? '已安装' : '可自动安装',
      description: claudePath
        ? '已安装 Claude Code，支持复用客机登录或访问密钥绑定'
        : '首次选择自动通过 npm 安装，支持访问密钥直接绑定'
    },
    {
      id: 'agy',
      name: 'Gemini · Antigravity',
      vendor: 'Google DeepMind',
      installed: Boolean(agyPath),
      autoInstall: true,
      ready: true,
      authenticated: agyAuth.authenticated,
      desktopLoggedIn: agyAuth.desktopLoggedIn,
      accountHint: agyAuth.accountHint,
      path: agyPath || '',
      badge: agyPath
        ? (agyAuth.desktopLoggedIn ? '已安装 · 同步桌面端订阅' : (agyAuth.authenticated ? '已安装 · 已登录订阅' : '已安装'))
        : (agyAuth.desktopLoggedIn ? '复用桌面端订阅 · 自动装CLI' : '可自动安装'),
      description: agyPath
        ? (agyAuth.desktopLoggedIn
          ? ('已安装 Antigravity CLI，自动同步桌面端订阅' + (agyAuth.accountHint ? '（' + agyAuth.accountHint + '）' : '') + '，零弹窗静默运行')
          : '已安装 Antigravity CLI，支持客机登录或 GEMINI_API_KEY')
        : (agyAuth.desktopLoggedIn
          ? ('检测到桌面端已登录订阅' + (agyAuth.accountHint ? '（' + agyAuth.accountHint + '）' : '') + '，切换或刷新模型时将自动安装 CLI 并同步订阅')
          : '首次选择自动安装 Antigravity CLI，支持复用桌面端订阅或密钥绑定')
    },
    {
      id: 'opencode',
      name: 'OpenCode CLI',
      vendor: 'OpenCode',
      installed: Boolean(opencodePath),
      autoInstall: false,
      ready: Boolean(opencodePath),
      path: opencodePath || '',
      badge: opencodePath ? '已安装' : '未安装',
      description: opencodePath
        ? '已检测到客机 OpenCode CLI (' + path.basename(opencodePath) + ')'
        : '客机未检测到 OpenCode CLI'
    }
  ];
}

function collectWindowsShortcutsAndAppx() {
  if (!IS_WIN) return { shortcuts: [], appx: [] };
  const script = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$ErrorActionPreference = "SilentlyContinue"',
    '$sh = New-Object -ComObject WScript.Shell',
    '$dirs = @("$env:USERPROFILE\\Desktop", "$env:PUBLIC\\Desktop", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs", "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs")',
    '$lnks = @()',
    'foreach ($d in $dirs) {',
    '  if (Test-Path -LiteralPath $d) {',
    '    Get-ChildItem -LiteralPath $d -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {',
    '      try {',
    '        $s = $sh.CreateShortcut($_.FullName)',
    '        if ($s.TargetPath) { $lnks += @{ name = $_.BaseName; target = $s.TargetPath; args = [string]$s.Arguments; dir = [string]$s.WorkingDirectory } }',
    '      } catch { }',
    '    }',
    '  }',
    '}',
    '$appx = @()',
    'Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "Claude|Codex|OpenAI|DeepSeek|Antigravity|Cursor" } | ForEach-Object {',
    '  $appx += @{ name = $_.Name; loc = $_.InstallLocation; fam = $_.PackageFamilyName }',
    '}',
    '(@{ shortcuts = $lnks; appx = $appx } | ConvertTo-Json -Depth 4 -Compress)'
  ].join('\n');

  try {
    const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      timeout: 12000,
      windowsHide: true
    });
    if (res.status === 0 && res.stdout) {
      const line = res.stdout.trim().split(/\r?\n/).pop();
      const parsed = JSON.parse(line);
      return {
        shortcuts: Array.isArray(parsed.shortcuts) ? parsed.shortcuts : [],
        appx: Array.isArray(parsed.appx) ? parsed.appx : []
      };
    }
  } catch { }
  return { shortcuts: [], appx: [] };
}

function candidateRootsWindows() {
  const home = os.homedir();
  const userName = path.basename(home);
  const roots = [];
  const add = p => { if (p && !roots.includes(p)) roots.push(p); };
  add(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'));
  add(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'));
  add(process.env.ProgramFiles || 'C:\\Program Files');
  add(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)');
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    add(path.join(drive, 'Users', userName, 'AppData', 'Local'));
    add(path.join(drive, 'Program Files'));
  }
  return roots;
}

function detectDesktopEnvironments() {
  const home = os.homedir();
  const winMeta = collectWindowsShortcutsAndAppx();
  const roots = IS_WIN ? candidateRootsWindows() : [];

  function findWinExe(relPaths, shortcutRegex, appxFilter) {
    // 1. Direct relative paths under candidate roots
    for (const root of roots) {
      for (const rel of relPaths) {
        const full = path.join(root, rel);
        if (isFile(full)) return full;
      }
    }
    // 2. AppxPackage install location
    if (appxFilter) {
      for (const pkg of winMeta.appx) {
        if (appxFilter.test(String(pkg.name || '')) && pkg.loc) {
          for (const sub of ['app\\Codex.exe', 'Codex.exe', 'app\\Claude.exe', 'Claude.exe', 'app\\ChatGPT.exe']) {
            const candidate = path.join(pkg.loc, sub);
            if (isFile(candidate)) return candidate;
          }
        }
      }
    }
    // 3. Desktop & Start Menu shortcuts
    if (shortcutRegex) {
      for (const s of winMeta.shortcuts) {
        const label = String(s.name || '') + ' ' + String(s.target || '');
        if (shortcutRegex.test(label) && s.target && isFile(s.target) && /\.exe$/i.test(s.target)) {
          return s.target;
        }
      }
    }
    return '';
  }

  function findMacApp(appNames) {
    for (const appName of appNames) {
      for (const base of ['/Applications', path.join(home, 'Applications')]) {
        const appDir = path.join(base, appName + '.app', 'Contents', 'MacOS');
        if (isDir(appDir)) {
          const bin = path.join(appDir, appName);
          if (isFile(bin)) return bin;
          try {
            const first = fs.readdirSync(appDir).map(n => path.join(appDir, n)).find(isFile);
            if (first) return first;
          } catch { }
        }
      }
    }
    return '';
  }

  const catalog = [
    {
      id: 'deepseek-harness',
      name: 'DeepSeek Harness',
      vendor: 'DeepSeek',
      kind: 'electron',
      supportsCdp: true,
      supportsFolderArg: false,
      description: 'DeepSeek 官方桌面端 Harness，支持工作区目录绑定与远程交互',
      winRel: [
        'Programs\\DeepSeek Harness\\DeepSeek Harness.exe',
        'DeepSeek Harness\\DeepSeek Harness.exe'
      ],
      shortcutRe: /deepseek\s*harness/i,
      macApps: ['DeepSeek Harness']
    },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      vendor: 'Anthropic',
      kind: 'electron',
      supportsCdp: true,
      supportsFolderArg: false,
      description: 'Anthropic Claude 桌面端（支持 MCP 与本地文件工作区）',
      winRel: [
        'AnthropicClaude\\claude.exe',
        'Programs\\Claude\\Claude.exe',
        'Programs\\claude-desktop\\Claude.exe',
        'Claude\\Claude.exe'
      ],
      shortcutRe: /\bclaude\b/i,
      appxRe: /claude/i,
      macApps: ['Claude']
    },
    {
      id: 'codex-desktop',
      name: 'Codex Desktop',
      vendor: 'OpenAI',
      kind: 'chromium',
      supportsCdp: true,
      supportsFolderArg: true,
      description: 'OpenAI Codex 桌面端，支持代码库加载与智能体任务',
      winRel: [
        'Programs\\Codex\\Codex.exe',
        'Codex\\Codex.exe',
        'Programs\\OpenAI Codex\\Codex.exe'
      ],
      shortcutRe: /\bcodex\b/i,
      appxRe: /OpenAI\.Codex|Codex/i,
      macApps: ['Codex']
    },
    {
      id: 'antigravity-desktop',
      name: 'Antigravity Desktop',
      vendor: 'Google DeepMind',
      kind: 'electron',
      supportsCdp: true,
      supportsFolderArg: true,
      description: 'Google Antigravity 桌面端 IDE，可直接打开客机同步文件夹',
      winRel: [
        'Programs\\antigravity\\Antigravity.exe',
        'Antigravity\\Antigravity.exe'
      ],
      shortcutRe: /\bantigravity\.exe|\bantigravity$/i,
      appxRe: /antigravity/i,
      macApps: ['Antigravity']
    },
    {
      id: 'hermes-desktop',
      name: 'Hermes Desktop',
      vendor: 'Nous Research',
      kind: 'electron',
      supportsCdp: true,
      supportsFolderArg: false,
      description: 'Hermes Agent 桌面图形客户端，支持多模型工作区操作',
      winRel: [
        'hermes\\hermes-agent\\apps\\desktop\\release\\win-unpacked\\Hermes.exe',
        'Programs\\Hermes\\Hermes.exe',
        'Hermes\\Hermes.exe'
      ],
      shortcutRe: /\bhermes\b/i,
      macApps: ['Hermes']
    },
    {
      id: 'opencode-desktop',
      name: 'OpenCode Desktop',
      vendor: 'OpenCode',
      kind: 'webview2',
      supportsCdp: true,
      supportsFolderArg: true,
      description: 'OpenCode 桌面客户端，直接操作客机工程代码与文件',
      winRel: [
        'OpenCode\\OpenCode.exe',
        'Programs\\@opencode-aidesktop\\OpenCode.exe',
        'Programs\\OpenCode\\OpenCode.exe'
      ],
      shortcutRe: /\bopencode\b/i,
      macApps: ['OpenCode']
    },
    {
      id: 'cursor-desktop',
      name: 'Cursor Desktop',
      vendor: 'Anysphere',
      kind: 'electron',
      supportsCdp: true,
      supportsFolderArg: true,
      description: 'Cursor AI 代码编辑器桌面端，支持直接打开客机同步工作区',
      winRel: [
        'Programs\\cursor\\Cursor.exe',
        'cursor\\Cursor.exe'
      ],
      shortcutRe: /\bcursor\b/i,
      macApps: ['Cursor']
    },
    {
      id: 'lm-studio',
      name: 'LM Studio',
      vendor: 'LM Studio',
      kind: 'electron',
      supportsCdp: true,
      supportsFolderArg: false,
      description: 'LM Studio 本地大模型桌面工作台',
      winRel: [
        'Programs\\LM Studio\\LM Studio.exe',
        'LM Studio\\LM Studio.exe'
      ],
      shortcutRe: /lm\s*studio/i,
      macApps: ['LM Studio']
    }
  ];

  const agyAuth = detectAntigravityAuth(home);
  const dshCredFile = path.join(home, '.dsh', '.credentials.yaml');
  let dshHasAuth = false;
  try {
    if (isFile(dshCredFile)) {
      dshHasAuth = /deepseek-account-platform\/default|API_KEY/i.test(fs.readFileSync(dshCredFile, 'utf8'));
    }
  } catch { }

  return catalog.map(item => {
    let exePath = '';
    if (IS_WIN) {
      exePath = findWinExe(item.winRel || [], item.shortcutRe, item.appxRe);
    } else if (IS_MAC) {
      exePath = findMacApp(item.macApps || [item.name]);
    } else {
      exePath = whichSync(item.id) || whichSync(item.name.toLowerCase().replace(/\s+/g, '-'));
    }
    let authenticated = false;
    let accountHint = '';
    let badge = exePath ? '已安装' : '未检测到';
    if (item.id === 'antigravity-desktop' && exePath) {
      authenticated = agyAuth.desktopLoggedIn;
      accountHint = agyAuth.accountHint;
      badge = agyAuth.desktopLoggedIn ? '已安装 · 已登录订阅（同步CLI）' : '已安装';
    } else if (item.id === 'deepseek-harness' && exePath) {
      authenticated = dshHasAuth;
      badge = dshHasAuth ? '已安装 · 已登录订阅' : '已安装';
    }
    return {
      id: item.id,
      name: item.name,
      vendor: item.vendor,
      kind: item.kind,
      supportsCdp: Boolean(item.supportsCdp),
      supportsFolderArg: Boolean(item.supportsFolderArg),
      installed: Boolean(exePath),
      authenticated,
      accountHint,
      path: exePath || '',
      badge,
      description: item.description
    };
  });
}

function detectAll() {
  const machine = detectNetworkAndMachine();
  const cli = detectCliEnvironments();
  const desktop = detectDesktopEnvironments();
  return {
    ok: true,
    detectedAt: new Date().toISOString(),
    machine,
    cli,
    desktop
  };
}

if (require.main === module) {
  const result = detectAll();
  if (process.argv.includes('--pretty')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write('SMAC_GUEST_ENV ' + JSON.stringify(result) + '\n');
  }
}

module.exports = {
  detectAll,
  detectNetworkAndMachine,
  detectCliEnvironments,
  detectDesktopEnvironments
};
