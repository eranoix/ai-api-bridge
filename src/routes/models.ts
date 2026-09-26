import { Hono } from 'hono';
import type { AppContext } from '../appContext.js';
import { apiKeyMiddleware } from '../auth/apiKeyMiddleware.js';
import { listKnownModels } from '../translate/openaiToAnthropic/models.js';
import type { ApiKeyRow } from '../auth/apiKeyStore.js';

type Vars = { apiKey: ApiKeyRow };

export function modelsRoutes(ctx: AppContext): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>();
  app.use('/v1/models', apiKeyMiddleware(ctx.apiKeys));

  app.get('/v1/models', (c) => {
    const now = Math.floor(Date.now() / 1000);
    const data = listKnownModels().map((id) => ({
      id,
      object: 'model' as const,
      created: now,
      owned_by: 'ai-api-bridge',
    }));
    return c.json({ object: 'list', data });
  });

  return app;
}
