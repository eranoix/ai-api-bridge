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
import type { AppContext } from '../../src/appContext.js';

let tmpDir: string;
let mock: MockAnthropicHandle;
let db: Db;
let ctx: AppContext;
let app: Hono;
let apiKey: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-it-'));
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
  const created = await apiKeys.create({ name: 'rl-test', rateLimitRpm: 3, rateLimitTpm: 1000 });
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
  app.route('/', chatCompletionsRoutes(ctx));
});

afterEach(async () => {
  await ctx.close();
  await mock.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function chatReq(): Promise<Response> {
  return app.fetch(
    new Request('http://test.local/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    }),
  );
}

describe('rate limiting — RPM enforcement', () => {
  it('allows first N requests, then returns 429 with rate_limit_error', async () => {
    const r1 = await chatReq();
    const r2 = await chatReq();
    const r3 = await chatReq();
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);

    const r4 = await chatReq();
    expect(r4.status).toBe(429);
    const body = (await r4.json()) as { error: { type: string; reason: string } };
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.reason).toBe('rpm_exceeded');
  });

  it('exposes x-ratelimit-* headers on every response', async () => {
    const r = await chatReq();
    expect(r.headers.get('x-ratelimit-limit-requests')).toBe('3');
    expect(r.headers.get('x-ratelimit-remaining-requests')).toBe('2');
    expect(r.headers.get('x-ratelimit-reset-requests')).toMatch(/^\d+s$/);
  });

  it('decrements remaining-requests across consecutive calls', async () => {
    const r1 = await chatReq();
    const r2 = await chatReq();
    expect(r1.headers.get('x-ratelimit-remaining-requests')).toBe('2');
    expect(r2.headers.get('x-ratelimit-remaining-requests')).toBe('1');
  });

  it('still counts a 429 request against the limit (no bypass via spam)', async () => {
    await chatReq();
    await chatReq();
    await chatReq();
    const r4 = await chatReq();
    expect(r4.status).toBe(429);
    const r5 = await chatReq();
    expect(r5.status).toBe(429);
  });
});

describe('rate limiting — token billing', () => {
  it('charges tokens after upstream returns, exposing them in TPM accounting', async () => {
    // Tight TPM via a key with very low budget — mock responds with 1500 tokens.
    mock.setMessagesResponder(() => ({
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'long' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 500 },
    }));
    const r1 = await chatReq();
    expect(r1.status).toBe(200);

    // Next request: TPM (1000) is exceeded by the previous call (1500 total tokens).
    const r2 = await chatReq();
    expect(r2.status).toBe(429);
    const body = (await r2.json()) as { error: { reason: string } };
    expect(body.error.reason).toBe('tpm_exceeded');
  });
});
