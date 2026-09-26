import type { Context, MiddlewareHandler } from 'hono';
import type { ApiKeyRow } from '../auth/apiKeyStore.js';
import type { SlidingWindowLimiter } from './slidingWindow.js';

/**
 * Hono middleware that enforces per-API-key RPM and TPM limits using a
 * sliding window limiter. Adds `x-ratelimit-*` headers to every response.
 *
 * Must run AFTER `apiKeyMiddleware` so that `c.get('apiKey')` is populated.
 */
export function rateLimitMiddleware(limiter: SlidingWindowLimiter): MiddlewareHandler {
  return async (c, next) => {
    const apiKey = c.get('apiKey') as ApiKeyRow | undefined;
    if (!apiKey) {
      // Defensive: auth middleware should have rejected already.
      await next();
      return;
    }
    const limits = {
      rpm: apiKey.rateLimitRpm,
      tpm: apiKey.rateLimitTpm,
      dailyTokens: apiKey.dailyTokenBudget,
    };
    const check = limiter.checkAndReserve(apiKey.id, limits);

    setRateLimitHeaders(c, limits.rpm, limits.rpm - check.requestsInWindow, check.resetSec);

    if (!check.allowed) {
      return c.json(
        {
          error: {
            message: `rate limit (${check.reason}); retry in ${check.resetSec}s`,
            type: 'rate_limit_error',
            reason: check.reason,
          },
        },
        429,
      );
    }
    await next();
  };
}

function setRateLimitHeaders(c: Context, limit: number, remaining: number, resetSec: number): void {
  c.res.headers.set('x-ratelimit-limit-requests', String(limit));
  c.res.headers.set('x-ratelimit-remaining-requests', String(Math.max(0, remaining)));
  c.res.headers.set('x-ratelimit-reset-requests', `${resetSec}s`);
}
