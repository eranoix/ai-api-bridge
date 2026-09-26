import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { startMockAnthropic, type MockAnthropicHandle, defaultStreamingScript } from './mockAnthropic.js';
import { openDb, type Db } from '../../src/storage/db.js';
import { ApiKeyStore } from '../../src/auth/apiKeyStore.js';
import { CredentialsStore } from '../../src/oauth/credentialsStore.js';
import { HttpRefreshClient } from '../../src/oauth/refreshClient.js';
import { TokenManager } from '../../src/oauth/TokenManager.js';
import { AnthropicClient } from '../../src/upstream/anthropicClient.js';
import { UsageLogger } from '../../src/storage/usageLogger.js';
import { SlidingWindowLimiter } from '../../src/ratelimit/slidingWindow.js';
import { messagesRoutes } from '../../src/routes/messages.js';
import type { AppContext } from '../../src/appContext.js';

let tmpDir: string;
let mock: MockAnthropicHandle;
let db: Db;
let ctx: AppContext;
let app: Hono;
let apiKey: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'msg-it-'));
  mock = await startMockAnthropic();
  const credPath = path.join(tmpDir, 'creds.json');
  await fs.writeFile(
    credPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'mock-access-initial',
        refreshToken: 'mock-refresh-initial',
        expiresAt: Date.now() + 3_600_000,
      },
    }),
  );
  db = await openDb({ dbPath: path.join(tmpDir, 'test.db') });
  const apiKeys = new ApiKeyStore(db);
  const created = await apiKeys.create({ name: 'msg-test' });
  apiKey = created.plaintext;

  const credentialsStore = new CredentialsStore(credPath);
  const refreshClient = new HttpRefreshClient({
    tokenUrl: `${mock.url}/v1/oauth/token`,
    clientId: 'test-client',
  });
  const tokenManager = new TokenManager({ credentialsStore, refreshClient });
  const anthropic = new AnthropicClient({
    baseUrl: mock.url,
    tokenManager,
    version: '0.1.0',
  });
  ctx = {
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 0,
      LOG_LEVEL: 'fatal',
      CREDENTIALS_PATH: credPath,
      ANTHROPIC_BASE_URL: mock.url,
      ANTHROPIC_OAUTH_TOKEN_URL: `${mock.url}/v1/oauth/token`,
      CLAUDE_CLIENT_ID: 'test-client',
      GATEWAY_VERSION: '0.1.0',
      DATABASE_PATH: path.join(tmpDir, 'test.db'),
      DEFAULT_MAX_TOKENS: 4096,
      ALLOWED_ORIGINS: '',
      ADMIN_TOKEN: '',
    },
    db,
    apiKeys,
    tokenManager,
    anthropic,
    usage: new UsageLogger(db),
    rateLimiter: new SlidingWindowLimiter(db),
    async close() {
      await anthropic.close();
      db.close();
    },
  };
  app = new Hono();
  app.route('/', messagesRoutes(ctx));
});

afterEach(async () => {
  await ctx.close();
  await mock.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('POST /v1/messages — Anthropic-compatible passthrough (non-streaming)', () => {
  it('forwards body VERBATIM upstream (no translation)', async () => {
    const requestBody = {
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'Native Anthropic call' },
      ],
      system: 'Be concise.',
      temperature: 0.5,
    };
    await app.fetch(
      new Request('http://test.local/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(requestBody),
      }),
    );
    // The body reaches the provider verbatim, `system` included: a protocol
    // gateway does not edit the caller's prompt.
    const upstream = mock.lastMessagesRequest as Record<string, unknown>;
    expect(upstream.model).toBe(requestBody.model);
    expect(upstream.max_tokens).toBe(requestBody.max_tokens);
    expect(upstream.messages).toEqual(requestBody.messages);
    expect(upstream.temperature).toBe(requestBody.temperature);
    expect(upstream.system).toBe(requestBody.system);
  });

  it('identifies itself upstream while accepting a client x-api-key', async () => {
    await app.fetch(
      new Request('http://test.local/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          max_tokens: 50,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
    );
    expect(mock.lastMessagesHeaders['authorization']).toBe('Bearer mock-access-initial');
    expect(mock.lastMessagesHeaders['anthropic-version']).toBe('2023-06-01');
    expect(mock.lastMessagesHeaders['anthropic-beta']).toBeUndefined();
    // The gateway names itself. Asserting this is what keeps a future
    // change from quietly reintroducing an impersonated user agent.
    expect(mock.lastMessagesHeaders['user-agent']).toMatch(/^ai-api-bridge\//);
  });

  it('returns the upstream JSON body verbatim with correct status', async () => {
    mock.setMessagesResponder(() => ({
      id: 'msg_native',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'Native reply' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 3 },
    }));
    const res = await app.fetch(
      new Request('http://test.local/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          max_tokens: 50,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: 'msg_native',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Native reply' }],
      stop_reason: 'end_turn',
    });
  });

  it('rejects unauthenticated requests', async () => {
    const res = await app.fetch(
      new Request('http://test.local/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'x' }],
        }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('writes usage_logs with input/output tokens parsed from upstream response', async () => {
    mock.setMessagesResponder(() => ({
      id: 'msg_x',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 42, output_tokens: 7 },
    }));
    await app.fetch(
      new Request('http://test.local/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          max_tokens: 50,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
    );
    const row = db
      .prepare('SELECT * FROM usage_logs ORDER BY id DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    expect(row?.endpoint).toBe('messages');
    expect(row?.input_tokens).toBe(42);
    expect(row?.output_tokens).toBe(7);
    expect(row?.status_code).toBe(200);
  });
});

describe('POST /v1/messages — streaming passthrough', () => {
  it('forwards upstream SSE bytes verbatim (Anthropic-native event names preserved)', async () => {
    mock.setStreamingScript(defaultStreamingScript());
    const res = await app.fetch(
      new Request('http://test.local/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          max_tokens: 50,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/event-stream/);

    if (!res.body) throw new Error('no body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    // Confirm we got the native Anthropic event names — NOT translated to OpenAI chunks.
    expect(text).toMatch(/event: message_start\n/);
    expect(text).toMatch(/event: content_block_delta\n/);
    expect(text).toMatch(/event: message_stop\n/);
    expect(text).not.toContain('chat.completion.chunk');
  });
});

describe('POST /v1/messages/count_tokens', () => {
  it('passes through to upstream and forwards response', async () => {
    // The mock has no count_tokens responder; verify the route does not crash
    // and passes upstream's JSON 404 through.
    const res = await app.fetch(
      new Request('http://test.local/v1/messages/count_tokens', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
    );
    // Mock returns 404 for unknown routes; the route should pass it through.
    expect([200, 404]).toContain(res.status);
  });
});
