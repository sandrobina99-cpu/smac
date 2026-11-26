'use strict';

// smac 管理员设备互联（Mesh）：
// 登录同一个唯一管理员账号的多台电脑，自动互相授权 SSH 公钥并互相出现在设备列表中（标注「管理员设备」）。
// - 本机管理员节点 ID 持久化在 ~/.smac/admin-node-id
// - 使用本机主机 SSH 密钥 ~/.ssh/smac_peer_ed25519
// - 其它管理员节点的公钥以 `# smac-admin-node:<nodeId>` 标记写入 authorized_keys；
//   节点登出 / 被移除后会在下一次同步时自动吊销
// - 与客机直连使用 `# smac-host:<nodeId>` 标记（由客户端写入），两者互不干扰

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const guestPackager = require('./guest-packager');
const guestEnv = require('../agent/guest-env');
const zerotier = require('./zerotier');

const USER_HOME = process.env.USERPROFILE || os.homedir();
const DATA_DIR = path.join(USER_HOME, '.smac');
const NODE_ID_FILE = path.join(DATA_DIR, 'admin-node-id');
const TAG = '# smac-admin-node:';
const WIN_ADMIN_AUTH_KEYS = 'C:\\ProgramData\\ssh\\administrators_authorized_keys';

function hostLabel() {
  return String(os.hostname() || 'smac-host').replace(/\.local$/i, '');
}

function platformLabel() {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'macOS';
  return 'Linux';
}

function getLocalAdminNodeId() {
  try {
    const existing = fs.readFileSync(NODE_ID_FILE, 'utf8').trim();
    if (/^[a-zA-Z0-9._:-]{3,96}$/.test(existing)) return existing;
  } catch { }
  const slug = hostLabel().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'host';
  const id = 'adm_' + slug + '_' + crypto.randomBytes(4).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(NODE_ID_FILE, id, 'utf8');
  } catch { }
  return id;
}

function getKeyInfo() {
  return guestPackager.ensureSshKeyPair('smac_peer_ed25519');
}

function getKeyPath() {
  return getKeyInfo().keyPath;
}

function keyCore(pub) {
  const parts = String(pub || '').trim().split(/\s+/);
  if (parts.length >= 2 && /^ssh-|^ecdsa-/.test(parts[0])) return parts[0] + ' ' + parts[1];
  return '';
}

function buildLocalAdminNodePayload() {
  const keyInfo = getKeyInfo();
  const machine = guestEnv.detectNetworkAndMachine();
  let zt = null;
  try { zt = zerotier.getLocalStatus(); } catch { }
  const lan = (machine.lanIps || []).filter(Boolean);
  const tail = (machine.tailscaleIps || []).filter(Boolean);
  const ztIp = (zt && zt.ip) || (machine.zerotierIps || [])[0] || '';
  const primaryIp = lan[0] || tail[0] || ztIp || '';
  const fallbackIp = [tail[0], lan[1], ztIp].find(ip => ip && ip !== primaryIp) || '';
  let endpoints = [];
  try { endpoints = guestPackager.ensurePairingConfig().endpoints || []; } catch { }
  let sshUser = '';
  try { sshUser = os.userInfo().username; } catch { sshUser = process.env.USERNAME || process.env.USER || ''; }
  return {
    id: getLocalAdminNodeId(),
    nodeName: hostLabel(),
    hostname: hostLabel(),
    os: platformLabel(),
    sshUser,
    sshPort: 22,
    primaryIp,
    fallbackIp,
    zerotierIp: ztIp,
    zerotierNodeId: (zt && zt.nodeId) || '',
    zerotierNetworkId: (zt && zt.networkId) || '',
    publicKey: keyInfo.publicKey,
    endpoints
  };
}

function authorizedKeyFiles(allowCreate) {
  const files = [path.join(USER_HOME, '.ssh', 'authorized_keys')];
  if (process.platform === 'win32') {
    try {
      if (fs.existsSync(path.dirname(WIN_ADMIN_AUTH_KEYS))) files.push(WIN_ADMIN_AUTH_KEYS);
    } catch { }
  }
  return files.filter(f => allowCreate || fs.existsSync(f));
}

function rewriteAuthorizedFile(file, peers) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { raw = ''; }
  const existingLines = raw.split(/\r?\n/);
  const kept = existingLines.filter(line => !line.includes(TAG));
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const lines = kept.slice();
  for (const peer of peers) {
    const core = keyCore(peer.publicKey);
    if (!core) continue;
    lines.push(core + ' ' + TAG + peer.id);
  }
  const next = lines.join('\n') + (lines.length ? '\n' : '');
  const normalizedPrev = existingLines.join('\n').replace(/\n+$/, '') + (raw ? '\n' : '');
  if (next === normalizedPrev || (!raw && !next)) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, next, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// 用当前有效的「其它管理员节点」重写 authorized_keys 中的 smac-admin-node 标记行：
// 新节点自动授权，已登出 / 被移除的节点自动吊销。
function syncAuthorizedAdminPeers(peers) {
  const list = Array.isArray(peers) ? peers.filter(p => p && p.id && p.publicKey) : [];
  let changed = false;
  for (const file of authorizedKeyFiles(list.length > 0)) {
    if (rewriteAuthorizedFile(file, list)) changed = true;
  }
  return changed;
}

module.exports = {
  getLocalAdminNodeId,
  getKeyPath,
  buildLocalAdminNodePayload,
  syncAuthorizedAdminPeers,
  platformLabel
};
