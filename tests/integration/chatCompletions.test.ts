import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { startMockAnthropic, type MockAnthropicHandle } from './mockAnthropic.js';
import { openDb, type Db } from '../../src/storage/db.js';
import { ApiKeyStore } from '../../src/auth/apiKeyStore.js';
import { CredentialsStore } from '../../src/oauth/credentialsStore.js';
import { HttpRefreshClient } from '../../src/oauth/refreshClient.js';
import { TokenManager } from '../../src/oauth/TokenManager.js';
import { AnthropicClient } from '../../src/upstream/anthropicClient.js';
import { UsageLogger } from '../../src/storage/usageLogger.js';
import { SlidingWindowLimiter } from '../../src/ratelimit/slidingWindow.js';
import { chatCompletionsRoutes } from '../../src/routes/chatCompletions.js';
import { modelsRoutes } from '../../src/routes/models.js';
import { healthRoutes } from '../../src/routes/health.js';
import type { AppContext } from '../../src/appContext.js';

let tmpDir: string;
let mock: MockAnthropicHandle;
let db: Db;
let ctx: AppContext;
let app: Hono;
let apiKeyPlaintext: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-it-'));
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
  const { plaintext } = await apiKeys.create({ name: 'test-key' });
  apiKeyPlaintext = plaintext;

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
  app.route('/', healthRoutes);
  app.route('/', modelsRoutes(ctx));
  app.route('/', chatCompletionsRoutes(ctx));
});

afterEach(async () => {
  await ctx.close();
  await mock.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function call(reqPath: string, init: RequestInit = {}): Promise<Response> {
  return app.fetch(new Request(`http://test.local${reqPath}`, init));
}

describe('POST /v1/chat/completions — non-streaming MVP', () => {
  it('returns 401 without an API key', async () => {
    const res = await call('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 with a wrong API key', async () => {
    const res = await call('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-priv-bogus',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(401);
  });

  it('routes a valid request through translation and back; echoes requested model', async () => {
    const res = await call('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKeyPlaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      model: string;
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(body.model).toBe('gpt-4o');
    expect(body.choices[0]?.message.content).toBe('mock response');
    expect(body.choices[0]?.finish_reason).toBe('stop');
    expect(body.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('sends self-identifying headers upstream (User-Agent, Bearer)', async () => {
    await call('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKeyPlaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(mock.lastMessagesHeaders['user-agent']).toMatch(/^ai-api-bridge\//);
    expect(mock.lastMessagesHeaders['anthropic-beta']).toBeUndefined();
    expect(mock.lastMessagesHeaders['anthropic-version']).toBe('2023-06-01');
    expect(mock.lastMessagesHeaders['authorization']).toBe('Bearer mock-access-initial');
  });

  it('translates system messages into top-level system field upstream', async () => {
    await call('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKeyPlaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'hi' },
        ],
      }),
    });
    const upstream = mock.lastMessagesRequest as {
      system?: unknown;
      messages: unknown[];
    };
    // An OpenAI `system` message becomes the upstream top-level `system`, with
    // nothing else added to it (no injected identity block).
    expect(upstream.system).toBe('You are terse.');
    expect(upstream.messages).toHaveLength(1);
  });

  it('accepts streaming requests (Phase 3+): returns text/event-stream', async () => {
    const res = await call('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKeyPlaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/event-stream/);
    await res.body?.cancel();
  });

  it('writes a usage_logs row on success', async () => {
    await call('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKeyPlaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const row = db
      .prepare('SELECT * FROM usage_logs ORDER BY id DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.endpoint).toBe('chat.completions');
    expect(row?.requested_model).toBe('gpt-4o');
    expect(row?.upstream_model).toBe('claude-opus-4-7');
    expect(row?.status_code).toBe(200);
    expect(row?.input_tokens).toBe(10);
    expect(row?.output_tokens).toBe(5);
  });

  it('rejects malformed request bodies with 400', async () => {
    const res = await call('/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKeyPlaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-4o' }), // missing messages
    });
    expect(res.status).toBe(400);
  });

  it('accepts x-api-key header (Anthropic style) in addition to Authorization Bearer', async () => {
    const res = await call('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'x-api-key': apiKeyPlaintext,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
  });
});

describe('GET /v1/models', () => {
  it('lists known model aliases for authenticated callers', async () => {
    const res = await call('/v1/models', {
      headers: { authorization: `Bearer ${apiKeyPlaintext}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain('gpt-4o');
    expect(ids).toContain('opus');
    expect(ids).toContain('sonnet');
  });

  it('requires authentication', async () => {
    const res = await call('/v1/models');
    expect(res.status).toBe(401);
  });
});
