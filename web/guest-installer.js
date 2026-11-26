'use strict';

// Remote Guest CLI & Desktop one-click installer for smac.
// Installs selected CLI tools and Desktop apps on a connected SSH Guest
// using each tool's official default installation directory, then re-probes
// the Guest with guest-env.js to verify installation and report per-item results.

const path = require('path');
const { spawn } = require('child_process');
const agent = require('./agent-manager');

const BRIDGE = path.join(__dirname, 'ssh-bridge.js');

const CLI_CATALOG = [
  {
    id: 'codex',
    kind: 'cli',
    name: 'Codex CLI',
    vendor: 'OpenAI',
    methodWin: 'npm install -g @openai/codex',
    methodPosix: 'npm install -g @openai/codex',
    description: 'OpenAI 官方命令行 Agent（默认全局目录）'
  },
  {
    id: 'claude',
    kind: 'cli',
    name: 'Claude Code CLI',
    vendor: 'Anthropic',
    methodWin: 'npm install -g @anthropic-ai/claude-code',
    methodPosix: 'npm install -g @anthropic-ai/claude-code',
    description: 'Anthropic 官方 Claude Code CLI（默认全局目录）'
  },
  {
    id: 'agy',
    kind: 'cli',
    name: 'Gemini · Antigravity CLI',
    vendor: 'Google DeepMind',
    methodWin: 'antigravity.google/cli/install.ps1',
    methodPosix: 'antigravity.google/cli/install.sh',
    description: 'Google Antigravity 官方 CLI（默认安装目录）'
  },
  {
    id: 'opencode',
    kind: 'cli',
    name: 'OpenCode CLI',
    vendor: 'OpenCode',
    methodWin: 'npm install -g opencode-ai',
    methodPosix: 'opencode.ai/install 或 npm -g',
    description: 'OpenCode 开源终端编程 Agent（默认全局目录）'
  },
  {
    id: 'hermes',
    kind: 'cli',
    name: 'Hermes Agent CLI',
    vendor: 'Nous Research',
    methodWin: 'Hermes 官方安装脚本（默认 %LOCALAPPDATA%\\hermes）',
    methodPosix: 'Hermes 官方安装脚本（默认 ~/.hermes）',
    description: 'Hermes 多模型命令行 Agent'
  },
  {
    id: 'dsh',
    kind: 'cli',
    name: 'DeepSeek Harness CLI',
    vendor: 'DeepSeek',
    methodWin: '随 DeepSeek Harness 安装 / npm',
    methodPosix: '随 DeepSeek Harness 安装 / npm',
    description: 'DeepSeek Harness 命令行引擎（自动复用桌面端订阅）'
  },
  {
    id: 'workbuddy',
    kind: 'cli',
    name: 'WorkBuddy · CodeBuddy CLI',
    vendor: 'Tencent',
    methodWin: 'npm install -g @tencent-ai/codebuddy-code',
    methodPosix: 'npm install -g @tencent-ai/codebuddy-code',
    description: '腾讯 WorkBuddy / CodeBuddy 官方命令行 Agent（已装桌面端则自动复用内置引擎）'
  },
  {
    id: 'qoder',
    kind: 'cli',
    name: 'Qoder CLI（国内版 CN / 国际版）',
    vendor: 'Alibaba / Qoder',
    methodWin: 'qoder.com.cn/install 或 qoder.com/install',
    methodPosix: 'curl -fsSL https://qoder.com.cn/install | bash',
    description: 'Qoder 官方 CLI（已装 Qoder 桌面端则自动复用内置无头引擎）'
  }
];

