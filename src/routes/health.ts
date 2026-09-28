import { Hono } from 'hono';
import type { AppContext } from '../appContext.js';

export const healthRoutes = new Hono();

healthRoutes.get('/healthz', (c) =>
  c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }),
);

export function readinessRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  app.get('/readyz', async (c) => {
    const checks: Record<string, 'ok' | 'fail'> = {};

    try {
      ctx.db.prepare('SELECT 1').get();
      checks.db = 'ok';
    } catch {
      checks.db = 'fail';
    }

    let oauthDetail: Record<string, unknown> | null = null;
    try {
      const status = await ctx.tokenManager.getStatus();
      checks.oauth =
        status.accessTokenValid || status.isLongLived
          ? 'ok'
          : status.circuitBreakerState === 'open'
            ? 'fail'
            : 'ok';
      oauthDetail = {
        accessTokenValid: status.accessTokenValid,
        isLongLived: status.isLongLived,
        circuitBreakerState: status.circuitBreakerState,
      };
    } catch {
      checks.oauth = 'fail';
    }

    const allOk = Object.values(checks).every((v) => v === 'ok');
    return c.json(
      { status: allOk ? 'ok' : 'degraded', checks, ...(oauthDetail ? { oauth: oauthDetail } : {}) },
      allOk ? 200 : 503,
    );
  });
  return app;
}
