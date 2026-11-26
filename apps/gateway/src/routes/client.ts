import { DatabaseSync } from 'node:sqlite';
import express, { type Request, type Response } from 'express';
import type { ClientProfile, UsageLogRow } from '@sandrobina/shared';
import { getSetting, type DbUserRecord } from '../db.js';
import {
  deleteBoundDevice,
  listBoundDevicesForUser,
  markDeviceDisconnected,
  readHostBindingConfig,
  upsertBoundDevice,
} from '../devices.js';
import { hubEvents } from '../events.js';
import { getAllowedModelsForUser, getUserQuotaSnapshot } from '../quota.js';
import {
  decryptSecret,
  hashPassword,
  LoginRateLimiter,
  signSession,
  verifyPassword,
  verifySession,
} from '../security.js';
import type { UpstreamService } from '../upstream.js';

interface ClientRequest extends Request {
  clientUser?: DbUserRecord;
}

function resolvePublicBaseUrl(db: DatabaseSync, req: Request): string {
  const configured = getSetting(db, 'public_base_url').trim().replace(/\/+$/, '');
  const reqHost = req.get('host');
  if (configured) {
    const isDefaultLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/v1)?$/i.test(
      configured,
    );
    const reqIsRemote =
      Boolean(reqHost) && !/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(reqHost || '');
    if (!isDefaultLocal || !reqIsRemote) {
      return configured.endsWith('/v1') ? configured : `${configured}/v1`;
    }
  }
  if (reqHost) {
    const proto =
      (typeof req.headers['x-forwarded-proto'] === 'string'
        ? req.headers['x-forwarded-proto'].split(',')[0].trim()
        : req.protocol) || 'http';
    return `${proto}://${reqHost}/v1`;
  }
  return 'http://localhost:8787/v1';
}

export function buildClientProfile(
  db: DatabaseSync,
  masterKey: Buffer,
  user: DbUserRecord,
  req: Request,
): ClientProfile {
  const now = Date.now();
  const quota = getUserQuotaSnapshot(db, user.id, user.weekly_token_limit, now);
  const { allowedModels } = getAllowedModelsForUser(db, user);

  let apiKey = '';
  if (user.api_key_enc) {
    try {
      apiKey = decryptSecret(user.api_key_enc, masterKey);
    } catch {
      apiKey = '';
    }
  }

  const usageRows = db
    .prepare(
      `SELECT * FROM usage_ledger
       WHERE user_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 50`,
    )
    .all(user.id) as Array<{
    id: number;
    user_id: number;
    model_id: string;
    endpoint: string;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    multiplier: number;
    weighted_tokens: number;
    status_code: number;
    is_stream: number;
    latency_ms: number;
    created_at: number;
  }>;

  const recentUsage: UsageLogRow[] = usageRows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    modelId: r.model_id,
    endpoint: r.endpoint,
    promptTokens: Number(r.prompt_tokens) || 0,
    completionTokens: Number(r.completion_tokens) || 0,
    totalTokens: Number(r.total_tokens) || 0,
    multiplier: Number(r.multiplier) || 1,
    weightedTokens: Number(r.weighted_tokens) || 0,
    statusCode: Number(r.status_code) || 200,
    isStream: r.is_stream === 1,
    latencyMs: Number(r.latency_ms) || 0,
    createdAt: Number(r.created_at),
  }));

  const boundDevices = listBoundDevicesForUser(db, user);
  const hostBinding = user.enabled === 1 ? readHostBindingConfig(db, masterKey) : null;

  return {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name || user.username,
      enabled: user.enabled === 1,
      modelAccessMode: user.model_access_mode,
      createdAt: Number(user.created_at),
    },
    api: {
      baseUrl: resolvePublicBaseUrl(db, req),
      apiKey,
    },
    quota,
    models: allowedModels.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      ownedBy: m.ownedBy,
      contextLength: m.contextLength,
      multiplier: m.multiplier,
      supportedReasoningEfforts: m.supportedReasoningEfforts,
      defaultReasoningEffort: m.defaultReasoningEffort,
    })),
    recentUsage,
    hostBinding,
    boundDevices,
    serverTime: now,
  };
}

function extractClientToken(req: Request): string {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  if (typeof req.query.token === 'string' && req.query.token.trim()) {
    return req.query.token.trim();
  }
  return '';
}

/**
 * Creates the `/api/client` router for the Client desktop application.
 */
