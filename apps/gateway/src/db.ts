import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { encryptSecret, hashPassword } from './security.js';

export interface SeedOptions {
  masterKey: Buffer;
  adminUsername: string;
  adminPassword: string;
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  publicBaseUrl: string;
  defaultWeeklyTokenLimit: number;
  silentBootstrap?: boolean;
}

export interface DbAdminRecord {
  id: number;
  username: string;
  password_hash: string;
  token_version: number;
  created_at: number;
  updated_at: number;
}

export interface DbUserRecord {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  token_version: number;
  api_key_enc: string;
  api_key_hash: string;
  api_key_prefix: string;
  enabled: number;
  weekly_token_limit: number;
  model_access_mode: 'all_except_denied' | 'allow_list';
  notes: string;
  created_at: number;
  updated_at: number;
}

export interface DbModelRecord {
  id: string;
  display_name: string;
  owned_by: string;
  context_length: number | null;
  multiplier: number;
  global_enabled: number;
  is_upstream_present: number;
  raw_data_json: string | null;
  raw_codex_json: string | null;
  synced_at: number;
  updated_at: number;
}

export interface DbGuestDeviceRecord {
  id: string;
  user_id: number;
  device_name: string;
  hostname: string;
  os: string;
  ssh_user: string;
  ssh_port: number;
  primary_ip: string;
  fallback_ip: string;
  zerotier_ip: string;
  zerotier_node_id: string;
  zerotier_network_id: string;
  connected: number;
  ssh_authorized: number;
  env_json: string | null;
  last_seen_at: number;
  created_at: number;
  updated_at: number;
}

/**
 * Opens the SQLite database using Node's built-in `node:sqlite` driver, initializes
 * schema/indexes, and seeds initial admin & system settings when absent.
 */
export function openDatabase(dbPath: string, seed: SeedOptions): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      token_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      token_version INTEGER NOT NULL DEFAULT 1,
      api_key_enc TEXT NOT NULL,
      api_key_hash TEXT UNIQUE NOT NULL,
      api_key_prefix TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      weekly_token_limit INTEGER NOT NULL DEFAULT 1000000,
      model_access_mode TEXT NOT NULL DEFAULT 'all_except_denied',
      notes TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      owned_by TEXT NOT NULL DEFAULT '',
      context_length INTEGER,
      multiplier REAL NOT NULL DEFAULT 1.0,
      global_enabled INTEGER NOT NULL DEFAULT 1,
      is_upstream_present INTEGER NOT NULL DEFAULT 1,
      raw_data_json TEXT,
      raw_codex_json TEXT,
      synced_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_model_permissions (
      user_id INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      allowed INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, model_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS usage_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      multiplier REAL NOT NULL DEFAULT 1.0,
      weighted_tokens INTEGER NOT NULL DEFAULT 0,
      status_code INTEGER NOT NULL DEFAULT 200,
      is_stream INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS guest_devices (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      device_name TEXT NOT NULL,
      hostname TEXT NOT NULL DEFAULT '',
      os TEXT NOT NULL DEFAULT '',
      ssh_user TEXT NOT NULL DEFAULT '',
      ssh_port INTEGER NOT NULL DEFAULT 22,
      primary_ip TEXT NOT NULL DEFAULT '',
      fallback_ip TEXT NOT NULL DEFAULT '',
      zerotier_ip TEXT NOT NULL DEFAULT '',
      zerotier_node_id TEXT NOT NULL DEFAULT '',
      zerotier_network_id TEXT NOT NULL DEFAULT '',
      connected INTEGER NOT NULL DEFAULT 1,
      ssh_authorized INTEGER NOT NULL DEFAULT 0,
      env_json TEXT,
      last_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_ledger(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_ledger(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_users_api_key_hash ON users(api_key_hash);
    CREATE INDEX IF NOT EXISTS idx_guest_devices_user ON guest_devices(user_id);

    CREATE TRIGGER IF NOT EXISTS enforce_single_admin
    BEFORE INSERT ON admins
    WHEN (SELECT COUNT(*) FROM admins) >= 1
    BEGIN
      SELECT RAISE(ABORT, 'only_one_admin_allowed');
    END;
  `);

  const now = Date.now();
  const adminCountRow = db
    .prepare('SELECT COUNT(*) AS cnt FROM admins')
    .get() as { cnt: number };
  if (adminCountRow.cnt === 0) {
    const initialPassword =
      seed.adminPassword || `admin_${crypto.randomBytes(8).toString('hex')}`;
    db.prepare(
      `INSERT INTO admins (username, password_hash, token_version, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)`,
    ).run(seed.adminUsername, hashPassword(initialPassword), now, now);

    if (!seed.silentBootstrap) {
      console.log('==========================================================');
      console.log('[sandrobina-gateway] Initial administrator account created');
      console.log(`  Username: ${seed.adminUsername}`);
      if (seed.adminPassword) {
        console.log('  Password: (loaded from ADMIN_PASSWORD env)');
      } else {
        console.log(`  Password: ${initialPassword}`);
      }
      console.log('==========================================================');
    }
  }

  const upsertDefaultSetting = db.prepare(
    `INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)`,
  );
  upsertDefaultSetting.run('upstream_base_url', seed.upstreamBaseUrl, now);
  upsertDefaultSetting.run(
    'upstream_api_key_enc',
    seed.upstreamApiKey ? encryptSecret(seed.upstreamApiKey, seed.masterKey) : '',
    now,
  );
  upsertDefaultSetting.run('public_base_url', seed.publicBaseUrl, now);
  upsertDefaultSetting.run(
    'default_weekly_token_limit',
    String(seed.defaultWeeklyTokenLimit),
    now,
  );
  upsertDefaultSetting.run('last_model_sync_at', '0', now);

  // If the stored upstream key is still empty and env now provides one, populate it.
  if (seed.upstreamApiKey) {
    const existing = getSetting(db, 'upstream_api_key_enc');
    if (!existing) {
      setSetting(
        db,
        'upstream_api_key_enc',
        encryptSecret(seed.upstreamApiKey, seed.masterKey),
      );
    }
  }

  return db;
}

export function getSetting(db: DatabaseSync, key: string): string {
  const row = db
    .prepare('SELECT value FROM system_settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

export function setSetting(db: DatabaseSync, key: string, value: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}

/**
 * Deletes `usage_ledger` rows older than `retentionDays` to keep SQLite compact.
 */
export function pruneOldUsageLedger(db: DatabaseSync, retentionDays = 90): number {
  const cutoff = Date.now() - Math.max(8, retentionDays) * 86_400_000;
  const result = db
    .prepare('DELETE FROM usage_ledger WHERE created_at < ?')
    .run(cutoff);
  return Number(result.changes) || 0;
}
