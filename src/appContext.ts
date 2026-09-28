import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Env } from './config/env.js';
import type { Db } from './storage/db.js';
import { openDb } from './storage/db.js';
import { createMockDispatcher } from './upstream/mockDispatcher.js';
import { ApiKeyStore } from './auth/apiKeyStore.js';
import { CredentialsStore } from './oauth/credentialsStore.js';
import { HttpRefreshClient } from './oauth/refreshClient.js';
import { TokenManager } from './oauth/TokenManager.js';
import { AnthropicClient } from './upstream/anthropicClient.js';
import { UsageLogger } from './storage/usageLogger.js';
import { SlidingWindowLimiter } from './ratelimit/slidingWindow.js';
import { logger } from './logging/logger.js';

export interface AppContext {
  env: Env;
  db: Db;
  apiKeys: ApiKeyStore;
  tokenManager: TokenManager;
  anthropic: AnthropicClient;
  usage: UsageLogger;
  rateLimiter: SlidingWindowLimiter;
  close(): Promise<void>;
}

export async function buildAppContext(env: Env): Promise<AppContext> {
  const db = await openDb({ dbPath: env.DATABASE_PATH });
  const apiKeys = new ApiKeyStore(db);
  const credentialsStore = new CredentialsStore(env.CREDENTIALS_PATH);
  const refreshClient = new HttpRefreshClient({
    tokenUrl: env.ANTHROPIC_OAUTH_TOKEN_URL,
    clientId: env.CLAUDE_CLIENT_ID,
  });
  const tokenManager = new TokenManager({
    credentialsStore,
    refreshClient,
    logger: logger.child({ module: 'oauth' }),
  });
  if (env.MOCK_UPSTREAM) {
    logger.warn('MOCK_UPSTREAM is set: replies are canned, no provider is contacted');
  }
  const anthropic = new AnthropicClient({
    baseUrl: env.ANTHROPIC_BASE_URL,
    tokenManager,
    version: env.GATEWAY_VERSION,
    dispatcher: env.MOCK_UPSTREAM
      ? createMockDispatcher(env.ANTHROPIC_BASE_URL)
      : undefined,
  });
  if (env.MOCK_UPSTREAM) {
    const credPath = env.CREDENTIALS_PATH;
    if (!existsSync(credPath)) {
      mkdirSync(dirname(credPath), { recursive: true });
      writeFileSync(
        credPath,
        JSON.stringify(
          {
            claudeAiOauth: {
              accessToken: 'mock-access-token',
              refreshToken: 'mock-refresh-token',
              expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
            },
          },
          null,
          2,
        ),
        'utf8',
      );
    }
    const demoKeyName = 'mock-mode demo key';
    const keyFile = join(dirname(credPath), 'DEMO_API_KEY.txt');
    const existingDemo = apiKeys.list().find((k) => k.name === demoKeyName && !k.revokedAt);

    if (existingDemo && existsSync(keyFile)) {
      logger.warn({ keyFile }, 'mock mode: reusing the demo API key already in ' + keyFile);
    } else {
      if (existingDemo) {
        db.prepare('DELETE FROM usage_logs WHERE api_key_id = ?').run(existingDemo.id);
        db.prepare('DELETE FROM rate_limit_buckets WHERE api_key_id = ?').run(existingDemo.id);
        db.prepare('DELETE FROM api_keys WHERE id = ?').run(existingDemo.id);
      }
      const created = await apiKeys.create({ name: demoKeyName });
      writeFileSync(keyFile, created.plaintext + String.fromCharCode(10), 'utf8');
      logger.warn(
        { apiKey: created.plaintext, keyFile },
        'mock mode: created demo API key — use it as Authorization: Bearer',
      );
    }
  }

  const usage = new UsageLogger(db);
  const rateLimiter = new SlidingWindowLimiter(db);

  const cleanupInterval = setInterval(() => {
    try {
      const deleted = rateLimiter.cleanup();
      if (deleted > 0) logger.debug({ deleted }, 'rate_limit_buckets cleanup');
    } catch (err) {
      logger.warn({ err }, 'rate_limit cleanup failed');
    }
  }, 5 * 60 * 1000);
  cleanupInterval.unref();

  return {
    env,
    db,
    apiKeys,
    tokenManager,
    anthropic,
    usage,
    rateLimiter,
    async close() {
      clearInterval(cleanupInterval);
      await anthropic.close();
      db.close();
    },
  };
}
