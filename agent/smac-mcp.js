'use strict';

// smac MCP file server (stdio). Codex runs with its native shell and patch tools
// disabled; this server is the only way it can touch files. Every path is
// resolved against the sync roots written by the console, so the agent can never
// read or write outside the folders the user selected.
//
// Usage: node smac-mcp.js --roots <roots.json> --cwd <selected root>

const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index > -1 ? String(args[index + 1] || '') : '';
}

const ROOTS_FILE = argValue('--roots') || process.env.SMAC_ROOTS_FILE || '';
const CWD = path.resolve(argValue('--cwd') || process.cwd());
const SERVER_NAME = 'smac';
const VERSION = '1.0.0';
const MAX_TEXT = 56 * 1024;
const MAX_READ = 400 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_WRITE = 8 * 1024 * 1024;
const MAX_SCAN_FILES = 4000;
const IS_WIN = process.platform === 'win32';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return null; }
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

function expandHome(value) {
  const text = String(value || '').trim();
  if (text === '~') { return os.homedir(); }
  if (/^~[\\/]/.test(text)) { return path.join(os.homedir(), text.slice(2)); }
  return text;
}

function realRoots() {
  const data = readJson(ROOTS_FILE);
  const list = data && Array.isArray(data.roots) ? data.roots : (Array.isArray(data) ? data : []);
  const roots = [];
  for (const item of list) {
    const rawOriginal = item && typeof item === 'object' ? item.path : item;
    const original = expandHome(rawOriginal);
    if (!original || !path.isAbsolute(String(original))) { continue; }
    let real = '';
    try { real = fs.realpathSync(original); } catch { real = path.resolve(String(original)); }
    if (!roots.some(root => normalizeForCompare(root.real) === normalizeForCompare(real))) {
      roots.push({ real, label: (item && item.label) || path.basename(real) });
    }
  }
  return roots;
}

function baseDir(roots) {
  if (roots.length === 0) { return CWD; }
  const match = roots.find(root => isUnder(CWD, root.real));
  return match ? CWD : roots[0].real;
}

