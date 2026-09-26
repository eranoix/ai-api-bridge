import { Hono, type Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import type { AppContext } from '../appContext.js';
import { apiKeyMiddleware } from '../auth/apiKeyMiddleware.js';
import type { ApiKeyRow } from '../auth/apiKeyStore.js';
import { logger } from '../logging/logger.js';
import { rateLimitMiddleware } from '../ratelimit/middleware.js';

const MAX_BODY_BYTES = 25 * 1024 * 1024;

type Vars = { apiKey: ApiKeyRow };

/**
 * Anthropic-compatible endpoints. These exist so that clients using the
 * official `@anthropic-ai/sdk` (or `curl`-style native requests) can hit the
 * proxy by setting `baseURL` and `apiKey` to a `sk-priv-*` value.
 *
 * The body is forwarded upstream verbatim — the gateway only attaches the
 * configured credential and its own identifying headers, then propagates the
 * response (JSON or SSE) back unchanged.
 */
export function messagesRoutes(ctx: AppContext): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>();
  app.use('/v1/messages', apiKeyMiddleware(ctx.apiKeys));
  app.use('/v1/messages/*', apiKeyMiddleware(ctx.apiKeys));
  app.use('/v1/messages', rateLimitMiddleware(ctx.rateLimiter));
  app.use('/v1/messages/*', rateLimitMiddleware(ctx.rateLimiter));

  app.post('/v1/messages', async (c) => {
    const apiKey = c.get('apiKey');
    const started = Date.now();

    const contentLength = Number(c.req.header('content-length') ?? '0');
    if (contentLength > MAX_BODY_BYTES) {
      return c.json(
        { type: 'error', error: { type: 'invalid_request_error', message: `body exceeds ${MAX_BODY_BYTES} bytes` } },
        413,
      );
    }

    let body: { model?: string; stream?: boolean } & Record<string, unknown>;
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json(
        { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } },
        400,
      );
    }

    if (body.stream) {
      return handlePassthroughStream(c, ctx, body, { apiKey, started });
    }

    try {
      const { statusCode, json } = await ctx.anthropic.passthroughJson('POST', '/v1/messages', body);
      const usage = extractUsage(json);
      const totalTokens = (usage.input ?? 0) + (usage.output ?? 0);
      if (totalTokens > 0) ctx.rateLimiter.addTokens(apiKey.id, totalTokens);
      ctx.usage.log({
        apiKeyId: apiKey.id,
        endpoint: 'messages',
        requestedModel: body.model,
        upstreamModel: body.model,
        inputTokens: usage.input,
        outputTokens: usage.output,
        latencyMs: Date.now() - started,
        statusCode,
      });
      return c.json(json as Record<string, unknown>, statusCode as 200 | 400 | 401 | 429 | 500 | 502);
    } catch (err) {
      logger.error({ err, keyId: apiKey.id }, 'messages passthrough error');
      ctx.usage.log({
        apiKeyId: apiKey.id,
        endpoint: 'messages',
        requestedModel: body.model,
        latencyMs: Date.now() - started,
        statusCode: 502,
        errorCode: 'upstream_network',
      });
      return c.json(
        { type: 'error', error: { type: 'api_error', message: 'upstream unreachable' } },
        502,
      );
    }
  });

  app.post('/v1/messages/count_tokens', async (c) => {
    const apiKey = c.get('apiKey');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } },
        400,
      );
    }
    try {
      const { statusCode, json } = await ctx.anthropic.passthroughJson(
        'POST',
        '/v1/messages/count_tokens',
        body,
      );
      ctx.usage.log({
        apiKeyId: apiKey.id,
        endpoint: 'messages.count_tokens',
        latencyMs: 0,
        statusCode,
      });
      return c.json(json as Record<string, unknown>, statusCode as 200 | 400);
    } catch (err) {
      logger.error({ err, keyId: apiKey.id }, 'count_tokens passthrough error');
      return c.json(
        { type: 'error', error: { type: 'api_error', message: 'upstream unreachable' } },
        502,
      );
    }
  });

  return app;
}

function extractUsage(json: unknown): { input?: number; output?: number } {
  if (!json || typeof json !== 'object') return {};
  const u = (json as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
  return { input: u?.input_tokens, output: u?.output_tokens };
}

interface StreamMeta {
  apiKey: ApiKeyRow;
  started: number;
}

function handlePassthroughStream(
  c: Context,
  ctx: AppContext,
  body: { model?: string; stream?: boolean } & Record<string, unknown>,
  meta: StreamMeta,
): Response {
  const log = logger.child({ keyId: meta.apiKey.id });
  c.header('content-type', 'text/event-stream');
  c.header('cache-control', 'no-cache');
  c.header('connection', 'keep-alive');
  return honoStream(c, async (out) => {
      const ac = new AbortController();
      const onClientAbort = (): void => ac.abort();
      c.req.raw.signal.addEventListener('abort', onClientAbort);

      let statusCode = 200;
      let errorCode: string | undefined;
      try {
        const { statusCode: sc, bodyStream } = await ctx.anthropic.passthroughStream(
          '/v1/messages',
          body,
          { signal: ac.signal },
        );
        statusCode = sc;
        if (sc !== 200) {
          // Forward the error body verbatim, then exit.
          for await (const chunk of bodyStream) {
            await out.write(chunk);
          }
          errorCode = `upstream_${sc}`;
          return;
        }
        for await (const chunk of bodyStream) {
          await out.write(chunk);
        }
      } catch (err) {
        statusCode = 502;
        errorCode = 'upstream_network';
        log.error({ err }, 'messages stream passthrough error');
        const errEvent =
          `event: error\n` +
          `data: ${JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: 'upstream unreachable' },
          })}\n\n`;
        try {
          await out.write(errEvent);
        } catch {
          // client disconnected
        }
      } finally {
        c.req.raw.signal.removeEventListener('abort', onClientAbort);
        ctx.usage.log({
          apiKeyId: meta.apiKey.id,
          endpoint: 'messages',
          requestedModel: body.model,
          upstreamModel: body.model,
          latencyMs: Date.now() - meta.started,
          statusCode,
          ...(errorCode ? { errorCode } : {}),
        });
      }
    });
}
