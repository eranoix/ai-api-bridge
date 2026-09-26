import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppContext } from './appContext.js';
import { healthRoutes, readinessRoutes } from './routes/health.js';
import { chatCompletionsRoutes } from './routes/chatCompletions.js';
import { modelsRoutes } from './routes/models.js';
import { messagesRoutes } from './routes/messages.js';
import { adminRoutes } from './routes/admin.js';
import { getAllowedOrigins } from './config/env.js';
import { logger } from './logging/logger.js';

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - start,
      },
      'request',
    );
  });

  // CORS for browser-based clients. Only the `/v1/*` API surface needs it;
  // /admin/* is cookie-authenticated and same-origin only.
  const allowed = getAllowedOrigins(ctx.env);
  if (allowed.length > 0) {
    app.use(
      '/v1/*',
      cors({
        origin: allowed,
        allowHeaders: [
          'authorization',
          'x-api-key',
          'content-type',
          'anthropic-version',
          'anthropic-beta',
          'accept',
        ],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        exposeHeaders: [
          'x-ratelimit-limit-requests',
          'x-ratelimit-remaining-requests',
          'x-ratelimit-reset-requests',
        ],
        maxAge: 86400,
        credentials: false,
      }),
    );
  }

  app.route('/', healthRoutes);
  app.route('/', readinessRoutes(ctx));
  app.route('/', adminRoutes(ctx));
  app.route('/', modelsRoutes(ctx));
  app.route('/', chatCompletionsRoutes(ctx));
  app.route('/', messagesRoutes(ctx));

  app.onError((err, c) => {
    logger.error({ err }, 'unhandled error');
    return c.json({ error: { message: 'internal_server_error', type: 'internal_error' } }, 500);
  });

  app.notFound((c) => c.json({ error: { message: 'not_found', path: c.req.path } }, 404));

  return app;
}