// Resolve a possibly-relative request path into a real path that must live
// inside one of the roots. Nonexistent tails are allowed (for writes) but the
// existing ancestor is still realpath-checked, which blocks symlink escapes.
function resolveTarget(input, options) {
  const opts = options || {};
  const roots = realRoots();
  if (!roots.length) { throw new Error('没有可用的同步目录（roots.json 为空）'); }
  let raw = String(input == null ? '' : input).trim();
  if (!raw) { raw = '.'; }
  if (raw.indexOf('\u0000') >= 0) { throw new Error('路径包含非法字符'); }
  if (raw === '~') { raw = os.homedir(); }
  else if (/^~[\\/]/.test(raw)) { raw = path.join(os.homedir(), raw.slice(2)); }
  const full = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(baseDir(roots), raw);

  let existing = full;
  const tail = [];
  let realExisting = '';
  for (;;) {
    try { realExisting = fs.realpathSync(existing); break; }
    catch {
      const parent = path.dirname(existing);
      if (parent === existing) { realExisting = existing; tail.length = 0; break; }
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const resolved = tail.length ? path.join(realExisting, ...tail) : realExisting;
  const root = roots.find(item => isUnder(resolved, item.real));
  if (!root) {
    throw new Error('路径不在允许的同步目录内: ' + full);
  }
  if (opts.mustExist) {
    try { fs.statSync(resolved); }
    catch { throw new Error('文件或目录不存在: ' + resolved); }
  }
  return { file: resolved, root };
}

function relPath(roots, file) {
  for (const root of roots) {
    if (isUnder(file, root.real)) {
      const rel = path.relative(root.real, file).split(path.sep).join('/');
      return rel || '.';
    }
  }
  return file;
}

function formatSize(size) {
  if (size < 1024) { return size + ' B'; }
  if (size < 1024 * 1024) { return (size / 1024).toFixed(1) + ' KB'; }
  return (size / 1024 / 1024).toFixed(1) + ' MB';
}

function clip(text) {
  const value = String(text);
  if (value.length <= MAX_TEXT) { return value; }
  return value.slice(0, MAX_TEXT) + '\n… 输出过长，已截断';
}

function isProbablyBinary(buffer) {
  const probe = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (let i = 0; i < probe.length; i += 1) {
    if (probe[i] === 0) { return true; }
  }
  return false;
}

function listDir(target) {
  const stat = fs.statSync(target.file);
  if (!stat.isDirectory()) { throw new Error('不是目录: ' + target.file); }
  const entries = fs.readdirSync(target.file, { withFileTypes: true });
  entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
  if (!entries.length) { return '（空目录）' + '\n' + target.file; }
  const lines = entries.map(entry => {
    const full = path.join(target.file, entry.name);
    let stat = null;
    try { stat = fs.lstatSync(full); } catch { }
    if (entry.isDirectory()) { return '[目录] ' + entry.name + '/'; }
    if (entry.isSymbolicLink()) {
      let link = '';
      try { link = fs.readlinkSync(full); } catch { }
      return '[链接] ' + entry.name + ' -> ' + link;
    }
    return '[文件] ' + entry.name + '\t' + (stat ? formatSize(stat.size) : '');
  });
  return '目录: ' + target.file + '\n' + lines.join('\n');
}

function readText(target, offset, limit) {
  const stat = fs.statSync(target.file);
  if (!stat.isFile()) { throw new Error('不是文件: ' + target.file); }
  const buffer = fs.readFileSync(target.file);
  if (isProbablyBinary(buffer)) { throw new Error('这是二进制文件；如果是图片请用 read_image'); }
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, (Number(offset) || 1) - 1);
  const count = Math.min(Math.max(Number(limit) || 2000, 1), 5000);
  const slice = lines.slice(start, start + count);
  const header = target.file + (start > 0 || start + count < lines.length
    ? '\n（第 ' + (start + 1) + '-' + Math.min(start + count, lines.length) + ' 行，共 ' + lines.length + ' 行）'
    : '');
  return clip(header + '\n' + slice.join('\n'));
}

function writeText(target, content) {
  const buffer = Buffer.from(String(content == null ? '' : content), 'utf8');
  if (buffer.length > MAX_WRITE) { throw new Error('内容超过 8MB 限制'); }
  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  fs.writeFileSync(target.file, buffer);
  return '已写入 ' + formatSize(buffer.length) + ': ' + target.file;
}

function replaceText(target, oldText, newText, replaceAll) {
  const stat = fs.statSync(target.file);
  if (!stat.isFile()) { throw new Error('不是文件: ' + target.file); }
  const oldValue = String(oldText == null ? '' : oldText);
  if (!oldValue) { throw new Error('old 不能为空'); }
  const source = fs.readFileSync(target.file, 'utf8');
  let count = 0;
  let index = 0;
  while ((index = source.indexOf(oldValue, index)) >= 0) { count += 1; index += oldValue.length; }
  if (!count) { throw new Error('没有找到要替换的内容'); }
  if (count > 1 && !replaceAll) {
    throw new Error('找到 ' + count + ' 处匹配；请提供更长的上下文，或设置 replace_all=true');
  }
  const next = replaceAll
    ? source.split(oldValue).join(String(newText == null ? '' : newText))
    : source.replace(oldValue, String(newText == null ? '' : newText));
  const buffer = Buffer.from(next, 'utf8');
  if (buffer.length > MAX_WRITE) { throw new Error('结果超过 8MB 限制'); }
  fs.writeFileSync(target.file, buffer);
  return '已替换 ' + (replaceAll ? count : 1) + ' 处: ' + target.file;
}

function walk(root, options) {
  const opts = options || {};
  const found = [];
  let visited = 0;
  const stack = [root.real];
  while (stack.length && found.length < (opts.maxResults || 200) && visited < MAX_SCAN_FILES) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      visited += 1;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root.real, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink()) { stack.push(full); }
        continue;
      }
      if (opts.accept && !opts.accept(entry.name, rel)) { continue; }
      found.push({ full, rel, entry });
      if (found.length >= (opts.maxResults || 200)) { break; }
    }
  }
  return { found, visited };
}

