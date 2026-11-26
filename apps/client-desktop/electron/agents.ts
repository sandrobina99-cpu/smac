import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

export interface AgentModel {
  id: string;
  name: string;
}

export interface ApplyInput {
  /** OpenAI-compatible base URL, e.g. https://hub.sandrobina.me/v1 */
  baseUrl: string;
  apiKey: string;
  models: AgentModel[];
  defaultModel: string;
}

export interface AgentStatus {
  id: string;
  name: string;
  description: string;
  mode: 'file' | 'guide';
  installed: boolean;
  configPaths: string[];
  configured: boolean;
  hasBackup: boolean;
  note: string;
  guide?: string[];
}

interface AgentDef {
  id: string;
  name: string;
  description: string;
  mode: 'file' | 'guide';
  note: string;
  guide?: string[];
  /** Directories / files whose existence implies the tool is installed. */
  markers: () => string[];
  binaries: string[];
  files: () => string[];
  apply?: (input: ApplyInput) => Array<{ file: string; update: (old: string) => string }>;
}

const home = os.homedir();
const h = (...p: string[]) => path.join(home, ...p);

function serverRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function extraBinDirs(): string[] {
  const dirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    h('.local', 'bin'),
    h('.npm-global', 'bin'),
    h('.bun', 'bin'),
    h('.cargo', 'bin'),
    h('.volta', 'bin'),
    h('go', 'bin'),
  ];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || h('AppData', 'Roaming');
    dirs.push(path.join(appData, 'npm'), h('.local', 'bin'), h('scoop', 'shims'));
  }
  const nvm = h('.nvm', 'versions', 'node');
  try {
    for (const v of fs.readdirSync(nvm)) dirs.push(path.join(nvm, v, 'bin'));
  } catch {
    // ignore
  }
  return dirs;
}

function hasBinary(names: string[]): boolean {
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = [...(process.env.PATH || '').split(sep), ...extraBinDirs()].filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of exts) {
        try {
          if (fs.existsSync(path.join(dir, name + ext))) return true;
        } catch {
          // ignore
        }
      }
    }
  }
  return false;
}

/* -------------------------- text helpers -------------------------- */

function parseJsonObject(text: string, file: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fallthrough
  }
  throw new Error(`${file} 不是标准 JSON（可能含注释），为避免破坏原配置已放弃写入，请手动处理`);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toJson(obj: unknown): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function upsertEnvLines(text: string, entries: Record<string, string>): string {
  const lines = text.length ? text.replace(/\r\n/g, '\n').split('\n') : [];
  const remaining = new Map(Object.entries(entries));
  const out = lines.map((line) => {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && remaining.has(m[1])) {
      const value = remaining.get(m[1])!;
      remaining.delete(m[1]);
      return `${m[1]}=${value}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of remaining) out.push(`${k}=${v}`);
  return `${out.join('\n')}\n`;
}

function upsertYamlTopLevel(text: string, entries: Record<string, string>): string {
  const lines = text.length ? text.replace(/\r\n/g, '\n').split('\n') : [];
  const remaining = new Map(Object.entries(entries));
  const out = lines.map((line) => {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:/);
    if (m && remaining.has(m[1])) {
      const value = remaining.get(m[1])!;
      remaining.delete(m[1]);
      return `${m[1]}: ${value}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of remaining) out.push(`${k}: ${v}`);
  return `${out.join('\n')}\n`;
}

function setTomlTopLevelKey(text: string, key: string, literal: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const end = firstTable === -1 ? lines.length : firstTable;
  const re = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = 0; i < end; i += 1) {
    if (re.test(lines[i])) {
      lines[i] = `${key} = ${literal}`;
      return lines.join('\n');
    }
  }
  return [`${key} = ${literal}`, ...lines].join('\n');
}

