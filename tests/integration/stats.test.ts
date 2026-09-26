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
import { adminRoutes } from '../../src/routes/admin.js';
import type { AppContext } from '../../src/appContext.js';

const ADMIN_TOKEN = 'admin-token-with-enough-length-32chars';

let tmpDir: string;
let mock: MockAnthropicHandle;
let db: Db;
let ctx: AppContext;
let chatApp: Hono;
let adminApp: Hono;
let apiKey: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stats-it-'));
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
  const created = await apiKeys.create({ name: 'stats-test', rateLimitRpm: 100 });
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
      ADMIN_TOKEN,
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
  chatApp = new Hono();
  chatApp.route('/', chatCompletionsRoutes(ctx));
  adminApp = new Hono();
  adminApp.route('/', adminRoutes(ctx));
});

afterEach(async () => {
  await ctx.close();
  await mock.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function fire(): Promise<void> {
  await chatApp.fetch(
    new Request('http://test.local/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    }),
  );
}

describe('/admin/api/stats (JSON)', () => {
  it('returns aggregated overall/latency-by-model/per-key after some traffic', async () => {
    for (let i = 0; i < 3; i++) await fire();

    const res = await adminApp.fetch(
      new Request('http://test.local/admin/api/stats', {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      overall: { totalRequests: number; totalInputTokens: number; totalOutputTokens: number };
      latencyByModel: Array<{ model: string; count: number; p50Ms: number; p95Ms: number; p99Ms: number }>;
      perKey: Array<{ name: string; requests: number }>;
    };
    expect(body.overall.totalRequests).toBe(3);
    expect(body.overall.totalInputTokens).toBe(30); // 3 × 10
    expect(body.overall.totalOutputTokens).toBe(15); // 3 × 5

    const gpt = body.latencyByModel.find((m) => m.model === 'gpt-4o');
    expect(gpt?.count).toBe(3);
    expect(gpt?.p50Ms).toBeGreaterThanOrEqual(0);

    const key = body.perKey.find((k) => k.name === 'stats-test');
    expect(key?.requests).toBe(3);
  });

  it('honors rangeHours query parameter', async () => {
    const res = await adminApp.fetch(
      new Request('http://test.local/admin/api/stats?rangeHours=168', {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rangeHours: number };
    expect(body.rangeHours).toBe(168);
  });
});

describe('/admin/dashboard (SPA shell)', () => {
  it('renders the SPA shell HTML — Alpine bootstrap, brand, nav items', async () => {
    const res = await adminApp.fetch(
      new Request('http://test.local/admin/dashboard', {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/html/);
    const html = await res.text();
    expect(html).toContain('ai-api-bridge');
    expect(html).toContain('dashboard()');
    expect(html).toContain('Overview');
    expect(html).toContain('API Keys');
    expect(html).toContain('Models');
    expect(html).toContain('alpinejs');
  });
});
