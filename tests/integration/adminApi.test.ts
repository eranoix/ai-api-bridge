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
import { adminRoutes } from '../../src/routes/admin.js';
import { chatCompletionsRoutes } from '../../src/routes/chatCompletions.js';
import type { AppContext } from '../../src/appContext.js';

const ADMIN_TOKEN = 'admin-token-with-enough-length-32chars';

let tmpDir: string;
let mock: MockAnthropicHandle;
let db: Db;
let ctx: AppContext;
let adminApp: Hono;
let chatApp: Hono;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-api-'));
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
  adminApp = new Hono();
  adminApp.route('/', adminRoutes(ctx));
  chatApp = new Hono();
  chatApp.route('/', chatCompletionsRoutes(ctx));
});

afterEach(async () => {
  await ctx.close();
  await mock.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function admin(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return adminApp.fetch(new Request(`http://test.local${path}`, init));
}

describe('POST /admin/api/keys — create', () => {
  it('creates a key with all configurable fields and returns plaintext once', async () => {
    const res = await admin('POST', '/admin/api/keys', {
      name: 'mobile-app',
      rateLimitRpm: 30,
      rateLimitTpm: 50_000,
      dailyTokenBudget: 1_000_000,
      expiresInDays: 30,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      plaintext: string;
      row: {
        id: number;
        name: string;
        keyPrefix: string;
        rateLimitRpm: number;
        rateLimitTpm: number;
        dailyTokenBudget: number | null;
        expiresAt: number | null;
      };
    };
    expect(body.plaintext.startsWith('sk-priv-')).toBe(true);
    expect(body.row.name).toBe('mobile-app');
    expect(body.row.rateLimitRpm).toBe(30);
    expect(body.row.rateLimitTpm).toBe(50_000);
    expect(body.row.dailyTokenBudget).toBe(1_000_000);
    expect(body.row.expiresAt).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
    expect(body.row.expiresAt).toBeLessThan(Date.now() + 31 * 24 * 60 * 60 * 1000);
  });

  it('rejects names with invalid chars (XSS / SQL injection vectors)', async () => {
    const cases = ['<script>', "abc' OR 1=1--", 'name\nwith\nnewline', 'a'.repeat(200)];
    for (const name of cases) {
      const res = await admin('POST', '/admin/api/keys', { name });
      expect(res.status).toBe(400);
    }
  });

  it('rejects duplicate active name (409)', async () => {
    await admin('POST', '/admin/api/keys', { name: 'unique-name' });
    const res = await admin('POST', '/admin/api/keys', { name: 'unique-name' });
    expect(res.status).toBe(409);
  });

  it('creates key without expiration when expiresInDays is omitted', async () => {
    const res = await admin('POST', '/admin/api/keys', { name: 'forever-key' });
    const body = (await res.json()) as { row: { expiresAt: number | null } };
    expect(body.row.expiresAt).toBeNull();
  });
});

describe('POST /admin/api/keys/:id/revoke', () => {
  it('revokes a key and subsequent chat calls return 401', async () => {
    const create = await admin('POST', '/admin/api/keys', { name: 'short-lived' });
    const { plaintext, row } = (await create.json()) as {
      plaintext: string;
      row: { id: number };
    };
    const before = await chatApp.fetch(
      new Request('http://test.local/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
      }),
    );
    expect(before.status).toBe(200);

    const revoke = await admin('POST', `/admin/api/keys/${row.id}/revoke`);
    expect(revoke.status).toBe(200);

    const after = await chatApp.fetch(
      new Request('http://test.local/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
      }),
    );
    expect(after.status).toBe(401);
  });

  it('returns 404 when revoking an already-revoked or unknown key', async () => {
    const res = await admin('POST', '/admin/api/keys/99999/revoke');
    expect(res.status).toBe(404);
  });
});

describe('Key expiration', () => {
  it('expired keys are rejected by the chat route', async () => {
    const { plaintext } = await ctx.apiKeys.create({
      name: 'already-expired',
      expiresAt: Date.now() - 1000,
    });
    const res = await chatApp.fetch(
      new Request('http://test.local/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('non-expired keys still work even with expiresAt set', async () => {
    const { plaintext } = await ctx.apiKeys.create({
      name: 'far-future',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    });
    const res = await chatApp.fetch(
      new Request('http://test.local/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('GET /admin/api/models', () => {
  it('lists all model metadata', async () => {
    const res = await admin('GET', '/admin/api/models');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        id: string;
        displayName: string;
        family: string;
        contextWindowTokens: number;
        pricing: { inputPerMTok: number; outputPerMTok: number };
        capabilities: { streaming: boolean; vision: boolean; toolUse: boolean };
        aliases: string[];
      }>;
    };
    expect(body.data.length).toBeGreaterThanOrEqual(3);
    const opus = body.data.find((m) => m.family === 'opus');
    expect(opus?.contextWindowTokens).toBe(200_000);
    expect(opus?.capabilities.streaming).toBe(true);
    expect(opus?.aliases).toContain('gpt-4o');
    expect(opus?.pricing.outputPerMTok).toBeGreaterThan(0);
  });
});

describe('GET /admin/api/system', () => {
  it('returns server runtime info', async () => {
    const res = await admin('GET', '/admin/api/system');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      nodeVersion: string;
      hostname: string;
      uptimeMs: number;
      dbPath: string;
      dbSize: number;
      migrations: string[];
    };
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.nodeVersion).toBeTruthy();
    expect(body.hostname).toBeTruthy();
    expect(body.uptimeMs).toBeGreaterThan(0);
    expect(body.dbPath).toContain('test.db');
    expect(body.dbSize).toBeGreaterThan(0);
    expect(body.migrations).toContain('001_init.sql');
    expect(body.migrations).toContain('002_api_key_expires.sql');
  });
});

describe('PATCH /admin/api/keys/:id — edit limits', () => {
  it('updates rate limits without changing other fields', async () => {
    const create = await admin('POST', '/admin/api/keys', {
      name: 'edit-test',
      rateLimitRpm: 30,
      rateLimitTpm: 50_000,
    });
    const { row } = (await create.json()) as { row: { id: number; createdAt: number } };

    const patch = await admin('PATCH', `/admin/api/keys/${row.id}`, {
      rateLimitRpm: 120,
      rateLimitTpm: 1_000_000,
    });
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as {
      row: { id: number; rateLimitRpm: number; rateLimitTpm: number; createdAt: number };
    };
    expect(body.row.id).toBe(row.id);
    expect(body.row.rateLimitRpm).toBe(120);
    expect(body.row.rateLimitTpm).toBe(1_000_000);
    expect(body.row.createdAt).toBe(row.createdAt);
  });

  it('removes expiration when expiresInDays=0', async () => {
    const create = await admin('POST', '/admin/api/keys', {
      name: 'unexpire',
      expiresInDays: 30,
    });
    const { row } = (await create.json()) as { row: { id: number; expiresAt: number | null } };
    expect(row.expiresAt).toBeGreaterThan(Date.now());

    const patch = await admin('PATCH', `/admin/api/keys/${row.id}`, { expiresInDays: 0 });
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as { row: { expiresAt: number | null } };
    expect(body.row.expiresAt).toBeNull();
  });

  it('extends expiration with positive expiresInDays', async () => {
    const create = await admin('POST', '/admin/api/keys', { name: 'extend' });
    const { row } = (await create.json()) as { row: { id: number; expiresAt: number | null } };
    expect(row.expiresAt).toBeNull();

    const patch = await admin('PATCH', `/admin/api/keys/${row.id}`, { expiresInDays: 60 });
    const body = (await patch.json()) as { row: { expiresAt: number | null } };
    expect(body.row.expiresAt).toBeGreaterThan(Date.now() + 59 * 24 * 60 * 60 * 1000);
    expect(body.row.expiresAt).toBeLessThan(Date.now() + 61 * 24 * 60 * 60 * 1000);
  });

  it('clears dailyTokenBudget when sent as null', async () => {
    const create = await admin('POST', '/admin/api/keys', {
      name: 'clear-budget',
      dailyTokenBudget: 500_000,
    });
    const { row } = (await create.json()) as { row: { id: number; dailyTokenBudget: number | null } };
    expect(row.dailyTokenBudget).toBe(500_000);

    const patch = await admin('PATCH', `/admin/api/keys/${row.id}`, { dailyTokenBudget: null });
    const body = (await patch.json()) as { row: { dailyTokenBudget: number | null } };
    expect(body.row.dailyTokenBudget).toBeNull();
  });

  it('returns 404 for unknown id', async () => {
    const patch = await admin('PATCH', '/admin/api/keys/99999', { rateLimitRpm: 999 });
    expect(patch.status).toBe(404);
  });

  it('ignores fields that are omitted (no-op patch returns current row)', async () => {
    const create = await admin('POST', '/admin/api/keys', {
      name: 'no-op',
      rateLimitRpm: 42,
      rateLimitTpm: 12_345,
    });
    const { row } = (await create.json()) as {
      row: { id: number; rateLimitRpm: number; rateLimitTpm: number };
    };

    const patch = await admin('PATCH', `/admin/api/keys/${row.id}`, {});
    const body = (await patch.json()) as {
      row: { rateLimitRpm: number; rateLimitTpm: number };
    };
    expect(body.row.rateLimitRpm).toBe(42);
    expect(body.row.rateLimitTpm).toBe(12_345);
  });
});
