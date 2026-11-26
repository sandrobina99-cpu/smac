import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import express, { type Request, type Response } from 'express';
import type {
  AdminOverview,
  AdminUserRow,
  GatewaySettings,
  GuestDeviceCommand,
  ModelAccessMode,
  ModelEntry,
  UsageLogRow,
} from '@sandrobina/shared';
import {
  getSetting,
  setSetting,
  type DbAdminRecord,
  type DbModelRecord,
  type DbUserRecord,
} from '../db.js';
import {
  deleteAdminNode,
  deleteBoundDevice,
  getAdminNodeById,
  issueDeviceCommand,
  listAdminNodes,
  listAllBoundDevices,
  markDeviceDisconnected,
  reviewHandshake,
  upsertAdminNode,
  listBoundDevicesForUser,
  readHostBindingConfig,
  reassignDeviceAccount,
  saveHostBindingConfig,
  upsertBoundDevice,
} from '../devices.js';
import { hubEvents } from '../events.js';
import {
  getAllowedModelsForUser,
  getGlobalDailyBreakdown,
  getUserQuotaSnapshot,
  mapModelRow,
  ROLLING_WINDOW_MS,
} from '../quota.js';
import {
  decryptSecret,
  encryptSecret,
  generateApiKey,
  hashApiKey,
  hashPassword,
  LoginRateLimiter,
  maskSecret,
  signSession,
  verifyPassword,
  verifySession,
} from '../security.js';
import { UpstreamService } from '../upstream.js';

interface AdminRequest extends Request {
  adminRecord?: DbAdminRecord;
}

function buildAdminUserRow(
  db: DatabaseSync,
  masterKey: Buffer,
  row: DbUserRecord,
  now = Date.now(),
): AdminUserRow {
  const quota = getUserQuotaSnapshot(db, row.id, row.weekly_token_limit, now);
  const { allowedSet, allEnabledCount, overridesMap } = getAllowedModelsForUser(db, row);
  let apiKey = '';
  if (row.api_key_enc) {
    try {
      apiKey = decryptSecret(row.api_key_enc, masterKey);
    } catch {
      apiKey = '';
    }
  }
  const boundDevices = listBoundDevicesForUser(db, row);
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    enabled: row.enabled === 1,
    weeklyTokenLimit: Number(row.weekly_token_limit),
    modelAccessMode: row.model_access_mode,
    notes: row.notes || '',
    apiKey,
    apiKeyPrefix: row.api_key_prefix,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    quota,
    allowedModelCount: allowedSet.size,
    totalActiveModelCount: allEnabledCount,
    modelOverrides: overridesMap,
    boundDevices,
    deviceCount: boundDevices.length,
    autoApproveHandshake: Number(row.auto_approve_handshake) === 1,
  };
}

function extractBearer(req: Request): string {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  if (typeof req.query?.token === 'string' && req.query.token.trim()) {
    return req.query.token.trim();
  }
  return '';
}

function parsePositiveInt(val: unknown): number | null {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}

/**
 * Creates the `/api/admin` management router.
 */