function wildcardRegex(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

function findFiles(target, namePattern, maxResults) {
  const regex = wildcardRegex(namePattern || '*');
  const roots = realRoots();
  if (target && !fs.statSync(target.file).isDirectory()) { throw new Error('path 必须是目录'); }
  const rootsToScan = target ? [{ real: target.file, label: '' }] : roots;
  const limit = Math.max(1, Math.min(Number(maxResults) || 100, 400));
  const out = [];
  let visited = 0;
  for (const root of rootsToScan) {
    const result = walk(root, {
      maxResults: Math.max(1, limit - out.length),
      accept: filename => regex.test(filename)
    });
    visited += result.visited;
    result.found.forEach(item => {
      const stat = (() => { try { return fs.statSync(item.full); } catch { return null; } })();
      out.push(item.rel + (stat ? '\t' + formatSize(stat.size) : ''));
    });
    if (out.length >= limit) { break; }
  }
  if (!out.length) { return '没有找到匹配的文件'; }
  return clip('找到 ' + out.length + ' 个文件（扫描 ' + visited + ' 项）:\n' + out.join('\n'));
}

function grepFiles(target, pattern, options) {
  const opts = options || {};
  const roots = realRoots();
  if (target && !fs.statSync(target.file).isDirectory()) { throw new Error('path 必须是目录'); }
  const rootsToScan = target ? [{ real: target.file, label: '' }] : roots;
  const useRegex = Boolean(opts.regex);
  let matcher;
  try {
    matcher = useRegex ? new RegExp(String(pattern), 'i') : null;
  } catch (error) {
    throw new Error('正则表达式无效: ' + error.message);
  }
  const needle = String(pattern || '');
  if (!useRegex && !needle) { throw new Error('pattern 不能为空'); }
  const maxResults = Math.max(1, Math.min(Number(opts.max_results) || 100, 400));
  const out = [];
  for (const root of rootsToScan) {
    const files = walk(root, { maxResults: 800 });
    for (const item of files.found) {
      if (out.length >= maxResults) { break; }
      let stat;
      try { stat = fs.statSync(item.full); } catch { continue; }
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) { continue; }
      let buffer;
      try { buffer = fs.readFileSync(item.full); } catch { continue; }
      if (isProbablyBinary(buffer)) { continue; }
      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length && out.length < maxResults; index += 1) {
        const line = lines[index];
        const hit = useRegex ? matcher.test(line) : line.indexOf(needle) >= 0;
        if (hit) { out.push(item.rel + ':' + (index + 1) + ': ' + line.trim().slice(0, 240)); }
      }
    }
    if (out.length >= maxResults) { break; }
  }
  if (!out.length) { return '没有匹配内容'; }
  return clip(out.join('\n'));
}

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp'
};

function readImage(target) {
  const stat = fs.statSync(target.file);
  if (!stat.isFile()) { throw new Error('不是文件: ' + target.file); }
  if (stat.size > MAX_IMAGE) { throw new Error('图片超过 8MB'); }
  const ext = path.extname(target.file).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) { throw new Error('不支持的图片格式: ' + ext); }
  return {
    content: [{
      type: 'image',
      data: fs.readFileSync(target.file).toString('base64'),
      mimeType: mime
    }]
  };
}

function deletePath(target, recursive) {
  const roots = realRoots();
  if (roots.some(root => normalizeForCompare(root.real) === normalizeForCompare(target.file))) {
    throw new Error('不能删除同步目录本身');
  }
  const stat = fs.lstatSync(target.file);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(target.file);
    if (entries.length && !recursive) {
      throw new Error('目录非空；确实要删除请设置 recursive=true');
    }
    fs.rmSync(target.file, { recursive: Boolean(recursive), force: true });
    return '已删除目录: ' + target.file;
  }
  fs.rmSync(target.file, { force: true });
  return '已删除文件: ' + target.file;
}

function movePath(fromTarget, toTarget) {
  const roots = realRoots();
  if (roots.some(root => normalizeForCompare(root.real) === normalizeForCompare(fromTarget.file))) {
    throw new Error('不能移动同步目录本身');
  }
  fs.mkdirSync(path.dirname(toTarget.file), { recursive: true });
  fs.renameSync(fromTarget.file, toTarget.file);
  return '已移动: ' + fromTarget.file + ' -> ' + toTarget.file;
}

const TOOLS = [
  {
    name: 'list_dir',
    description: 'List files and folders in a directory inside the allowed sync folders. Relative paths are resolved against the current working folder.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path (default: current folder).' } }
    }
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the allowed sync folders. Returns plain text with line range information.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path.' },
        offset: { type: 'number', description: '1-based first line (default 1).' },
        limit: { type: 'number', description: 'Maximum lines to return (default 2000).' }
      },
      required: ['path']
    }
  },
  {
    name: 'read_image',
    description: 'Read an image file (png/jpg/gif/webp/bmp) inside the allowed sync folders and return it as an image the model can view.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Image path.' } },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file inside the allowed sync folders. Parent folders are created automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path.' },
        content: { type: 'string', description: 'Full file content.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'replace_in_file',
    description: 'Replace an exact piece of text in a file. The old text must appear exactly once unless replace_all is true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path.' },
        old: { type: 'string', description: 'Exact text to find.' },
        new: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' }
      },
      required: ['path', 'old', 'new']
    }
  },
  {
    name: 'make_dir',
    description: 'Create a folder (including parents) inside the allowed sync folders.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Folder path.' } },
      required: ['path']
    }
  },
  {
    name: 'move_path',
    description: 'Move or rename a file or folder inside the allowed sync folders.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source path.' },
        to: { type: 'string', description: 'Destination path.' }
      },
      required: ['from', 'to']
    }
  },
  {
    name: 'delete_path',
    description: 'Delete a file or folder inside the allowed sync folders. Folders require recursive=true when not empty.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to delete.' },
        recursive: { type: 'boolean', description: 'Allow deleting a non-empty folder.' }
      },
      required: ['path']
    }
  },
  {
    name: 'find_files',
    description: 'Recursively find files by file-name wildcard (for example *.pdf or figure?). Returns relative paths.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder to search (default: all allowed folders).' },
        name: { type: 'string', description: 'File-name wildcard, default *.' },
        max_results: { type: 'number', description: 'Maximum results (default 100).' }
      }
    }
  },
  {
    name: 'grep',
    description: 'Search text inside files under the allowed sync folders. Returns file:line: text. Plain substring by default.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regular expression to search.' },
        path: { type: 'string', description: 'Folder to search (default: all allowed folders).' },
        regex: { type: 'boolean', description: 'Treat pattern as a regular expression (case-insensitive).' },
        max_results: { type: 'number', description: 'Maximum matching lines (default 100).' }
      },
      required: ['pattern']
    }
  }
];

