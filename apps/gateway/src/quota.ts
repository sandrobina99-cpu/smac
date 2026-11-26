import { DatabaseSync } from 'node:sqlite';
import type { DailyBucket, ModelEntry, QuotaSnapshot } from '@sandrobina/shared';
import type { DbModelRecord, DbUserRecord } from './db.js';

export const ROLLING_WINDOW_HOURS = 168;
export const ROLLING_WINDOW_MS = ROLLING_WINDOW_HOURS * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export function toDateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function buildEmpty7DayBuckets(now = Date.now()): Map<string, DailyBucket> {
  const map = new Map<string, DailyBucket>();
  for (let offset = 6; offset >= 0; offset -= 1) {
    const key = toDateKey(now - offset * DAY_MS);
    map.set(key, {
      date: key,
      weightedTokens: 0,
      rawTokens: 0,
      requests: 0,
    });
  }
  return map;
}

/**
 * Computes weighted quota consumption from raw total tokens and the model multiplier.
 */
export function computeWeightedTokens(totalTokens: number, multiplier: number): number {
  const safeTokens = Math.max(0, Number(totalTokens) || 0);
  if (safeTokens <= 0) return 0;
  const safeMult = Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : 1;
  if (safeMult === 0) return 0;
  return Math.ceil(safeTokens * safeMult);
}

/**
 * Computes the strict 7x24-hour (168h) rolling quota snapshot for a given user.
 */
