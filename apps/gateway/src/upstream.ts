import { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import { getSetting, setSetting, type DbModelRecord } from './db.js';
import { hubEvents } from './events.js';
import { decryptSecret } from './security.js';

export const UPSTREAM_USER_AGENT = 'sandrobina-api-hub/1.0';
const MODELS_CACHE_TTL_MS = 30_000;

export interface ExtractedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  found: boolean;
}

export interface UpstreamCredentials {
  baseUrl: string;
  apiKey: string;
}

export function getUpstreamCredentials(
  db: DatabaseSync,
  masterKey: Buffer,
): UpstreamCredentials {
  const baseUrl = getSetting(db, 'upstream_base_url').trim().replace(/\/+$/, '');
  const enc = getSetting(db, 'upstream_api_key_enc').trim();
  let apiKey = '';
  if (enc) {
    try {
      apiKey = decryptSecret(enc, masterKey);
    } catch {
      apiKey = '';
    }
  }
  return { baseUrl, apiKey };
}

/**
 * Extracts normalized token counts from OpenAI Chat Completions and Responses API JSON objects.
 */
export function extractUsageFromJson(obj: unknown): ExtractedUsage {
  if (!obj || typeof obj !== 'object') {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, found: false };
  }
  const record = obj as Record<string, unknown>;
  const nestedResp =
    record.response && typeof record.response === 'object'
      ? (record.response as Record<string, unknown>)
      : null;

  const usageCandidate =
    (record.usage && typeof record.usage === 'object'
      ? (record.usage as Record<string, unknown>)
      : null) ??
    (nestedResp?.usage && typeof nestedResp.usage === 'object'
      ? (nestedResp.usage as Record<string, unknown>)
      : null);

  if (!usageCandidate) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, found: false };
  }

  const promptTokens = Number(
    usageCandidate.prompt_tokens ?? usageCandidate.input_tokens ?? 0,
  );
  const completionTokens = Number(
    usageCandidate.completion_tokens ?? usageCandidate.output_tokens ?? 0,
  );
  const rawTotal = Number(usageCandidate.total_tokens ?? 0);
  const safePrompt = Number.isFinite(promptTokens) && promptTokens >= 0 ? promptTokens : 0;
  const safeCompletion =
    Number.isFinite(completionTokens) && completionTokens >= 0 ? completionTokens : 0;
  const safeTotal =
    Number.isFinite(rawTotal) && rawTotal > 0
      ? rawTotal
      : safePrompt + safeCompletion;

  return {
    promptTokens: Math.round(safePrompt),
    completionTokens: Math.round(safeCompletion),
    totalTokens: Math.round(safeTotal),
    found: true,
  };
}

/**
 * Incrementally parses SSE chunks to capture token usage without buffering the stream.
 */
export class StreamUsageTracker {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private usage: ExtractedUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    found: false,
  };
  private streamedTextChars = 0;

  push(chunk: Uint8Array | Buffer): void {
    this.buffer += this.decoder.write(Buffer.from(chunk));
    this.drainLines(false);
  }

  finish(estimatedPromptTokens = 0): ExtractedUsage {
    this.buffer += this.decoder.end();
    this.drainLines(true);
    if (this.usage.found && this.usage.totalTokens > 0) {
      return this.usage;
    }
    if (this.streamedTextChars > 0) {
      const estOut = Math.max(1, Math.ceil(this.streamedTextChars / 4));
      const estIn = Math.max(0, estimatedPromptTokens);
      return {
        promptTokens: estIn,
        completionTokens: estOut,
        totalTokens: estIn + estOut,
        found: false,
      };
    }
    return this.usage;
  }

  private drainLines(flushTail: boolean): void {
    const lines = this.buffer.split(/\r?\n/);
    if (!flushTail) {
      this.buffer = lines.pop() ?? '';
    } else {
      this.buffer = '';
    }
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;
      try {
        const parsed = JSON.parse(dataStr) as Record<string, unknown>;
        const extracted = extractUsageFromJson(parsed);
        if (extracted.found) {
          this.usage = extracted;
        }
        this.accumulateDeltaChars(parsed);
      } catch {
        // Ignore partial or non-JSON SSE payloads.
      }
    }
  }

  private accumulateDeltaChars(parsed: Record<string, unknown>): void {
    const choices = parsed.choices;
    if (Array.isArray(choices)) {
      for (const ch of choices) {
        if (!ch || typeof ch !== 'object') continue;
        const delta = (ch as Record<string, unknown>).delta as
          | Record<string, unknown>
          | undefined;
        if (delta) {
          if (typeof delta.content === 'string') {
            this.streamedTextChars += delta.content.length;
          }
          if (typeof delta.reasoning_content === 'string') {
            this.streamedTextChars += delta.reasoning_content.length;
          }
        }
      }
    }
    if (typeof parsed.delta === 'string') {
      this.streamedTextChars += parsed.delta.length;
    } else if (typeof parsed.text === 'string') {
      this.streamedTextChars += parsed.text.length;
    }
  }
}

