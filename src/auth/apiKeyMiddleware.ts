import type { Context, MiddlewareHandler } from 'hono';
import type { ApiKeyRow, ApiKeyStore } from './apiKeyStore.js';

export interface AuthedContext {
  apiKey: ApiKeyRow;
}

/**
 * Extracts the API key from either `Authorization: Bearer <key>` (OpenAI style)
 * or `x-api-key: <key>` (Anthropic style), validates against the store, and
 * attaches the matched row to the context as `apiKey`.
 */
export function apiKeyMiddleware(store: ApiKeyStore): MiddlewareHandler {
  return async (c, next) => {
    const key = extractApiKey(c);
    if (!key) {
      return c.json(
        {
          error: {
            message: 'missing api key — provide Authorization: Bearer or x-api-key header',
            type: 'authentication_error',
          },
        },
        401,
      );
    }

    const row = await store.findByPlaintext(key);
    if (!row) {
      return c.json(
        { error: { message: 'invalid api key', type: 'authentication_error' } },
        401,
      );
    }

    c.set('apiKey', row);
    // Best-effort last-used tracking; never blocks the request.
    try {
      store.markUsed(row.id);
    } catch {
    }
    await next();
  };
}

function extractApiKey(c: Context): string | null {
  const auth = c.req.header('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return auth.slice('bearer '.length).trim();
  }
  const xKey = c.req.header('x-api-key');
  if (xKey) return xKey.trim();
  return null;
}