export function createClientRouter(
  db: DatabaseSync,
  masterKey: Buffer,
  upstream: UpstreamService,
): express.Router {
  const router = express.Router();
  const rateLimiter = new LoginRateLimiter();

  router.post('/login', (req: Request, res: Response) => {
    const ipKey = `client:${req.ip || 'unknown'}`;
    if (rateLimiter.isBlocked(ipKey)) {
      res.status(429).json({ error: '登录失败次数过多，请稍后再试' });
      return;
    }

    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) {
      res.status(400).json({ error: '请输入账号和密码' });
      return;
    }

    const user = db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username) as unknown as DbUserRecord | undefined;

    if (!user || !verifyPassword(password, user.password_hash)) {
      rateLimiter.recordFailure(ipKey);
      res.status(401).json({ error: '账号或密码错误' });
      return;
    }

    if (user.enabled !== 1) {
      res.status(403).json({ error: '您的账号已被管理员禁用，请联系管理员处理' });
      return;
    }

    rateLimiter.clear(ipKey);
    const token = signSession(
      {
        sub: user.id,
        role: 'client',
        username: user.username,
        tv: user.token_version,
      },
      masterKey,
    );

    res.json({
      token,
      profile: buildClientProfile(db, masterKey, user, req),
    });
  });

  // Authenticate client endpoints
  router.use((req: ClientRequest, res: Response, next) => {
    const token = extractClientToken(req);
    const claims = verifySession(token, masterKey);
    if (!claims || claims.role !== 'client') {
      res.status(401).json({ error: '登录已过期，请重新登录' });
      return;
    }

    const user = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(claims.sub) as unknown as DbUserRecord | undefined;

    if (!user || user.token_version !== claims.tv) {
      res.status(401).json({ error: '账号凭证已变更，请重新登录' });
      return;
    }
    if (user.enabled !== 1) {
      res.status(403).json({ error: '账号已被管理员禁用' });
      return;
    }

    req.clientUser = user;
    next();
  });

  router.get('/me', (req: ClientRequest, res: Response) => {
    res.json(buildClientProfile(db, masterKey, req.clientUser!, req));
  });

  router.post('/password', (req: ClientRequest, res: Response) => {
    const user = req.clientUser!;
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (!verifyPassword(currentPassword, user.password_hash)) {
      res.status(400).json({ error: '当前密码不正确' });
      return;
    }
    if (newPassword.length < 4) {
      res.status(400).json({ error: '新密码长度不能少于 4 位' });
      return;
    }

    const nextTv = user.token_version + 1;
    const now = Date.now();
    db.prepare(
      'UPDATE users SET password_hash = ?, token_version = ?, updated_at = ? WHERE id = ?',
    ).run(hashPassword(newPassword), nextTv, now, user.id);

    const token = signSession(
      {
        sub: user.id,
        role: 'client',
        username: user.username,
        tv: nextTv,
      },
      masterKey,
    );
    res.json({ ok: true, token });
  });

  router.post('/test-key', async (req: ClientRequest, res: Response) => {
    const user = req.clientUser!;
    const startedAt = Date.now();
    try {
      const { allowedModels } = getAllowedModelsForUser(db, user);
      const quota = getUserQuotaSnapshot(db, user.id, user.weekly_token_limit);
      await upstream.getModelsPayload(true);
      const latencyMs = Date.now() - startedAt;
      res.json({
        ok: true,
        allowedModelCount: allowedModels.length,
        sampleModels: allowedModels.slice(0, 5).map((m) => m.id),
        quotaRemaining: quota.remainingWeighted,
        isExhausted: quota.isExhausted,
        latencyMs,
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : '连接上游验证失败',
        latencyMs: Date.now() - startedAt,
      });
    }
  });

  // --- Guest Device Self-Binding under Logged-in Account (1 Account -> N Devices) ---
  router.get('/devices', (req: ClientRequest, res: Response) => {
    res.json({ devices: listBoundDevicesForUser(db, req.clientUser!) });
  });

  router.post('/devices/register', (req: ClientRequest, res: Response) => {
    const user = req.clientUser!;
    try {
      const device = upsertBoundDevice(
        db,
        user.id,
        {
          id: typeof req.body?.id === 'string' ? req.body.id : (typeof req.body?.deviceId === 'string' ? req.body.deviceId : undefined),
          deviceName: typeof req.body?.deviceName === 'string' ? req.body.deviceName : (typeof req.body?.name === 'string' ? req.body.name : undefined),
          hostname: typeof req.body?.hostname === 'string' ? req.body.hostname : undefined,
          os: typeof req.body?.os === 'string' ? req.body.os : undefined,
          sshUser: typeof req.body?.sshUser === 'string' ? req.body.sshUser : (typeof req.body?.user === 'string' ? req.body.user : undefined),
          sshPort: req.body?.sshPort !== undefined ? Number(req.body.sshPort) : undefined,
          primaryIp: typeof req.body?.primaryIp === 'string' ? req.body.primaryIp : undefined,
          fallbackIp: typeof req.body?.fallbackIp === 'string' ? req.body.fallbackIp : undefined,
          zerotierIp: typeof req.body?.zerotierIp === 'string' ? req.body.zerotierIp : undefined,
          zerotierNodeId: typeof req.body?.zerotierNodeId === 'string' ? req.body.zerotierNodeId : undefined,
          zerotierNetworkId: typeof req.body?.zerotierNetworkId === 'string' ? req.body.zerotierNetworkId : undefined,
          connected: req.body?.connected !== false,
          sshAuthorized: req.body?.sshAuthorized !== undefined ? Boolean(req.body.sshAuthorized) : true,
          env: req.body?.env && typeof req.body.env === 'object' ? (req.body.env as Record<string, unknown>) : undefined,
        },
        { isAdmin: false },
      );
      hubEvents.emitUserUpdated(user.id);
      res.json({
        ok: true,
        device,
        hostBinding: readHostBindingConfig(db, masterKey),
        devices: listBoundDevicesForUser(db, user),
      });
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode || 400;
      res.status(code).json({ error: err instanceof Error ? err.message : '注册客机失败' });
    }
  });

  router.post('/devices/:id/disconnect', (req: ClientRequest, res: Response) => {
    const user = req.clientUser!;
    const deviceId = decodeURIComponent(String(req.params.id || '')).trim();
    if (!deviceId) {
      res.status(400).json({ error: '缺少设备 ID' });
      return;
    }
    const updated = markDeviceDisconnected(db, deviceId, user.id);
    if (!updated) {
      res.status(404).json({ error: '当前账号下未找到该客机设备' });
      return;
    }
    hubEvents.emitUserUpdated(user.id);
    res.json({
      ok: true,
      device: updated,
      devices: listBoundDevicesForUser(db, user),
    });
  });

  router.delete('/devices/:id', (req: ClientRequest, res: Response) => {
    const user = req.clientUser!;
    const deviceId = decodeURIComponent(String(req.params.id || '')).trim();
    if (!deviceId) {
      res.status(400).json({ error: '缺少设备 ID' });
      return;
    }
    const result = deleteBoundDevice(db, deviceId, user.id);
    if (!result.deleted) {
      res.status(404).json({ error: '当前账号下未找到该客机设备' });
      return;
    }
    hubEvents.emitUserUpdated(user.id);
    res.json({ ok: true, devices: listBoundDevicesForUser(db, user) });
  });

  router.get('/stream', (req: ClientRequest, res: Response) => {
    const initialUser = req.clientUser!;
    const expectedTv = initialUser.token_version;

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const pushCurrentProfile = () => {
      if (res.writableEnded) return;
      const freshUser = db
        .prepare('SELECT * FROM users WHERE id = ?')
        .get(initialUser.id) as unknown as DbUserRecord | undefined;
      if (
        !freshUser ||
        freshUser.enabled !== 1 ||
        freshUser.token_version !== expectedTv
      ) {
        res.write(
          `event: unauthorized\ndata: ${JSON.stringify({ error: '账号已被停用或凭证已重置' })}\n\n`,
        );
        cleanup();
        res.end();
        return;
      }
      const profile = buildClientProfile(db, masterKey, freshUser, req);
      res.write(`event: profile\ndata: ${JSON.stringify(profile)}\n\n`);
    };

    const onUserUpdated = (updatedId: number) => {
      if (updatedId === initialUser.id) {
        pushCurrentProfile();
      }
    };

    const onModelsUpdated = () => {
      pushCurrentProfile();
    };

    hubEvents.on('user-updated', onUserUpdated);
    hubEvents.on('models-updated', onModelsUpdated);

    const keepaliveTimer = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': ping\n\n');
      }
    }, 25_000);
    keepaliveTimer.unref();

    // Refresh rolling 168h window every 60s so expired tokens release live
    const rollingRefreshTimer = setInterval(() => {
      pushCurrentProfile();
    }, 60_000);
    rollingRefreshTimer.unref();

    const cleanup = () => {
      clearInterval(keepaliveTimer);
      clearInterval(rollingRefreshTimer);
      hubEvents.off('user-updated', onUserUpdated);
      hubEvents.off('models-updated', onModelsUpdated);
    };

    res.on('close', cleanup);
    pushCurrentProfile();
  });

  return router;
}
