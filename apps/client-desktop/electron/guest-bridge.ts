import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface HostBindingPayload {
  hostName: string;
  publicKey: string;
  pairToken?: string;
  endpoints?: string[];
  zerotierNetworkId?: string;
  updatedAt?: number;
}

export interface AdminNodePayload {
  id: string;
  nodeName: string;
  hostname?: string;
  os?: string;
  sshUser?: string;
  sshPort?: number;
  primaryIp?: string;
  fallbackIp?: string;
  zerotierIp?: string;
  zerotierNetworkId?: string;
  publicKey: string;
  endpoints?: string[];
}

export interface GuestLocalStatus {
  deviceId: string;
  deviceName: string;
  hostname: string;
  os: string;
  sshUser: string;
  sshPort: number;
  primaryIp: string;
  fallbackIp: string;
  zerotierIp: string;
  sshAuthorized: boolean;
  authorizedAdminNodeId: string;
}

const GUEST_DATA_DIR = path.join(os.homedir(), '.smac-guest');
const DEVICE_ID_FILE = path.join(GUEST_DATA_DIR, 'device-id');
const HOST_PROFILE_FILE = path.join(GUEST_DATA_DIR, 'host-profile.json');
const WIN_ADMIN_AUTH_KEYS = 'C:\\ProgramData\\ssh\\administrators_authorized_keys';
const HOST_TAG_PREFIX = '# smac-host:';
const LEGACY_HOST_TAG = 'smac-host-managed';

function detectPlatformLabel(): string {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'macOS';
  return 'Linux';
}

function getOrCreateDeviceId(): string {
  try {
    if (fs.existsSync(DEVICE_ID_FILE)) {
      const existing = fs.readFileSync(DEVICE_ID_FILE, 'utf8').trim();
      if (existing.length >= 6) return existing;
    }
  } catch {
    // regenerate below
  }
  const hostSlug =
    os
      .hostname()
      .replace(/\.local$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 18) || 'guest';
  const id = `${hostSlug}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.mkdirSync(GUEST_DATA_DIR, { recursive: true });
    fs.writeFileSync(DEVICE_ID_FILE, `${id}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // ignore write failure
  }
  return id;
}

function detectNetworkIps(): {
  primaryIp: string;
  fallbackIp: string;
  zerotierIp: string;
} {
  const ifaces = os.networkInterfaces();
  const lanIps: string[] = [];
  const tailscaleIps: string[] = [];
  const otherIps: string[] = [];
  let zerotierIp = '';

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    const lowerName = name.toLowerCase();
    for (const addr of addrs) {
      if (addr.internal || addr.family !== 'IPv4') continue;
      const ip = addr.address;
      if (ip.startsWith('169.254.')) continue;
      if (lowerName.includes('zerotier') || lowerName.startsWith('zt')) {
        if (!zerotierIp) zerotierIp = ip;
        continue;
      }
      if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(ip)) {
        tailscaleIps.push(ip);
        continue;
      }
      if (
        ip.startsWith('192.168.') ||
        ip.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
      ) {
        lanIps.push(ip);
      } else {
        otherIps.push(ip);
      }
    }
  }

  const ordered = [...lanIps, ...tailscaleIps, ...otherIps];
  const primaryIp = ordered[0] || zerotierIp || '';
  const fallbackIp =
    [tailscaleIps[0], lanIps[1], otherIps[0], zerotierIp].find(
      (ip) => Boolean(ip) && ip !== primaryIp,
    ) || '';

  return {
    primaryIp,
    fallbackIp,
    zerotierIp,
  };
}

function extractKeyCore(pubKey: string): string {
  const parts = String(pubKey || '').trim().split(/\s+/);
  if (parts.length >= 2 && /^(ssh-|ecdsa-)/.test(parts[0])) {
    return `${parts[0]} ${parts[1]}`;
  }
  return '';
}

function getAuthorizedKeyPaths(allowCreate = false): string[] {
  const userAuthKeys = path.join(os.homedir(), '.ssh', 'authorized_keys');
  if (process.platform === 'win32') {
    const out = [userAuthKeys];
    try {
      if (allowCreate ? fs.existsSync(path.dirname(WIN_ADMIN_AUTH_KEYS)) : fs.existsSync(WIN_ADMIN_AUTH_KEYS)) {
        out.push(WIN_ADMIN_AUTH_KEYS);
      }
    } catch {
      // ignore
    }
    return out;
  }
  return [userAuthKeys];
}

function parseAuthorizedAdminNodeId(): string {
  for (const file of getAuthorizedKeyPaths(false)) {
    try {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const idx = line.indexOf(HOST_TAG_PREFIX);
        if (idx >= 0) {
          const id = line.slice(idx + HOST_TAG_PREFIX.length).trim().split(/\s+/)[0] || '';
          if (id) return id;
        }
      }
    } catch {
      // ignore
    }
  }
  return '';
}

