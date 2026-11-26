'use strict';

// 远程设备与 SSH 终端后端。
// 设备配置保存在 %USERPROFILE%\.smac\devices.json；密码可选择明文保存，供后台同步/发送使用。
// 密码不会通过 API 返回给浏览器，网页终端仍在使用时输入。

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

let ssh2 = null;
let WebSocketServer = null;
try { ssh2 = require('ssh2'); } catch { }
try { WebSocketServer = require('ws').WebSocketServer; } catch { }
const sshDial = require('./ssh-dial');

const USER_HOME = process.env.USERPROFILE || os.homedir();
const DATA_DIR = path.join(USER_HOME, '.smac');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const MAX_SESSIONS = 8;

const sessions = new Set();
let wss = null;
let directOperableChecker = null;

function available() {
  return Boolean(ssh2 && WebSocketServer);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function expandHome(value) {
  const text = String(value || '').trim();
  if (text === '~') return USER_HOME;
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(USER_HOME, text.slice(2));
  return text;
}

function guessKeyPath() {
  const sshDir = path.join(USER_HOME, '.ssh');
  const names = ['smac_peer_ed25519', 'id_ed25519', 'id_ecdsa', 'id_rsa'];
  for (const name of names) {
    const candidate = path.join(sshDir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { }
  }
  return '';
}

function nowIso() {
  return new Date().toISOString();
}

function cleanDevice(raw) {
  const device = {
    id: String(raw.id || '').trim(),
    name: String(raw.name || '').trim(),
    host: String(raw.host || '').trim().replace(/^\[(.*)\]$/, '$1'),
    fallbackHost: String(raw.fallbackHost || '').trim().replace(/^\[(.*)\]$/, '$1'),
    port: Number(raw.port) || 22,
    user: String(raw.user || '').trim(),
    auth: raw.auth === 'password' ? 'password' : 'key',
    keyPath: expandHome(raw.keyPath),
    password: typeof raw.password === 'string' ? raw.password : '',
    hostFingerprint: String(raw.hostFingerprint || ''),
    os: String(raw.os || ''),
    jumpDeviceId: String(raw.jumpDeviceId || '').trim(),
    zerotierNodeId: String(raw.zerotierNodeId || '').trim(),
    zerotierIp: String(raw.zerotierIp || '').trim(),
    zerotierStatus: String(raw.zerotierStatus || '').trim(),
    zerotierNetworkId: String(raw.zerotierNetworkId || '').trim(),
    accountId: Number(raw.accountId) || 0,
    accountUsername: String(raw.accountUsername || '').trim(),
    accountDisplayName: String(raw.accountDisplayName || '').trim(),
    accountEnabled: raw.accountEnabled !== false,
    gatewayDeviceId: String(raw.gatewayDeviceId || '').trim(),
    isAdminNode: Boolean(raw.isAdminNode),
    adminNodeId: String(raw.adminNodeId || '').trim(),
    hostAdminNodeId: String(raw.hostAdminNodeId || '').trim(),
    hostAdminName: String(raw.hostAdminName || '').trim(),
    handshakeStatus: ['pending', 'connected', 'rejected', 'disconnected'].includes(raw.handshakeStatus) ? raw.handshakeStatus : 'connected',
    pendingCommand: raw.pendingCommand && typeof raw.pendingCommand === 'object' ? raw.pendingCommand : null,
    guestDisconnected: Boolean(raw.guestDisconnected),
    guestEnv: raw.guestEnv && typeof raw.guestEnv === 'object' ? raw.guestEnv : null,
    createdAt: raw.createdAt || nowIso(),
    updatedAt: raw.updatedAt || nowIso(),
    lastConnectedAt: raw.lastConnectedAt || '',
    lastError: String(raw.lastError || '')
  };
  if (device.fallbackHost === device.host) device.fallbackHost = '';
  return device;
}

function seedDevices() {
  if (fs.existsSync(DEVICES_FILE)) return;
  const config = readJsonSafe(CONFIG_FILE) || {};
  const host = String(config.lanHost || config.host || '').trim();
  const devices = [];
  if (host) {
    devices.push(cleanDevice({
      id: crypto.randomUUID(),
      name: String(config.defaultDeviceName || (process.platform === 'win32' ? 'Mac' : 'Windows')),
      host,
      fallbackHost: config.host && config.host !== host ? config.host : '',
      port: Number(config.port) || 22,
      user: config.user || '',
      auth: 'key',
      keyPath: config.key ? expandHome(config.key) : guessKeyPath()
    }));
  }
  writeDevices(devices);
}

function readDevices() {
  seedDevices();
  const data = readJsonSafe(DEVICES_FILE);
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.devices) ? data.devices : []);
  return list.map(cleanDevice);
}

function writeDevices(devices) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DEVICES_FILE + '.tmp';
  const payload = JSON.stringify({ version: 1, devices }, null, 2);
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, DEVICES_FILE);
}

