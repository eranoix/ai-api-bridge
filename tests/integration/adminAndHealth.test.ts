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
import { healthRoutes, readinessRoutes } from '../../src/routes/health.js';
import { adminRoutes } from '../../src/routes/admin.js';
import type { AppContext } from '../../src/appContext.js';

const ADMIN_TOKEN = 'admin-token-with-enough-length-32chars';

let tmpDir: string;
let mock: MockAnthropicHandle;
let db: Db;
let ctx: AppContext;
let app: Hono;

async function buildCtx(env: Partial<AppContext['env']> = {}): Promise<{ ctx: AppContext; app: Hono }> {
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
  await apiKeys.create({ name: 'k1' });
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
  const builtCtx: AppContext = {
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
      ...env,
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
  const builtApp = new Hono();
  builtApp.route('/', healthRoutes);
  builtApp.route('/', readinessRoutes(builtCtx));
  builtApp.route('/', adminRoutes(builtCtx));
  return { ctx: builtCtx, app: builtApp };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-it-'));
  mock = await startMockAnthropic();
});

afterEach(async () => {
  await ctx.close();
  await mock.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('/healthz — liveness', () => {
  it('always returns 200 with a timestamp', async () => {
    ({ ctx, app } = await buildCtx());
    const res = await app.fetch(new Request('http://test.local/healthz'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; timestamp: string };
    expect(body.status).toBe('ok');
    expect(Date.parse(body.timestamp)).not.toBeNaN();
  });
});

describe('/readyz — readiness with downstream checks', () => {
  it('returns 200 with checks.db=ok + checks.oauth=ok when healthy', async () => {
    ({ ctx, app } = await buildCtx());
    const res = await app.fetch(new Request('http://test.local/readyz'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('ok');
    expect(body.checks.db).toBe('ok');
    expect(body.checks.oauth).toBe('ok');
  });
});

describe('/admin/* — gated by ADMIN_TOKEN', () => {
  it('returns 404 when ADMIN_TOKEN is unset (endpoint hidden)', async () => {
    ({ ctx, app } = await buildCtx({ ADMIN_TOKEN: '' }));
    const res = await app.fetch(
      new Request('http://test.local/admin/api/oauth-status', {
        headers: { authorization: 'Bearer anything' },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 401 when token is wrong', async () => {
    ({ ctx, app } = await buildCtx({ ADMIN_TOKEN: ADMIN_TOKEN }));
    const res = await app.fetch(
      new Request('http://test.local/admin/api/oauth-status', {
        headers: { authorization: 'Bearer not-the-right-token-of-same-length-xx' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns OAuth status JSON with the right admin token', async () => {
    ({ ctx, app } = await buildCtx({ ADMIN_TOKEN: ADMIN_TOKEN }));
    const res = await app.fetch(
      new Request('http://test.local/admin/api/oauth-status', {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ accessTokenValid: true });
    expect(body).toHaveProperty('expiresAt');
    expect(body).toHaveProperty('circuitBreakerState');
  });

  it('lists API keys without exposing hashes or plaintext', async () => {
    ({ ctx, app } = await buildCtx({ ADMIN_TOKEN: ADMIN_TOKEN }));
    const res = await app.fetch(
      new Request('http://test.local/admin/api/keys', {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ name: string; keyPrefix: string }> };
    expect(body.data.length).toBeGreaterThan(0);
    const row = body.data[0]!;
    expect(row.name).toBeDefined();
    expect(row.keyPrefix).toBeDefined();
    expect(JSON.stringify(row)).not.toContain('scrypt$'); // no hash leak
  });
});