function hasPublicKeyInstalled(pubKey: string): boolean {
  const core = extractKeyCore(pubKey);
  if (!core) return false;
  for (const file of getAuthorizedKeyPaths(false)) {
    try {
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes(core)) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

function isManagedHostLine(line: string, extraCore?: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.includes(HOST_TAG_PREFIX) || trimmed.includes(LEGACY_HOST_TAG)) return true;
  if (extraCore && trimmed.includes(extraCore)) return true;
  return false;
}

// Strict single-direct-host replacement: strips ALL previous # smac-host:* and legacy managed lines,
// then installs ONLY the target admin host's key tagged with # smac-host:<adminNodeId>.
function replaceManagedHostKeyInFile(filePath: string, keyLine: string | null, extraCore?: string): { ok: boolean; removed: number } {
  try {
    const dir = path.dirname(filePath);
    if (keyLine && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    if (!keyLine && !fs.existsSync(filePath)) {
      return { ok: true, removed: 0 };
    }
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    const lines = existing.split(/\r?\n/);
    let removed = 0;
    const kept = lines.filter((line) => {
      if (isManagedHostLine(line, extraCore)) {
        removed += 1;
        return false;
      }
      return true;
    });
    while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
    if (keyLine) {
      kept.push(keyLine);
    }
    const next = kept.length ? `${kept.join('\n')}\n` : '';
    fs.writeFileSync(filePath, next, { encoding: 'utf8', mode: 0o600 });
    return { ok: true, removed };
  } catch {
    return { ok: false, removed: 0 };
  }
}

export function getGuestLocalStatus(hostPublicKey?: string): GuestLocalStatus {
  const deviceId = getOrCreateDeviceId();
  const hostname = os.hostname().replace(/\.local$/i, '');
  const ips = detectNetworkIps();
  let sshUser = '';
  try {
    sshUser = os.userInfo().username;
  } catch {
    sshUser = process.env.USER || process.env.USERNAME || '';
  }
  const authorizedAdminNodeId = parseAuthorizedAdminNodeId();
  const sshAuthorized = Boolean(authorizedAdminNodeId) || (hostPublicKey ? hasPublicKeyInstalled(hostPublicKey) : false);
  return {
    deviceId,
    deviceName: hostname,
    hostname,
    os: detectPlatformLabel(),
    sshUser,
    sshPort: 22,
    primaryIp: ips.primaryIp,
    fallbackIp: ips.fallbackIp,
    zerotierIp: ips.zerotierIp,
    sshAuthorized,
    authorizedAdminNodeId,
  };
}

export function connectLocalToAdminNode(
  adminNode: AdminNodePayload,
  customDeviceName?: string,
): {
  ok: boolean;
  sshAuthorized: boolean;
  authorizedAdminNodeId: string;
  device: {
    deviceId: string;
    deviceName: string;
    hostname: string;
    os: string;
    sshUser: string;
    sshPort: number;
    primaryIp: string;
    fallbackIp: string;
    zerotierIp: string;
    zerotierNetworkId: string;
    targetAdminNodeId: string;
    connected: boolean;
    sshAuthorized: boolean;
  };
} {
  const nodeId = String(adminNode?.id || '').trim();
  const pubKey = String(adminNode?.publicKey || '').trim();
  const core = extractKeyCore(pubKey);
  if (!nodeId || !core) {
    throw new Error('目标管理员主机尚未同步有效的 SSH 公钥，请先在管理员端登录并同步网络拓扑');
  }

  const taggedKeyLine = `${core} ${HOST_TAG_PREFIX}${nodeId}`;
  let authorized = false;
  for (const targetFile of getAuthorizedKeyPaths(true)) {
    const r = replaceManagedHostKeyInFile(targetFile, taggedKeyLine);
    if (r.ok) authorized = true;
  }
  if (!authorized) {
    throw new Error('无法写入本机 SSH authorized_keys，请检查 ~/.ssh 目录权限');
  }

  try {
    fs.mkdirSync(GUEST_DATA_DIR, { recursive: true });
    fs.writeFileSync(
      HOST_PROFILE_FILE,
      JSON.stringify(
        {
          adminNodeId: nodeId,
          hostName: adminNode.nodeName || adminNode.hostname || 'smac-host',
          publicKey: pubKey,
          endpoints: Array.isArray(adminNode.endpoints) ? adminNode.endpoints : [],
          zerotierNetworkId: adminNode.zerotierNetworkId || '',
          importedAt: Date.now(),
        },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch {
    // non-fatal
  }

  const status = getGuestLocalStatus(pubKey);
  return {
    ok: true,
    sshAuthorized: true,
    authorizedAdminNodeId: nodeId,
    device: {
      deviceId: status.deviceId,
      deviceName: (customDeviceName || '').trim() || status.hostname,
      hostname: status.hostname,
      os: status.os,
      sshUser: status.sshUser,
      sshPort: status.sshPort,
      primaryIp: status.primaryIp,
      fallbackIp: status.fallbackIp,
      zerotierIp: status.zerotierIp,
      zerotierNetworkId: adminNode.zerotierNetworkId || '',
      targetAdminNodeId: nodeId,
      connected: true,
      sshAuthorized: true,
    },
  };
}

export function connectLocalToHost(
  hostBinding: HostBindingPayload,
  customDeviceName?: string,
) {
  return connectLocalToAdminNode(
    {
      id: 'legacy-host',
      nodeName: hostBinding.hostName || 'smac-host',
      publicKey: hostBinding.publicKey,
      endpoints: hostBinding.endpoints,
      zerotierNetworkId: hostBinding.zerotierNetworkId,
    },
    customDeviceName,
  );
}

export function disconnectLocalFromHost(hostPublicKey?: string): {
  ok: boolean;
  removedCount: number;
  deviceId: string;
} {
  const core = extractKeyCore(hostPublicKey || '');
  let removedCount = 0;
  for (const targetFile of getAuthorizedKeyPaths(false)) {
    const r = replaceManagedHostKeyInFile(targetFile, null, core || undefined);
    removedCount += r.removed;
  }
  return {
    ok: true,
    removedCount,
    deviceId: getOrCreateDeviceId(),
  };
}
