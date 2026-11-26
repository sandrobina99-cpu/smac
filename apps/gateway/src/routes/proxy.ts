import { DatabaseSync } from 'node:sqlite';
import express, { type Request, type Response } from 'express';
import { type DbModelRecord, type DbUserRecord } from '../db.js';
import { hubEvents } from '../events.js';
import {
  computeWeightedTokens,
  getAllowedModelsForUser,
  getUserQuotaSnapshot,
} from '../quota.js';
import { hashApiKey } from '../security.js';
import {
  buildSyntheticModelData,
  extractUsageFromJson,
  getUpstreamCredentials,
  StreamUsageTracker,
  UPSTREAM_USER_AGENT,
  UpstreamService,
} from '../upstream.js';

interface ProxyRequest extends Request {
  proxyUser?: DbUserRecord;
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

function extractBearerApiKey(req: Request): string {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const alt = req.headers['x-api-key'];
  if (typeof alt === 'string') {
    return alt.trim();
  }
  return '';
}

function sendOpenAIError(
  res: Response,
  status: number,
  message: string,
  type: string,
  code: string,
  param: string | null = null,
): void {
  res.status(status).json({
    error: {
      message,
      type,
      param,
      code,
    },
  });
}

function estimatePromptTokens(body: Record<string, unknown> | null): number {
  if (!body) return 0;
  try {
    const serialized = JSON.stringify(body.messages ?? body.input ?? body.prompt ?? '');
    return serialized.length > 2 ? Math.max(1, Math.ceil(serialized.length / 4)) : 0;
  } catch {
    return 0;
  }
}

function copySafeUpstreamHeaders(upstreamHeaders: Headers, res: Response): void {
  upstreamHeaders.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });
}

function setQuotaHeaders(
  res: Response,
  quota: ReturnType<typeof getUserQuotaSnapshot>,
): void {
  res.setHeader('X-Quota-Limit', String(quota.weeklyLimit));
  res.setHeader('X-Quota-Used', String(quota.usedWeighted));
  res.setHeader('X-Quota-Remaining', String(quota.remainingWeighted));
  if (quota.nextReleaseAt) {
    res.setHeader('X-Quota-Next-Release', new Date(quota.nextReleaseAt).toISOString());
  }
}

/**
 * Creates the OpenAI-compatible `/v1` API proxy router enforcing per-user API key auth,
 * per-user model ACL filtering, and strict 7x24h rolling token quotas.
 */
