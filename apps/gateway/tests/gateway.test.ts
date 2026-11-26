import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { createApp, type GatewayInstance } from '../src/app.js';
import { pruneOldUsageLedger } from '../src/db.js';
import { ROLLING_WINDOW_MS } from '../src/quota.js';

interface RunningServer {
  server: http.Server;
  url: string;
  close: () => Promise<void>;
}

async function listenExpress(
  handler: http.RequestListener,
): Promise<RunningServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Unexpected address');
  }
  return {
    server,
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe('Sandrobina API Gateway', () => {
  let mockUpstream: RunningServer;
  let gateway: GatewayInstance;
  let gwServer: RunningServer;
  let upstreamChatHits = 0;
  let lastStreamOptions: unknown = null;
  let lastReasoningEffort: unknown = null;
  let lastUpstreamUserAgent = '';

  before(async () => {
    mockUpstream = await listenExpress(async (req, res) => {
      lastUpstreamUserAgent = String(req.headers['user-agent'] || '');
      if (req.headers.authorization !== 'Bearer upstream-secret-key') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad upstream auth' } }));
        return;
      }

      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [
              {
                id: 'gpt-6-luna',
                object: 'model',
                display_name: 'GPT-6-Luna',
                context_length: 272000,
                owned_by: 'configured-upstream',
                model_info: {
                  default_reasoning_effort: 'low',
                  supported_reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
                },
              },
              {
                id: 'gpt-6.2-astra',
                object: 'model',
                display_name: 'GPT-6.2-Astra',
                context_length: 272000,
                owned_by: 'configured-upstream',
              },
              {
                id: 'gpt-6.1-sol',
                object: 'model',
                display_name: 'GPT-6.1-Sol',
                context_length: 500000,
                owned_by: 'configured-upstream',
                model_info: {
                  default_reasoning_effort: 'medium',
                  supported_reasoning_efforts: [
                    'low',
                    'medium',
                    'high',
                    'xhigh',
                    'max',
                    'ultra',
                  ],
                },
              },
            ],
            models: [
              { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna' },
              { slug: 'gpt-6.2-astra', display_name: 'GPT-6.2-Astra' },
              { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol' },
            ],
          }),
        );
        return;
      }

      const chunks: Buffer[] = [];
      for await (const ch of req) {
        chunks.push(Buffer.from(ch));
      }
      const body = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
        : {};

      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        upstreamChatHits += 1;
        lastReasoningEffort = body.reasoning_effort ?? null;
        if (body.stream === true) {
          lastStreamOptions = body.stream_options ?? null;
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              model: body.model,
              choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              model: body.model,
              choices: [],
              usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-nonstream',
            object: 'chat.completion',
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Hi there' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
          }),
        );
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/responses') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        res.write(
          `event: response.created\ndata: ${JSON.stringify({
            type: 'response.created',
            response: { id: 'resp-1', status: 'in_progress' },
          })}\n\n`,
        );
        res.write(
          `event: response.completed\ndata: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp-1',
              status: 'completed',
              usage: { input_tokens: 7, output_tokens: 13, total_tokens: 20 },
            },
          })}\n\n`,
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    gateway = createApp({
      dbPath: ':memory:',
      adminUsername: 'admin',
      adminPassword: 'init-password-123',
      upstreamBaseUrl: `${mockUpstream.url}/v1`,
      upstreamApiKey: 'upstream-secret-key',
      publicBaseUrl: 'http://gateway.local/v1',
      defaultWeeklyTokenLimit: 100,
      silentBootstrap: true,
    });
    gwServer = await listenExpress(gateway.app);
  });

  after(async () => {
    await gwServer.close();
    gateway.close();
    await mockUpstream.close();
  });

  test('full admin, model ACL, rolling 7-day quota, SSE, and proxy lifecycle', async () => {
    // 1. Admin login (wrong password fails, right password succeeds)
    const badLogin = await fetch(`${gwServer.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    assert.equal(badLogin.status, 401);

    const okLogin = await fetch(`${gwServer.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'init-password-123' }),
    });
    assert.equal(okLogin.status, 200);
    const { token: initialAdminToken } = (await okLogin.json()) as { token: string };

    // Change admin password -> invalidates old session
    const pwChange = await fetch(`${gwServer.url}/api/admin/password`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${initialAdminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        currentPassword: 'init-password-123',
        newPassword: 'new-password-456',
      }),
    });
    assert.equal(pwChange.status, 200);
    const { token: adminToken } = (await pwChange.json()) as { token: string };

    const staleMe = await fetch(`${gwServer.url}/api/admin/me`, {
      headers: { Authorization: `Bearer ${initialAdminToken}` },
    });
    assert.equal(staleMe.status, 401);

    // 2. Sync models from upstream and check User-Agent header
    const syncRes = await fetch(`${gwServer.url}/api/admin/models/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(syncRes.status, 200);
    const syncBody = (await syncRes.json()) as { syncedCount: number };
    assert.equal(syncBody.syncedCount, 3);
    assert.equal(lastUpstreamUserAgent, 'sandrobina-api-hub/1.0');

    // Set multipliers: gpt-6-luna = 2.0, gpt-6.1-sol = 0.5
    const multRes = await fetch(`${gwServer.url}/api/admin/models/gpt-6-luna`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ multiplier: 2.0 }),
    });
    assert.equal(multRes.status, 200);

    // 3. Create user alice with weekly limit 100
    const createUserRes = await fetch(`${gwServer.url}/api/admin/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: 'alice',
        displayName: 'Alice Chen',
        password: 'alice-secret',
        weeklyTokenLimit: 100,
      }),
    });
    assert.equal(createUserRes.status, 201);
    const createdPayload = (await createUserRes.json()) as {
      user: { id: number; apiKey: string };
    };
    const aliceId = createdPayload.user.id;
    let aliceApiKey = createdPayload.user.apiKey;
    assert.ok(aliceApiKey.startsWith('sbk_'));

    // 4. Disable gpt-6.2-astra for alice (all_except_denied)
    const aclRes = await fetch(`${gwServer.url}/api/admin/users/${aliceId}/models`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        modelAccessMode: 'all_except_denied',
        overrides: { 'gpt-6.2-astra': false },
      }),
    });
    assert.equal(aclRes.status, 200);

    // Verify GET /v1/models filters BOTH `data` and `models`
    const modelsRes = await fetch(`${gwServer.url}/v1/models`, {
      headers: { Authorization: `Bearer ${aliceApiKey}` },
    });
    assert.equal(modelsRes.status, 200);
    const modelsJson = (await modelsRes.json()) as {
      data: Array<{ id: string }>;
      models: Array<{ slug: string }>;
    };
    assert.deepEqual(
      modelsJson.data.map((m) => m.id).sort(),
      ['gpt-6-luna', 'gpt-6.1-sol'],
    );
    assert.deepEqual(
      modelsJson.models.map((m) => m.slug).sort(),
      ['gpt-6-luna', 'gpt-6.1-sol'],
    );

    // Direct lookup & completion on disabled model must fail cleanly without hitting upstream
    const hitsBeforeDisabled = upstreamChatHits;
    const singleDisabledRes = await fetch(`${gwServer.url}/v1/models/gpt-6.2-astra`, {
      headers: { Authorization: `Bearer ${aliceApiKey}` },
    });
    assert.equal(singleDisabledRes.status, 404);

    const chatDisabledRes = await fetch(`${gwServer.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-6.2-astra',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(chatDisabledRes.status, 403);
    assert.equal(upstreamChatHits, hitsBeforeDisabled);

    // 5. Client login & SSE real-time stream
    const clientLoginRes = await fetch(`${gwServer.url}/api/client/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'alice-secret' }),
    });
    assert.equal(clientLoginRes.status, 200);
    const clientAuth = (await clientLoginRes.json()) as {
      token: string;
      profile: {
        api: { baseUrl: string; apiKey: string };
        models: Array<{
          id: string;
          multiplier: number;
          supportedReasoningEfforts?: string[];
          defaultReasoningEffort?: string | null;
        }>;
        quota: { remainingWeighted: number };
      };
    };
    assert.equal(clientAuth.profile.api.baseUrl, 'http://gateway.local/v1');
    assert.equal(clientAuth.profile.api.apiKey, aliceApiKey);
    assert.deepEqual(
      clientAuth.profile.models.map((m) => m.id).sort(),
      ['gpt-6-luna', 'gpt-6.1-sol'],
    );
    const solModel = clientAuth.profile.models.find((m) => m.id === 'gpt-6.1-sol');
    assert.deepEqual(solModel?.supportedReasoningEfforts, [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    assert.equal(solModel?.defaultReasoningEffort, 'medium');
    assert.equal(clientAuth.profile.quota.remainingWeighted, 100);

    // Connect SSE stream and await initial + post-call updates
    const sseAbort = new AbortController();
    const sseRes = await fetch(
      `${gwServer.url}/api/client/stream?token=${encodeURIComponent(clientAuth.token)}`,
      { signal: sseAbort.signal },
    );
    assert.equal(sseRes.status, 200);
    const sseReader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    const readNextProfileEvent = async (): Promise<{
      quota: { usedWeighted: number; remainingWeighted: number };
    }> => {
      while (true) {
        const sep = sseBuffer.indexOf('\n\n');
        if (sep !== -1) {
          const block = sseBuffer.slice(0, sep);
          sseBuffer = sseBuffer.slice(sep + 2);
          if (block.includes('event: profile')) {
            const dataLine = block
              .split('\n')
              .find((l) => l.startsWith('data:'))!;
            return JSON.parse(dataLine.slice(5).trim());
          }
          continue;
        }
        const { value, done } = await sseReader.read();
        assert.equal(done, false);
        sseBuffer += decoder.decode(value, { stream: true });
      }
    };

    const initialSseProfile = await readNextProfileEvent();
    assert.equal(initialSseProfile.quota.remainingWeighted, 100);

    // 6. Non-stream chat completion: 25 raw * 2.0 multiplier = 50 weighted tokens
    const chatRes1 = await fetch(`${gwServer.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-6-luna',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(chatRes1.status, 200);
    assert.equal(chatRes1.headers.get('x-quota-limit'), '100');
    assert.equal(chatRes1.headers.get('x-quota-used'), '50');
    assert.equal(chatRes1.headers.get('x-quota-remaining'), '50');
    const sseAfterCall1 = await readNextProfileEvent();
    assert.equal(sseAfterCall1.quota.usedWeighted, 50);
    assert.equal(sseAfterCall1.quota.remainingWeighted, 50);

    // 7. Stream chat completion: verifies stream_options.include_usage injection & 20*2 = 40 weighted
    const chatRes2 = await fetch(`${gwServer.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-6-luna',
        messages: [{ role: 'user', content: 'stream' }],
        reasoning_effort: 'high',
        stream: true,
      }),
    });
    assert.equal(chatRes2.status, 200);
    await chatRes2.text();
    assert.deepEqual(lastStreamOptions, { include_usage: true });
    assert.equal(lastReasoningEffort, 'high');
    const sseAfterCall2 = await readNextProfileEvent();
    assert.equal(sseAfterCall2.quota.usedWeighted, 90);
    assert.equal(sseAfterCall2.quota.remainingWeighted, 10);

    // 8. Stream /v1/responses: 20 raw * 2.0 = 40 weighted -> total 130 >= limit 100
    const respRes = await fetch(`${gwServer.url}/v1/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-6-luna',
        input: 'hi',
        stream: true,
      }),
    });
    assert.equal(respRes.status, 200);
    await respRes.text();
    const sseAfterCall3 = await readNextProfileEvent();
    assert.equal(sseAfterCall3.quota.usedWeighted, 130);
    assert.equal(sseAfterCall3.quota.remainingWeighted, 0);

    sseAbort.abort();

    // 9. Subsequent call must be blocked with 429 weekly_quota_exceeded
    const blockedRes = await fetch(`${gwServer.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-6-luna',
        messages: [{ role: 'user', content: 'blocked?' }],
      }),
    });
    assert.equal(blockedRes.status, 429);
    assert.ok(blockedRes.headers.get('retry-after'));
    const blockedJson = (await blockedRes.json()) as {
      error: { code: string };
    };
    assert.equal(blockedJson.error.code, 'weekly_quota_exceeded');

    // 10. Age out the first 2 records beyond 168h -> rolling quota releases automatically
    const expiredTs = Date.now() - (ROLLING_WINDOW_MS + 5000);
    gateway.db
      .prepare(
        `UPDATE usage_ledger SET created_at = ?
         WHERE id IN (
           SELECT id FROM usage_ledger WHERE user_id = ? ORDER BY id ASC LIMIT 2
         )`,
      )
      .run(expiredTs, aliceId);

    const meAfterRollRes = await fetch(`${gwServer.url}/api/client/me`, {
      headers: { Authorization: `Bearer ${clientAuth.token}` },
    });
    assert.equal(meAfterRollRes.status, 200);
    const meAfterRoll = (await meAfterRollRes.json()) as {
      quota: { usedWeighted: number; remainingWeighted: number; isExhausted: boolean };
    };
    assert.equal(meAfterRoll.quota.usedWeighted, 40);
    assert.equal(meAfterRoll.quota.remainingWeighted, 60);
    assert.equal(meAfterRoll.quota.isExhausted, false);

    // Calls work again after rolling window release
    const recoveredRes = await fetch(`${gwServer.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-6-luna',
        messages: [{ role: 'user', content: 'recovered' }],
      }),
    });
    assert.equal(recoveredRes.status, 200);

    // 10b. Client API key connectivity test + self-service password change
    const testKeyRes = await fetch(`${gwServer.url}/api/client/test-key`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${clientAuth.token}` },
    });
    assert.equal(testKeyRes.status, 200);
    const testKeyJson = (await testKeyRes.json()) as {
      ok: boolean;
      allowedModelCount: number;
      latencyMs: number;
    };
    assert.equal(testKeyJson.ok, true);
    assert.equal(testKeyJson.allowedModelCount, 2);

    const clientPwChangeRes = await fetch(`${gwServer.url}/api/client/password`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clientAuth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        currentPassword: 'alice-secret',
        newPassword: 'alice-new-password',
      }),
    });
    assert.equal(clientPwChangeRes.status, 200);
    const { token: freshClientToken } = (await clientPwChangeRes.json()) as {
      token: string;
    };
    const oldClientMe = await fetch(`${gwServer.url}/api/client/me`, {
      headers: { Authorization: `Bearer ${clientAuth.token}` },
    });
    assert.equal(oldClientMe.status, 401);

    // 10c. Admin reset rolling quota -> remaining returns to 100
    const resetQuotaRes = await fetch(
      `${gwServer.url}/api/admin/users/${aliceId}/reset-quota`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      },
    );
    assert.equal(resetQuotaRes.status, 200);
    const resetQuotaJson = (await resetQuotaRes.json()) as {
      ok: boolean;
      user: { quota: { usedWeighted: number; remainingWeighted: number } };
    };
    assert.equal(resetQuotaJson.ok, true);
    assert.equal(resetQuotaJson.user.quota.usedWeighted, 0);
    assert.equal(resetQuotaJson.user.quota.remainingWeighted, 100);

    // Verify pruneOldUsageLedger clears >90d rows safely
    const veryOldTs = Date.now() - 100 * 86_400_000;
    gateway.db
      .prepare(
        `INSERT INTO usage_ledger (user_id, model_id, endpoint, total_tokens, weighted_tokens, created_at)
         VALUES (?, 'gpt-6-luna', '/chat/completions', 10, 20, ?)`,
      )
      .run(aliceId, veryOldTs);
    assert.equal(pruneOldUsageLedger(gateway.db, 90), 1);

    // Verify freshClientToken works cleanly
    const freshClientMe = await fetch(`${gwServer.url}/api/client/me`, {
      headers: { Authorization: `Bearer ${freshClientToken}` },
    });
    assert.equal(freshClientMe.status, 200);

    // 11. Rotate API key -> old key rejected, new key works
    const rotateRes = await fetch(`${gwServer.url}/api/admin/users/${aliceId}/rotate-key`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(rotateRes.status, 200);
    const rotated = (await rotateRes.json()) as { apiKey: string };
    const oldKey = aliceApiKey;
    aliceApiKey = rotated.apiKey;
    assert.notEqual(aliceApiKey, oldKey);

    const oldKeyModels = await fetch(`${gwServer.url}/v1/models`, {
      headers: { Authorization: `Bearer ${oldKey}` },
    });
    assert.equal(oldKeyModels.status, 401);

    const newKeyModels = await fetch(`${gwServer.url}/v1/models`, {
      headers: { Authorization: `Bearer ${aliceApiKey}` },
    });
    assert.equal(newKeyModels.status, 200);

    // 12. Disable user -> both proxy and client login rejected
    const disableRes = await fetch(`${gwServer.url}/api/admin/users/${aliceId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disableRes.status, 200);

    const disabledProxy = await fetch(`${gwServer.url}/v1/models`, {
      headers: { Authorization: `Bearer ${aliceApiKey}` },
    });
    assert.equal(disabledProxy.status, 403);

    const disabledClientLogin = await fetch(`${gwServer.url}/api/client/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'alice-new-password' }),
    });
    assert.equal(disabledClientLogin.status, 403);
  });

  test('unique admin enforcement and 1:N account-to-guest-devices binding lifecycle', async () => {
    // 1. Unique admin trigger rejects second admin row
    assert.throws(() => {
      gateway.db
        .prepare(
          `INSERT INTO admins (username, password_hash, token_version, created_at, updated_at)
           VALUES ('second-admin', 'x', 1, 1, 1)`,
        )
        .run();
    }, /only_one_admin_allowed/);

    // Login as unique admin
    const loginRes = await fetch(`${gwServer.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'new-password-456' }),
    });
    assert.equal(loginRes.status, 200);
    const { token: adminToken } = (await loginRes.json()) as { token: string };

    const meRes = await fetch(`${gwServer.url}/api/admin/me`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const meJson = (await meRes.json()) as { uniqueAdmin?: boolean; role?: string };
    assert.equal(meJson.uniqueAdmin, true);
    assert.equal(meJson.role, 'super_admin');

    // Publish Host SSH pairing profile to gateway
    const hostBindRes = await fetch(`${gwServer.url}/api/admin/host-binding`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        hostName: 'main-star-host',
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestHostKey smac-guest',
        pairToken: 'pair-tok-123',
        endpoints: ['http://192.168.1.10:8797'],
        zerotierNetworkId: '0123456789abcdef',
      }),
    });
    assert.equal(hostBindRes.status, 200);

    // Create two user accounts: bob and carol
    const bobRes = await fetch(`${gwServer.url}/api/admin/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', displayName: 'Bob Lin', password: 'bob-password' }),
    });
    assert.equal(bobRes.status, 201);
    const bobId = ((await bobRes.json()) as { user: { id: number } }).user.id;

    const carolRes = await fetch(`${gwServer.url}/api/admin/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'carol', displayName: 'Carol Wu', password: 'carol-password' }),
    });
    assert.equal(carolRes.status, 201);
    const carolId = ((await carolRes.json()) as { user: { id: number } }).user.id;

    // Bob logs in and receives hostBinding automatically
    const bobLogin = await fetch(`${gwServer.url}/api/client/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'bob-password' }),
    });
    assert.equal(bobLogin.status, 200);
    const bobSession = (await bobLogin.json()) as {
      token: string;
      profile: { hostBinding?: { hostName: string } | null };
    };
    assert.equal(bobSession.profile.hostBinding?.hostName, 'main-star-host');

    // Bob binds TWO guest machines under the same account (1:N)
    const reg1 = await fetch(`${gwServer.url}/api/client/devices/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bobSession.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: 'dev-bob-mac',
        deviceName: 'Bob-MacBook',
        os: 'macOS',
        sshUser: 'bob',
        primaryIp: '192.168.1.21',
      }),
    });
    assert.equal(reg1.status, 200);

    const reg2 = await fetch(`${gwServer.url}/api/client/devices/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bobSession.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: 'dev-bob-win',
        deviceName: 'Bob-Workstation',
        os: 'Windows',
        sshUser: 'Administrator',
        primaryIp: '192.168.1.22',
      }),
    });
    assert.equal(reg2.status, 200);
    const reg2Body = (await reg2.json()) as { devices: Array<{ id: string }> };
    assert.equal(reg2Body.devices.length, 2);

    // Carol cannot hijack Bob's bound device
    const carolLogin = await fetch(`${gwServer.url}/api/client/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'carol', password: 'carol-password' }),
    });
    const carolToken = ((await carolLogin.json()) as { token: string }).token;
    const hijack = await fetch(`${gwServer.url}/api/client/devices/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${carolToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: 'dev-bob-win', deviceName: 'Hijack' }),
    });
    assert.equal(hijack.status, 403);

    // Admin has supreme authority to reassign dev-bob-win to Carol
    const reassign = await fetch(`${gwServer.url}/api/admin/devices/dev-bob-win/bind`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: carolId }),
    });
    assert.equal(reassign.status, 200);
    const reassigned = (await reassign.json()) as {
      device: { userId: number; accountUsername: string; accountDisplayName: string };
    };
    assert.equal(reassigned.device.userId, carolId);
    assert.equal(reassigned.device.accountUsername, 'carol');
    assert.equal(reassigned.device.accountDisplayName, 'Carol Wu');

    // Bob actively disconnects dev-bob-mac
    const disc = await fetch(`${gwServer.url}/api/client/devices/dev-bob-mac/disconnect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobSession.token}` },
    });
    assert.equal(disc.status, 200);
    const discBody = (await disc.json()) as { device: { connected: boolean; sshAuthorized: boolean } };
    assert.equal(discBody.device.connected, false);
    assert.equal(discBody.device.sshAuthorized, false);

    // Admin devices list shows accurate account tags
    const listAll = await fetch(`${gwServer.url}/api/admin/devices`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const allDevs = ((await listAll.json()) as { devices: Array<{ id: string; userId: number; accountUsername: string }> }).devices;
    assert.equal(allDevs.find((d) => d.id === 'dev-bob-mac')?.userId, bobId);
    assert.equal(allDevs.find((d) => d.id === 'dev-bob-win')?.accountUsername, 'carol');
  });

  test('admin node mesh, targeted client handshake approval, switch-host and force-disconnect commands', async () => {
    const loginRes = await fetch(`${gwServer.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'new-password-456' }),
    });
    const { token: adminToken } = (await loginRes.json()) as { token: string };
    const adminHeaders = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

    // Two machines logged into the single admin account register as admin nodes
    for (const [id, name, ip] of [
      ['node-win-a', 'WIN-DESKTOP', '192.168.1.10'],
      ['node-mac-b', 'Admin-Mac', '192.168.1.11'],
    ]) {
      const r = await fetch(`${gwServer.url}/api/admin/nodes/register`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          id,
          nodeName: name,
          hostname: name,
          os: id.includes('win') ? 'Windows' : 'macOS',
          sshUser: 'admin',
          primaryIp: ip,
          publicKey: `ssh-ed25519 AAAAC3Nza${id.replace(/\W/g, '')}Key smac-admin`,
        }),
      });
      assert.equal(r.status, 200);
    }
    const nodesRes = await fetch(`${gwServer.url}/api/admin/nodes`, { headers: adminHeaders });
    const nodes = ((await nodesRes.json()) as { nodes: Array<{ id: string; online: boolean }> }).nodes;
    assert.equal(nodes.length, 2);
    assert.ok(nodes.every((n) => n.online));

    // Accounts: dave (manual approval), erin (trusted auto-approve)
    const mkUser = async (username: string, extra: Record<string, unknown> = {}) => {
      const r = await fetch(`${gwServer.url}/api/admin/users`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ username, displayName: username, password: `${username}-pass`, ...extra }),
      });
      assert.equal(r.status, 201);
      return ((await r.json()) as { user: { id: number } }).user.id;
    };
    await mkUser('dave');
    await mkUser('erin', { autoApproveHandshake: true });
    const clientLogin = async (username: string) => {
      const r = await fetch(`${gwServer.url}/api/client/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: `${username}-pass` }),
      });
      assert.equal(r.status, 200);
      const body = (await r.json()) as { token: string; profile: { adminNodes?: unknown[] } };
      assert.equal(body.profile.adminNodes?.length, 2);
      return { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' };
    };
    const daveH = await clientLogin('dave');
    const erinH = await clientLogin('erin');

    // dave handshakes with node-win-a -> pending
    const hs = await fetch(`${gwServer.url}/api/client/devices/handshake`, {
      method: 'POST',
      headers: daveH,
      body: JSON.stringify({
        targetAdminNodeId: 'node-win-a',
        id: 'dev-dave-1',
        deviceName: 'Dave-Laptop',
        os: 'Windows',
        sshUser: 'dave',
        primaryIp: '192.168.1.50',
      }),
    });
    assert.equal(hs.status, 200);
    const hsDev = ((await hs.json()) as {
      device: { handshakeStatus: string; connected: boolean; hostAdminNodeId: string; hostAdminName: string };
    }).device;
    assert.equal(hsDev.handshakeStatus, 'pending');
    assert.equal(hsDev.connected, false);
    assert.equal(hsDev.hostAdminNodeId, 'node-win-a');
    assert.equal(hsDev.hostAdminName, 'WIN-DESKTOP');

    // Unknown target admin node is rejected
    const badTarget = await fetch(`${gwServer.url}/api/client/devices/handshake`, {
      method: 'POST',
      headers: daveH,
      body: JSON.stringify({ targetAdminNodeId: 'nope-node', id: 'dev-dave-x' }),
    });
    assert.equal(badTarget.status, 404);

    // Wrong admin node cannot approve; the direct host can
    const wrongApprove = await fetch(`${gwServer.url}/api/admin/devices/dev-dave-1/approve`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ adminNodeId: 'node-mac-b' }),
    });
    assert.equal(wrongApprove.status, 403);
    const okApprove = await fetch(`${gwServer.url}/api/admin/devices/dev-dave-1/approve`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ adminNodeId: 'node-win-a' }),
    });
    assert.equal(okApprove.status, 200);
    const approved = ((await okApprove.json()) as { device: { handshakeStatus: string; connected: boolean } }).device;
    assert.equal(approved.handshakeStatus, 'connected');
    assert.equal(approved.connected, true);

    // Trusted account auto-approves instantly
    const erinHs = await fetch(`${gwServer.url}/api/client/devices/handshake`, {
      method: 'POST',
      headers: erinH,
      body: JSON.stringify({ targetAdminNodeId: 'node-mac-b', id: 'dev-erin-1', deviceName: 'Erin-Mac', os: 'macOS', sshUser: 'erin', primaryIp: '192.168.1.60' }),
    });
    assert.equal(erinHs.status, 200);
    const erinDev = ((await erinHs.json()) as { device: { handshakeStatus: string; hostAdminName: string } }).device;
    assert.equal(erinDev.handshakeStatus, 'connected');
    assert.equal(erinDev.hostAdminName, 'Admin-Mac');

    // Non-direct admin node issues "switch to me" command; client acks it
    const sw = await fetch(`${gwServer.url}/api/admin/devices/dev-dave-1/switch-host`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ targetAdminNodeId: 'node-mac-b', issuedByAdminNodeId: 'node-mac-b' }),
    });
    assert.equal(sw.status, 200);
    const swBody = (await sw.json()) as { command: { id: string; type: string; targetAdminPublicKey: string } };
    assert.equal(swBody.command.type, 'switch_host');
    assert.ok(swBody.command.targetAdminPublicKey.startsWith('ssh-ed25519'));

    const meRes = await fetch(`${gwServer.url}/api/client/me`, { headers: daveH });
    const me = (await meRes.json()) as {
      boundDevices: Array<{ id: string; pendingCommand?: { id: string } | null }>;
    };
    assert.equal(me.boundDevices.find((d) => d.id === 'dev-dave-1')?.pendingCommand?.id, swBody.command.id);

    const ack1 = await fetch(`${gwServer.url}/api/client/devices/dev-dave-1/ack-command`, {
      method: 'POST',
      headers: daveH,
      body: JSON.stringify({ commandId: swBody.command.id, status: 'applied', hostAdminNodeId: 'node-mac-b' }),
    });
    assert.equal(ack1.status, 200);
    const ack1Dev = ((await ack1.json()) as {
      device: { hostAdminNodeId: string; hostAdminName: string; pendingCommand: unknown; connected: boolean };
    }).device;
    assert.equal(ack1Dev.hostAdminNodeId, 'node-mac-b');
    assert.equal(ack1Dev.hostAdminName, 'Admin-Mac');
    assert.equal(ack1Dev.pendingCommand, null);
    assert.equal(ack1Dev.connected, true);

    // Another account cannot ack someone else's device command
    const foreignAck = await fetch(`${gwServer.url}/api/client/devices/dev-dave-1/ack-command`, {
      method: 'POST',
      headers: erinH,
      body: JSON.stringify({ commandId: 'x', status: 'applied' }),
    });
    assert.equal(foreignAck.status, 404);

    // Force-disconnect command
    const fd = await fetch(`${gwServer.url}/api/admin/devices/dev-dave-1/force-disconnect`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ issuedByAdminNodeId: 'node-win-a' }),
    });
    assert.equal(fd.status, 200);
    const fdBody = (await fd.json()) as {
      command: { id: string; type: string };
      device: { handshakeStatus: string; connected: boolean };
    };
    assert.equal(fdBody.command.type, 'force_disconnect');
    assert.equal(fdBody.device.handshakeStatus, 'disconnected');
    assert.equal(fdBody.device.connected, false);
    const ack2 = await fetch(`${gwServer.url}/api/client/devices/dev-dave-1/ack-command`, {
      method: 'POST',
      headers: daveH,
      body: JSON.stringify({ commandId: fdBody.command.id, status: 'applied' }),
    });
    assert.equal(ack2.status, 200);
    const ack2Dev = ((await ack2.json()) as { device: { pendingCommand: unknown; hostAdminNodeId: string } }).device;
    assert.equal(ack2Dev.pendingCommand, null);
    assert.equal(ack2Dev.hostAdminNodeId, '');

    // Admin overview exposes node + handshake counters
    const ovRes = await fetch(`${gwServer.url}/api/admin/overview`, { headers: adminHeaders });
    const ov = (await ovRes.json()) as { totalAdminNodes: number; onlineAdminNodes: number; pendingHandshakes: number };
    assert.equal(ov.totalAdminNodes, 2);
    assert.equal(ov.onlineAdminNodes, 2);
    assert.equal(ov.pendingHandshakes, 0);

    // Removing an admin node (logout) drops it from the list
    const del = await fetch(`${gwServer.url}/api/admin/nodes/node-win-a`, { method: 'DELETE', headers: adminHeaders });
    assert.equal(del.status, 200);
    const nodesAfter = await fetch(`${gwServer.url}/api/admin/nodes`, { headers: adminHeaders });
    assert.equal(((await nodesAfter.json()) as { nodes: unknown[] }).nodes.length, 1);

  });
});
