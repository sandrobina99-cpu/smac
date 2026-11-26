import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import cors from 'cors';
import express, { type Express } from 'express';
import { openDatabase, type SeedOptions } from './db.js';
import { createAdminRouter } from './routes/admin.js';
import { createClientRouter } from './routes/client.js';
import { createProxyRouter } from './routes/proxy.js';
import { UpstreamService } from './upstream.js';

export interface CreateAppOptions extends Partial<SeedOptions> {
  dbPath?: string;
}

export interface GatewayInstance {
  app: Express;
  db: DatabaseSync;
  upstream: UpstreamService;
  masterKey: Buffer;
  close: () => void;
}

/**
 * Constructs a configured Express application, SQLite database instance,
 * and upstream proxy service. Used by both production startup and tests.
 */
export function createApp(options: CreateAppOptions = {}): GatewayInstance {
  const masterKey =
    options.masterKey ?? crypto.createHash('sha256').update('test-master-secret').digest();
  const dbPath = options.dbPath ?? ':memory:';
  const db = openDatabase(dbPath, {
    masterKey,
    adminUsername: options.adminUsername || 'admin',
    adminPassword: options.adminPassword || '',
    upstreamBaseUrl: options.upstreamBaseUrl || 'https://api.sandrobina.me/v1',
    upstreamApiKey: options.upstreamApiKey || '',
    publicBaseUrl: options.publicBaseUrl || 'http://localhost:8787/v1',
    defaultWeeklyTokenLimit: options.defaultWeeklyTokenLimit ?? 1_000_000,
    silentBootstrap: options.silentBootstrap ?? false,
  });

  const upstream = new UpstreamService(db, masterKey);
  const app = express();

  app.set('trust proxy', true);
  app.use(
    cors({
      origin: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'x-api-key'],
      exposedHeaders: [
        'Retry-After',
        'X-Quota-Limit',
        'X-Quota-Used',
        'X-Quota-Remaining',
        'X-Quota-Next-Release',
      ],
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'sandrobina-api-hub-gateway',
      time: Date.now(),
    });
  });

  // Mount /v1 proxy before express.json() so raw/multipart/SSE streams pass intact
  app.use('/v1', createProxyRouter(db, masterKey, upstream));

  app.use('/api', express.json({ limit: '4mb' }));
  app.use('/api/admin', createAdminRouter(db, masterKey, upstream));
  app.use('/api/client', createClientRouter(db, masterKey, upstream));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  return {
    app,
    db,
    upstream,
    masterKey,
    close: () => {
      db.close();
    },
  };
}