export function createProxyRouter(
  db: DatabaseSync,
  masterKey: Buffer,
  upstream: UpstreamService,
): express.Router {
  const router = express.Router();

  // Authenticate all `/v1/*` requests with a distributed user API key
  router.use((req: ProxyRequest, res: Response, next) => {
    const rawKey = extractBearerApiKey(req);
    if (!rawKey) {
      sendOpenAIError(
        res,
        401,
        'Missing API key in Authorization header.',
        'authentication_error',
        'missing_api_key',
      );
      return;
    }

    const user = db
      .prepare('SELECT * FROM users WHERE api_key_hash = ?')
      .get(hashApiKey(rawKey)) as unknown as DbUserRecord | undefined;

    if (!user) {
      sendOpenAIError(
        res,
        401,
        'Invalid API key provided.',
        'authentication_error',
        'invalid_api_key',
      );
      return;
    }

    if (user.enabled !== 1) {
      sendOpenAIError(
        res,
        403,
        'This account has been disabled by the administrator.',
        'permission_error',
        'account_disabled',
      );
      return;
    }

    req.proxyUser = user;
    next();
  });

  // Filtered model discovery: removes disabled models from BOTH `data` and Codex `models`
  router.get('/models', async (req: ProxyRequest, res: Response) => {
    const user = req.proxyUser!;
    const { allowedSet, allowedModels } = getAllowedModelsForUser(db, user);
    const payload = await upstream.getModelsPayload();

    const filtered: Record<string, unknown> = { ...payload, object: 'list' };

    const rawData = Array.isArray(payload.data)
      ? (payload.data as Array<Record<string, unknown>>)
      : [];
    const filteredData = rawData.filter((item) =>
      allowedSet.has(String(item?.id ?? '')),
    );
    const presentIds = new Set(filteredData.map((item) => String(item?.id ?? '')));

    for (const allowed of allowedModels) {
      if (!presentIds.has(allowed.id)) {
        const dbRow = db
          .prepare('SELECT * FROM models WHERE id = ?')
          .get(allowed.id) as unknown as DbModelRecord | undefined;
        if (dbRow) {
          filteredData.push(buildSyntheticModelData(dbRow));
        }
      }
    }
    filtered.data = filteredData;

    if (Array.isArray(payload.models)) {
      filtered.models = (payload.models as Array<Record<string, unknown>>).filter(
        (item) => allowedSet.has(String(item?.slug ?? item?.id ?? '')),
      );
    }

    res.json(filtered);
  });

  router.get('/models/:modelId', async (req: ProxyRequest, res: Response) => {
    const user = req.proxyUser!;
    const modelId = String(req.params.modelId || '');
    const { allowedSet } = getAllowedModelsForUser(db, user);
    if (!allowedSet.has(modelId)) {
      sendOpenAIError(
        res,
        404,
        `The model '${modelId}' does not exist or is not enabled for your account.`,
        'invalid_request_error',
        'model_not_found',
        'model',
      );
      return;
    }

    const payload = await upstream.getModelsPayload();
    const rawData = Array.isArray(payload.data)
      ? (payload.data as Array<Record<string, unknown>>)
      : [];
    const matched = rawData.find((item) => String(item?.id ?? '') === modelId);
    if (matched) {
      res.json(matched);
      return;
    }

    const dbRow = db
      .prepare('SELECT * FROM models WHERE id = ?')
      .get(modelId) as unknown as DbModelRecord | undefined;
    if (dbRow && dbRow.global_enabled === 1) {
      res.json(buildSyntheticModelData(dbRow));
      return;
    }

    sendOpenAIError(
      res,
      404,
      `The model '${modelId}' does not exist.`,
      'invalid_request_error',
      'model_not_found',
      'model',
    );
  });

  // Catch-all OpenAI / Codex proxy handler
  router.use(
    express.raw({ type: '*/*', limit: '64mb' }),
    async (req: ProxyRequest, res: Response) => {
      const user = req.proxyUser!;
      const startedAt = Date.now();
      const subPath = req.url.startsWith('/') ? req.url : `/${req.url}`;
      const endpointPath = subPath.split('?')[0] || '/';
      const contentType = String(req.headers['content-type'] || '');
      const isJsonBody =
        contentType.toLowerCase().includes('application/json') &&
        Buffer.isBuffer(req.body) &&
        req.body.length > 0;

      let parsedBody: Record<string, unknown> | null = null;
      if (isJsonBody) {
        try {
          const decoded = JSON.parse((req.body as Buffer).toString('utf8'));
          if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
            parsedBody = decoded as Record<string, unknown>;
          }
        } catch {
          sendOpenAIError(
            res,
            400,
            'Invalid JSON request body.',
            'invalid_request_error',
            'invalid_json',
          );
          return;
        }
      }

      const requestedModel =
        typeof parsedBody?.model === 'string' ? parsedBody.model.trim() : '';
      const requiresModel =
        endpointPath === '/chat/completions' ||
        endpointPath === '/responses' ||
        endpointPath === '/completions' ||
        endpointPath === '/embeddings' ||
        endpointPath === '/images/generations';

      if (requiresModel && !requestedModel) {
        sendOpenAIError(
          res,
          400,
          'Missing required parameter: model.',
          'invalid_request_error',
          'missing_model',
          'model',
        );
        return;
      }

      const { allowedSet } = getAllowedModelsForUser(db, user);
      if (requestedModel && !allowedSet.has(requestedModel)) {
        sendOpenAIError(
          res,
          403,
          `Model '${requestedModel}' is disabled or not permitted for this API key.`,
          'invalid_request_error',
          'model_not_allowed',
          'model',
        );
        return;
      }

      const quota = getUserQuotaSnapshot(db, user.id, user.weekly_token_limit);
      if (quota.isExhausted) {
        setQuotaHeaders(res, quota);
        if (quota.nextReleaseAt) {
          const retryAfter = Math.max(
            60,
            Math.ceil((quota.nextReleaseAt - Date.now()) / 1000),
          );
          res.setHeader('Retry-After', String(retryAfter));
        }
        sendOpenAIError(
          res,
          429,
          'Weekly rolling token quota exceeded. API access has been paused until older usage rolls off.',
          'insufficient_quota',
          'weekly_quota_exceeded',
        );
        return;
      }

      const { baseUrl, apiKey } = getUpstreamCredentials(db, masterKey);
      if (!baseUrl || !apiKey) {
        sendOpenAIError(
          res,
          503,
          'Gateway upstream API credentials are not configured.',
          'server_error',
          'upstream_not_configured',
        );
        return;
      }

      const modelRow = requestedModel
        ? (db
            .prepare('SELECT multiplier FROM models WHERE id = ?')
            .get(requestedModel) as { multiplier: number } | undefined)
        : undefined;
      const multiplier =
        modelRow && Number.isFinite(Number(modelRow.multiplier))
          ? Number(modelRow.multiplier)
          : 1.0;

      const isStreamRequested = parsedBody?.stream === true;
      let outgoingBody: BodyInit | undefined;
      const forwardHeaders: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': UPSTREAM_USER_AGENT,
      };
      if (req.headers.accept) {
        forwardHeaders.Accept = String(req.headers.accept);
      }

      if (parsedBody) {
        const bodyToForward: Record<string, unknown> = { ...parsedBody };
        if (endpointPath === '/chat/completions' && isStreamRequested) {
          const existingOpts =
            bodyToForward.stream_options &&
            typeof bodyToForward.stream_options === 'object'
              ? (bodyToForward.stream_options as Record<string, unknown>)
              : {};
          bodyToForward.stream_options = { ...existingOpts, include_usage: true };
        }
        outgoingBody = JSON.stringify(bodyToForward);
        forwardHeaders['Content-Type'] = 'application/json';
      } else if (
        req.method !== 'GET' &&
        req.method !== 'HEAD' &&
        Buffer.isBuffer(req.body) &&
        req.body.length > 0
      ) {
        outgoingBody = new Uint8Array(req.body);
        if (contentType) {
          forwardHeaders['Content-Type'] = contentType;
        }
      }

      const abortController = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) {
          abortController.abort();
        }
      });

      let upstreamRes: globalThis.Response;
      try {
        upstreamRes = await fetch(`${baseUrl}${subPath}`, {
          method: req.method,
          headers: forwardHeaders,
          body: outgoingBody,
          signal: abortController.signal,
        });
      } catch (err) {
        if (abortController.signal.aborted) return;
        sendOpenAIError(
          res,
          502,
          `Failed to reach upstream API: ${err instanceof Error ? err.message : String(err)}`,
          'server_error',
          'upstream_unreachable',
        );
        return;
      }

      const upstreamContentType = (
        upstreamRes.headers.get('content-type') || ''
      ).toLowerCase();
      const isEventStream =
        upstreamContentType.includes('text/event-stream') && upstreamRes.body !== null;

      const recordUsage = (
        promptTokens: number,
        completionTokens: number,
        totalTokens: number,
        statusCode: number,
        streamed: boolean,
      ) => {
        const safeTotal =
          totalTokens > 0 ? totalTokens : Math.max(0, promptTokens + completionTokens);
        const weighted = computeWeightedTokens(safeTotal, multiplier);
        db.prepare(
          `INSERT INTO usage_ledger (
             user_id, model_id, endpoint, prompt_tokens, completion_tokens,
             total_tokens, multiplier, weighted_tokens, status_code, is_stream,
             latency_ms, created_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          user.id,
          requestedModel || 'unknown',
          endpointPath,
          promptTokens,
          completionTokens,
          safeTotal,
          multiplier,
          weighted,
          statusCode,
          streamed ? 1 : 0,
          Date.now() - startedAt,
          Date.now(),
        );
        hubEvents.emitUserUpdated(user.id);
      };

      if (isEventStream && upstreamRes.body) {
        res.status(upstreamRes.status);
        copySafeUpstreamHeaders(upstreamRes.headers, res);
        setQuotaHeaders(res, quota);
        res.setHeader('Cache-Control', 'no-cache');
        res.flushHeaders();

        const tracker = new StreamUsageTracker();
        const reader = upstreamRes.body.getReader();
        const estPrompt = estimatePromptTokens(parsedBody);
        let recorded = false;

        const finalizeStreamUsage = () => {
          if (recorded) return;
          recorded = true;
          const usage = tracker.finish(estPrompt);
          if (upstreamRes.status < 500 || usage.totalTokens > 0) {
            recordUsage(
              usage.promptTokens,
              usage.completionTokens,
              usage.totalTokens,
              upstreamRes.status,
              true,
            );
          }
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              tracker.push(value);
              if (!res.writableEnded) {
                const canContinue = res.write(value);
                if (!canContinue) {
                  await new Promise<void>((resolve) => {
                    res.once('drain', resolve);
                    res.once('close', resolve);
                  });
                }
              }
            }
          }
        } catch {
          // Stream aborted or client disconnected; ledger will record tokens seen so far.
        } finally {
          finalizeStreamUsage();
          if (!res.writableEnded) {
            res.end();
          }
        }
        return;
      }

      // Non-streaming response path
      const rawBytes = Buffer.from(await upstreamRes.arrayBuffer());
      if (upstreamContentType.includes('application/json') && rawBytes.length > 0) {
        try {
          const json = JSON.parse(rawBytes.toString('utf8')) as Record<string, unknown>;
          let usage = extractUsageFromJson(json);
          if (
            !usage.found &&
            upstreamRes.ok &&
            endpointPath.startsWith('/images/')
          ) {
            const imgCount = Array.isArray(json.data) ? Math.max(1, json.data.length) : 1;
            usage = {
              promptTokens: 0,
              completionTokens: imgCount * 1000,
              totalTokens: imgCount * 1000,
              found: true,
            };
          }
          if (upstreamRes.status < 500 || usage.totalTokens > 0) {
            recordUsage(
              usage.promptTokens,
              usage.completionTokens,
              usage.totalTokens,
              upstreamRes.status,
              false,
            );
          }
        } catch {
          // Non-JSON or malformed JSON; still forward response.
        }
      }

      res.status(upstreamRes.status);
      copySafeUpstreamHeaders(upstreamRes.headers, res);
      setQuotaHeaders(
        res,
        getUserQuotaSnapshot(db, user.id, user.weekly_token_limit),
      );
      res.send(rawBytes);
    },
  );

  return router;
}
