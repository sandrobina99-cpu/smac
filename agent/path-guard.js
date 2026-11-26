'use strict';

// smac remote-agent path guard.
// Installed as a Hermes pre_tool_call shell hook. It receives the hook payload
// on stdin and blocks file tools whose target path leaves the allowed roots.
// Reads SMAC_AGENT_ROOTS (JSON array) from the environment of the Hermes run.

const fs = require('fs');
const os = require('os');
const path = require('path');

function readStdin() {
  return new Promise(resolve => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { text += chunk; });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', () => resolve(''));
  });
}

function loadRoots() {
  const raw = process.env.SMAC_AGENT_ROOTS || '';
  if (!raw) { return []; }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) { return parsed.map(String).filter(Boolean); }
  } catch { }
  return raw.split(path.delimiter).map(item => item.trim()).filter(Boolean);
}

function expandHome(value) {
  const text = String(value || '');
  if (text === '~') { return os.homedir(); }
  if (/^~[\\/]/.test(text)) { return path.join(os.homedir(), text.slice(2)); }
  return text;
}

function norm(p) {
  const expanded = expandHome(p);
  let value = path.resolve(expanded).replace(/[\\/]+$/, '');
  if (!value) { value = path.parse(path.resolve(expanded)).root.replace(/[\\/]+$/, ''); }
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isUnder(target, root) {
  if (!root) { return false; }
  const base = norm(root);
  if (!base) { return false; }
  const candidate = norm(target);
  return candidate === base || candidate.startsWith(base + path.sep) || candidate.startsWith(base + '/');
}

function resolveTarget(value, cwd) {
  let text = expandHome(String(value || '').trim());
  if (!text) { return null; }
  if (/^[\\/]{2}[?.][\\/]/.test(text)) { return { blocked: '拒绝 NT/设备命名空间路径: ' + text }; }
  if (!path.isAbsolute(text)) { text = path.resolve(cwd || process.cwd(), text); }
  let real = text;
  try { real = fs.realpathSync.native ? fs.realpathSync.native(text) : fs.realpathSync(text); }
  catch { /* 不存在的目标按字面路径判断 */ }
  return { path: real, display: value };
}

const PATH_KEYS = new Set([
  'path', 'file_path', 'filepath', 'file', 'filename', 'target', 'target_path',
  'directory', 'dir', 'folder', 'root', 'cwd', 'workdir', 'paths', 'files', 'targets'
]);

const FILE_TOOLS = new Set([
  'read_file', 'write_file', 'patch', 'search_files', 'list_dir', 'list_files',
  'glob', 'grep', 'create_file', 'edit_file', 'delete_file', 'move_file',
  'copy_file', 'apply_patch', 'str_replace_editor'
]);

function collectCandidates(toolName, input) {
  const out = [];
  for (const [key, value] of Object.entries(input || {})) {
    const lower = key.toLowerCase();
    if (PATH_KEYS.has(lower)) {
      if (Array.isArray(value)) { out.push(...value.map(String)); }
      else if (typeof value === 'string' && value.trim()) { out.push(value); }
    }
  }
  if (toolName === 'patch' || toolName === 'apply_patch') {
    const texts = ['patch', 'diff', 'input'].map(key => input && input[key]).filter(value => typeof value === 'string');
    for (const text of texts) {
      const patterns = [
        /^\*\*\* (?:Update|Add|Delete|Move to) File:\s*(.+)$/gm,
        /^diff --git a\/(.+?) b\/(.+)$/gm,
        /^\+\+\+ b?\/(.+?)(?:\t.*)?$/gm,
        /^--- a?\/(.+?)(?:\t.*)?$/gm
      ];
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
          for (let i = 1; i < match.length; i += 1) {
            const candidate = String(match[i] || '').trim();
            if (candidate && candidate !== '/dev/null') { out.push(candidate); }
          }
        }
      }
    }
  }
  return out;
}

function respond(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(0);
}

(async () => {
  let payload = {};
  try { payload = JSON.parse((await readStdin()) || '{}'); }
  catch { }
  const toolName = String(payload.tool_name || payload.toolName || '');
  let input = payload.tool_input || payload.args || payload.toolInput || {};
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { input = {}; }
  }
  if (!input || typeof input !== 'object') { input = {}; }
  const cwd = payload.cwd || process.cwd();

  // 非文件工具（todo 等）不涉及路径，直接放行。
  if (!FILE_TOOLS.has(toolName) && !Object.keys(input).some(key => PATH_KEYS.has(key.toLowerCase()))) {
    respond({ decision: 'allow' });
    return;
  }

  const roots = loadRoots();
  if (roots.length === 0) {
    respond({ decision: 'block', reason: '远程 Agent 未配置允许目录，文件操作已拒绝。' });
    return;
  }

  const candidates = collectCandidates(toolName, input);
  for (const raw of candidates) {
    const resolved = resolveTarget(raw, cwd);
    if (!resolved) { continue; }
    if (resolved.blocked) { respond({ decision: 'block', reason: resolved.blocked }); return; }
    if (!roots.some(root => isUnder(resolved.path, root))) {
      respond({
        decision: 'block',
        reason: `路径不在允许的同步目录内：${raw}。远程 Agent 只能操作本设备上被选中的同步文件夹。`
      });
      return;
    }
  }
  respond({ decision: 'allow' });
})().catch(error => {
  respond({ decision: 'block', reason: '路径校验失败: ' + (error && error.message ? error.message : String(error)) });
});
