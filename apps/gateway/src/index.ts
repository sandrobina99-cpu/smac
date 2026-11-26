import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { pruneOldUsageLedger } from './db.js';
import { getUpstreamCredentials } from './upstream.js';

const config = loadConfig();
const gateway = createApp({
  dbPath: config.dbPath,
  masterKey: config.masterKey,
  adminUsername: config.adminUsername,
  adminPassword: config.adminPassword,
  upstreamBaseUrl: config.upstreamBaseUrl,
  upstreamApiKey: config.upstreamApiKey,
  publicBaseUrl: config.publicBaseUrl,
  defaultWeeklyTokenLimit: config.defaultWeeklyTokenLimit,
  silentBootstrap: false,
});

const server = gateway.app.listen(config.port, config.host, () => {
  console.log(
    `[sandrobina-gateway] Listening on http://${config.host}:${config.port}`,
  );
  console.log(`[sandrobina-gateway] Database: ${config.dbPath}`);

  const pruned = pruneOldUsageLedger(gateway.db, 90);
  if (pruned > 0) {
    console.log(`[sandrobina-gateway] Pruned ${pruned} legacy usage ledger rows (>90d)`);
  }

  const creds = getUpstreamCredentials(gateway.db, gateway.masterKey);
  if (creds.baseUrl && creds.apiKey) {
    gateway.upstream
      .syncModels()
      .then((res) => {
        console.log(
          `[sandrobina-gateway] Synced ${res.syncedCount} upstream models (${res.addedCount} new)`,
        );
      })
      .catch((err) => {
        console.warn(
          `[sandrobina-gateway] Initial model sync skipped/failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  } else {
    console.log(
      '[sandrobina-gateway] Upstream API key not set yet. Configure it in Admin -> Settings.',
    );
  }
});

// Background model sync every 15 minutes
const syncInterval = setInterval(() => {
  const creds = getUpstreamCredentials(gateway.db, gateway.masterKey);
  if (creds.baseUrl && creds.apiKey) {
    gateway.upstream.syncModels().catch(() => {
      // Non-fatal periodic sync failure
    });
  }
}, 15 * 60_000);
syncInterval.unref();

// Prune usage rows older than 90 days once every 24 hours
const pruneInterval = setInterval(() => {
  pruneOldUsageLedger(gateway.db, 90);
}, 24 * 3600_000);
pruneInterval.unref();

const shutdown = () => {
  clearInterval(syncInterval);
  clearInterval(pruneInterval);
  server.close(() => {
    gateway.close();
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
