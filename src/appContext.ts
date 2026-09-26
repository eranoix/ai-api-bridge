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

/**
 * Wires together the long-lived singletons used by every request.
 * Built once in `main.ts`, then handed to route factories.
 */
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
  // Mock upstream is injected at the dispatcher seam the tests use, so routing,
  // validation, translation, rate limiting and usage accounting still run for real.
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
  // Mock mode hands whoever just cloned this a working API key, and seeds a
  // long-lived fake credential file so the real token path (single-flight,
  // locking, expiry checks) still runs instead of being bypassed.
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
              // Far future: mock mode should never attempt a refresh, since
              // there is no token endpoint to refresh against.
              expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
            },
          },
          null,
          2,
        ),
        'utf8',
      );
    }
    // Written to a file as well as logged: parsing a log depends on its format,
    // colour codes and redirection, while a file lets a script read the key reliably.
    const demoKeyName = 'mock-mode demo key';
    const keyFile = join(dirname(credPath), 'DEMO_API_KEY.txt');
    const existingDemo = apiKeys.list().find((k) => k.name === demoKeyName && !k.revokedAt);

    if (existingDemo && existsSync(keyFile)) {
      // Reuse: `api_keys.name` is UNIQUE, so creating it unconditionally would fail
      // every boot after the first (and `tsx watch` restarts on every save).
      logger.warn({ keyFile }, 'mock mode: reusing the demo API key already in ' + keyFile);
    } else {
      if (existingDemo) {
        // The row outlived its key file. Only the hash is stored, so the
        // plaintext is unrecoverable: drop the row and mint a new one. The
        // usage rows go first, because the foreign key is enforced.
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

  // Periodically clean up old rate-limit buckets so the table doesn't grow unbounded.
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
