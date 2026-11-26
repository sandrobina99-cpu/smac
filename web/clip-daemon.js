'use strict';

// Cross-platform multi-device background clipboard sync daemon (Windows / macOS / Linux).
const fs = require('fs');
const path = require('path');
const os = require('os');
const engine = require('./host-engine');
const clipboardSync = require('./clipboard-sync');

const USER_HOME = process.env.USERPROFILE || os.homedir();
const DATA_DIR = path.join(USER_HOME, '.smac');
const CLIP_PID = path.join(DATA_DIR, 'clip.pid');
const CLIP_STOP = path.join(DATA_DIR, 'clip.stop');
const CLIP_STATUS = path.join(DATA_DIR, 'clip-status.json');

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { fs.rmSync(CLIP_STOP, { force: true }); } catch { }
  fs.writeFileSync(CLIP_PID, String(process.pid), 'ascii');
} catch { }

let stopping = false;

async function loop() {
  while (!stopping) {
    if (fs.existsSync(CLIP_STOP)) break;
    const cfg = engine.readConfig();
    const intervalMs = Math.max(1, Number(cfg.clipboardIntervalSeconds) || 2) * 1000;
    try {
      await clipboardSync.syncOnce();
    } catch { }
    if (fs.existsSync(CLIP_STOP)) break;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  cleanup();
}

function cleanup() {
  if (stopping) return;
  stopping = true;
  try { clipboardSync.cleanupCache(); } catch { }
  try {
    const cur = parseInt(fs.readFileSync(CLIP_PID, 'utf8').trim(), 10);
    if (cur === process.pid) fs.rmSync(CLIP_PID, { force: true });
  } catch { }
  try { fs.rmSync(CLIP_STOP, { force: true }); } catch { }
  try {
    const prev = JSON.parse(fs.readFileSync(CLIP_STATUS, 'utf8'));
    prev.running = false;
    prev.pid = null;
    prev.stoppedAt = new Date().toISOString();
    fs.writeFileSync(CLIP_STATUS, JSON.stringify(prev, null, 2), 'utf8');
  } catch { }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
loop();