function removeTomlSection(text: string, header: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      skipping = trimmed === `[${header}]` || trimmed.startsWith(`[${header}.`);
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

/* ---------------------------- definitions ---------------------------- */

const AGENTS: AgentDef[] = [
  {
    id: 'codex',
    name: 'Codex CLI',
    description: 'OpenAI Codex 命令行 / IDE 插件',
    mode: 'file',
    note: '写入 ~/.codex/config.toml（自定义 provider，Responses 协议）与 ~/.codex/auth.json',
    markers: () => [h('.codex')],
    binaries: ['codex'],
    files: () => [h('.codex', 'config.toml'), h('.codex', 'auth.json')],
    apply: (input) => [
      {
        file: h('.codex', 'config.toml'),
        update: (old) => {
          let text = removeTomlSection(old, 'model_providers.sandrobina');
          text = setTomlTopLevelKey(text, 'model_provider', '"sandrobina"');
          if (input.defaultModel) {
            text = setTomlTopLevelKey(text, 'model', JSON.stringify(input.defaultModel));
          }
          text = text.replace(/\n+$/, '\n');
          return `${text}\n[model_providers.sandrobina]\nname = "Sandrobina API Hub"\nbase_url = ${JSON.stringify(input.baseUrl)}\nwire_api = "responses"\nrequires_openai_auth = true\n`;
        },
      },
      {
        file: h('.codex', 'auth.json'),
        update: (old) => {
          const obj = parseJsonObject(old, 'auth.json');
          obj.OPENAI_API_KEY = input.apiKey;
          return toJson(obj);
        },
      },
    ],
  },
  {
    id: 'claude',
    name: 'Claude Code',
    description: 'Anthropic Claude Code 命令行',
    mode: 'file',
    note: '写入 ~/.claude/settings.json 的 env（ANTHROPIC_BASE_URL / AUTH_TOKEN）。需网关上游支持 Anthropic Messages 协议（/v1/messages）',
    markers: () => [h('.claude')],
    binaries: ['claude'],
    files: () => [h('.claude', 'settings.json')],
    apply: (input) => [
      {
        file: h('.claude', 'settings.json'),
        update: (old) => {
          const obj = parseJsonObject(old, 'settings.json');
          const env = asObject(obj.env);
          env.ANTHROPIC_BASE_URL = serverRoot(input.baseUrl);
          env.ANTHROPIC_AUTH_TOKEN = input.apiKey;
          if (input.defaultModel) env.ANTHROPIC_MODEL = input.defaultModel;
          obj.env = env;
          return toJson(obj);
        },
      },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'sst/opencode 终端 AI 编程助手',
    mode: 'file',
    note: '写入 ~/.config/opencode/opencode.json（@ai-sdk/openai-compatible provider）',
    markers: () => [h('.config', 'opencode')],
    binaries: ['opencode'],
    files: () => [h('.config', 'opencode', 'opencode.json')],
    apply: (input) => [
      {
        file: h('.config', 'opencode', 'opencode.json'),
        update: (old) => {
          const obj = parseJsonObject(old, 'opencode.json');
          if (!obj.$schema) obj.$schema = 'https://opencode.ai/config.json';
          const provider = asObject(obj.provider);
          const models: Record<string, unknown> = {};
          for (const m of input.models) models[m.id] = { name: m.name || m.id };
          provider.sandrobina = {
            npm: '@ai-sdk/openai-compatible',
            name: 'Sandrobina API Hub',
            options: { baseURL: input.baseUrl, apiKey: input.apiKey },
            models,
          };
          obj.provider = provider;
          if (input.defaultModel) obj.model = `sandrobina/${input.defaultModel}`;
          return toJson(obj);
        },
      },
    ],
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    description: 'Nous Research Hermes Agent',
    mode: 'file',
    note: '写入 ~/.hermes/.env（OPENAI_BASE_URL / OPENAI_API_KEY），请在 Hermes 中选择 OpenAI 兼容 / custom 提供商',
    markers: () => [h('.hermes')],
    binaries: ['hermes'],
    files: () => [h('.hermes', '.env')],
    apply: (input) => [
      {
        file: h('.hermes', '.env'),
        update: (old) =>
          upsertEnvLines(old, {
            OPENAI_BASE_URL: input.baseUrl,
            OPENAI_API_KEY: input.apiKey,
            ...(input.defaultModel ? { LLM_MODEL: input.defaultModel } : {}),
          }),
      },
    ],
  },
  {
    id: 'droid',
    name: 'Factory Droid',
    description: 'Factory Droid CLI',
    mode: 'file',
    note: '写入 ~/.factory/config.json 的 custom_models（generic-chat-completion-api）',
    markers: () => [h('.factory')],
    binaries: ['droid'],
    files: () => [h('.factory', 'config.json')],
    apply: (input) => [
      {
        file: h('.factory', 'config.json'),
        update: (old) => {
          const obj = parseJsonObject(old, 'config.json');
          const existing = Array.isArray(obj.custom_models) ? (obj.custom_models as unknown[]) : [];
          const kept = existing.filter(
            (m) => !(m && typeof m === 'object' && String((m as { model_display_name?: string }).model_display_name || '').startsWith('Sandrobina · ')),
          );
          for (const m of input.models) {
            kept.push({
              model_display_name: `Sandrobina · ${m.name || m.id}`,
              model: m.id,
              base_url: input.baseUrl,
              api_key: input.apiKey,
              provider: 'generic-chat-completion-api',
            });
          }
          obj.custom_models = kept;
          return toJson(obj);
        },
      },
    ],
  },
  {
    id: 'aider',
    name: 'Aider',
    description: 'Aider 终端结对编程',
    mode: 'file',
    note: '写入 ~/.aider.conf.yml（openai-api-base / openai-api-key / model）',
    markers: () => [h('.aider.conf.yml'), h('.aider')],
    binaries: ['aider'],
    files: () => [h('.aider.conf.yml')],
    apply: (input) => [
      {
        file: h('.aider.conf.yml'),
        update: (old) =>
          upsertYamlTopLevel(old, {
            'openai-api-base': input.baseUrl,
            'openai-api-key': input.apiKey,
            ...(input.defaultModel ? { model: `openai/${input.defaultModel}` } : {}),
          }),
      },
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    description: '通义千问 Qwen Code CLI',
    mode: 'file',
    note: '写入 ~/.qwen/.env（OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL）',
    markers: () => [h('.qwen')],
    binaries: ['qwen'],
    files: () => [h('.qwen', '.env')],
    apply: (input) => [
      {
        file: h('.qwen', '.env'),
        update: (old) =>
          upsertEnvLines(old, {
            OPENAI_BASE_URL: input.baseUrl,
            OPENAI_API_KEY: input.apiKey,
            ...(input.defaultModel ? { OPENAI_MODEL: input.defaultModel } : {}),
          }),
      },
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    description: 'Cursor 编辑器',
    mode: 'guide',
    note: 'Cursor 的模型设置保存在应用内部数据库，无法安全地写文件，需在设置里手动粘贴',
    guide: [
      '打开 Cursor → Settings → Models',
      '开启 “Override OpenAI Base URL”，粘贴下方 Base URL',
      '在 OpenAI API Key 处粘贴下方 API Key 并点击 Verify',
      '通过 “Add Model” 添加下方模型名称',
    ],
    markers: () => [
      '/Applications/Cursor.app',
      h('.cursor'),
      path.join(process.env.LOCALAPPDATA || h('AppData', 'Local'), 'Programs', 'cursor'),
    ],
    binaries: ['cursor'],
    files: () => [],
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    description: 'Google Antigravity IDE / CLI (agy)',
    mode: 'guide',
    note: '请在 Antigravity 的自定义模型 / OpenAI 兼容提供商设置里填入下方信息（该应用无公开的配置文件格式）',
    guide: [
      '打开 Antigravity → Settings → Models / Providers',
      '选择 OpenAI Compatible（自定义 Provider）',
      '粘贴下方 Base URL 与 API Key，并添加模型名称',
    ],
    markers: () => [
      '/Applications/Antigravity.app',
      h('.gemini', 'antigravity'),
      path.join(process.env.LOCALAPPDATA || h('AppData', 'Local'), 'Programs', 'Antigravity'),
    ],
    binaries: ['agy', 'antigravity'],
    files: () => [],
  },
  {
    id: 'deepseekharness',
    name: 'DeepSeek Harness',
    description: 'DeepSeek 系列 Agent / Harness',
    mode: 'guide',
    note: '该工具没有公开统一的配置文件格式，使用 OpenAI 兼容方式手动填入（或导出为环境变量）',
    guide: [
      '在工具的模型 / Provider 设置中选择 OpenAI Compatible',
      '粘贴下方 Base URL 与 API Key，模型名称填写下方任一模型',
      '或在终端导出 OPENAI_BASE_URL / OPENAI_API_KEY 环境变量后启动',
    ],
    markers: () => [h('.deepseek')],
    binaries: ['deepseek'],
    files: () => [],
  },
];

/* ---------------------------- backups ---------------------------- */

interface BackupEntry {
  existed: boolean;
  backup?: string;
}

function backupDir(): string {
  return path.join(app.getPath('userData'), 'agent-backups');
}

function manifestPath(): string {
  return path.join(backupDir(), 'manifest.json');
}

function readManifest(): Record<string, BackupEntry> {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(), 'utf8')) as Record<string, BackupEntry>;
  } catch {
    return {};
  }
}

function writeManifest(m: Record<string, BackupEntry>): void {
  fs.mkdirSync(backupDir(), { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify(m, null, 2), 'utf8');
}

function ensureBackup(file: string): void {
  const manifest = readManifest();
  if (manifest[file]) return;
  const existed = fs.existsSync(file);
  const entry: BackupEntry = { existed };
  if (existed) {
    fs.mkdirSync(backupDir(), { recursive: true });
    const name = `${crypto.createHash('sha1').update(file).digest('hex')}.bak`;
    fs.copyFileSync(file, path.join(backupDir(), name));
    entry.backup = name;
  }
  manifest[file] = entry;
  writeManifest(manifest);
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.sandrobina-tmp`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // ignore
    }
  }
}

/* ---------------------------- public API ---------------------------- */

function isInstalled(def: AgentDef): boolean {
  return def.markers().some((p) => fs.existsSync(p)) || hasBinary(def.binaries);
}

export function detectAgents(baseUrl: string): AgentStatus[] {
  const manifest = readManifest();
  return AGENTS.map((def) => {
    const files = def.files();
    let configured = false;
    if (baseUrl) {
      configured = files.some((f) => {
        try {
          return fs.readFileSync(f, 'utf8').includes(serverRoot(baseUrl));
        } catch {
          return false;
        }
      });
    }
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      mode: def.mode,
      installed: isInstalled(def),
      configPaths: files,
      configured,
      hasBackup: files.some((f) => Boolean(manifest[f])),
      note: def.note,
      guide: def.guide,
    };
  });
}

export function applyAgent(id: string, input: ApplyInput): { written: string[] } {
  const def = AGENTS.find((a) => a.id === id);
  if (!def || !def.apply) throw new Error('该工具不支持自动写入配置');
  if (!input.apiKey || !input.baseUrl) throw new Error('缺少 API Key 或网关地址');

  const plan = def.apply(input);
  // Compute every new content first so a parse failure aborts before touching any file.
  const prepared = plan.map((item) => {
    let old = '';
    try {
      old = fs.readFileSync(item.file, 'utf8');
    } catch {
      old = '';
    }
    return { file: item.file, content: item.update(old) };
  });
  for (const item of prepared) {
    ensureBackup(item.file);
    atomicWrite(item.file, item.content);
  }
  return { written: prepared.map((p) => p.file) };
}

export function restoreAgent(id: string): { restored: string[] } {
  const def = AGENTS.find((a) => a.id === id);
  if (!def) throw new Error('未知工具');
  const manifest = readManifest();
  const restored: string[] = [];
  for (const file of def.files()) {
    const entry = manifest[file];
    if (!entry) continue;
    if (entry.existed && entry.backup) {
      fs.copyFileSync(path.join(backupDir(), entry.backup), file);
    } else {
      fs.rmSync(file, { force: true });
    }
    delete manifest[file];
    restored.push(file);
  }
  writeManifest(manifest);
  if (!restored.length) throw new Error('没有可恢复的备份');
  return { restored };
}

export function revealAgentConfig(id: string): string | null {
  const def = AGENTS.find((a) => a.id === id);
  const file = def?.files().find((f) => fs.existsSync(f)) ?? def?.files()[0];
  return file ?? null;
}
