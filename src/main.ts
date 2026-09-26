import { serve } from '@hono/node-server';
import { loadEnv } from './config/env.js';
import { createApp } from './server.js';
import { buildAppContext } from './appContext.js';
import { logger } from './logging/logger.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const ctx = await buildAppContext(env);
  const app = createApp(ctx);

  const server = serve(
    {
      fetch: app.fetch,
      hostname: env.HOST,
      port: env.PORT,
    },
    (info) => {
      logger.info(
        { host: info.address, port: info.port, env: env.NODE_ENV },
        'ai-api-bridge listening',
      );
    },
  );

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutdown initiated');
    server.close(async (err) => {
      if (err) {
        logger.error({ err }, 'shutdown error');
        process.exit(1);
      }
      await ctx.close().catch((closeErr) => logger.error({ closeErr }, 'context close error'));
      logger.info('shutdown complete');
      process.exit(0);
    });
    setTimeout(() => {
      logger.warn('shutdown timeout — forcing exit');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  // Bootstrap-time failure: the logger may not be initialized.
  console.error('fatal startup error:', err);
  process.exit(1);
});