function listDevices() {
  return readDevices().map(publicDevice);
}

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    host: device.host,
    fallbackHost: device.fallbackHost,
    port: device.port,
    user: device.user,
    auth: device.auth,
    keyPath: device.keyPath,
    hasPassword: Boolean(device.password),
    hostFingerprint: device.hostFingerprint,
    os: device.os,
    jumpDeviceId: device.jumpDeviceId || '',
    zerotierNodeId: device.zerotierNodeId || '',
    zerotierIp: device.zerotierIp || '',
    zerotierStatus: device.zerotierStatus || '',
    zerotierNetworkId: device.zerotierNetworkId || '',
    accountId: Number(device.accountId) || 0,
    accountUsername: device.accountUsername || '',
    accountDisplayName: device.accountDisplayName || '',
    accountEnabled: device.accountEnabled !== false,
    gatewayDeviceId: device.gatewayDeviceId || '',
    isAdminNode: Boolean(device.isAdminNode),
    adminNodeId: device.adminNodeId || '',
    hostAdminNodeId: device.hostAdminNodeId || '',
    hostAdminName: device.hostAdminName || '',
    handshakeStatus: device.handshakeStatus || 'connected',
    pendingCommand: device.pendingCommand || null,
    guestDisconnected: Boolean(device.guestDisconnected),
    guestEnv: device.guestEnv || null,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    lastConnectedAt: device.lastConnectedAt,
    lastError: device.lastError
  };
}

function setDeviceAccountBinding(id, binding) {
  const devices = readDevices();
  const target = devices.find(d => d.id === id);
  if (!target) return null;
  if (binding.accountId !== undefined) target.accountId = Number(binding.accountId) || 0;
  if (binding.accountUsername !== undefined) target.accountUsername = String(binding.accountUsername || '').trim();
  if (binding.accountDisplayName !== undefined) target.accountDisplayName = String(binding.accountDisplayName || '').trim();
  if (binding.accountEnabled !== undefined) target.accountEnabled = binding.accountEnabled !== false;
  if (binding.gatewayDeviceId !== undefined) target.gatewayDeviceId = String(binding.gatewayDeviceId || '').trim();
  if (binding.guestDisconnected !== undefined) target.guestDisconnected = Boolean(binding.guestDisconnected);
  if (binding.hostAdminNodeId !== undefined) target.hostAdminNodeId = String(binding.hostAdminNodeId || '').trim();
  if (binding.hostAdminName !== undefined) target.hostAdminName = String(binding.hostAdminName || '').trim();
  if (binding.handshakeStatus !== undefined) {
    target.handshakeStatus = ['pending', 'connected', 'rejected', 'disconnected'].includes(binding.handshakeStatus)
      ? binding.handshakeStatus : 'connected';
  }
  if (binding.pendingCommand !== undefined) {
    target.pendingCommand = binding.pendingCommand && typeof binding.pendingCommand === 'object' ? binding.pendingCommand : null;
  }
  if (binding.primaryIp) target.host = String(binding.primaryIp).trim();
  if (binding.fallbackIp !== undefined) {
    const fb = String(binding.fallbackIp || '').trim();
    target.fallbackHost = fb && fb !== target.host ? fb : '';
  }
  if (binding.zerotierIp) target.zerotierIp = String(binding.zerotierIp).trim();
  if (binding.sshUser) target.user = String(binding.sshUser).trim();
  if (binding.sshPort) target.port = Number(binding.sshPort) || 22;
  if (binding.os) target.os = String(binding.os).trim();
  target.updatedAt = nowIso();
  writeDevices(devices);
  return publicDevice(target);
}

let localIdentityCache = { at: 0, data: null };

function getLocalMachineIdentity() {
  if (localIdentityCache.data && Date.now() - localIdentityCache.at < 15000) {
    return localIdentityCache.data;
  }
  const ips = new Set();
  try {
    const ifaces = os.networkInterfaces() || {};
    for (const list of Object.values(ifaces)) {
      for (const item of (list || [])) {
        if (!item || item.internal || item.family !== 'IPv4') continue;
        const ip = String(item.address || '').trim();
        if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.') || ip.startsWith('198.18.') || ip.startsWith('198.19.')) continue;
        ips.add(ip);
      }
    }
  } catch { }
  let localAdminNodeId = '';
  try { localAdminNodeId = fs.readFileSync(path.join(DATA_DIR, 'admin-node-id'), 'utf8').trim(); } catch { }
  let localGuestDeviceId = '';
  try { localGuestDeviceId = fs.readFileSync(path.join(USER_HOME, '.smac-guest', 'device-id'), 'utf8').trim(); } catch { }
  const hostname = String(os.hostname() || '').replace(/\.local$/i, '').toLowerCase();
  const data = { ips, hostname, localAdminNodeId, localGuestDeviceId };
  localIdentityCache = { at: Date.now(), data };
  return data;
}