const DESKTOP_CATALOG = [
  {
    id: 'claude-desktop',
    kind: 'desktop',
    name: 'Claude Desktop',
    vendor: 'Anthropic',
    methodWin: 'winget Anthropic.Claude',
    methodPosix: 'brew install --cask claude',
    description: 'Anthropic 官方 Claude 桌面客户端'
  },
  {
    id: 'codex-desktop',
    kind: 'desktop',
    name: 'Codex Desktop',
    vendor: 'OpenAI',
    methodWin: 'winget OpenAI.Codex / OpenAI.ChatGPT',
    methodPosix: 'brew install --cask codex',
    description: 'OpenAI Codex / ChatGPT 桌面端'
  },
  {
    id: 'antigravity-desktop',
    kind: 'desktop',
    name: 'Antigravity Desktop',
    vendor: 'Google DeepMind',
    methodWin: 'winget Google.Antigravity',
    methodPosix: 'brew install --cask antigravity',
    description: 'Google Antigravity 桌面端 IDE'
  },
  {
    id: 'cursor-desktop',
    kind: 'desktop',
    name: 'Cursor Desktop',
    vendor: 'Anysphere',
    methodWin: 'winget Anysphere.Cursor',
    methodPosix: 'brew install --cask cursor',
    description: 'Cursor AI 代码编辑器桌面端'
  },
  {
    id: 'lm-studio',
    kind: 'desktop',
    name: 'LM Studio',
    vendor: 'LM Studio',
    methodWin: 'winget ElementLabs.LMStudio',
    methodPosix: 'brew install --cask lm-studio',
    description: 'LM Studio 本地大模型桌面工作台'
  },
  {
    id: 'opencode-desktop',
    kind: 'desktop',
    name: 'OpenCode Desktop',
    vendor: 'OpenCode',
    methodWin: 'winget OpenCode Desktop',
    methodPosix: 'brew install --cask opencode-desktop',
    description: 'OpenCode 桌面客户端'
  },
  {
    id: 'deepseek-harness',
    kind: 'desktop',
    name: 'DeepSeek Harness',
    vendor: 'DeepSeek',
    methodWin: 'winget DeepSeek Harness',
    methodPosix: 'brew install --cask deepseek-harness',
    description: 'DeepSeek 官方桌面端 Harness'
  },
  {
    id: 'hermes-desktop',
    kind: 'desktop',
    name: 'Hermes Desktop',
    vendor: 'Nous Research',
    methodWin: 'winget Hermes Desktop',
    methodPosix: 'brew install --cask hermes',
    description: 'Hermes Agent 桌面客户端'
  }
];

function getCatalog() {
  return {
    cli: CLI_CATALOG.map(x => Object.assign({}, x)),
    desktop: DESKTOP_CATALOG.map(x => Object.assign({}, x))
  };
}

