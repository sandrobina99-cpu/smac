'use strict';

// Background file sync daemon for macOS / Linux Host Edition.
const fs = require('fs');
const path = require('path');
const os = require('os');
const engine = require('./host-engine');

const USER_HOME = process.env.USERPROFILE || os.homedir();
const WATCH_PID = path.join(USER_HOME, '.smac', 'watch.pid');

try {
  fs.mkdirSync(path.dirname(WATCH_PID), { recursive: true });
  fs.writeFileSync(WATCH_PID, String(process.pid), 'ascii');
} catch { }

let stopping = false;

async function loop() {
  while (!stopping) {
    const cfg = engine.readConfig();
    const intervalMs = Math.max(5, Number(cfg.syncIntervalSeconds) || 20) * 1000;
    try {
      await engine.syncNow('');
    } catch { }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

function cleanup() {
  stopping = true;
  try {
    const cur = parseInt(fs.readFileSync(WATCH_PID, 'utf8').trim(), 10);
    if (cur === process.pid) fs.rmSync(WATCH_PID, { force: true });
  } catch { }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
loop();