function ipSetOf(dev) {
  const out = [];
  if (!dev) return out;
  for (const h of [dev.host, dev.fallbackHost, dev.zerotierIp, dev.primaryIp, dev.fallbackIp]) {
    const clean = String(h || '').trim().toLowerCase();
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}

function isSelfDevice(dev, localAdminNodeId) {
  if (!dev) return false;
  const me = getLocalMachineIdentity();
  const myNodeId = localAdminNodeId || me.localAdminNodeId;
  if (myNodeId && dev.adminNodeId && dev.adminNodeId === myNodeId) return true;
  if (myNodeId && dev.id && dev.id === myNodeId) return true;
  if (me.localGuestDeviceId && dev.gatewayDeviceId && dev.gatewayDeviceId === me.localGuestDeviceId) return true;
  const ips = ipSetOf(dev);
  if (ips.length && ips.some(ip => me.ips.has(ip))) return true;
  return false;
}

function devicesMatchSameMachine(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return true;
  if (a.adminNodeId && b.adminNodeId && a.adminNodeId === b.adminNodeId) return true;
  if (a.gatewayDeviceId && b.gatewayDeviceId && a.gatewayDeviceId === b.gatewayDeviceId) return true;
  const portA = Number(a.port || a.sshPort) || 22;
  const portB = Number(b.port || b.sshPort) || 22;
  if (portA !== portB) return false;
  const userA = String(a.user || a.sshUser || '').trim().toLowerCase();
  const userB = String(b.user || b.sshUser || '').trim().toLowerCase();
  if (userA && userB && userA !== userB) return false;
  const ipsA = ipSetOf(a);
  const ipsB = ipSetOf(b);
  if (!ipsA.length || !ipsB.length) return false;
  return ipsA.some(ip => ipsB.includes(ip));
}

function chooseMergedAddresses(a, b) {
  const all = [];
  for (const ip of [...ipSetOf(a), ...ipSetOf(b)]) {
    if (ip && !all.includes(ip)) all.push(ip);
  }
  const isTs = ip => /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(ip);
  const isLan = ip => /^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  const explicitZt = String(b.zerotierIp || a.zerotierIp || '').trim();
  const isZt = ip => (explicitZt && ip === explicitZt) || /^10\.(21|147|241|242|243|244)\./.test(ip);

  const lan = all.find(isLan) || '';
  const ts = all.find(isTs) || '';
  const zt = explicitZt || all.find(isZt) || '';
  const host = lan || String(a.host || b.host || ts || zt || all[0] || '').trim();
  const fallbackHost = [ts, all.find(ip => ip !== host && ip !== zt), zt].find(ip => ip && ip !== host) || '';
  return { host, fallbackHost, zerotierIp: zt };
}

function mergeDeviceRecords(primary, secondary, preferredAdminKey) {
  const isAdmin = Boolean(primary.isAdminNode || secondary.isAdminNode);
  const addrs = chooseMergedAddresses(primary, secondary);
  const newerLastConn = String(primary.lastConnectedAt || '') >= String(secondary.lastConnectedAt || '')
    ? (primary.lastConnectedAt || secondary.lastConnectedAt || '')
    : (secondary.lastConnectedAt || '');
  const keyCandidate = isAdmin && preferredAdminKey && fs.existsSync(preferredAdminKey)
    ? preferredAdminKey
    : (primary.keyPath || secondary.keyPath || '');
  const hostChanged = addrs.host !== primary.host && addrs.host !== secondary.host;
  return cleanDevice({
    id: primary.id,
    name: primary.name || secondary.name,
    host: addrs.host || primary.host || secondary.host,
    fallbackHost: addrs.fallbackHost === addrs.host ? '' : addrs.fallbackHost,
    port: Number(primary.port || secondary.port) || 22,
    user: primary.user || secondary.user,
    auth: isAdmin ? 'key' : (primary.auth || secondary.auth || 'key'),
    keyPath: keyCandidate,
    password: isAdmin ? '' : (primary.password || secondary.password || ''),
    hostFingerprint: hostChanged ? '' : (primary.hostFingerprint || secondary.hostFingerprint || ''),
    os: primary.os || secondary.os || '',
    jumpDeviceId: primary.jumpDeviceId || secondary.jumpDeviceId || '',
    zerotierNodeId: primary.zerotierNodeId || secondary.zerotierNodeId || '',
    zerotierIp: addrs.zerotierIp || primary.zerotierIp || secondary.zerotierIp || '',
    zerotierStatus: primary.zerotierStatus || secondary.zerotierStatus || '',
    zerotierNetworkId: primary.zerotierNetworkId || secondary.zerotierNetworkId || '',
    accountId: isAdmin ? 0 : (primary.accountId || secondary.accountId || 0),
    accountUsername: isAdmin ? '' : (primary.accountUsername || secondary.accountUsername || ''),
    accountDisplayName: isAdmin ? '' : (primary.accountDisplayName || secondary.accountDisplayName || ''),
    accountEnabled: isAdmin ? true : (primary.accountEnabled !== false && secondary.accountEnabled !== false),
    gatewayDeviceId: isAdmin ? '' : (primary.gatewayDeviceId || secondary.gatewayDeviceId || ''),
    isAdminNode: isAdmin,
    adminNodeId: primary.adminNodeId || secondary.adminNodeId || '',
    hostAdminNodeId: isAdmin ? '' : (primary.hostAdminNodeId || secondary.hostAdminNodeId || ''),
    hostAdminName: isAdmin ? '' : (primary.hostAdminName || secondary.hostAdminName || ''),
    handshakeStatus: isAdmin ? 'connected' : (primary.handshakeStatus || secondary.handshakeStatus || 'connected'),
    pendingCommand: isAdmin ? null : (primary.pendingCommand || secondary.pendingCommand || null),
    guestDisconnected: isAdmin
      ? Boolean(secondary.isAdminNode ? secondary.guestDisconnected : primary.guestDisconnected)
      : Boolean(primary.guestDisconnected && secondary.guestDisconnected),
    guestEnv: primary.guestEnv || secondary.guestEnv || null,
    createdAt: primary.createdAt || secondary.createdAt || nowIso(),
    updatedAt: nowIso(),
    lastConnectedAt: newerLastConn,
    lastError: primary.lastError || secondary.lastError || ''
  });
}

function getConfigReferencedIds() {
  const refIds = new Set();
  const cfg = readJsonSafe(CONFIG_FILE);
  if (!cfg) return refIds;
  if (cfg.defaultDeviceId) refIds.add(String(cfg.defaultDeviceId));
  for (const p of (Array.isArray(cfg.syncPairs) ? cfg.syncPairs : [])) {
    if (p && p.deviceId) refIds.add(String(p.deviceId));
    if (p && p.peerRemotes && typeof p.peerRemotes === 'object') {
      for (const k of Object.keys(p.peerRemotes)) refIds.add(k);
    }
  }
  return refIds;
}

function remapConfigDeviceIds(idMap, removedSelfIds) {
  if ((!idMap || idMap.size === 0) && (!removedSelfIds || removedSelfIds.size === 0)) return false;
  const cfg = readJsonSafe(CONFIG_FILE);
  if (!cfg || typeof cfg !== 'object') return false;
  let changed = false;
  if (cfg.defaultDeviceId && idMap.has(cfg.defaultDeviceId)) {
    cfg.defaultDeviceId = idMap.get(cfg.defaultDeviceId);
    changed = true;
  }
  if (Array.isArray(cfg.syncPairs)) {
    for (const p of cfg.syncPairs) {
      if (!p) continue;
      if (p.deviceId && idMap.has(p.deviceId)) {
        p.deviceId = idMap.get(p.deviceId);
        changed = true;
      }
      if (p.peerRemotes && typeof p.peerRemotes === 'object') {
        for (const [oldId, newId] of idMap.entries()) {
          if (p.peerRemotes[oldId]) {
            if (!p.peerRemotes[newId]) p.peerRemotes[newId] = p.peerRemotes[oldId];
            delete p.peerRemotes[oldId];
            changed = true;
          }
        }
      }
    }
  }
  if (Array.isArray(cfg.clipboardDeviceIds)) {
    const nextClip = [];
    for (const rawId of cfg.clipboardDeviceIds) {
      if (removedSelfIds && removedSelfIds.has(rawId)) { changed = true; continue; }
      const mapped = idMap.has(rawId) ? idMap.get(rawId) : rawId;
      if (mapped !== rawId) changed = true;
      if (mapped && !nextClip.includes(mapped)) nextClip.push(mapped);
    }
    if (changed || nextClip.length !== cfg.clipboardDeviceIds.length) {
      cfg.clipboardDeviceIds = nextClip;
      changed = true;
    }
  }
  if (changed) {
    try {
      const tmp = CONFIG_FILE + '.tmp-' + crypto.randomBytes(2).toString('hex');
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
      fs.renameSync(tmp, CONFIG_FILE);
    } catch { }
  }
  return changed;
}

function dedupeAndPruneDevices(localAdminNodeId, preferredAdminKey) {
  const devices = readDevices();
  const refIds = getConfigReferencedIds();
  const removedSelfIds = new Set();
  const nonSelf = [];

  for (const d of devices) {
    if (isSelfDevice(d, localAdminNodeId)) {
      removedSelfIds.add(d.id);
      disconnectDeviceSessions(d.id);
      continue;
    }
    nonSelf.push(d);
  }

  const clusters = [];
  for (const d of nonSelf) {
    const cluster = clusters.find(c => c.some(existing => devicesMatchSameMachine(existing, d)));
    if (cluster) cluster.push(d);
    else clusters.push([d]);
  }

  const scoreOf = d => {
    let s = 0;
    if (refIds.has(d.id)) s += 100;
    if (d.guestEnv) s += 40;
    if (d.hostFingerprint) s += 30;
    if (!String(d.id || '').startsWith('adm-peer-')) s += 20;
    if (d.isAdminNode) s += 10;
    if (d.lastConnectedAt) s += 5;
    return s;
  };

  const idMap = new Map();
  const merged = [];
  for (const cluster of clusters) {
    if (cluster.length === 1) {
      merged.push(cluster[0]);
      continue;
    }
    cluster.sort((a, b) => scoreOf(b) - scoreOf(a));
    let acc = cluster[0];
    for (let i = 1; i < cluster.length; i += 1) {
      const dup = cluster[i];
      idMap.set(dup.id, acc.id);
      disconnectDeviceSessions(dup.id);
      acc = mergeDeviceRecords(acc, dup, preferredAdminKey);
    }
    merged.push(acc);
  }

  // Sort admin nodes before clients/remote devices
  merged.sort((a, b) => (b.isAdminNode ? 1 : 0) - (a.isAdminNode ? 1 : 0));

  const sigOf = list => JSON.stringify(list.map(d => [
    d.id, d.name, d.host, d.fallbackHost, d.port, d.user, d.os, d.zerotierIp,
    d.isAdminNode, d.adminNodeId, d.hostAdminNodeId, d.handshakeStatus, d.guestDisconnected, d.keyPath
  ]));
  const changed = removedSelfIds.size > 0 || idMap.size > 0 || sigOf(merged) !== sigOf(devices);
  if (changed) {
    writeDevices(merged);
    remapConfigDeviceIds(idMap, removedSelfIds);
  }
  return { changed, removedSelfCount: removedSelfIds.size, mergedCount: idMap.size, devices: merged.map(publicDevice) };
}

function isDeviceDirectLocal(device, localAdminNodeId) {
  if (!device) return false;
  if (device.isAdminNode) return true;
  if (!device.hostAdminNodeId) return true;
  return Boolean(localAdminNodeId && device.hostAdminNodeId === localAdminNodeId);
}

function syncAdminPeers(localAdminNodeId, peers, keyPath) {
  const resolvedKey = expandHome(keyPath) || guessKeyPath();
  dedupeAndPruneDevices(localAdminNodeId, resolvedKey);
  const devices = readDevices();
  const refIds = getConfigReferencedIds();

  const validPeers = (Array.isArray(peers) ? peers : []).filter(p =>
    p && p.id && p.id !== localAdminNodeId
    && (p.primaryIp || p.fallbackIp || p.zerotierIp)
    && p.sshUser
    && !isSelfDevice({
      adminNodeId: p.id,
      host: p.primaryIp,
      fallbackHost: p.fallbackIp,
      zerotierIp: p.zerotierIp
    }, localAdminNodeId)
  );

  const activePeerIds = new Set(validPeers.map(p => p.id));

  for (const peer of validPeers) {
    const host = String(peer.primaryIp || peer.fallbackIp || peer.zerotierIp || '').trim();
    const fallbackHost = String(peer.fallbackIp && peer.fallbackIp !== host ? peer.fallbackIp : '').trim();
    const incoming = cleanDevice({
      id: 'adm-peer-' + peer.id.replace(/[^a-zA-Z0-9_-]/g, ''),
      name: String(peer.nodeName || peer.hostname || host).trim().slice(0, 38),
      host,
      fallbackHost,
      port: Number(peer.sshPort) || 22,
      user: String(peer.sshUser || '').trim(),
      auth: 'key',
      keyPath: resolvedKey,
      password: '',
      hostFingerprint: '',
      os: String(peer.os || '').trim(),
      zerotierNodeId: String(peer.zerotierNodeId || '').trim(),
      zerotierIp: String(peer.zerotierIp || '').trim(),
      zerotierNetworkId: String(peer.zerotierNetworkId || '').trim(),
      isAdminNode: true,
      adminNodeId: peer.id,
      hostAdminNodeId: '',
      hostAdminName: '',
      handshakeStatus: 'connected',
      pendingCommand: null,
      guestDisconnected: peer.online === false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastConnectedAt: '',
      lastError: ''
    });

    const matchIdx = devices.findIndex(d => devicesMatchSameMachine(d, incoming));
    if (matchIdx >= 0) {
      // Promote/merge in-place so existing friendly name (e.g. Mac / win-hermes), ID, guestEnv & syncPairs stay intact!
      const merged = mergeDeviceRecords(devices[matchIdx], incoming, resolvedKey);
      merged.isAdminNode = true;
      merged.adminNodeId = peer.id;
      merged.guestDisconnected = peer.online === false;
      devices[matchIdx] = merged;
    } else {
      devices.unshift(incoming);
    }
  }

  // Demote or remove admin nodes no longer in active peers
  const nextList = [];
  for (const d of devices) {
    if (d.isAdminNode && d.adminNodeId && !activePeerIds.has(d.adminNodeId)) {
      if (String(d.id || '').startsWith('adm-peer-') && !refIds.has(d.id)) {
        disconnectDeviceSessions(d.id);
        continue;
      }
      d.isAdminNode = false;
      d.adminNodeId = '';
      d.updatedAt = nowIso();
    }
    nextList.push(d);
  }

  writeDevices(nextList);
  const result = dedupeAndPruneDevices(localAdminNodeId, resolvedKey);
  return result.devices.filter(d => d.isAdminNode);
}

function disconnectDeviceSessions(id) {
  for (const session of sessions) {
    if (session.deviceId === id) {
      try { session.closeNow(); } catch { }
    }
  }
}

function findDevice(id) {
  return readDevices().find(item => item.id === id) || null;
}

function updateDevice(id, patch) {
  const devices = readDevices();
  const index = devices.findIndex(item => item.id === id);
  if (index < 0) return null;
  devices[index] = cleanDevice(Object.assign({}, devices[index], patch, { updatedAt: nowIso() }));
  writeDevices(devices);
  return devices[index];
}

function validateHost(value) {
  return Boolean(value) && value.length <= 255 && !/[\s\x00-\x1f]/.test(value) && !value.startsWith('-');
}

function validateUser(value) {
  return Boolean(value) && value.length <= 64 && !/[\s\x00-\x1f]/.test(value);
}

function validateDeviceInput(body, existing) {
  const device = existing ? Object.assign({}, existing) : cleanDevice({ id: crypto.randomUUID() });
  const name = String(body.name != null ? body.name : device.name).trim();
  const host = String(body.host != null ? body.host : device.host).trim().replace(/^\[(.*)\]$/, '$1');
  const fallbackHost = String(body.fallbackHost != null ? body.fallbackHost : device.fallbackHost).trim().replace(/^\[(.*)\]$/, '$1');
  const zerotierIp = String(body.zerotierIp != null ? body.zerotierIp : (device.zerotierIp || '')).trim().replace(/^\[(.*)\]$/, '$1');
  const user = String(body.user != null ? body.user : device.user).trim();
  const portRaw = body.port != null ? body.port : device.port;
  const port = parseInt(portRaw, 10);
  const auth = body.auth === 'password' ? 'password' : (body.auth === 'key' ? 'key' : device.auth);
  const keyPath = expandHome(body.keyPath != null ? body.keyPath : device.keyPath);
  const passwordInput = body.password != null ? String(body.password) : null;
  let password = device.password || '';
  const authChanged = auth !== device.auth;
  const loginChanged = host !== device.host || port !== device.port || user !== device.user;
  if (auth === 'key') {
    password = '';
  }
  else {
    if (authChanged || loginChanged) password = '';
    if (passwordInput) {
      if (passwordInput.length > 1024) throw badRequest('密码过长');
      password = passwordInput;
    }
    if (body.savePassword === false) password = '';
  }

  if (!name) throw badRequest('请填写设备名称');
  if (name.length > 40) throw badRequest('设备名称不能超过 40 个字符');
  if (!validateHost(host)) throw badRequest('主机地址无效');
  if (fallbackHost && !validateHost(fallbackHost)) throw badRequest('备用地址无效');
  if (zerotierIp && !validateHost(zerotierIp)) throw badRequest('ZeroTier IP 地址无效');
  if (!validateUser(user)) throw badRequest('用户名无效');
  if (!Number.isFinite(port) || port < 1 || port > 65535) throw badRequest('端口需在 1-65535 之间');
  if (auth === 'key') {
    if (!keyPath) throw badRequest('请填写私钥路径');
    if (keyPath.length > 1024) throw badRequest('私钥路径过长');
    let stat = null;
    try { stat = fs.statSync(keyPath); } catch { }
    if (!stat || !stat.isFile()) throw badRequest('私钥文件不存在: ' + keyPath);
  }

  const existingList = readDevices();
  const duplicates = existingList.filter(item => item.id !== device.id && item.name.toLowerCase() === name.toLowerCase());
  if (duplicates.length) throw badRequest('已有同名设备: ' + name);
  const candidateCheck = { id: device.id, host, fallbackHost, zerotierIp, port, user };
  if (isSelfDevice(candidateCheck)) throw badRequest('不能将本机 IP 添加为远程设备');
  const sameMachine = existingList.find(item => item.id !== device.id && devicesMatchSameMachine(item, candidateCheck));
  if (sameMachine) throw badRequest('已有指向同一台设备的记录「' + sameMachine.name + '」，请直接编辑该设备以免重复');

  const hostChanged = host !== device.host || port !== device.port;

  return cleanDevice({
    id: device.id,
    name,
    host,
    fallbackHost: fallbackHost === host ? '' : fallbackHost,
    port,
    user,
    auth,
    keyPath,
    password,
    hostFingerprint: hostChanged ? '' : device.hostFingerprint,
    os: hostChanged ? '' : device.os,
    jumpDeviceId: body.jumpDeviceId != null ? String(body.jumpDeviceId).trim() : (device.jumpDeviceId || ''),
    zerotierNodeId: device.zerotierNodeId || '',
    zerotierIp,
    zerotierStatus: device.zerotierStatus || '',
    zerotierNetworkId: device.zerotierNetworkId || '',
    accountId: device.accountId || 0,
    accountUsername: device.accountUsername || '',
    accountDisplayName: device.accountDisplayName || '',
    accountEnabled: device.accountEnabled !== false,
    gatewayDeviceId: device.gatewayDeviceId || '',
    isAdminNode: Boolean(device.isAdminNode),
    adminNodeId: device.adminNodeId || '',
    hostAdminNodeId: device.hostAdminNodeId || '',
    hostAdminName: device.hostAdminName || '',
    handshakeStatus: device.handshakeStatus || 'connected',
    pendingCommand: device.pendingCommand || null,
    guestDisconnected: Boolean(device.guestDisconnected),
    guestEnv: device.guestEnv || null,
    createdAt: device.createdAt,
    updatedAt: nowIso(),
    lastConnectedAt: device.lastConnectedAt,
    lastError: hostChanged ? '' : device.lastError
  });
}

function saveDevice(body) {
  const existing = body.id ? findDevice(String(body.id)) : null;
  if (body.id && !existing) throw badRequest('设备不存在，可能已被删除');
  const device = validateDeviceInput(body, existing);
  const devices = readDevices();
  const index = devices.findIndex(item => item.id === device.id);
  if (index >= 0) devices[index] = device;
  else devices.push(device);
  writeDevices(devices);
  return publicDevice(device);
}

function removeDevice(id) {
  const devices = readDevices();
  const next = devices.filter(item => item.id !== id);
  if (next.length === devices.length) throw badRequest('设备不存在');
  for (const session of sessions) {
    if (session.deviceId === id) session.closeNow();
  }
  writeDevices(next);
  return { ok: true };
}

function resetHostKey(id) {
  const device = updateDevice(id, { hostFingerprint: '', lastError: '' });
  if (!device) throw badRequest('设备不存在');
  return publicDevice(device);
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function fingerprintOf(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function clamp(value, min, max, fallback) {
  const number = parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function isNetworkError(error) {
  const text = String(error && (error.code || '') + ' ' + (error.message || '')).toLowerCase();
  return /econnrefused|etimedout|ehostunreach|enetunreach|enotfound|econnreset|timed? ?out|socket|network/.test(text);
}

function friendlyError(error) {
  const message = String(error && error.message ? error.message : error);
  if (/Encrypted private .* no passphrase/i.test(message)) return '私钥已加密，需要输入口令';
  if (/bad passphrase/i.test(message)) return '私钥口令不正确';
  if (/All configured authentication methods failed/i.test(message)) return '认证失败：请检查用户名、私钥或密码';
  if (/Host verification failed/i.test(message)) return '服务器主机密钥与上次记录不一致';
  if (/Timed out while waiting for handshake|Timed out/i.test(message)) return '连接超时，设备可能不可达';
  if (/ENOTFOUND|getaddrinfo/i.test(message)) return '找不到该主机，请检查地址';
  if (/ECONNREFUSED/i.test(message)) return '端口拒绝连接，请检查 SSH 端口';
  return message;
}

function classifyError(error) {
  const message = String(error && error.message ? error.message : error);
  if (error && error.code === 'hostkey-mismatch') return 'hostkey-mismatch';
  if (/Encrypted private .* no passphrase/i.test(message)) return 'passphrase-required';
  if (/bad passphrase/i.test(message)) return 'passphrase-invalid';
  if (/Host verification failed/i.test(message)) return 'hostkey-mismatch';
  if (/All configured authentication methods failed/i.test(message)) return 'auth-failed';
  if (/Timed out while waiting for handshake|Timed out/i.test(message)) return 'timeout';
  if (isNetworkError(error)) return 'unreachable';
  return 'connect-failed';
}

async function connectDevice(device, credentials, cols, rows, onStatus, dialOpts) {
  const result = await sshDial.connect(device, Object.assign({
    credentials: credentials || {},
    connectTimeoutMs: 20000,
    onStatus
  }, dialOpts || {}));
  return {
    conn: result.conn,
    jumpConn: result.jumpConn || null,
    fingerprint: result.fingerprint || '',
    usedHost: result.usedHost || result.host || device.host,
    routeKind: result.routeKind || '',
    routeLabel: result.routeLabel || '',
    cols: clamp(cols, 20, 400, 100),
    rows: clamp(rows, 5, 200, 30)
  };
}

function detectOs(conn) {
  return new Promise(resolve => {
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(''), 4000);
    try {
      conn.exec('uname -s 2>/dev/null || ver', (error, stream) => {
        if (error) { clearTimeout(timer); finish(''); return; }
        let text = '';
        stream.on('data', chunk => {
          text += chunk.toString('utf8');
          if (text.length > 200) text = text.slice(0, 200);
        });
        stream.stderr.on('data', () => { });
        stream.on('close', () => {
          clearTimeout(timer);
          const value = text.trim().split(/\r?\n/)[0] || '';
          if (/MINGW|MSYS|CYGWIN/i.test(value)) finish('Windows');
          else if (/darwin/i.test(value)) finish('macOS');
          else if (/linux/i.test(value)) finish('Linux');
          else if (/windows|microsoft/i.test(value)) finish('Windows');
          else if (/freebsd|openbsd|netbsd/i.test(value)) finish('BSD');
          else finish(value.slice(0, 24));
        });
      });
    } catch {
      clearTimeout(timer);
      finish('');
    }
  });
}

function probeTcp(host, port, timeoutMs = 2500) {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, ms: ok ? Date.now() - started : 0 });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

async function testDevice(id, credentials = {}) {
  const device = findDevice(String(id || ''));
  if (!device) throw badRequest('设备不存在');
  if (device.auth === 'password' && !credentials.password && device.password) {
    credentials = Object.assign({}, credentials, { password: device.password });
  }
  const started = Date.now();

  if (device.auth === 'password' && !credentials.password) {
    const targets = sshDial.orderedHosts(device);
    for (const item of targets) {
      const result = await probeTcp(item.host, device.port);
      if (result.ok) {
        return {
          ok: true,
          tcpOnly: true,
          host: item.host,
          routeKind: item.kind,
          routeLabel: item.label,
          latencyMs: Date.now() - started,
          message: '端口可达 (' + item.label + ' ' + item.host + ')；密码将在连接时输入并验证'
        };
      }
    }
    return { ok: false, code: 'unreachable', message: '无法连接到 ' + device.host + ':' + device.port };
  }

  let result;
  try {
    // 严格按「局域网 -> Tailscale -> ZeroTier -> 跳板」顺序验证连接
    result = await connectDevice(device, credentials, 100, 30, null, { ignoreRouteCache: true });
  } catch (error) {
    const code = error.code === 'hostkey-mismatch' ? 'hostkey-mismatch' : classifyError(error);
    updateDevice(device.id, { lastError: friendlyError(error) });
    return {
      ok: false,
      code,
      message: friendlyError(error),
      expected: error.expected || '',
      actual: error.actual || ''
    };
  }

  try {
    const remoteOs = await detectOs(result.conn);
    const patch = { lastError: '', guestDisconnected: false, lastConnectedAt: nowIso() };
    if (remoteOs) patch.os = remoteOs;
    if (!device.hostFingerprint && result.fingerprint) patch.hostFingerprint = result.fingerprint;
    updateDevice(device.id, patch);
    return {
      ok: true,
      host: result.usedHost,
      routeKind: result.routeKind || '',
      routeLabel: result.routeLabel || '',
      latencyMs: Date.now() - started,
      fingerprint: result.fingerprint || device.hostFingerprint,
      os: remoteOs || device.os || ''
    };
  } finally {
    try { result.conn.end(); } catch { }
    try { if (result.jumpConn) result.jumpConn.end(); } catch { }
  }
}

// ---------------- WebSocket 终端 ----------------

function isAllowedRequest(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return false;
  const origin = String(req.headers.origin || '').toLowerCase();
  if (origin && origin !== 'http://127.0.0.1:' + port && origin !== 'http://localhost:' + port) return false;
  return true;
}

function attachUpgrade(server, getPort, checkDirectOperable) {
  if (!available()) return false;
  directOperableChecker = typeof checkDirectOperable === 'function' ? checkDirectOperable : null;
  if (!wss) {
    wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
    wss.on('connection', (ws, req) => handleConnection(ws, req));
  }
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { socket.destroy(); return; }
    if (url.pathname !== '/ws/ssh') { socket.destroy(); return; }
    if (!isAllowedRequest(req, getPort())) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, client => {
      wss.emit('connection', client, req, url);
    });
  });
  return true;
}

