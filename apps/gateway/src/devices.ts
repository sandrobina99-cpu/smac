import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  AdminNodeInfo,
  GuestDeviceBinding,
  GuestDeviceCommand,
  HandshakeStatus,
  HostBindingConfig,
} from '@sandrobina/shared';
import {
  getSetting,
  setSetting,
  type DbAdminNodeRecord,
  type DbGuestDeviceRecord,
  type DbUserRecord,
} from './db.js';
import { decryptSecret, encryptSecret } from './security.js';

interface JoinedGuestDeviceRow extends DbGuestDeviceRecord {
  account_username: string;
  account_display_name: string;
  account_enabled: number;
}

export interface UpsertGuestDeviceInput {
  id?: string;
  deviceName?: string;
  hostname?: string;
  os?: string;
  sshUser?: string;
  sshPort?: number;
  primaryIp?: string;
  fallbackIp?: string;
  zerotierIp?: string;
  zerotierNodeId?: string;
  zerotierNetworkId?: string;
  connected?: boolean;
  sshAuthorized?: boolean;
  env?: Record<string, unknown> | null;
}

function mapDeviceRow(row: JoinedGuestDeviceRow): GuestDeviceBinding {
  let env: Record<string, unknown> | null = null;
  if (row.env_json) {
    try {
      const parsed = JSON.parse(row.env_json);
      if (parsed && typeof parsed === 'object') env = parsed as Record<string, unknown>;
    } catch {
      env = null;
    }
  }
  let pendingCommand: GuestDeviceCommand | null = null;
  if (row.pending_command_json) {
    try {
      const parsedCmd = JSON.parse(row.pending_command_json);
      if (parsedCmd && typeof parsedCmd === 'object') pendingCommand = parsedCmd as GuestDeviceCommand;
    } catch {
      pendingCommand = null;
    }
  }
  const rawHandshake = String(row.handshake_status || 'connected');
  const handshakeStatus: HandshakeStatus = (['pending', 'connected', 'disconnected', 'rejected'] as const).includes(
    rawHandshake as HandshakeStatus,
  )
    ? (rawHandshake as HandshakeStatus)
    : 'connected';
  return {
    id: row.id,
    userId: Number(row.user_id),
    hostAdminNodeId: row.host_admin_node_id || '',
    hostAdminName: row.host_admin_name || '',
    handshakeStatus,
    pendingCommand,
    accountUsername: row.account_username || '',
    accountDisplayName: row.account_display_name || row.account_username || '',
    accountEnabled: Number(row.account_enabled) === 1,
    deviceName: row.device_name || row.hostname || row.primary_ip || row.id,
    hostname: row.hostname || '',
    os: row.os || '',
    sshUser: row.ssh_user || '',
    sshPort: Number(row.ssh_port) || 22,
    primaryIp: row.primary_ip || '',
    fallbackIp: row.fallback_ip || '',
    zerotierIp: row.zerotier_ip || '',
    zerotierNodeId: row.zerotier_node_id || '',
    zerotierNetworkId: row.zerotier_network_id || '',
    connected: Number(row.connected) === 1,
    sshAuthorized: Number(row.ssh_authorized) === 1,
    env,
    lastSeenAt: Number(row.last_seen_at) || 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

export function listAllBoundDevices(
  db: DatabaseSync,
  filterUserId?: number | null,
): GuestDeviceBinding[] {
  const baseSql = `
    SELECT
      g.*,
      u.username AS account_username,
      u.display_name AS account_display_name,
      u.enabled AS account_enabled
    FROM guest_devices g
    INNER JOIN users u ON u.id = g.user_id
  `;
  const rows = filterUserId
    ? (db
        .prepare(`${baseSql} WHERE g.user_id = ? ORDER BY g.connected DESC, g.last_seen_at DESC`)
        .all(filterUserId) as unknown as JoinedGuestDeviceRow[])
    : (db
        .prepare(`${baseSql} ORDER BY g.connected DESC, g.last_seen_at DESC`)
        .all() as unknown as JoinedGuestDeviceRow[]);
  return rows.map(mapDeviceRow);
}

export function listBoundDevicesForUser(
  db: DatabaseSync,
  user: Pick<DbUserRecord, 'id'>,
): GuestDeviceBinding[] {
  return listAllBoundDevices(db, user.id);
}

export function getBoundDeviceById(
  db: DatabaseSync,
  deviceId: string,
): GuestDeviceBinding | null {
  const row = db
    .prepare(
      `SELECT
         g.*,
         u.username AS account_username,
         u.display_name AS account_display_name,
         u.enabled AS account_enabled
       FROM guest_devices g
       INNER JOIN users u ON u.id = g.user_id
       WHERE g.id = ?`,
    )
    .get(deviceId) as unknown as JoinedGuestDeviceRow | undefined;
  return row ? mapDeviceRow(row) : null;
}

export function upsertBoundDevice(
  db: DatabaseSync,
  userId: number,
  input: UpsertGuestDeviceInput,
  options: { isAdmin: boolean },
): GuestDeviceBinding {
  const rawId = String(input.id || '').trim();
  const id = rawId && /^[a-zA-Z0-9._:-]{3,96}$/.test(rawId)
    ? rawId
    : `dev_${crypto.randomBytes(10).toString('hex')}`;

  const existing = db
    .prepare('SELECT * FROM guest_devices WHERE id = ?')
    .get(id) as unknown as DbGuestDeviceRecord | undefined;

  if (existing && Number(existing.user_id) !== userId && !options.isAdmin) {
    const err = new Error('该客机设备已绑定到其他账号，如需更改归属请联系唯一管理员在主机管理端重新绑定') as Error & {
      statusCode?: number;
    };
    err.statusCode = 403;
    throw err;
  }

  const now = Date.now();
  const deviceName = String(input.deviceName || existing?.device_name || input.hostname || input.primaryIp || id).trim();
  const hostname = String(input.hostname ?? existing?.hostname ?? '').trim();
  const osLabel = String(input.os ?? existing?.os ?? '').trim();
  const sshUser = String(input.sshUser ?? existing?.ssh_user ?? '').trim();
  const sshPortRaw = Number(input.sshPort ?? existing?.ssh_port ?? 22);
  const sshPort = Number.isFinite(sshPortRaw) && sshPortRaw >= 1 && sshPortRaw <= 65535
    ? Math.floor(sshPortRaw)
    : 22;
  const primaryIp = String(input.primaryIp ?? existing?.primary_ip ?? '').trim();
  const fallbackIp = String(input.fallbackIp ?? existing?.fallback_ip ?? '').trim();
  const zerotierIp = String(input.zerotierIp ?? existing?.zerotier_ip ?? '').trim();
  const zerotierNodeId = String(input.zerotierNodeId ?? existing?.zerotier_node_id ?? '').trim();
  const zerotierNetworkId = String(input.zerotierNetworkId ?? existing?.zerotier_network_id ?? '').trim();
  const connected = input.connected !== undefined ? (input.connected ? 1 : 0) : (existing ? existing.connected : 1);
  const sshAuthorized = input.sshAuthorized !== undefined
    ? (input.sshAuthorized ? 1 : 0)
    : (existing ? existing.ssh_authorized : 0);
  const envJson = input.env !== undefined
    ? (input.env ? JSON.stringify(input.env) : null)
    : (existing?.env_json ?? null);

  if (existing) {
    db.prepare(
      `UPDATE guest_devices
       SET user_id = ?, device_name = ?, hostname = ?, os = ?, ssh_user = ?, ssh_port = ?,
           primary_ip = ?, fallback_ip = ?, zerotier_ip = ?, zerotier_node_id = ?,
           zerotier_network_id = ?, connected = ?, ssh_authorized = ?, env_json = ?,
           last_seen_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      userId,
      deviceName,
      hostname,
      osLabel,
      sshUser,
      sshPort,
      primaryIp,
      fallbackIp,
      zerotierIp,
      zerotierNodeId,
      zerotierNetworkId,
      connected,
      sshAuthorized,
      envJson,
      now,
      now,
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO guest_devices (
         id, user_id, device_name, hostname, os, ssh_user, ssh_port,
         primary_ip, fallback_ip, zerotier_ip, zerotier_node_id, zerotier_network_id,
         connected, ssh_authorized, env_json, last_seen_at, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      userId,
      deviceName,
      hostname,
      osLabel,
      sshUser,
      sshPort,
      primaryIp,
      fallbackIp,
      zerotierIp,
      zerotierNodeId,
      zerotierNetworkId,
      connected,
      sshAuthorized,
      envJson,
      now,
      now,
      now,
    );
  }

  return getBoundDeviceById(db, id)!;
}

export function reassignDeviceAccount(
  db: DatabaseSync,
  deviceId: string,
  targetUserId: number,
  patch?: { deviceName?: string; connected?: boolean },
): GuestDeviceBinding | null {
  const existing = db
    .prepare('SELECT * FROM guest_devices WHERE id = ?')
    .get(deviceId) as unknown as DbGuestDeviceRecord | undefined;
  if (!existing) return null;
  const now = Date.now();
  const nextName = patch?.deviceName !== undefined ? String(patch.deviceName).trim() || existing.device_name : existing.device_name;
  const nextConnected = patch?.connected !== undefined ? (patch.connected ? 1 : 0) : existing.connected;
  db.prepare(
    `UPDATE guest_devices
     SET user_id = ?, device_name = ?, connected = ?, updated_at = ?
     WHERE id = ?`,
  ).run(targetUserId, nextName, nextConnected, now, deviceId);
  return getBoundDeviceById(db, deviceId);
}

export function markDeviceDisconnected(
  db: DatabaseSync,
  deviceId: string,
  ownerUserId?: number,
): GuestDeviceBinding | null {
  const existing = db
    .prepare('SELECT * FROM guest_devices WHERE id = ?')
    .get(deviceId) as unknown as DbGuestDeviceRecord | undefined;
  if (!existing) return null;
  if (ownerUserId !== undefined && Number(existing.user_id) !== ownerUserId) {
    return null;
  }
  const now = Date.now();
  db.prepare(
    `UPDATE guest_devices
     SET connected = 0, ssh_authorized = 0, handshake_status = 'disconnected',
         host_admin_node_id = '', host_admin_name = '', updated_at = ?
     WHERE id = ?`,
  ).run(now, deviceId);
  return getBoundDeviceById(db, deviceId);
}

export function deleteBoundDevice(
  db: DatabaseSync,
  deviceId: string,
  ownerUserId?: number,
): { deleted: boolean; previousUserId: number | null } {
  const existing = db
    .prepare('SELECT user_id FROM guest_devices WHERE id = ?')
    .get(deviceId) as { user_id: number } | undefined;
  if (!existing) return { deleted: false, previousUserId: null };
  if (ownerUserId !== undefined && Number(existing.user_id) !== ownerUserId) {
    return { deleted: false, previousUserId: null };
  }
  db.prepare('DELETE FROM guest_devices WHERE id = ?').run(deviceId);
  return { deleted: true, previousUserId: Number(existing.user_id) };
}

export function readHostBindingConfig(
  db: DatabaseSync,
  masterKey: Buffer,
): HostBindingConfig | null {
  const raw = getSetting(db, 'host_binding_json');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HostBindingConfig>;
    let pairToken = '';
    const enc = getSetting(db, 'host_pair_token_enc');
    if (enc) {
      try {
        pairToken = decryptSecret(enc, masterKey);
      } catch {
        pairToken = '';
      }
    }
    const endpoints = Array.isArray(parsed.endpoints)
      ? parsed.endpoints.map((s) => String(s || '').trim()).filter(Boolean)
      : [];
    return {
      hostName: String(parsed.hostName || '').trim(),
      publicKey: String(parsed.publicKey || '').trim(),
      pairToken,
      endpoints,
      zerotierNetworkId: String(parsed.zerotierNetworkId || '').trim().toLowerCase(),
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch {
    return null;
  }
}

export function saveHostBindingConfig(
  db: DatabaseSync,
  masterKey: Buffer,
  patch: Partial<HostBindingConfig>,
): HostBindingConfig {
  const current = readHostBindingConfig(db, masterKey) || {
    hostName: '',
    publicKey: '',
    pairToken: '',
    endpoints: [],
    zerotierNetworkId: '',
    updatedAt: 0,
  };
  const now = Date.now();
  const nextHostName = patch.hostName !== undefined ? String(patch.hostName || '').trim() : current.hostName;
  const nextPublicKey = patch.publicKey !== undefined ? String(patch.publicKey || '').trim() : current.publicKey;
  const nextEndpoints = Array.isArray(patch.endpoints)
    ? Array.from(new Set(patch.endpoints.map((s) => String(s || '').trim().replace(/\/+$/, '')).filter(Boolean)))
    : current.endpoints;
  const nextZt = patch.zerotierNetworkId !== undefined
    ? String(patch.zerotierNetworkId || '').trim().toLowerCase()
    : current.zerotierNetworkId;
  const nextPairToken = typeof patch.pairToken === 'string' && patch.pairToken.trim()
    ? patch.pairToken.trim()
    : current.pairToken;

  setSetting(
    db,
    'host_binding_json',
    JSON.stringify({
      hostName: nextHostName,
      publicKey: nextPublicKey,
      endpoints: nextEndpoints,
      zerotierNetworkId: nextZt,
      updatedAt: now,
    }),
  );
  if (nextPairToken) {
    setSetting(db, 'host_pair_token_enc', encryptSecret(nextPairToken, masterKey));
  }
  return {
    hostName: nextHostName,
    publicKey: nextPublicKey,
    pairToken: nextPairToken,
    endpoints: nextEndpoints,
    zerotierNetworkId: nextZt,
    updatedAt: now,
  };
}


// ---------------------------------------------------------------------------
// Admin nodes (multiple machines logged into the single admin account)
// ---------------------------------------------------------------------------

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

function mapAdminNodeRow(row: DbAdminNodeRecord, now = Date.now()): AdminNodeInfo {
  let endpoints: string[] = [];
  try {
    const parsed = JSON.parse(row.endpoints_json || '[]');
    if (Array.isArray(parsed)) {
      endpoints = parsed.map((x) => String(x || '').trim()).filter(Boolean);
    }
  } catch {
    endpoints = [];
  }
  const lastSeenAt = Number(row.last_seen_at) || 0;
  return {
    id: row.id,
    nodeName: row.node_name || row.hostname || row.id,
    hostname: row.hostname || '',
    os: row.os || '',
    sshUser: row.ssh_user || '',
    sshPort: Number(row.ssh_port) || 22,
    primaryIp: row.primary_ip || '',
    fallbackIp: row.fallback_ip || '',
    zerotierIp: row.zerotier_ip || '',
    zerotierNodeId: row.zerotier_node_id || '',
    zerotierNetworkId: row.zerotier_network_id || '',
    publicKey: row.public_key || '',
    endpoints,
    online: now - lastSeenAt < ADMIN_NODE_ONLINE_MS,
    lastSeenAt,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

export const ADMIN_NODE_ONLINE_MS = 180_000;

export function listAdminNodes(db: DatabaseSync): AdminNodeInfo[] {
  const now = Date.now();
  const rows = db
    .prepare('SELECT * FROM admin_nodes ORDER BY last_seen_at DESC, created_at ASC')
    .all() as unknown as DbAdminNodeRecord[];
  return rows.map((r) => mapAdminNodeRow(r, now));
}

export function getAdminNodeById(db: DatabaseSync, nodeId: string): AdminNodeInfo | null {
  const row = db
    .prepare('SELECT * FROM admin_nodes WHERE id = ?')
    .get(nodeId) as unknown as DbAdminNodeRecord | undefined;
  return row ? mapAdminNodeRow(row) : null;
}

export interface UpsertAdminNodeInput {
  id?: string;
  nodeName?: string;
  hostname?: string;
  os?: string;
  sshUser?: string;
  sshPort?: number;
  primaryIp?: string;
  fallbackIp?: string;
  zerotierIp?: string;
  zerotierNodeId?: string;
  zerotierNetworkId?: string;
  publicKey?: string;
  endpoints?: string[];
}

export function upsertAdminNode(db: DatabaseSync, input: UpsertAdminNodeInput): AdminNodeInfo {
  const id = String(input.id || '').trim();
  if (!/^[a-zA-Z0-9._:-]{3,96}$/.test(id)) {
    throw httpError('管理员节点 ID 无效', 400);
  }
  const existing = db
    .prepare('SELECT * FROM admin_nodes WHERE id = ?')
    .get(id) as unknown as DbAdminNodeRecord | undefined;
  const now = Date.now();
  const str = (v: unknown, fallback: string) => String(v ?? fallback ?? '').trim();
  const hostname = str(input.hostname, existing?.hostname || '');
  const nodeName = str(input.nodeName, existing?.node_name || hostname || id) || hostname || id;
  const portRaw = Number(input.sshPort ?? existing?.ssh_port ?? 22);
  const sshPort = Number.isFinite(portRaw) && portRaw >= 1 && portRaw <= 65535 ? Math.floor(portRaw) : 22;
  const publicKey = str(input.publicKey, existing?.public_key || '').split(/\r?\n/)[0].trim();
  const endpoints = Array.isArray(input.endpoints)
    ? Array.from(new Set(input.endpoints.map((x) => String(x || '').trim()).filter(Boolean)))
    : (() => {
        try {
          return JSON.parse(existing?.endpoints_json || '[]') as string[];
        } catch {
          return [];
        }
      })();
  const vals = [
    nodeName,
    hostname,
    str(input.os, existing?.os || ''),
    str(input.sshUser, existing?.ssh_user || ''),
    sshPort,
    str(input.primaryIp, existing?.primary_ip || ''),
    str(input.fallbackIp, existing?.fallback_ip || ''),
    str(input.zerotierIp, existing?.zerotier_ip || ''),
    str(input.zerotierNodeId, existing?.zerotier_node_id || ''),
    str(input.zerotierNetworkId, existing?.zerotier_network_id || ''),
    publicKey,
    JSON.stringify(endpoints),
  ];
  if (existing) {
    db.prepare(
      `UPDATE admin_nodes SET node_name = ?, hostname = ?, os = ?, ssh_user = ?, ssh_port = ?,
         primary_ip = ?, fallback_ip = ?, zerotier_ip = ?, zerotier_node_id = ?, zerotier_network_id = ?,
         public_key = ?, endpoints_json = ?, last_seen_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(...(vals as [string, string, string, string, number, string, string, string, string, string, string, string]), now, now, id);
  } else {
    db.prepare(
      `INSERT INTO admin_nodes (id, node_name, hostname, os, ssh_user, ssh_port, primary_ip, fallback_ip,
         zerotier_ip, zerotier_node_id, zerotier_network_id, public_key, endpoints_json,
         last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, ...(vals as [string, string, string, string, number, string, string, string, string, string, string, string]), now, now, now);
  }
  return getAdminNodeById(db, id)!;
}

export function deleteAdminNode(db: DatabaseSync, nodeId: string): boolean {
  const info = db.prepare('DELETE FROM admin_nodes WHERE id = ?').run(nodeId);
  return Number(info.changes) > 0;
}

// ---------------------------------------------------------------------------
// Client handshake (direct host) + remote commands
// ---------------------------------------------------------------------------

export function requestClientHandshake(
  db: DatabaseSync,
  user: DbUserRecord,
  input: UpsertGuestDeviceInput & { targetAdminNodeId?: string },
): GuestDeviceBinding {
  const targetId = String(input.targetAdminNodeId || '').trim();
  const node = targetId ? getAdminNodeById(db, targetId) : null;
  if (!node) {
    throw httpError('目标管理员主机不存在或已被移除，请刷新主机列表后重试', 404);
  }
  const auto = Number(user.auto_approve_handshake) === 1;
  const device = upsertBoundDevice(
    db,
    user.id,
    { ...input, connected: auto, sshAuthorized: true },
    { isAdmin: false },
  );
  db.prepare(
    `UPDATE guest_devices
     SET host_admin_node_id = ?, host_admin_name = ?, handshake_status = ?,
         pending_command_json = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(node.id, node.nodeName, auto ? 'connected' : 'pending', Date.now(), device.id);
  return getBoundDeviceById(db, device.id)!;
}

export function reviewHandshake(
  db: DatabaseSync,
  deviceId: string,
  action: 'approve' | 'reject',
  actorAdminNodeId?: string,
): GuestDeviceBinding | null {
  const existing = db
    .prepare('SELECT * FROM guest_devices WHERE id = ?')
    .get(deviceId) as unknown as DbGuestDeviceRecord | undefined;
  if (!existing) return null;
  const hostId = String(existing.host_admin_node_id || '');
  if (actorAdminNodeId && hostId && hostId !== actorAdminNodeId) {
    throw httpError('仅限目标直连管理员主机审批该握手请求', 403);
  }
  const approve = action === 'approve';
  db.prepare(
    `UPDATE guest_devices
     SET handshake_status = ?, connected = ?, ssh_authorized = ?, updated_at = ?
     WHERE id = ?`,
  ).run(approve ? 'connected' : 'rejected', approve ? 1 : 0, approve ? 1 : 0, Date.now(), deviceId);
  return getBoundDeviceById(db, deviceId);
}

export function issueDeviceCommand(
  db: DatabaseSync,
  deviceId: string,
  command: GuestDeviceCommand,
): GuestDeviceBinding | null {
  const existing = db
    .prepare('SELECT id FROM guest_devices WHERE id = ?')
    .get(deviceId) as { id: string } | undefined;
  if (!existing) return null;
  db.prepare('UPDATE guest_devices SET pending_command_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(command),
    Date.now(),
    deviceId,
  );
  return getBoundDeviceById(db, deviceId);
}

export function ackDeviceCommand(
  db: DatabaseSync,
  deviceId: string,
  ownerUserId: number,
  result: { commandId: string; status: 'applied' | 'failed'; hostAdminNodeId?: string },
): GuestDeviceBinding | null {
  const existing = db
    .prepare('SELECT * FROM guest_devices WHERE id = ?')
    .get(deviceId) as unknown as DbGuestDeviceRecord | undefined;
  if (!existing || Number(existing.user_id) !== ownerUserId) return null;
  let pending: GuestDeviceCommand | null = null;
  if (existing.pending_command_json) {
    try {
      pending = JSON.parse(existing.pending_command_json) as GuestDeviceCommand;
    } catch {
      pending = null;
    }
  }
  if (pending && result.commandId && pending.id !== result.commandId) {
    return getBoundDeviceById(db, deviceId);
  }
  const now = Date.now();
  if (result.status === 'applied' && pending) {
    if (pending.type === 'switch_host') {
      const node = getAdminNodeById(db, String(result.hostAdminNodeId || pending.targetAdminNodeId || ''));
      db.prepare(
        `UPDATE guest_devices
         SET host_admin_node_id = ?, host_admin_name = ?, handshake_status = 'connected',
             connected = 1, ssh_authorized = 1, pending_command_json = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(node?.id || pending.targetAdminNodeId || '', node?.nodeName || pending.targetAdminName || '', now, deviceId);
    } else {
      db.prepare(
        `UPDATE guest_devices
         SET host_admin_node_id = '', host_admin_name = '', handshake_status = 'disconnected',
             connected = 0, ssh_authorized = 0, pending_command_json = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(now, deviceId);
    }
  } else {
    db.prepare('UPDATE guest_devices SET pending_command_json = NULL, updated_at = ? WHERE id = ?').run(now, deviceId);
  }
  return getBoundDeviceById(db, deviceId);
}