export function createAdminRouter(
  db: DatabaseSync,
  masterKey: Buffer,
  upstream: UpstreamService,
): express.Router {
  const router = express.Router();
  const rateLimiter = new LoginRateLimiter();

  router.post('/login', (req: Request, res: Response) => {
    const ipKey = `admin:${req.ip || 'unknown'}`;
    if (rateLimiter.isBlocked(ipKey)) {
      res.status(429).json({ error: '登录失败次数过多，请稍后再试' });
      return;
    }

    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) {
      res.status(400).json({ error: '请输入管理员账号和密码' });
      return;
    }

    const admin = db
      .prepare('SELECT * FROM admins WHERE username = ?')
      .get(username) as unknown as DbAdminRecord | undefined;

    if (!admin || !verifyPassword(password, admin.password_hash)) {
      rateLimiter.recordFailure(ipKey);
      res.status(401).json({ error: '管理员账号或密码错误' });
      return;
    }

    rateLimiter.clear(ipKey);
    const token = signSession(
      {
        sub: admin.id,
        role: 'admin',
        username: admin.username,
        tv: admin.token_version,
      },
      masterKey,
    );

    res.json({
      token,
      admin: {
        id: admin.id,
        username: admin.username,
      },
    });
  });

  // Require valid admin session for all subsequent routes
  router.use((req: AdminRequest, res: Response, next) => {
    const token = extractBearer(req);
    const claims = verifySession(token, masterKey);
    if (!claims || claims.role !== 'admin') {
      res.status(401).json({ error: '登录已失效，请重新登录管理端' });
      return;
    }

    const admin = db
      .prepare('SELECT * FROM admins WHERE id = ?')
      .get(claims.sub) as unknown as DbAdminRecord | undefined;
    if (!admin || admin.token_version !== claims.tv) {
      res.status(401).json({ error: '会话凭证已过期，请重新登录' });
      return;
    }

    req.adminRecord = admin;
    next();
  });

  router.get('/me', (req: AdminRequest, res: Response) => {
    const admin = req.adminRecord!;
    res.json({ id: admin.id, username: admin.username, role: 'super_admin', uniqueAdmin: true });
  });

  router.post('/password', (req: AdminRequest, res: Response) => {
    const admin = req.adminRecord!;
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (!verifyPassword(currentPassword, admin.password_hash)) {
      res.status(400).json({ error: '当前管理员密码不正确' });
      return;
    }
    if (newPassword.length < 6) {
      res.status(400).json({ error: '新密码长度不能少于 6 位' });
      return;
    }

    const nextVersion = admin.token_version + 1;
    const now = Date.now();
    db.prepare(
      'UPDATE admins SET password_hash = ?, token_version = ?, updated_at = ? WHERE id = ?',
    ).run(hashPassword(newPassword), nextVersion, now, admin.id);

    const token = signSession(
      {
        sub: admin.id,
        role: 'admin',
        username: admin.username,
        tv: nextVersion,
      },
      masterKey,
    );
    res.json({
      token,
      admin: { id: admin.id, username: admin.username },
    });
  });

  router.get('/overview', (_req: Request, res: Response) => {
    const now = Date.now();
    const windowStartAt = now - ROLLING_WINDOW_MS;

    const userCounts = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0) AS active
         FROM users`,
      )
      .get() as { total: number; active: number };

    const modelCounts = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN global_enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled
         FROM models`,
      )
      .get() as { total: number; enabled: number };

    const usageTotals = db
      .prepare(
        `SELECT
           COALESCE(SUM(weighted_tokens), 0) AS used_weighted,
           COALESCE(SUM(total_tokens), 0) AS used_raw,
           COUNT(*) AS requests
         FROM usage_ledger
         WHERE created_at > ?`,
      )
      .get(windowStartAt) as {
      used_weighted: number;
      used_raw: number;
      requests: number;
    };

    const topModelsRows = db
      .prepare(
        `SELECT
           u.model_id,
           COALESCE(m.display_name, u.model_id) AS display_name,
           COALESCE(m.multiplier, 1.0) AS multiplier,
           COALESCE(SUM(u.weighted_tokens), 0) AS weighted_tokens,
           COALESCE(SUM(u.total_tokens), 0) AS raw_tokens,
           COUNT(*) AS requests
         FROM usage_ledger u
         LEFT JOIN models m ON m.id = u.model_id
         WHERE u.created_at > ?
         GROUP BY u.model_id
         ORDER BY weighted_tokens DESC
         LIMIT 8`,
      )
      .all(windowStartAt) as Array<{
      model_id: string;
      display_name: string;
      multiplier: number;
      weighted_tokens: number;
      raw_tokens: number;
      requests: number;
    }>;

    const userRows = db
      .prepare('SELECT id, username, display_name, weekly_token_limit FROM users')
      .all() as Array<{
      id: number;
      username: string;
      display_name: string;
      weekly_token_limit: number;
    }>;

    const topUsers = userRows
      .map((u) => {
        const snap = getUserQuotaSnapshot(db, u.id, u.weekly_token_limit, now);
        return {
          userId: u.id,
          username: u.username,
          displayName: u.display_name || u.username,
          usedWeighted: snap.usedWeighted,
          weeklyLimit: snap.weeklyLimit,
          usagePercent: snap.usagePercent,
        };
      })
      .sort((a, b) => b.usedWeighted - a.usedWeighted)
      .slice(0, 8);

    const deviceCounts = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN connected = 1 THEN 1 ELSE 0 END), 0) AS connected
         FROM guest_devices`,
      )
      .get() as { total: number; connected: number };

    const lastSyncRaw = Number(getSetting(db, 'last_model_sync_at') || '0');
    const overview: AdminOverview = {
      totalUsers: Number(userCounts.total) || 0,
      activeUsers: Number(userCounts.active) || 0,
      totalModels: Number(modelCounts.total) || 0,
      enabledModels: Number(modelCounts.enabled) || 0,
      usedWeighted7d: Number(usageTotals.used_weighted) || 0,
      usedRaw7d: Number(usageTotals.used_raw) || 0,
      requests7d: Number(usageTotals.requests) || 0,
      dailyBreakdown: getGlobalDailyBreakdown(db, now),
      topModels: topModelsRows.map((r) => ({
        modelId: r.model_id,
        displayName: r.display_name,
        multiplier: Number(r.multiplier),
        weightedTokens: Number(r.weighted_tokens) || 0,
        rawTokens: Number(r.raw_tokens) || 0,
        requests: Number(r.requests) || 0,
      })),
      topUsers,
      lastModelSyncAt: lastSyncRaw > 0 ? lastSyncRaw : null,
      upstreamConfigured: Boolean(
        getSetting(db, 'upstream_base_url') && getSetting(db, 'upstream_api_key_enc'),
      ),
      totalBoundDevices: Number(deviceCounts.total) || 0,
      connectedDevices: Number(deviceCounts.connected) || 0,
      totalAdminNodes: listAdminNodes(db).length,
      onlineAdminNodes: listAdminNodes(db).filter((n) => n.online).length,
      pendingHandshakes:
        Number(
          (
            db
              .prepare("SELECT COUNT(*) AS c FROM guest_devices WHERE handshake_status = 'pending'")
              .get() as { c: number }
          ).c,
        ) || 0,
    };

    res.json(overview);
  });

  // --- Users CRUD & API Keys & Per-User Model ACL ---
  router.get('/users', (_req: Request, res: Response) => {
    const now = Date.now();
    const rows = db
      .prepare('SELECT * FROM users ORDER BY created_at DESC, id DESC')
      .all() as unknown as DbUserRecord[];
    const users = rows.map((row) => buildAdminUserRow(db, masterKey, row, now));
    res.json({ users });
  });

  router.get('/users/:id', (req: Request, res: Response) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      res.status(400).json({ error: '无效的用户 ID' });
      return;
    }
    const row = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id) as unknown as DbUserRecord | undefined;
    if (!row) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }
    res.json({ user: buildAdminUserRow(db, masterKey, row) });
  });

  router.post('/users', (req: Request, res: Response) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const displayName = String(req.body?.displayName || '').trim();
    const notes = String(req.body?.notes || '').trim();
    const enabled = req.body?.enabled !== false;
    const modelAccessMode: ModelAccessMode =
      req.body?.modelAccessMode === 'allow_list' ? 'allow_list' : 'all_except_denied';

    if (username.length < 2 || /\s/.test(username)) {
      res.status(400).json({ error: '用户名至少需要 2 个非空白字符' });
      return;
    }
    if (password.length < 4) {
      res.status(400).json({ error: '初始密码至少需要 4 位字符' });
      return;
    }

    const defaultLimit =
      Number(getSetting(db, 'default_weekly_token_limit')) || 1_000_000;
    const rawLimit =
      req.body?.weeklyTokenLimit !== undefined
        ? Number(req.body.weeklyTokenLimit)
        : defaultLimit;
    if (!Number.isFinite(rawLimit) || rawLimit < 0) {
      res.status(400).json({ error: '周限额必须是非负数字' });
      return;
    }

    const existing = db
      .prepare('SELECT id FROM users WHERE username = ?')
      .get(username) as { id: number } | undefined;
    if (existing) {
      res.status(409).json({ error: `用户名 "${username}" 已存在` });
      return;
    }

    const rawApiKey = generateApiKey();
    const now = Date.now();
    const result = db
      .prepare(
        `INSERT INTO users (
           username, display_name, password_hash, token_version,
           api_key_enc, api_key_hash, api_key_prefix, enabled,
           weekly_token_limit, model_access_mode, notes, created_at, updated_at
         )
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        username,
        displayName || username,
        hashPassword(password),
        encryptSecret(rawApiKey, masterKey),
        hashApiKey(rawApiKey),
        maskSecret(rawApiKey),
        enabled ? 1 : 0,
        Math.round(rawLimit),
        modelAccessMode,
        notes,
        now,
        now,
      );

    const createdId = Number(result.lastInsertRowid);
    if (req.body?.autoApproveHandshake !== undefined) {
      db.prepare('UPDATE users SET auto_approve_handshake = ? WHERE id = ?').run(
        req.body.autoApproveHandshake ? 1 : 0,
        createdId,
      );
    }
    if (
      req.body?.modelOverrides &&
      typeof req.body.modelOverrides === 'object'
    ) {
      const insertPerm = db.prepare(
        `INSERT INTO user_model_permissions (user_id, model_id, allowed, updated_at)
         VALUES (?, ?, ?, ?)`,
      );
      for (const [modelId, allowed] of Object.entries(
        req.body.modelOverrides as Record<string, unknown>,
      )) {
        if (typeof allowed === 'boolean') {
          insertPerm.run(createdId, modelId, allowed ? 1 : 0, now);
        }
      }
    }

    const row = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(createdId) as unknown as DbUserRecord;
    res.status(201).json({ user: buildAdminUserRow(db, masterKey, row) });
  });

  router.patch('/users/:id', (req: Request, res: Response) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      res.status(400).json({ error: '无效的用户 ID' });
      return;
    }
    const current = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id) as unknown as DbUserRecord | undefined;
    if (!current) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }

    const nextUsername =
      req.body?.username !== undefined
        ? String(req.body.username).trim()
        : current.username;
    if (nextUsername.length < 2 || /\s/.test(nextUsername)) {
      res.status(400).json({ error: '用户名至少需要 2 个非空白字符' });
      return;
    }
    if (nextUsername !== current.username) {
      const dup = db
        .prepare('SELECT id FROM users WHERE username = ? AND id != ?')
        .get(nextUsername, id);
      if (dup) {
        res.status(409).json({ error: `用户名 "${nextUsername}" 已被占用` });
        return;
      }
    }

    const nextDisplayName =
      req.body?.displayName !== undefined
        ? String(req.body.displayName).trim()
        : current.display_name;
    const nextNotes =
      req.body?.notes !== undefined ? String(req.body.notes).trim() : current.notes;
    const nextEnabled =
      req.body?.enabled !== undefined
        ? req.body.enabled
          ? 1
          : 0
        : current.enabled;
    const nextLimit =
      req.body?.weeklyTokenLimit !== undefined
        ? Number(req.body.weeklyTokenLimit)
        : current.weekly_token_limit;
    if (!Number.isFinite(nextLimit) || nextLimit < 0) {
      res.status(400).json({ error: '周限额必须是非负数字' });
      return;
    }
    const nextMode: ModelAccessMode =
      req.body?.modelAccessMode === 'allow_list'
        ? 'allow_list'
        : req.body?.modelAccessMode === 'all_except_denied'
          ? 'all_except_denied'
          : current.model_access_mode;

    const nextTv =
      nextEnabled === 0 && current.enabled === 1
        ? current.token_version + 1
        : current.token_version;

    const now = Date.now();
    db.prepare(
      `UPDATE users
       SET username = ?, display_name = ?, notes = ?, enabled = ?,
           weekly_token_limit = ?, model_access_mode = ?, token_version = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      nextUsername,
      nextDisplayName || nextUsername,
      nextNotes,
      nextEnabled,
      Math.round(nextLimit),
      nextMode,
      nextTv,
      now,
      id,
    );
    if (req.body?.autoApproveHandshake !== undefined) {
      db.prepare('UPDATE users SET auto_approve_handshake = ? WHERE id = ?').run(
        req.body.autoApproveHandshake ? 1 : 0,
        id,
      );
    }

    hubEvents.emitUserUpdated(id);
    const updated = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id) as unknown as DbUserRecord;
    res.json({ user: buildAdminUserRow(db, masterKey, updated) });
  });

  router.put('/users/:id/models', (req: Request, res: Response) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      res.status(400).json({ error: '无效的用户 ID' });
      return;
    }
    const current = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id) as unknown as DbUserRecord | undefined;
    if (!current) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }

    const mode: ModelAccessMode =
      req.body?.modelAccessMode === 'allow_list'
        ? 'allow_list'
        : req.body?.modelAccessMode === 'all_except_denied'
          ? 'all_except_denied'
          : current.model_access_mode;

    const overrides: Record<string, boolean> = {};
    if (req.body?.overrides && typeof req.body.overrides === 'object') {
      for (const [k, v] of Object.entries(
        req.body.overrides as Record<string, unknown>,
      )) {
        if (typeof v === 'boolean') {
          overrides[k] = v;
        }
      }
    } else if (Array.isArray(req.body?.allowedModelIds) && mode === 'allow_list') {
      for (const mId of req.body.allowedModelIds) {
        if (typeof mId === 'string' && mId.trim()) {
          overrides[mId.trim()] = true;
        }
      }
    } else if (
      Array.isArray(req.body?.disabledModelIds) &&
      mode === 'all_except_denied'
    ) {
      for (const mId of req.body.disabledModelIds) {
        if (typeof mId === 'string' && mId.trim()) {
          overrides[mId.trim()] = false;
        }
      }
    }

    const now = Date.now();
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE users SET model_access_mode = ?, updated_at = ? WHERE id = ?').run(
        mode,
        now,
        id,
      );
      db.prepare('DELETE FROM user_model_permissions WHERE user_id = ?').run(id);
      const insertStmt = db.prepare(
        `INSERT INTO user_model_permissions (user_id, model_id, allowed, updated_at)
         VALUES (?, ?, ?, ?)`,
      );
      for (const [modelId, allowed] of Object.entries(overrides)) {
        insertStmt.run(id, modelId, allowed ? 1 : 0, now);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    hubEvents.emitUserUpdated(id);
    const updated = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id) as unknown as DbUserRecord;
    res.json({ user: buildAdminUserRow(db, masterKey, updated) });
  });

  router.post('/users/:id/reset-password', (req: Request, res: Response) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      res.status(400).json({ error: '无效的用户 ID' });
      return;
    }
    const password = String(req.body?.password || '');
    if (password.length < 4) {
      res.status(400).json({ error: '密码长度不能少于 4 位' });
      return;
    }
    const current = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id) as unknown as DbUserRecord | undefined;
    if (!current) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }
    const now = Date.now();
    db.prepare(
      `UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(hashPassword(password), now, id);
    hubEvents.emitUserUpdated(id);
    res.json({ ok: true });
  });

  router.post('/users/:id/rotate-key', (req: Request, res: Response) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      res.status(400).json({ error: '无效的用户 ID' });
      return;
    }
    const current = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id) as unknown as DbUserRecord | undefined;
    if (!current) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }
    const newKey = generateApiKey();
    const now = Date.now();
    db.prepare(
      `UPDATE users
       SET api_key_enc = ?, api_key_hash = ?, api_key_prefix = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      encryptSecret(newKey, masterKey),
      hashApiKey(newKey),
      maskSecret(newKey),
      now,
      id,
    );
    hubEvents.emitUserUpdated(id);
    const updated = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id) as unknown as DbUserRecord;
    res.json({
      apiKey: newKey,
      user: buildAdminUserRow(db, masterKey, updated),
    });
  });

  router.post('/users/:id/reset-quota', (req: Request, res: Response) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      res.status(400).json({ error: '无效的用户 ID' });
      return;
    }
    const current = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id) as unknown as DbUserRecord | undefined;
    if (!current) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }
    const windowStartAt = Date.now() - ROLLING_WINDOW_MS;
    const result = db
      .prepare('DELETE FROM usage_ledger WHERE user_id = ? AND created_at > ?')
      .run(id, windowStartAt);
    hubEvents.emitUserUpdated(id);
    const updated = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id) as unknown as DbUserRecord;
    res.json({
      ok: true,
      clearedRecords: Number(result.changes) || 0,
      user: buildAdminUserRow(db, masterKey, updated),
    });
  });

  router.delete('/users/:id', (req: Request, res: Response) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      res.status(400).json({ error: '无效的用户 ID' });
      return;
    }
    const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
    if (info.changes === 0) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }
    res.json({ ok: true });
  });

  // --- Models & Multipliers ---
  router.get('/models', (_req: Request, res: Response) => {
    const now = Date.now();
    const windowStartAt = now - ROLLING_WINDOW_MS;

    const rows = db
      .prepare('SELECT * FROM models ORDER BY is_upstream_present DESC, id ASC')
      .all() as unknown as DbModelRecord[];

    const statRows = db
      .prepare(
        `SELECT
           model_id,
           COALESCE(SUM(weighted_tokens), 0) AS used_weighted,
           COALESCE(SUM(total_tokens), 0) AS used_raw,
           COUNT(*) AS requests
         FROM usage_ledger
         WHERE created_at > ?
         GROUP BY model_id`,
      )
      .all(windowStartAt) as Array<{
      model_id: string;
      used_weighted: number;
      used_raw: number;
      requests: number;
    }>;

    const statMap = new Map(statRows.map((s) => [s.model_id, s]));
    const models: ModelEntry[] = rows.map((row) => {
      const base = mapModelRow(row);
      const st = statMap.get(row.id);
      return {
        ...base,
        usedWeighted7d: st ? Number(st.used_weighted) || 0 : 0,
        usedRaw7d: st ? Number(st.used_raw) || 0 : 0,
        requests7d: st ? Number(st.requests) || 0 : 0,
      };
    });

    res.json({ models });
  });

  router.post('/models/sync', async (_req: Request, res: Response) => {
    try {
      const result = await upstream.syncModels();
      res.json({
        syncedCount: result.syncedCount,
        addedCount: result.addedCount,
        models: result.models.map(mapModelRow),
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : '同步上游模型失败',
      });
    }
  });

  router.post('/models', (req: Request, res: Response) => {
    const id = String(req.body?.id || '').trim();
    if (!id) {
      res.status(400).json({ error: '模型 ID 不能为空' });
      return;
    }
    const displayName = String(req.body?.displayName || id).trim() || id;
    const ownedBy = String(req.body?.ownedBy || 'custom').trim() || 'custom';
    const multiplier =
      req.body?.multiplier !== undefined ? Number(req.body.multiplier) : 1.0;
    if (!Number.isFinite(multiplier) || multiplier < 0) {
      res.status(400).json({ error: '倍率必须是非负数字' });
      return;
    }
    const globalEnabled = req.body?.globalEnabled !== false ? 1 : 0;
    const contextLength =
      req.body?.contextLength !== undefined && req.body.contextLength !== null
        ? Number(req.body.contextLength)
        : null;

    const now = Date.now();
    db.prepare(
      `INSERT INTO models (
         id, display_name, owned_by, context_length, multiplier,
         global_enabled, is_upstream_present, raw_data_json, raw_codex_json,
         synced_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         display_name = excluded.display_name,
         owned_by = excluded.owned_by,
         context_length = excluded.context_length,
         multiplier = excluded.multiplier,
         global_enabled = excluded.global_enabled,
         updated_at = excluded.updated_at`,
    ).run(
      id,
      displayName,
      ownedBy,
      contextLength !== null && Number.isFinite(contextLength)
        ? Math.round(contextLength)
        : null,
      multiplier,
      globalEnabled,
      now,
      now,
    );

    upstream.invalidateCache();
    hubEvents.emitModelsUpdated();
    const row = db
      .prepare('SELECT * FROM models WHERE id = ?')
      .get(id) as unknown as DbModelRecord;
    res.status(201).json({ model: mapModelRow(row) });
  });

  router.patch('/models/:id', (req: Request, res: Response) => {
    const id = decodeURIComponent(String(req.params.id || '')).trim();
    const current = db
      .prepare('SELECT * FROM models WHERE id = ?')
      .get(id) as unknown as DbModelRecord | undefined;
    if (!current) {
      res.status(404).json({ error: `模型 "${id}" 不存在` });
      return;
    }

    const nextDisplayName =
      req.body?.displayName !== undefined
        ? String(req.body.displayName).trim() || id
        : current.display_name;
    const nextMultiplier =
      req.body?.multiplier !== undefined
        ? Number(req.body.multiplier)
        : current.multiplier;
    if (!Number.isFinite(nextMultiplier) || nextMultiplier < 0) {
      res.status(400).json({ error: '模型倍率必须是非负数字（如 0.5、1.0、2.0）' });
      return;
    }
    const nextGlobalEnabled =
      req.body?.globalEnabled !== undefined
        ? req.body.globalEnabled
          ? 1
          : 0
        : current.global_enabled;
    const nextContextLength =
      req.body?.contextLength !== undefined
        ? req.body.contextLength === null || req.body.contextLength === ''
          ? null
          : Number(req.body.contextLength)
        : current.context_length;

    const now = Date.now();
    db.prepare(
      `UPDATE models
       SET display_name = ?, multiplier = ?, global_enabled = ?,
           context_length = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      nextDisplayName,
      nextMultiplier,
      nextGlobalEnabled,
      nextContextLength !== null && Number.isFinite(nextContextLength)
        ? Math.round(nextContextLength)
        : null,
      now,
      id,
    );

    upstream.invalidateCache();
    hubEvents.emitModelsUpdated();
    const updated = db
      .prepare('SELECT * FROM models WHERE id = ?')
      .get(id) as unknown as DbModelRecord;
    res.json({ model: mapModelRow(updated) });
  });

  // --- Usage Ledger ---
  router.get('/usage', (req: Request, res: Response) => {
    const userId = req.query.userId ? parsePositiveInt(req.query.userId) : null;
    const modelId =
      typeof req.query.modelId === 'string' && req.query.modelId.trim()
        ? req.query.modelId.trim()
        : null;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (userId) {
      conditions.push('l.user_id = ?');
      params.push(userId);
    }
    if (modelId) {
      conditions.push('l.model_id = ?');
      params.push(modelId);
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM usage_ledger l ${whereSql}`)
      .get(...params) as { cnt: number };

    const rows = db
      .prepare(
        `SELECT l.*, u.username, u.display_name
         FROM usage_ledger l
         LEFT JOIN users u ON u.id = l.user_id
         ${whereSql}
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<{
      id: number;
      user_id: number;
      username: string | null;
      display_name: string | null;
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

    const logs: UsageLogRow[] = rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username ?? undefined,
      displayName: r.display_name ?? undefined,
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

    res.json({ logs, total: Number(totalRow.cnt) || 0 });
  });

  // --- Gateway Settings ---
  router.get('/settings', (_req: Request, res: Response) => {
    res.json(readGatewaySettings(db, masterKey));
  });

  router.put('/settings', (req: Request, res: Response) => {
    if (req.body?.upstreamBaseUrl !== undefined) {
      const url = String(req.body.upstreamBaseUrl).trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(url)) {
        res.status(400).json({ error: '上游 API 地址必须以 http:// 或 https:// 开头' });
        return;
      }
      setSetting(db, 'upstream_base_url', url);
    }

    if (
      typeof req.body?.upstreamApiKey === 'string' &&
      req.body.upstreamApiKey.trim().length > 0
    ) {
      setSetting(
        db,
        'upstream_api_key_enc',
        encryptSecret(req.body.upstreamApiKey.trim(), masterKey),
      );
    }

    if (req.body?.publicBaseUrl !== undefined) {
      const pubUrl = String(req.body.publicBaseUrl).trim().replace(/\/+$/, '');
      if (pubUrl && !/^https?:\/\//i.test(pubUrl)) {
        res.status(400).json({ error: '对外 API 地址必须以 http:// 或 https:// 开头' });
        return;
      }
      setSetting(db, 'public_base_url', pubUrl);
    }

    if (req.body?.defaultWeeklyTokenLimit !== undefined) {
      const limit = Number(req.body.defaultWeeklyTokenLimit);
      if (!Number.isFinite(limit) || limit < 0) {
        res.status(400).json({ error: '默认周限额必须是非负数字' });
        return;
      }
      setSetting(db, 'default_weekly_token_limit', String(Math.round(limit)));
    }

    upstream.invalidateCache();
    res.json(readGatewaySettings(db, masterKey));
  });

  router.post('/settings/test-upstream', async (req: Request, res: Response) => {
    const baseUrl =
      typeof req.body?.upstreamBaseUrl === 'string'
        ? req.body.upstreamBaseUrl.trim()
        : undefined;
    const apiKey =
      typeof req.body?.upstreamApiKey === 'string' && req.body.upstreamApiKey.trim()
        ? req.body.upstreamApiKey.trim()
        : undefined;
    const result = await upstream.testConnection(baseUrl, apiKey);
    res.status(result.ok ? 200 : 502).json(result);
  });

  // --- Host SSH Pairing Profile (Unique Admin publishes Host binding config to Gateway) ---
  router.get('/host-binding', (_req: Request, res: Response) => {
    res.json({ hostBinding: readHostBindingConfig(db, masterKey) });
  });

  router.put('/host-binding', (req: Request, res: Response) => {
    const saved = saveHostBindingConfig(db, masterKey, {
      hostName: req.body?.hostName,
      publicKey: req.body?.publicKey,
      pairToken: req.body?.pairToken,
      endpoints: req.body?.endpoints,
      zerotierNetworkId: req.body?.zerotierNetworkId,
    });
    hubEvents.emitModelsUpdated();
    res.json({ ok: true, hostBinding: saved });
  });

  // --- Guest Devices bound under User Accounts (1 Account -> N Guest Devices, Admin Supreme Authority) ---
  router.get('/devices', (req: Request, res: Response) => {
    const userId = req.query.userId ? parsePositiveInt(req.query.userId) : null;
    const devices = listAllBoundDevices(db, userId);
    res.json({ devices });
  });

  router.post('/devices', (req: Request, res: Response) => {
    const userId = parsePositiveInt(req.body?.userId);
    if (!userId) {
      res.status(400).json({ error: '请选择要绑定的目标账号 (userId)' });
      return;
    }
    const userRow = db
      .prepare('SELECT id FROM users WHERE id = ?')
      .get(userId) as { id: number } | undefined;
    if (!userRow) {
      res.status(404).json({ error: '目标账号不存在' });
      return;
    }
    try {
      const device = upsertBoundDevice(db, userId, req.body || {}, { isAdmin: true });
      hubEvents.emitUserUpdated(userId);
      res.status(201).json({ ok: true, device });
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode || 400;
      res.status(code).json({ error: err instanceof Error ? err.message : '绑定客机失败' });
    }
  });

  router.patch('/devices/:id/bind', (req: Request, res: Response) => {
    const deviceId = decodeURIComponent(String(req.params.id || '')).trim();
    const userId = parsePositiveInt(req.body?.userId);
    if (!deviceId || !userId) {
      res.status(400).json({ error: '缺少设备 ID 或目标账号 ID' });
      return;
    }
    const userRow = db
      .prepare('SELECT id FROM users WHERE id = ?')
      .get(userId) as { id: number } | undefined;
    if (!userRow) {
      res.status(404).json({ error: '目标账号不存在' });
      return;
    }
    const prev = db
      .prepare('SELECT user_id FROM guest_devices WHERE id = ?')
      .get(deviceId) as { user_id: number } | undefined;
    if (!prev) {
      res.status(404).json({ error: '客机设备不存在' });
      return;
    }
    const updated = reassignDeviceAccount(db, deviceId, userId, {
      deviceName: typeof req.body?.deviceName === 'string' ? req.body.deviceName : undefined,
      connected: typeof req.body?.connected === 'boolean' ? req.body.connected : undefined,
    });
    if (Number(prev.user_id) !== userId) {
      hubEvents.emitUserUpdated(Number(prev.user_id));
    }
    hubEvents.emitUserUpdated(userId);
    res.json({ ok: true, device: updated });
  });

  router.delete('/devices/:id', (req: Request, res: Response) => {
    const deviceId = decodeURIComponent(String(req.params.id || '')).trim();
    if (!deviceId) {
      res.status(400).json({ error: '缺少设备 ID' });
      return;
    }
    const result = deleteBoundDevice(db, deviceId);
    if (!result.deleted) {
      res.status(404).json({ error: '客机设备不存在' });
      return;
    }
    if (result.previousUserId) {
      hubEvents.emitUserUpdated(result.previousUserId);
    }
    res.json({ ok: true });
  });


  // --- Admin nodes: multiple machines logged into the single admin account auto-mesh ---
  router.get('/nodes', (_req: Request, res: Response) => {
    res.json({ nodes: listAdminNodes(db) });
  });

  router.post('/nodes/register', (req: Request, res: Response) => {
    try {
      const b = (req.body || {}) as Record<string, unknown>;
      const node = upsertAdminNode(db, {
        id: typeof b.id === 'string' ? b.id : undefined,
        nodeName: typeof b.nodeName === 'string' ? b.nodeName : undefined,
        hostname: typeof b.hostname === 'string' ? b.hostname : undefined,
        os: typeof b.os === 'string' ? b.os : undefined,
        sshUser: typeof b.sshUser === 'string' ? b.sshUser : undefined,
        sshPort: b.sshPort !== undefined ? Number(b.sshPort) : undefined,
        primaryIp: typeof b.primaryIp === 'string' ? b.primaryIp : undefined,
        fallbackIp: typeof b.fallbackIp === 'string' ? b.fallbackIp : undefined,
        zerotierIp: typeof b.zerotierIp === 'string' ? b.zerotierIp : undefined,
        zerotierNodeId: typeof b.zerotierNodeId === 'string' ? b.zerotierNodeId : undefined,
        zerotierNetworkId: typeof b.zerotierNetworkId === 'string' ? b.zerotierNetworkId : undefined,
        publicKey: typeof b.publicKey === 'string' ? b.publicKey : undefined,
        endpoints: Array.isArray(b.endpoints) ? (b.endpoints as unknown[]).map((x) => String(x || '')) : undefined,
      });
      hubEvents.emitAdminNodesUpdated();
      res.json({ ok: true, node, nodes: listAdminNodes(db) });
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode || 400;
      res.status(code).json({ error: err instanceof Error ? err.message : '注册管理员节点失败' });
    }
  });

  router.delete('/nodes/:id', (req: Request, res: Response) => {
    const nodeId = decodeURIComponent(String(req.params.id || '')).trim();
    const deleted = deleteAdminNode(db, nodeId);
    if (deleted) hubEvents.emitAdminNodesUpdated();
    res.json({ ok: true, deleted });
  });

  router.get('/stream', (req: Request, res: Response) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const snapshot = () => ({ nodes: listAdminNodes(db), devices: listAllBoundDevices(db) });
    const push = (event: string) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(snapshot())}\n\n`);
    };
    const onNodes = () => push('admin-nodes');
    const onDevices = () => push('devices');
    hubEvents.on('admin-nodes-updated', onNodes);
    hubEvents.on('devices-updated', onDevices);

    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 25_000);
    keepalive.unref();

    const cleanup = () => {
      clearInterval(keepalive);
      hubEvents.off('admin-nodes-updated', onNodes);
      hubEvents.off('devices-updated', onDevices);
    };
    res.on('close', cleanup);
    push('snapshot');
  });

  // --- Handshake review & remote commands ---
  const reviewRoute = (action: 'approve' | 'reject') => (req: Request, res: Response) => {
    const deviceId = decodeURIComponent(String(req.params.id || '')).trim();
    try {
      const dev = reviewHandshake(
        db,
        deviceId,
        action,
        typeof req.body?.adminNodeId === 'string' ? req.body.adminNodeId : undefined,
      );
      if (!dev) {
        res.status(404).json({ error: '客机设备不存在' });
        return;
      }
      hubEvents.emitUserUpdated(dev.userId);
      hubEvents.emitDevicesUpdated();
      res.json({ ok: true, device: dev });
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode || 400;
      res.status(code).json({ error: err instanceof Error ? err.message : '操作失败' });
    }
  };
  router.post('/devices/:id/approve', reviewRoute('approve'));
  router.post('/devices/:id/reject', reviewRoute('reject'));

  router.post('/devices/:id/switch-host', (req: Request, res: Response) => {
    const deviceId = decodeURIComponent(String(req.params.id || '')).trim();
    const targetId = String(req.body?.targetAdminNodeId || '').trim();
    const target = targetId ? getAdminNodeById(db, targetId) : null;
    if (!target) {
      res.status(404).json({ error: '目标管理员主机不存在' });
      return;
    }
    const command: GuestDeviceCommand = {
      id: crypto.randomUUID(),
      type: 'switch_host',
      targetAdminNodeId: target.id,
      targetAdminName: target.nodeName,
      targetAdminPublicKey: target.publicKey,
      issuedByAdminNodeId: typeof req.body?.issuedByAdminNodeId === 'string' ? req.body.issuedByAdminNodeId : undefined,
      issuedAt: Date.now(),
    };
    const dev = issueDeviceCommand(db, deviceId, command);
    if (!dev) {
      res.status(404).json({ error: '客机设备不存在' });
      return;
    }
    hubEvents.emitDeviceCommand(dev.userId, dev.id, command);
    hubEvents.emitUserUpdated(dev.userId);
    hubEvents.emitDevicesUpdated();
    res.json({ ok: true, device: dev, command });
  });

  router.post('/devices/:id/force-disconnect', (req: Request, res: Response) => {
    const deviceId = decodeURIComponent(String(req.params.id || '')).trim();
    const disconnected = markDeviceDisconnected(db, deviceId);
    if (!disconnected) {
      res.status(404).json({ error: '客机设备不存在' });
      return;
    }
    const command: GuestDeviceCommand = {
      id: crypto.randomUUID(),
      type: 'force_disconnect',
      issuedByAdminNodeId: typeof req.body?.issuedByAdminNodeId === 'string' ? req.body.issuedByAdminNodeId : undefined,
      issuedAt: Date.now(),
    };
    const dev = issueDeviceCommand(db, deviceId, command) || disconnected;
    hubEvents.emitDeviceCommand(dev.userId, dev.id, command);
    hubEvents.emitUserUpdated(dev.userId);
    hubEvents.emitDevicesUpdated();
    res.json({ ok: true, device: dev, command });
  });

  return router;
}

function readGatewaySettings(db: DatabaseSync, masterKey: Buffer): GatewaySettings {
  const enc = getSetting(db, 'upstream_api_key_enc');
  let plain = '';
  if (enc) {
    try {
      plain = decryptSecret(enc, masterKey);
    } catch {
      plain = '';
    }
  }
  const lastSyncRaw = Number(getSetting(db, 'last_model_sync_at') || '0');
  return {
    upstreamBaseUrl: getSetting(db, 'upstream_base_url'),
    hasUpstreamApiKey: Boolean(plain),
    upstreamApiKeyMasked: plain ? maskSecret(plain) : '',
    publicBaseUrl: getSetting(db, 'public_base_url'),
    defaultWeeklyTokenLimit:
      Number(getSetting(db, 'default_weekly_token_limit')) || 1_000_000,
    lastModelSyncAt: lastSyncRaw > 0 ? lastSyncRaw : null,
  };
}