function handleConnection(ws, req, url) {
  if (sessions.size >= MAX_SESSIONS) {
    ws.close(1013, 'too many sessions');
    return;
  }
  let deviceId = '';
  try { deviceId = new URL(req.url, 'http://127.0.0.1').searchParams.get('id') || ''; } catch { }
  const device = findDevice(deviceId);
  if (!device) {
    ws.send(JSON.stringify({ type: 'error', code: 'not-found', message: '设备不存在，可能已被删除' }));
    ws.close();
    return;
  }
  if (directOperableChecker) {
    const deny = directOperableChecker(device);
    if (deny) {
      ws.send(JSON.stringify({ type: 'error', code: 'forbidden', message: deny }));
      ws.close();
      return;
    }
  }

  const session = {
    ws,
    deviceId,
    conn: null,
    stream: null,
    decoder: null,
    closing: false,
    closeNow() {
      this.closing = true;
      try { if (this.stream) this.stream.close(); } catch { }
      try { if (this.conn) this.conn.end(); } catch { }
      try { ws.close(); } catch { }
    }
  };
  sessions.add(session);

  const send = payload => {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  };
  send({
    type: 'hello',
    device: { id: device.id, name: device.name, user: device.user, host: device.host, port: device.port, os: device.os }
  });
  send({ type: 'status', status: 'idle' });

  let started = false;
  let cols = 100;
  let rows = 30;

  const shutdown = () => {
    session.closing = true;
    try { if (session.stream) session.stream.close(); } catch { }
    try { if (session.conn) session.conn.end(); } catch { }
    session.stream = null;
    session.conn = null;
    sessions.delete(session);
  };

  ws.on('message', raw => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'connect') {
      if (started) return;
      started = true;
      cols = clamp(message.cols, 20, 400, 100);
      rows = clamp(message.rows, 5, 200, 30);
      const credentials = {
        password: typeof message.password === 'string' ? message.password : '',
        passphrase: typeof message.passphrase === 'string' ? message.passphrase : ''
      };
      startShell(session, device, credentials, send, value => { cols = value.cols; rows = value.rows; })
        .catch(error => {
          const code = error.code === 'hostkey-mismatch' ? 'hostkey-mismatch' : classifyError(error);
          send({
            type: 'error',
            code,
            message: friendlyError(error),
            expected: error.expected || '',
            actual: error.actual || ''
          });
          send({ type: 'status', status: 'error' });
          updateDevice(device.id, { lastError: friendlyError(error) });
          shutdown();
        });
      return;
    }

    if (message.type === 'input') {
      if (session.stream && typeof message.data === 'string') {
        try { session.stream.write(message.data); } catch { }
      }
      return;
    }

    if (message.type === 'resize') {
      cols = clamp(message.cols, 20, 400, cols);
      rows = clamp(message.rows, 5, 200, rows);
      if (session.stream) {
        try { session.stream.setWindow(rows, cols, 0, 0); } catch { }
      }
      return;
    }

    if (message.type === 'disconnect') {
      shutdown();
      return;
    }

    if (message.type === 'ping') send({ type: 'pong', at: Date.now() });
  });

  ws.on('close', shutdown);
  ws.on('error', shutdown);
}

