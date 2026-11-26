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
}

const GUEST_DATA_DIR = path.join(os.homedir(), '.smac-guest');
const DEVICE_ID_FILE = path.join(GUEST_DATA_DIR, 'device-id');
const HOST_PROFILE_FILE = path.join(GUEST_DATA_DIR, 'host-profile.json');
const WIN_ADMIN_AUTH_KEYS = 'C:\\ProgramData\\ssh\\administrators_authorized_keys';

function detectPlatformLabel(): string {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
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
  const hostSlug = os
    .hostname()
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

  const all = [...lanIps, ...otherIps];
  return {
    primaryIp: all[0] || '',
    fallbackIp: all[1] || '',
    zerotierIp,
  };
}

function extractKeyCore(pubKey: string): string {
  const parts = String(pubKey || '').trim().split(/\s+/);
  if (parts.length >= 2 && parts[0].startsWith('ssh-')) {
    return `${parts[0]} ${parts[1]}`;
  }
  return '';
}

function getAuthorizedKeyPaths(): string[] {
  const userAuthKeys = path.join(os.homedir(), '.ssh', 'authorized_keys');
  if (process.platform === 'win32') {
    return [userAuthKeys, WIN_ADMIN_AUTH_KEYS];
  }
  return [userAuthKeys];
}

function hasPublicKeyInstalled(pubKey: string): boolean {
  const core = extractKeyCore(pubKey);
  if (!core) return false;
  for (const file of getAuthorizedKeyPaths()) {
    try {
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes(core)) return true;
    } catch {
      // ignore unreadable path
    }
  }
  return false;
}

function appendKeyToFile(filePath: string, keyLine: string, core: string): boolean {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    let existing = '';
    if (fs.existsSync(filePath)) {
      existing = fs.readFileSync(filePath, 'utf8');
    }
    if (existing.includes(core)) {
      return true;
    }
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(filePath, `${existing}${prefix}${keyLine}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

function removeKeyFromFile(filePath: string, core: string): number {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    let removed = 0;
    const kept = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      const matchCore = core ? trimmed.includes(core) : false;
      const matchTag = trimmed.includes('smac-host-managed');
      if (matchCore || (!core && matchTag)) {
        removed += 1;
        return false;
      }
      return true;
    });
    if (removed > 0) {
      fs.writeFileSync(filePath, `${kept.join('\n').replace(/\n+$/, '')}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
    return removed;
  } catch {
    return 0;
  }
}

export function getGuestLocalStatus(hostPublicKey?: string): GuestLocalStatus {
  const deviceId = getOrCreateDeviceId();
  const hostname = os.hostname();
  const ips = detectNetworkIps();
  let sshUser = '';
  try {
    sshUser = os.userInfo().username;
  } catch {
    sshUser = process.env.USER || process.env.USERNAME || '';
  }
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
    sshAuthorized: hostPublicKey ? hasPublicKeyInstalled(hostPublicKey) : false,
  };
}

export function connectLocalToHost(
  hostBinding: HostBindingPayload,
  customDeviceName?: string,
): {
  ok: boolean;
  sshAuthorized: boolean;
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
    connected: boolean;
    sshAuthorized: boolean;
  };
} {
  const pubKey = String(hostBinding?.publicKey || '').trim();
  const core = extractKeyCore(pubKey);
  if (!core) {
    throw new Error('主机尚未在网关发布有效的 SSH 公钥，请先在 smac 主机端登录管理员同步配置');
  }

  const taggedKeyLine = pubKey.includes('smac-host-managed')
    ? pubKey
    : `${core} smac-host-managed`;

  let authorized = false;
  for (const targetFile of getAuthorizedKeyPaths()) {
    if (appendKeyToFile(targetFile, taggedKeyLine, core)) {
      authorized = true;
    }
  }
  if (!authorized) {
    throw new Error('无法写入本机 SSH authorized_keys，请检查目录权限');
  }

  try {
    fs.mkdirSync(GUEST_DATA_DIR, { recursive: true });
    fs.writeFileSync(
      HOST_PROFILE_FILE,
      JSON.stringify(
        {
          hostName: hostBinding.hostName || 'smac-host',
          publicKey: pubKey,
          pairToken: hostBinding.pairToken || '',
          endpoints: Array.isArray(hostBinding.endpoints) ? hostBinding.endpoints : [],
          zerotierNetworkId: hostBinding.zerotierNetworkId || '',
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
      zerotierNetworkId: hostBinding.zerotierNetworkId || '',
      connected: true,
      sshAuthorized: true,
    },
  };
}

export function disconnectLocalFromHost(hostPublicKey?: string): {
  ok: boolean;
  removedCount: number;
  deviceId: string;
} {
  const core = extractKeyCore(hostPublicKey || '');
  let removedCount = 0;
  for (const targetFile of getAuthorizedKeyPaths()) {
    removedCount += removeKeyFromFile(targetFile, core);
  }
  return {
    ok: true,
    removedCount,
    deviceId: getOrCreateDeviceId(),
  };
}
