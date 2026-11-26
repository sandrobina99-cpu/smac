import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

export interface GatewayConfig {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  masterKey: Buffer;
  adminUsername: string;
  adminPassword: string;
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  publicBaseUrl: string;
  defaultWeeklyTokenLimit: number;
}

/**
 * Loads `.env` from the current directory and monorepo root without overriding
 * explicitly set environment variables.
 */
export function loadEnvFiles(): void {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../.env'),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath, override: false });
    }
  }
}

/**
 * Derives a 32-byte AES/HMAC master key from MASTER_SECRET or a persisted
 * `.master.key` file inside `dataDir`.
 */
export function resolveMasterKey(dataDir: string, explicitSecret?: string): Buffer {
  const envSecret = (explicitSecret ?? process.env.MASTER_SECRET ?? '').trim();
  if (envSecret) {
    return crypto.createHash('sha256').update(envSecret, 'utf8').digest();
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const keyFile = path.join(dataDir, '.master.key');
  if (fs.existsSync(keyFile)) {
    const raw = fs.readFileSync(keyFile, 'utf8').trim();
    if (raw.length >= 32) {
      return crypto.createHash('sha256').update(raw, 'utf8').digest();
    }
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keyFile, `${generated}\n`, { mode: 0o600 });
  return crypto.createHash('sha256').update(generated, 'utf8').digest();
}

export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/**
 * Builds the runtime gateway configuration from environment variables and defaults.
 */
export function loadConfig(): GatewayConfig {
  loadEnvFiles();
  const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR || './data');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = Math.max(1, Number.parseInt(process.env.PORT || '8787', 10) || 8787);
  const host = (process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';
  const defaultLimit = Number.parseInt(
    process.env.DEFAULT_WEEKLY_TOKEN_LIMIT || '1000000',
    10,
  );
  return {
    port,
    host,
    dataDir,
    dbPath: path.join(dataDir, 'hub.db'),
    masterKey: resolveMasterKey(dataDir),
    adminUsername: (process.env.ADMIN_USERNAME || 'admin').trim() || 'admin',
    adminPassword: (process.env.ADMIN_PASSWORD || '').trim(),
    upstreamBaseUrl: normalizeBaseUrl(
      process.env.UPSTREAM_BASE_URL || 'https://api.sandrobina.me/v1',
    ),
    upstreamApiKey: (process.env.UPSTREAM_API_KEY || '').trim(),
    publicBaseUrl: normalizeBaseUrl(
      process.env.PUBLIC_BASE_URL || `http://localhost:${port}/v1`,
    ),
    defaultWeeklyTokenLimit:
      Number.isFinite(defaultLimit) && defaultLimit > 0 ? defaultLimit : 1_000_000,
  };
}