async function startShell(session, device, credentials, send, onSize) {
  send({ type: 'status', status: 'connecting', message: '正在连接 ' + device.host });

  const result = await connectDevice(device, credentials, 100, 30, (host, isFallback) => {
    if (!isFallback) return;
    send({
      type: 'status',
      status: 'fallback',
      message: '主地址不可达，正在尝试 ' + host
    });
  });
  const conn = result.conn;
  session.conn = conn;
  send({ type: 'status', status: 'authenticated', message: '认证成功，正在打开终端' });
  if (result.fingerprint) send({ type: 'fingerprint', fingerprint: result.fingerprint });

  // 首次连接采用 TOFU：认证成功后才记录主机指纹
  const patch = { lastError: '', lastConnectedAt: nowIso() };
  if (!device.hostFingerprint && result.fingerprint) patch.hostFingerprint = result.fingerprint;
  updateDevice(device.id, patch);

  detectOs(conn).then(remoteOs => {
    if (!remoteOs) return;
    updateDevice(device.id, { os: remoteOs });
    send({ type: 'device', os: remoteOs });
  }).catch(() => { });

  await new Promise((resolve, reject) => {
    conn.shell({ term: 'xterm-256color', cols: result.cols, rows: result.rows }, (error, stream) => {
      if (error) { reject(error); return; }
      session.stream = stream;
      session.decoder = new StringDecoder('utf8');
      onSize({ cols: result.cols, rows: result.rows });
      send({
        type: 'status',
        status: 'connected',
        message: '已连接',
        host: result.usedHost
      });

      stream.on('data', chunk => {
        send({ type: 'data', data: session.decoder.write(chunk) });
      });
      stream.stderr.on('data', chunk => {
        send({ type: 'data', data: session.decoder.write(chunk) });
      });
      stream.on('close', (code, signal) => {
        const tail = session.decoder ? session.decoder.end() : '';
        if (tail) send({ type: 'data', data: tail });
        send({ type: 'exit', code: code == null ? 0 : code, signal: signal || '' });
        send({ type: 'status', status: 'closed', message: '会话已结束' });
        session.stream = null;
        try { conn.end(); } catch { }
      });
      conn.on('close', () => {
        if (session.closing) return;
        session.closing = true;
        send({ type: 'status', status: 'closed', message: '连接已断开' });
        try { session.ws.close(); } catch { }
        sessions.delete(session);
      });
      resolve();
    });
  });
}

module.exports = {
  available,
  listDevices,
  saveDevice,
  removeDevice,
  resetHostKey,
  testDevice,
  setDeviceAccountBinding,
  isDeviceDirectLocal,
  isSelfDevice,
  devicesMatchSameMachine,
  dedupeAndPruneDevices,
  syncAdminPeers,
  disconnectDeviceSessions,
  attachUpgrade
};
