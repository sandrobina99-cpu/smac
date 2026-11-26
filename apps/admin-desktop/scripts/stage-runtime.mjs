import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const adminDir = process.cwd();
const repoRoot = path.resolve(adminDir, '../..');
const runtimeDir = path.join(adminDir, 'runtime');

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'release',
  'drop-staging',
  '.git',
  '.cache',
  '__pycache__',
]);

const SKIP_FILE_EXTS = new Set([
  '.node',
  '.dll',
  '.dylib',
  '.so',
  '.exe',
  '.pdb',
  '.zip',
  '.dmg',
  '.icns',
  '.ico',
  '.log',
  '.pid',
  '.db',
  '.sqlite',
  '.sqlite3',
]);

const SKIP_EXACT_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  '.env',
  '.env.local',
  '.master.key',
  'hub.db',
  'hub-admin.json',
  'devices.json',
  'config.json',
  'agent-credentials.json',
  'guest-pairing.json',
  'bootstrap-peer.json',
]);

function copyTreeFiltered(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_EXACT_NAMES.has(entry.name)) continue;
    if (entry.name.startsWith('.env.')) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      copyTreeFiltered(srcPath, destPath);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_FILE_EXTS.has(ext)) continue;
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function stripBinariesAndOptionalNative(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'cpu-features' || entry.name === 'build-gyp' || entry.name === '.bin') {
        fs.rmSync(full, { recursive: true, force: true });
        continue;
      }
      stripBinariesAndOptionalNative(full);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_FILE_EXTS.has(ext) || SKIP_EXACT_NAMES.has(entry.name)) {
        fs.rmSync(full, { force: true });
      }
    }
  }
}

console.log('[stage-runtime] Cleaning:', runtimeDir);
fs.rmSync(runtimeDir, { recursive: true, force: true });
fs.mkdirSync(runtimeDir, { recursive: true });

for (const folder of ['web', 'agent', 'lib', 'guest']) {
  const src = path.join(repoRoot, folder);
  if (fs.existsSync(src)) {
    copyTreeFiltered(src, path.join(runtimeDir, folder));
  }
}

for (const rootFile of ['smac.ps1', 'smac.sh']) {
  const src = path.join(repoRoot, rootFile);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(runtimeDir, rootFile));
  }
}

const runtimeWebDir = path.join(runtimeDir, 'web');
const sourceWebNodeModules = path.join(repoRoot, 'web', 'node_modules');
const destWebNodeModules = path.join(runtimeWebDir, 'node_modules');

const hasLocalPureDeps =
  process.env.CI !== 'true' &&
  fs.existsSync(path.join(sourceWebNodeModules, 'ssh2', 'package.json')) &&
  fs.existsSync(path.join(sourceWebNodeModules, 'ws', 'package.json'));

if (hasLocalPureDeps) {
  console.log('[stage-runtime] Copying preinstalled web/node_modules (pure JS deps)...');
  fs.cpSync(sourceWebNodeModules, destWebNodeModules, { recursive: true });
} else {
  console.log('[stage-runtime] Installing web/node_modules (omit=dev, omit=optional)...');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = spawnSync(
    npmCmd,
    ['install', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund', '--ignore-scripts'],
    {
      cwd: runtimeWebDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );
  if (res.status !== 0) {
    throw new Error(`npm install in runtime/web failed with exit code ${res.status}`);
  }
}

stripBinariesAndOptionalNative(destWebNodeModules);

// Sanity checks
const required = [
  path.join(runtimeWebDir, 'server.js'),
  path.join(runtimeWebDir, 'admin-mesh.js'),
  path.join(runtimeWebDir, 'api-hub-bridge.js'),
  path.join(runtimeWebDir, 'index.html'),
  path.join(runtimeWebDir, 'node_modules', 'ssh2', 'package.json'),
  path.join(runtimeWebDir, 'node_modules', 'ws', 'package.json'),
  path.join(runtimeDir, 'agent', 'guest-env.js'),
];
for (const file of required) {
  if (!fs.existsSync(file)) {
    throw new Error(`[stage-runtime] Missing required runtime asset: ${file}`);
  }
}

console.log('[stage-runtime] Staged smac-runtime cleanly.');