interface CachedModelsPayload {
  baseUrl: string;
  fetchedAt: number;
  payload: Record<string, unknown>;
}

export interface SyncModelsResult {
  syncedCount: number;
  addedCount: number;
  models: DbModelRecord[];
}

/**
 * Manages upstream model synchronization, `/v1/models` caching, and connection checks.
 */
export class UpstreamService {
  private modelsCache: CachedModelsPayload | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly masterKey: Buffer,
  ) {}

  invalidateCache(): void {
    this.modelsCache = null;
  }

  async syncModels(): Promise<SyncModelsResult> {
    const { baseUrl, apiKey } = getUpstreamCredentials(this.db, this.masterKey);
    if (!baseUrl || !apiKey) {
      throw new Error('请先在系统设置中配置上游 API 地址与 API Key');
    }

    const res = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'User-Agent': UPSTREAM_USER_AGENT,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`上游模型接口返回 HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const payload = (await res.json()) as Record<string, unknown>;
    const dataArr = Array.isArray(payload.data)
      ? (payload.data as Array<Record<string, unknown>>)
      : [];
    const codexArr = Array.isArray(payload.models)
      ? (payload.models as Array<Record<string, unknown>>)
      : [];

    const dataById = new Map<string, Record<string, unknown>>();
    for (const item of dataArr) {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (id) dataById.set(id, item);
    }

    const codexById = new Map<string, Record<string, unknown>>();
    for (const item of codexArr) {
      const id =
        typeof item?.slug === 'string'
          ? item.slug.trim()
          : typeof item?.id === 'string'
            ? item.id.trim()
            : '';
      if (id) codexById.set(id, item);
    }

    const allIds = Array.from(new Set([...dataById.keys(), ...codexById.keys()]));
    if (allIds.length === 0) {
      throw new Error('上游 /models 返回的模型列表为空');
    }

    const existingRows = this.db
      .prepare('SELECT id FROM models')
      .all() as Array<{ id: string }>;
    const existingSet = new Set(existingRows.map((r) => r.id));

    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE models SET is_upstream_present = 0, updated_at = ?').run(now);

      const upsertStmt = this.db.prepare(`
        INSERT INTO models (
          id, display_name, owned_by, context_length, multiplier,
          global_enabled, is_upstream_present, raw_data_json, raw_codex_json,
          synced_at, updated_at
        )
        VALUES (?, ?, ?, ?, 1.0, 1, 1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          owned_by = excluded.owned_by,
          context_length = excluded.context_length,
          is_upstream_present = 1,
          raw_data_json = excluded.raw_data_json,
          raw_codex_json = excluded.raw_codex_json,
          synced_at = excluded.synced_at,
          updated_at = excluded.updated_at
      `);

      for (const id of allIds) {
        const dItem = dataById.get(id);
        const cItem = codexById.get(id);
        const displayName =
          (typeof dItem?.display_name === 'string' && dItem.display_name.trim()) ||
          (typeof cItem?.display_name === 'string' && cItem.display_name.trim()) ||
          id;
        const ownedBy =
          (typeof dItem?.owned_by === 'string' && dItem.owned_by) || 'configured-upstream';
        const rawCtx =
          dItem?.context_length ??
          (dItem?.model_info as Record<string, unknown> | undefined)?.context_length ??
          cItem?.context_window ??
          null;
        const contextLength =
          typeof rawCtx === 'number' && Number.isFinite(rawCtx) ? Math.round(rawCtx) : null;

        upsertStmt.run(
          id,
          displayName,
          ownedBy,
          contextLength,
          dItem ? JSON.stringify(dItem) : null,
          cItem ? JSON.stringify(cItem) : null,
          now,
          now,
        );
      }

      setSetting(this.db, 'last_model_sync_at', String(now));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    this.modelsCache = { baseUrl, fetchedAt: now, payload };
    hubEvents.emitModelsUpdated();

    const addedCount = allIds.filter((id) => !existingSet.has(id)).length;
    const models = this.db
      .prepare('SELECT * FROM models ORDER BY id ASC')
      .all() as unknown as DbModelRecord[];

    return {
      syncedCount: allIds.length,
      addedCount,
      models,
    };
  }

  /**
   * Returns the raw upstream `/models` payload (cached briefly) or synthesizes
   * a compatible payload from locally synced models when upstream is unavailable.
   */
  async getModelsPayload(forceRefresh = false): Promise<Record<string, unknown>> {
    const { baseUrl, apiKey } = getUpstreamCredentials(this.db, this.masterKey);
    const now = Date.now();
    if (
      !forceRefresh &&
      this.modelsCache &&
      this.modelsCache.baseUrl === baseUrl &&
      now - this.modelsCache.fetchedAt < MODELS_CACHE_TTL_MS
    ) {
      return this.modelsCache.payload;
    }

    if (baseUrl && apiKey) {
      try {
        const res = await fetch(`${baseUrl}/models`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
            'User-Agent': UPSTREAM_USER_AGENT,
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const payload = (await res.json()) as Record<string, unknown>;
          this.modelsCache = { baseUrl, fetchedAt: now, payload };
          return payload;
        }
      } catch {
        // Fall through to DB-backed model list synthesis.
      }
    }

    const rows = this.db
      .prepare('SELECT * FROM models WHERE global_enabled = 1 ORDER BY id ASC')
      .all() as unknown as DbModelRecord[];

    const data: unknown[] = [];
    const models: unknown[] = [];
    for (const row of rows) {
      if (row.raw_data_json) {
        try {
          data.push(JSON.parse(row.raw_data_json));
        } catch {
          data.push(buildSyntheticModelData(row));
        }
      } else {
        data.push(buildSyntheticModelData(row));
      }
      if (row.raw_codex_json) {
        try {
          models.push(JSON.parse(row.raw_codex_json));
        } catch {
          // ignore invalid cached codex JSON
        }
      }
    }

    const synthesized: Record<string, unknown> = { object: 'list', data };
    if (models.length > 0) {
      synthesized.models = models;
    }
    return synthesized;
  }

  async testConnection(overrideBaseUrl?: string, overrideApiKey?: string): Promise<{
    ok: boolean;
    status: number;
    modelCount: number;
    latencyMs: number;
    error?: string;
  }> {
    const stored = getUpstreamCredentials(this.db, this.masterKey);
    const baseUrl = (overrideBaseUrl || stored.baseUrl).trim().replace(/\/+$/, '');
    const apiKey = (overrideApiKey || stored.apiKey).trim();
    if (!baseUrl || !apiKey) {
      return {
        ok: false,
        status: 0,
        modelCount: 0,
        latencyMs: 0,
        error: '上游地址或 API Key 为空',
      };
    }

    const started = Date.now();
    try {
      const res = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'User-Agent': UPSTREAM_USER_AGENT,
        },
        signal: AbortSignal.timeout(10_000),
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        return {
          ok: false,
          status: res.status,
          modelCount: 0,
          latencyMs,
          error: `HTTP ${res.status}: ${msg.slice(0, 200)}`,
        };
      }
      const json = (await res.json()) as Record<string, unknown>;
      const dataLen = Array.isArray(json.data) ? json.data.length : 0;
      const modelsLen = Array.isArray(json.models) ? json.models.length : 0;
      return {
        ok: true,
        status: res.status,
        modelCount: Math.max(dataLen, modelsLen),
        latencyMs,
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        modelCount: 0,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export function buildSyntheticModelData(row: DbModelRecord): Record<string, unknown> {
  return {
    id: row.id,
    object: 'model',
    created: Math.floor((row.synced_at || Date.now()) / 1000),
    owned_by: row.owned_by || 'sandrobina-hub',
    display_name: row.display_name || row.id,
    context_length: row.context_length ?? undefined,
  };
}