export function getUserQuotaSnapshot(
  db: DatabaseSync,
  userId: number,
  weeklyLimit: number,
  now = Date.now(),
): QuotaSnapshot {
  const windowStartAt = now - ROLLING_WINDOW_MS;
  const safeLimit = Math.max(0, Math.round(weeklyLimit));

  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(weighted_tokens), 0) AS used_weighted,
         COALESCE(SUM(total_tokens), 0) AS used_raw,
         COUNT(*) AS request_count
       FROM usage_ledger
       WHERE user_id = ? AND created_at > ?`,
    )
    .get(userId, windowStartAt) as {
    used_weighted: number;
    used_raw: number;
    request_count: number;
  };

  const usedWeighted = Math.max(0, Number(totals.used_weighted) || 0);
  const usedRaw = Math.max(0, Number(totals.used_raw) || 0);
  const requestCount = Number(totals.request_count) || 0;
  const remainingWeighted = Math.max(0, safeLimit - usedWeighted);
  const usagePercent =
    safeLimit > 0
      ? Math.min(100, Number(((usedWeighted / safeLimit) * 100).toFixed(2)))
      : usedWeighted > 0
        ? 100
        : 0;
  const isExhausted = safeLimit <= 0 ? true : usedWeighted >= safeLimit;

  const earliestRow = db
    .prepare(
      `SELECT MIN(created_at) AS min_ts
       FROM usage_ledger
       WHERE user_id = ? AND created_at > ? AND weighted_tokens > 0`,
    )
    .get(userId, windowStartAt) as { min_ts: number | null };

  let nextReleaseAt: number | null = null;
  let nextReleaseAmount = 0;
  if (earliestRow?.min_ts != null) {
    const minTs = Number(earliestRow.min_ts);
    nextReleaseAt = minTs + ROLLING_WINDOW_MS;
    const batchRow = db
      .prepare(
        `SELECT COALESCE(SUM(weighted_tokens), 0) AS amt
         FROM usage_ledger
         WHERE user_id = ? AND created_at > ? AND created_at <= ? AND weighted_tokens > 0`,
      )
      .get(userId, windowStartAt, minTs + 3600 * 1000) as { amt: number };
    nextReleaseAmount = Number(batchRow?.amt) || 0;
  }

  const release24Row = db
    .prepare(
      `SELECT COALESCE(SUM(weighted_tokens), 0) AS amt
       FROM usage_ledger
       WHERE user_id = ? AND created_at > ? AND created_at <= ? AND weighted_tokens > 0`,
    )
    .get(userId, windowStartAt, windowStartAt + DAY_MS) as { amt: number };
  const releasingIn24h = Number(release24Row?.amt) || 0;

  const rows = db
    .prepare(
      `SELECT created_at, weighted_tokens, total_tokens
       FROM usage_ledger
       WHERE user_id = ? AND created_at > ?
       ORDER BY created_at ASC`,
    )
    .all(userId, windowStartAt) as Array<{
    created_at: number;
    weighted_tokens: number;
    total_tokens: number;
  }>;

  const buckets = buildEmpty7DayBuckets(now);
  for (const row of rows) {
    const key = toDateKey(Number(row.created_at));
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.weightedTokens += Number(row.weighted_tokens) || 0;
      bucket.rawTokens += Number(row.total_tokens) || 0;
      bucket.requests += 1;
    }
  }

  return {
    windowHours: ROLLING_WINDOW_HOURS,
    windowStartAt,
    weeklyLimit: safeLimit,
    usedWeighted,
    usedRaw,
    remainingWeighted,
    usagePercent,
    requestCount,
    isExhausted,
    nextReleaseAt,
    nextReleaseAmount,
    releasingIn24h,
    dailyBreakdown: Array.from(buckets.values()),
  };
}

export function getGlobalDailyBreakdown(db: DatabaseSync, now = Date.now()): DailyBucket[] {
  const windowStartAt = now - ROLLING_WINDOW_MS;
  const rows = db
    .prepare(
      `SELECT created_at, weighted_tokens, total_tokens
       FROM usage_ledger
       WHERE created_at > ?
       ORDER BY created_at ASC`,
    )
    .all(windowStartAt) as Array<{
    created_at: number;
    weighted_tokens: number;
    total_tokens: number;
  }>;

  const buckets = buildEmpty7DayBuckets(now);
  for (const row of rows) {
    const key = toDateKey(Number(row.created_at));
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.weightedTokens += Number(row.weighted_tokens) || 0;
      bucket.rawTokens += Number(row.total_tokens) || 0;
      bucket.requests += 1;
    }
  }
  return Array.from(buckets.values());
}

export interface AllowedModelsResult {
  allowedSet: Set<string>;
  allowedModels: ModelEntry[];
  allEnabledCount: number;
  overridesMap: Record<string, boolean>;
}

export function extractReasoningMetadata(row: DbModelRecord): {
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
} {
  let supported: string[] | undefined;
  let defaultEffort: string | null | undefined;

  if (row.raw_data_json) {
    try {
      const parsed = JSON.parse(row.raw_data_json) as {
        model_info?: {
          supported_reasoning_efforts?: unknown;
          default_reasoning_effort?: unknown;
        };
      };
      const info = parsed?.model_info;
      if (info && Array.isArray(info.supported_reasoning_efforts)) {
        supported = info.supported_reasoning_efforts
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map((item) => item.trim());
      }
      if (info && typeof info.default_reasoning_effort === 'string' && info.default_reasoning_effort.trim()) {
        defaultEffort = info.default_reasoning_effort.trim();
      } else if (info && info.default_reasoning_effort === null) {
        defaultEffort = null;
      }
    } catch {
      // Ignore malformed JSON in raw_data_json
    }
  }

  if (supported === undefined && row.raw_codex_json) {
    try {
      const codex = JSON.parse(row.raw_codex_json) as {
        supported_reasoning_levels?: unknown;
        default_reasoning_level?: unknown;
      };
      if (Array.isArray(codex?.supported_reasoning_levels)) {
        const extracted = codex.supported_reasoning_levels
          .map((item) => {
            if (typeof item === 'string') return item.trim();
            if (item && typeof item === 'object' && typeof (item as { effort?: unknown }).effort === 'string') {
              return (item as { effort: string }).effort.trim();
            }
            return '';
          })
          .filter(Boolean);
        supported = extracted;
      }
      if (defaultEffort === undefined && typeof codex?.default_reasoning_level === 'string' && codex.default_reasoning_level.trim()) {
        defaultEffort = codex.default_reasoning_level.trim();
      }
    } catch {
      // Ignore malformed JSON in raw_codex_json
    }
  }

  if (supported === undefined) {
    if (row.id.toLowerCase().includes('image')) {
      return { supportedReasoningEfforts: [], defaultReasoningEffort: null };
    }
    return {
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: defaultEffort ?? 'medium',
    };
  }

  return {
    supportedReasoningEfforts: supported,
    defaultReasoningEffort:
      defaultEffort !== undefined ? defaultEffort : supported[0] ?? null,
  };
}

export function mapModelRow(row: DbModelRecord): ModelEntry {
  const reasoning = extractReasoningMetadata(row);
  return {
    id: row.id,
    displayName: row.display_name || row.id,
    ownedBy: row.owned_by || '',
    contextLength: row.context_length ?? null,
    multiplier: Number(row.multiplier),
    globalEnabled: row.global_enabled === 1,
    isUpstreamPresent: row.is_upstream_present === 1,
    syncedAt: Number(row.synced_at),
    updatedAt: Number(row.updated_at),
    supportedReasoningEfforts: reasoning.supportedReasoningEfforts,
    defaultReasoningEffort: reasoning.defaultReasoningEffort,
  };
}

/**
 * Resolves the effective list of allowed models for a specific user based on
 * global model status, `model_access_mode`, and per-user permission overrides.
 */
export function getAllowedModelsForUser(
  db: DatabaseSync,
  user: Pick<DbUserRecord, 'id' | 'model_access_mode'>,
): AllowedModelsResult {
  const modelRows = db
    .prepare('SELECT * FROM models WHERE global_enabled = 1 ORDER BY id ASC')
    .all() as unknown as DbModelRecord[];

  const permRows = db
    .prepare('SELECT model_id, allowed FROM user_model_permissions WHERE user_id = ?')
    .all(user.id) as Array<{ model_id: string; allowed: number }>;

  const permMap = new Map<string, boolean>();
  const overridesMap: Record<string, boolean> = {};
  for (const row of permRows) {
    const allowed = row.allowed === 1;
    permMap.set(row.model_id, allowed);
    overridesMap[row.model_id] = allowed;
  }

  const allowedSet = new Set<string>();
  const allowedModels: ModelEntry[] = [];

  for (const row of modelRows) {
    const explicit = permMap.get(row.id);
    const isAllowed =
      user.model_access_mode === 'allow_list' ? explicit === true : explicit !== false;
    if (isAllowed) {
      allowedSet.add(row.id);
      allowedModels.push(mapModelRow(row));
    }
  }

  return {
    allowedSet,
    allowedModels,
    allEnabledCount: modelRows.length,
    overridesMap,
  };
}
