'use strict';

// Codex PreToolUse guard for the smac remote agent.
//
// The Codex backend runs with its native shell disabled and its patch tool
// blocked. The only file access it may use is the `smac` MCP server, which
// enforces the selected sync roots. Everything else is denied here.
//
// Codex invokes this script for every local tool call, writes one JSON object
// to stdin, and reads an optional JSON decision from stdout.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.USERPROFILE || os.homedir();
const AGENT_DIR = path.join(HOME, '.smac-agent');
const LOG_DIR = path.join(AGENT_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'codex-hook.log');
const ALLOWED_PREFIX = 'mcp__smac__';
// Native tools that cannot touch the filesystem: image generation writes only
// into Codex's own home, and view_image is read-only.
const ALLOWED_TOOLS = new Set(['image_generation', 'image_generation_call', 'view_image']);

function log(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = JSON.stringify(entry) + '\n';
    const stat = (() => { try { return fs.statSync(LOG_FILE); } catch { return null; } })();
    if (stat && stat.size > 2 * 1024 * 1024) {
      const kept = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-2000).join('\n');
      fs.writeFileSync(LOG_FILE, kept, 'utf8');
    }
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch { }
}

function readStdin() {
  return new Promise(resolve => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { text += chunk; });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', () => resolve(text));
  });
}

function decide(toolName, input) {
  const name = String(toolName || '');
  const allowed = name.startsWith(ALLOWED_PREFIX) || ALLOWED_TOOLS.has(name);
  const entry = {
    at: new Date().toISOString(),
    tool: name,
    allowed,
    command: input && typeof input.command === 'string' ? input.command.slice(0, 500) : undefined
  };
  log(entry);
  if (allowed) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: '工具 ' + (name || '(unknown)') + ' 已被 smac 远程 Agent 禁用；只能通过 smac 文件工具访问已选同步目录。'
    }
  };
}

async function main() {
  const raw = await readStdin();
  let event = {};
  try { event = JSON.parse(raw || '{}'); } catch { }
  const result = decide(event.tool_name, event.tool_input);
  if (result) process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch(() => { process.exitCode = 0; });