function findCatalogItem(kind, id) {
  const list = kind === 'desktop' ? DESKTOP_CATALOG : CLI_CATALOG;
  return list.find(x => x.id === id) || null;
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
      reject(new Error('远程安装命令超时'));
    }, Number(timeoutMs) || 300000);
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
        resolve(JSON.parse(line));
      } catch {
        reject(new Error('SSH 返回格式错误'));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function buildWindowsInstallScript(kind, id) {
  const commonNpmHelper = [
    "$ErrorActionPreference='Continue'",
    "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)",
    "function Find-Npm {",
    "  $c = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source",
    "  if ($c) { return $c }",
    "  foreach ($p in @((Join-Path $env:ProgramFiles 'nodejs\\npm.cmd'), (Join-Path $env:LOCALAPPDATA 'Programs\\nodejs\\npm.cmd'), (Join-Path $env:LOCALAPPDATA 'hermes\\node\\npm.cmd'))) {",
    "    if (Test-Path -LiteralPath $p) { return $p }",
    "  }",
    "  return ''",
    "}",
    "function Ensure-Node {",
    "  $n = Find-Npm",
    "  if ($n) { return $n }",
    "  $wg = (Get-Command winget.exe -ErrorAction SilentlyContinue).Source",
    "  if ($wg) { & $wg install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null }",
    "  $env:PATH = (Join-Path $env:ProgramFiles 'nodejs') + ';' + (Join-Path $env:LOCALAPPDATA 'Programs\\nodejs') + ';' + $env:PATH",
    "  return (Find-Npm)",
    "}",
    "function Run-WingetIds([string[]]$ids) {",
    "  $wg = (Get-Command winget.exe -ErrorAction SilentlyContinue).Source",
    "  if (-not $wg) { Write-Output 'SMAC_INSTALL_ERR 客机未检测到 winget（应用安装程序），无法自动安装该桌面端'; exit 1 }",
    "  $lastOut = ''",
    "  foreach ($wid in $ids) {",
    "    $out = (& $wg install --id $wid -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 | Out-String)",
    "    $code = $LASTEXITCODE",
    "    $lastOut = $out",
    "    if ($code -eq 0 -or $out -match 'already installed|Successfully installed|已安装|成功安装') { Write-Output ('SMAC_INSTALL_OK winget:' + $wid); exit 0 }",
    "  }",
    "  $brief = (($lastOut -split \"`r?`n\" | Where-Object { $_.Trim() } | Select-Object -Last 3) -join ' | ')",
    "  Write-Output ('SMAC_INSTALL_ERR ' + $brief)",
    "  exit 1",
    "}"
  ];

  if (kind === 'cli') {
    if (id === 'codex') {
      return commonNpmHelper.concat([
        "$npm = Ensure-Node; if (-not $npm) { Write-Output 'SMAC_INSTALL_ERR 客机未安装 Node.js / npm'; exit 1 }",
        "$out = (& $npm install -g @openai/codex --no-audit --no-fund 2>&1 | Out-String)",
        "if ($LASTEXITCODE -eq 0) { Write-Output 'SMAC_INSTALL_OK npm:@openai/codex'; exit 0 }",
        "Write-Output ('SMAC_INSTALL_ERR ' + (($out -split \"`r?`n\" | Where-Object { $_.Trim() } | Select-Object -Last 3) -join ' | ')); exit 1"
      ]).join('\n');
    }
    if (id === 'claude') {
      return commonNpmHelper.concat([
        "$npm = Ensure-Node; if (-not $npm) { Write-Output 'SMAC_INSTALL_ERR 客机未安装 Node.js / npm'; exit 1 }",
        "$out = (& $npm install -g @anthropic-ai/claude-code --no-audit --no-fund 2>&1 | Out-String)",
        "if ($LASTEXITCODE -eq 0) { Write-Output 'SMAC_INSTALL_OK npm:@anthropic-ai/claude-code'; exit 0 }",
        "Write-Output ('SMAC_INSTALL_ERR ' + (($out -split \"`r?`n\" | Where-Object { $_.Trim() } | Select-Object -Last 3) -join ' | ')); exit 1"
      ]).join('\n');
    }
    if (id === 'opencode') {
      return commonNpmHelper.concat([
        "$npm = Ensure-Node",
        "if ($npm) {",
        "  $out = (& $npm install -g opencode-ai --no-audit --no-fund 2>&1 | Out-String)",
        "  if ($LASTEXITCODE -eq 0) { Write-Output 'SMAC_INSTALL_OK npm:opencode-ai'; exit 0 }",
        "}",
        "Run-WingetIds @('SST.opencode')"
      ]).join('\n');
    }
    if (id === 'agy') {
      return commonNpmHelper.concat([
        "try {",
        "  $tmp = Join-Path $env:TEMP 'smac-install-agy.ps1'",
        "  Invoke-WebRequest -UseBasicParsing 'https://antigravity.google/cli/install.ps1' -OutFile $tmp -TimeoutSec 60",
        "  $out = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tmp 2>&1 | Out-String)",
        "  if ($LASTEXITCODE -eq 0 -or (Get-Command agy.exe -ErrorAction SilentlyContinue)) { Write-Output 'SMAC_INSTALL_OK agy:official'; exit 0 }",
        "  Write-Output ('SMAC_INSTALL_ERR ' + (($out -split \"`r?`n\" | Where-Object { $_.Trim() } | Select-Object -Last 3) -join ' | ')); exit 1",
        "} catch { Write-Output ('SMAC_INSTALL_ERR ' + $_.Exception.Message); exit 1 }"
      ]).join('\n');
    }
    if (id === 'hermes') {
      return commonNpmHelper.concat([
        "try {",
        "  $tmp = Join-Path $env:TEMP 'smac-install-hermes.ps1'",
        "  Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1' -OutFile $tmp -TimeoutSec 60",
        "  $out = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tmp 2>&1 | Out-String)",
        "  if ($LASTEXITCODE -eq 0 -or (Test-Path (Join-Path $env:LOCALAPPDATA 'hermes\\bin\\hermes.exe'))) { Write-Output 'SMAC_INSTALL_OK hermes:official'; exit 0 }",
        "  Write-Output ('SMAC_INSTALL_ERR ' + (($out -split \"`r?`n\" | Where-Object { $_.Trim() } | Select-Object -Last 3) -join ' | ')); exit 1",
        "} catch { Write-Output ('SMAC_INSTALL_ERR ' + $_.Exception.Message); exit 1 }"
      ]).join('\n');
    }
    if (id === 'dsh') {
      return commonNpmHelper.concat([
        "$npm = Ensure-Node",
        "if ($npm) {",
        "  $out = (& $npm install -g @deepseek/harness --no-audit --no-fund 2>&1 | Out-String)",
        "  if ($LASTEXITCODE -eq 0) { Write-Output 'SMAC_INSTALL_OK npm:@deepseek/harness'; exit 0 }",
        "}",
        "Write-Output 'SMAC_INSTALL_ERR DeepSeek Harness CLI 随 DeepSeek Harness 桌面端内置，请先在客机安装 DeepSeek Harness 桌面端'; exit 1"
      ]).join('\n');
    }
    if (id === 'workbuddy') {
      return commonNpmHelper.concat([
        "$npm = Ensure-Node; if (-not $npm) { Write-Output 'SMAC_INSTALL_ERR 客机未安装 Node.js / npm'; exit 1 }",
        "$out = (& $npm install -g @tencent-ai/codebuddy-code --no-audit --no-fund 2>&1 | Out-String)",
        "if ($LASTEXITCODE -eq 0) { Write-Output 'SMAC_INSTALL_OK npm:@tencent-ai/codebuddy-code'; exit 0 }",
        "Write-Output ('SMAC_INSTALL_ERR ' + (($out -split \"`r?`n\" | Where-Object { $_.Trim() } | Select-Object -Last 3) -join ' | ')); exit 1"
      ]).join('\n');
    }
    if (id === 'qoder') {
      return commonNpmHelper.concat([
        "try {",
        "  $tmp = Join-Path $env:TEMP 'smac-install-qoder.ps1'",
        "  Invoke-WebRequest -UseBasicParsing 'https://qoder.com.cn/install.ps1' -OutFile $tmp -TimeoutSec 60",
        "  $out = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tmp 2>&1 | Out-String)",
        "  if ($LASTEXITCODE -eq 0) { Write-Output 'SMAC_INSTALL_OK qoder:official'; exit 0 }",
        "  Write-Output ('SMAC_INSTALL_ERR ' + (($out -split \"`r?`n\" | Where-Object { $_.Trim() } | Select-Object -Last 3) -join ' | ')); exit 1",
        "} catch { Write-Output ('SMAC_INSTALL_ERR ' + $_.Exception.Message); exit 1 }"
      ]).join('\n');
    }
  }

  // Desktop apps on Windows (winget official default installation directory)
  const wingetMap = {
    'claude-desktop': ['Anthropic.Claude'],
    'codex-desktop': ['OpenAI.Codex', 'OpenAI.ChatGPT'],
    'antigravity-desktop': ['Google.Antigravity'],
    'cursor-desktop': ['Anysphere.Cursor'],
    'lm-studio': ['ElementLabs.LMStudio'],
    'opencode-desktop': ['Anomaly.OpenCodeDesktop', 'SST.OpenCodeDesktop', 'SST.opencode'],
    'deepseek-harness': ['DeepSeek.DeepSeekHarness', 'DeepSeek.Harness'],
    'hermes-desktop': ['NousResearch.Hermes', 'Hermes.Desktop']
  };
  const ids = wingetMap[id] || [];
  if (!ids.length) {
    return "Write-Output 'SMAC_INSTALL_ERR 暂不支持自动安装该组件'; exit 1";
  }
  return commonNpmHelper.concat([
    'Run-WingetIds @(' + ids.map(s => "'" + s + "'").join(', ') + ')'
  ]).join('\n');
}

function buildPosixInstallScript(kind, id) {
  const header = [
    'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.gemini/bin:$HOME/.local/bin:$HOME/.hermes/node/bin:$PATH"',
    'for d in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && export PATH="$d:$PATH"; done',
    'ensure_npm() {',
    '  if command -v npm >/dev/null 2>&1; then return 0; fi',
    '  if command -v brew >/dev/null 2>&1; then brew install node >/dev/null 2>&1 || true; fi',
    '  command -v npm >/dev/null 2>&1',
    '}',
    'run_cask() {',
    '  if ! command -v brew >/dev/null 2>&1; then echo "SMAC_INSTALL_ERR 客机未安装 Homebrew，无法自动安装 macOS 桌面应用"; exit 1; fi',
    '  last=""',
    '  for c in "$@"; do',
    '    out=$(brew install --cask "$c" 2>&1) && { echo "SMAC_INSTALL_OK brew:$c"; exit 0; }',
    '    if echo "$out" | grep -qi "already installed"; then echo "SMAC_INSTALL_OK brew:$c"; exit 0; fi',
    '    last=$(echo "$out" | tail -n 3 | tr "\\n" " ")',
    '  done',
    '  echo "SMAC_INSTALL_ERR $last"; exit 1',
    '}'
  ];

  if (kind === 'cli') {
    if (id === 'codex') {
      return header.concat([
        'ensure_npm || { echo "SMAC_INSTALL_ERR 客机未安装 Node.js / npm"; exit 1; }',
        'out=$(npm install -g @openai/codex --no-audit --no-fund 2>&1) && { echo "SMAC_INSTALL_OK npm:@openai/codex"; exit 0; }',
        'echo "SMAC_INSTALL_ERR $(echo "$out" | tail -n 3 | tr "\\n" " ")"; exit 1'
      ]).join('\n');
    }
    if (id === 'claude') {
      return header.concat([
        'ensure_npm || { echo "SMAC_INSTALL_ERR 客机未安装 Node.js / npm"; exit 1; }',
        'out=$(npm install -g @anthropic-ai/claude-code --no-audit --no-fund 2>&1) && { echo "SMAC_INSTALL_OK npm:@anthropic-ai/claude-code"; exit 0; }',
        'echo "SMAC_INSTALL_ERR $(echo "$out" | tail -n 3 | tr "\\n" " ")"; exit 1'
      ]).join('\n');
    }
    if (id === 'opencode') {
      return header.concat([
        'if out=$(curl -fsSL https://opencode.ai/install | bash 2>&1); then echo "SMAC_INSTALL_OK opencode:official"; exit 0; fi',
        'if ensure_npm && out=$(npm install -g opencode-ai --no-audit --no-fund 2>&1); then echo "SMAC_INSTALL_OK npm:opencode-ai"; exit 0; fi',
        'echo "SMAC_INSTALL_ERR $(echo "$out" | tail -n 3 | tr "\\n" " ")"; exit 1'
      ]).join('\n');
    }
    if (id === 'agy') {
      return header.concat([
        'out=$(curl -fsSL https://antigravity.google/cli/install.sh | bash 2>&1) && { echo "SMAC_INSTALL_OK agy:official"; exit 0; }',
        'echo "SMAC_INSTALL_ERR $(echo "$out" | tail -n 3 | tr "\\n" " ")"; exit 1'
      ]).join('\n');
    }
    if (id === 'hermes') {
      return header.concat([
        'out=$(curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash 2>&1) && { echo "SMAC_INSTALL_OK hermes:official"; exit 0; }',
        'echo "SMAC_INSTALL_ERR $(echo "$out" | tail -n 3 | tr "\\n" " ")"; exit 1'
      ]).join('\n');
    }
    if (id === 'dsh') {
      return header.concat([
        'if ensure_npm && out=$(npm install -g @deepseek/harness --no-audit --no-fund 2>&1); then echo "SMAC_INSTALL_OK npm:@deepseek/harness"; exit 0; fi',
        'echo "SMAC_INSTALL_ERR DeepSeek Harness CLI 随 DeepSeek Harness 桌面端内置，请先在客机安装 DeepSeek Harness"; exit 1'
      ]).join('\n');
    }
    if (id === 'workbuddy') {
      return header.concat([
        'ensure_npm || { echo "SMAC_INSTALL_ERR 客机未安装 Node.js / npm"; exit 1; }',
        'out=$(npm install -g @tencent-ai/codebuddy-code --no-audit --no-fund 2>&1) && { echo "SMAC_INSTALL_OK npm:@tencent-ai/codebuddy-code"; exit 0; }',
        'echo "SMAC_INSTALL_ERR $(echo "$out" | tail -n 3 | tr "\\n" " ")"; exit 1'
      ]).join('\n');
    }
    if (id === 'qoder') {
      return header.concat([
        'out=$(curl -fsSL https://qoder.com.cn/install | bash 2>&1) && { echo "SMAC_INSTALL_OK qoder:cn"; exit 0; }',
        'out=$(curl -fsSL https://qoder.com/install | bash 2>&1) && { echo "SMAC_INSTALL_OK qoder:global"; exit 0; }',
        'echo "SMAC_INSTALL_ERR $(echo "$out" | tail -n 3 | tr "\\n" " ")"; exit 1'
      ]).join('\n');
    }
  }

  const caskMap = {
    'claude-desktop': ['claude'],
    'codex-desktop': ['codex', 'chatgpt'],
    'antigravity-desktop': ['antigravity'],
    'cursor-desktop': ['cursor'],
    'lm-studio': ['lm-studio'],
    'opencode-desktop': ['opencode-desktop'],
    'deepseek-harness': ['deepseek-harness'],
    'hermes-desktop': ['hermes']
  };
  const casks = caskMap[id] || [];
  if (!casks.length) {
    return 'echo "SMAC_INSTALL_ERR 暂不支持自动安装该组件"; exit 1';
  }
  return header.concat(['run_cask ' + casks.map(s => JSON.stringify(s)).join(' ')]).join('\n');
}

function findInstalledEntry(env, kind, id) {
  if (!env || typeof env !== 'object') return null;
  const arr = kind === 'desktop' ? env.desktop : env.cli;
  if (!Array.isArray(arr)) return null;
  return arr.find(x => x && x.id === id) || null;
}

async function installOnDevice(deviceId, rawItems) {
  const items = (Array.isArray(rawItems) ? rawItems : [])
    .map(item => ({
      kind: item && item.kind === 'desktop' ? 'desktop' : 'cli',
      id: String((item && item.id) || '').trim().toLowerCase()
    }))
    .filter(item => item.id && findCatalogItem(item.kind, item.id));

  if (!items.length) {
    throw new Error('请至少选择一个要安装的 CLI 或 Desktop 组件');
  }

  const probe = await bridge({ op: 'probe', deviceId, timeoutMs: 30000 }, 35000);
  if (!probe.ok) {
    throw new Error(probe.error || '无法连接到目标客机');
  }
  const osName = probe.os === 'windows' ? 'windows' : 'posix';

  let preEnv = null;
  try {
    preEnv = await agent.detectEnvForDevice(deviceId, true);
  } catch { }

  const pendingResults = [];
  let ranAnyInstall = false;

  for (const item of items) {
    const meta = findCatalogItem(item.kind, item.id);
    const existing = findInstalledEntry(preEnv, item.kind, item.id);
    if (existing && existing.installed) {
      pendingResults.push({
        id: item.id,
        kind: item.kind,
        name: meta.name,
        ok: true,
        alreadyInstalled: true,
        path: existing.path || '',
        message: '已安装，跳过重复安装'
      });
      continue;
    }

    ranAnyInstall = true;
    const script = osName === 'windows'
      ? buildWindowsInstallScript(item.kind, item.id)
      : buildPosixInstallScript(item.kind, item.id);

    try {
      const execRes = await bridge({
        op: 'exec',
        deviceId,
        os: osName,
        script,
        timeoutMs: 300000
      }, 310000);
      const lines = String(execRes.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const okLine = lines.find(l => l.startsWith('SMAC_INSTALL_OK'));
      const errLine = lines.find(l => l.startsWith('SMAC_INSTALL_ERR'));
      if (okLine) {
        pendingResults.push({
          id: item.id,
          kind: item.kind,
          name: meta.name,
          ok: true,
          alreadyInstalled: false,
          source: okLine.replace(/^SMAC_INSTALL_OK\s*/, '').trim(),
          path: '',
          message: '安装命令执行成功'
        });
      } else {
        const detail = errLine
          ? errLine.replace(/^SMAC_INSTALL_ERR\s*/, '').trim()
          : (String(execRes.error || execRes.stderr || '').trim().slice(0, 260) || '安装失败');
        pendingResults.push({
          id: item.id,
          kind: item.kind,
          name: meta.name,
          ok: false,
          alreadyInstalled: false,
          path: '',
          message: detail
        });
      }
    } catch (err) {
      pendingResults.push({
        id: item.id,
        kind: item.kind,
        name: meta.name,
        ok: false,
        alreadyInstalled: false,
        path: '',
        message: String(err && err.message ? err.message : err)
      });
    }
  }

  // Re-probe the Guest after installations to verify actual installed paths and update cached guestEnv!
  let postEnv = preEnv;
  if (ranAnyInstall) {
    try {
      postEnv = await agent.detectEnvForDevice(deviceId, true);
    } catch { }
  }

  const results = pendingResults.map(r => {
    const after = findInstalledEntry(postEnv, r.kind, r.id);
    if (after && after.installed) {
      return Object.assign({}, r, {
        ok: true,
        verified: true,
        path: after.path || r.path || '',
        message: r.alreadyInstalled ? r.message : ('安装成功并已检测就绪' + (r.source ? ' (' + r.source + ')' : ''))
      });
    }
    if (r.ok && !r.alreadyInstalled) {
      return Object.assign({}, r, {
        verified: false,
        message: '安装完成（部分桌面端/环境变量可能需要重新登录会话或点一次「探环境」刷新）'
      });
    }
    return Object.assign({}, r, { verified: false });
  });

  const okCount = results.filter(r => r.ok).length;
  return {
    ok: okCount === results.length,
    partial: okCount > 0 && okCount < results.length,
    okCount,
    total: results.length,
    deviceId,
    os: osName,
    results,
    env: postEnv
  };
}

module.exports = {
  getCatalog,
  installOnDevice
};