function textResult(text) {
  return { content: [{ type: 'text', text: String(text) }] };
}

function errorResult(text) {
  return { content: [{ type: 'text', text: '错误: ' + String(text) }], isError: true };
}

function callTool(name, input) {
  const argsValue = input && typeof input === 'object' ? input : {};
  try {
    switch (name) {
      case 'list_dir':
        return textResult(listDir(resolveTarget(argsValue.path, { mustExist: true })));
      case 'read_file':
        return textResult(readText(resolveTarget(argsValue.path, { mustExist: true }), argsValue.offset, argsValue.limit));
      case 'read_image':
        return readImage(resolveTarget(argsValue.path, { mustExist: true }));
      case 'write_file':
        return textResult(writeText(resolveTarget(argsValue.path), argsValue.content));
      case 'replace_in_file':
        return textResult(replaceText(resolveTarget(argsValue.path, { mustExist: true }), argsValue.old, argsValue.new, argsValue.replace_all));
      case 'make_dir': {
        const target = resolveTarget(argsValue.path);
        fs.mkdirSync(target.file, { recursive: true });
        return textResult('已创建目录: ' + target.file);
      }
      case 'move_path':
        return textResult(movePath(
          resolveTarget(argsValue.from, { mustExist: true }),
          resolveTarget(argsValue.to)
        ));
      case 'delete_path':
        return textResult(deletePath(resolveTarget(argsValue.path, { mustExist: true }), argsValue.recursive));
      case 'find_files':
        return textResult(findFiles(
          argsValue.path ? resolveTarget(argsValue.path, { mustExist: true }) : null,
          argsValue.name,
          argsValue.max_results
        ));
      case 'grep':
        return textResult(grepFiles(
          argsValue.path ? resolveTarget(argsValue.path, { mustExist: true }) : null,
          argsValue.pattern,
          argsValue
        ));
      default:
        return errorResult('未知工具: ' + name);
    }
  } catch (error) {
    return errorResult(error && error.message ? error.message : String(error));
  }
}

function respond(id, result, error) {
  const message = error
    ? { jsonrpc: '2.0', id, error: { code: error.code || -32000, message: error.message || String(error) } }
    : { jsonrpc: '2.0', id, result };
  try { process.stdout.write(JSON.stringify(message) + '\n'); } catch { }
}

function handle(request) {
  const method = String(request.method || '');
  const id = request.id;
  const isNotification = id === undefined || id === null;
  const params = request.params || {};

  if (method === 'initialize') {
    return respond(id, {
      protocolVersion: params.protocolVersion || '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: VERSION },
      instructions: 'File access for the selected sync folders only. Use these tools for all file work; shell and patch tools are disabled.'
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') { return; }
  if (method === 'ping') { return respond(id, {}); }
  if (method === 'tools/list') {
    return respond(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const result = callTool(String(params.name || ''), params.arguments || {});
    return respond(id, result);
  }
  if (method === 'resources/list') { return respond(id, { resources: [] }); }
  if (method === 'prompts/list') { return respond(id, { prompts: [] }); }
  if (method === 'logging/setLevel') { return respond(id, {}); }
  if (isNotification) { return; }
  return respond(id, null, { code: -32601, message: 'Method not found: ' + method });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) { continue; }
    let request;
    try { request = JSON.parse(line); }
    catch {
      process.stderr.write('smac-mcp: invalid JSON line\n');
      continue;
    }
    try { handle(request); }
    catch (error) { respond(request && request.id, null, error); }
  }
});
process.stdin.on('end', () => { process.exit(0); });
process.on('uncaughtException', error => { try { process.stderr.write('smac-mcp: ' + String(error && error.stack || error) + '\n'); } catch { } });
