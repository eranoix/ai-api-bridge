import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppContext } from '../appContext.js';
import { apiKeyMiddleware } from '../auth/apiKeyMiddleware.js';
import type { ApiKeyRow } from '../auth/apiKeyStore.js';
import { logger } from '../logging/logger.js';
import { translateRequest } from '../translate/openaiToAnthropic/request.js';
import { resolveUpstreamModel } from '../translate/openaiToAnthropic/models.js';
import { translateResponse } from '../translate/anthropicToOpenAI/response.js';
import { StreamTranslator } from '../translate/anthropicToOpenAI/streamTransform.js';
import { openaiChatCompletionRequestSchema } from '../translate/schemas.js';
import { MultimodalError } from '../translate/openaiToAnthropic/multimodal.js';
import { rateLimitMiddleware } from '../ratelimit/middleware.js';
import {
  UpstreamAuthError,
  UpstreamError,
  UpstreamNetworkError,
  UpstreamRateLimitError,
} from '../upstream/errors.js';

/** Body size cap; nginx enforces the same limit at the edge. */
const MAX_BODY_BYTES = 25 * 1024 * 1024;

type Vars = { apiKey: ApiKeyRow };

export function chatCompletionsRoutes(ctx: AppContext): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>();

  app.use('/v1/chat/completions', apiKeyMiddleware(ctx.apiKeys));
  app.use('/v1/chat/completions', rateLimitMiddleware(ctx.rateLimiter));

  app.post('/v1/chat/completions', async (c) => {
    const apiKey = c.get('apiKey');
    const started = Date.now();

    const contentLength = Number(c.req.header('content-length') ?? '0');
    if (contentLength > MAX_BODY_BYTES) {
      return c.json(
        { error: { message: `request body exceeds ${MAX_BODY_BYTES} bytes`, type: 'invalid_request_error' } },
        413,
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        { error: { message: 'invalid JSON in request body', type: 'invalid_request_error' } },
        400,
      );
    }

    const parsed = openaiChatCompletionRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
            type: 'invalid_request_error',
          },
        },
        400,
      );
    }

    const requestedModel = parsed.data.model;

    let anthropicReq;
    try {
      anthropicReq = translateRequest(parsed.data, {
        defaultMaxTokens: ctx.env.DEFAULT_MAX_TOKENS,
      });
    } catch (err) {
      if (err instanceof MultimodalError) {
        return c.json(
          { error: { message: err.message, type: 'invalid_request_error' } },
          400,
        );
      }
      throw err;
    }

    if (parsed.data.stream) {
      return handleStreaming(c, ctx, anthropicReq, {
        apiKey,
        requestedModel,
        started,
      });
    }

    try {
      const upstream = await ctx.anthropic.createMessage(anthropicReq);
      const response = translateResponse(upstream, { requestedModel });
      const totalTokens = upstream.usage.input_tokens + upstream.usage.output_tokens;
      ctx.rateLimiter.addTokens(apiKey.id, totalTokens);
      ctx.usage.log({
        apiKeyId: apiKey.id,
        endpoint: 'chat.completions',
        requestedModel,
        upstreamModel: resolveUpstreamModel(requestedModel),
        inputTokens: upstream.usage.input_tokens,
        outputTokens: upstream.usage.output_tokens,
        latencyMs: Date.now() - started,
        statusCode: 200,
      });
      return c.json(response);
    } catch (err) {
      return handleUpstreamError(c, err, {
        apiKey,
        requestedModel,
        latencyMs: Date.now() - started,
        ctx,
      });
    }
  });

  return app;
}

interface ErrorContext {
  apiKey: ApiKeyRow;
  requestedModel: string;
  latencyMs: number;
  ctx: AppContext;
}

function handleUpstreamError(
  c: Context,
  err: unknown,
  meta: ErrorContext,
): Response {
  const log = logger.child({ keyId: meta.apiKey.id, keyName: meta.apiKey.name });

  if (err instanceof UpstreamRateLimitError) {
    log.warn({ retryAfterSec: err.retryAfterSec }, 'upstream 429');
    meta.ctx.usage.log({
      apiKeyId: meta.apiKey.id,
      endpoint: 'chat.completions',
      requestedModel: meta.requestedModel,
      latencyMs: meta.latencyMs,
      statusCode: 429,
      errorCode: 'upstream_rate_limit',
    });
    return c.json(
      { error: { message: 'upstream rate limit', type: 'rate_limit_error' } },
      429,
    );
  }
  if (err instanceof UpstreamAuthError) {
    log.error('upstream 401 — OAuth token rejected even after refresh');
    meta.ctx.usage.log({
      apiKeyId: meta.apiKey.id,
      endpoint: 'chat.completions',
      requestedModel: meta.requestedModel,
      latencyMs: meta.latencyMs,
      statusCode: 502,
      errorCode: 'upstream_auth_failed',
    });
    return c.json(
      {
        error: {
          message: 'upstream auth failed — token may need re-login. Check check-oauth-health.',
          type: 'upstream_error',
        },
      },
      502,
    );
  }
  if (err instanceof UpstreamError) {
    log.error({ status: err.statusCode, body: err.responseBody }, 'upstream error');
    meta.ctx.usage.log({
      apiKeyId: meta.apiKey.id,
      endpoint: 'chat.completions',
      requestedModel: meta.requestedModel,
      latencyMs: meta.latencyMs,
      statusCode: 502,
      errorCode: `upstream_${err.statusCode}`,
    });
    return c.json(
      { error: { message: `upstream error: ${err.message}`, type: err.errorType } },
      502,
    );
  }
  if (err instanceof UpstreamNetworkError) {
    log.error({ cause: (err.upstreamCause as Error)?.message }, 'upstream network error');
    meta.ctx.usage.log({
      apiKeyId: meta.apiKey.id,
      endpoint: 'chat.completions',
      requestedModel: meta.requestedModel,
      latencyMs: meta.latencyMs,
      statusCode: 503,
      errorCode: 'upstream_network',
    });
    return c.json(
      { error: { message: 'upstream unreachable', type: 'upstream_error' } },
      503,
    );
  }

  log.error({ err }, 'unexpected error in chat.completions');
  return c.json(
    { error: { message: 'internal server error', type: 'internal_error' } },
    500,
  );
}

interface StreamMeta {
  apiKey: ApiKeyRow;
  requestedModel: string;
  started: number;
}

function handleStreaming(
  c: Context,
  ctx: AppContext,
  anthropicReq: ReturnType<typeof translateRequest>,
  meta: StreamMeta,
): Response {
  const log = logger.child({ keyId: meta.apiKey.id, keyName: meta.apiKey.name });
  const translator = new StreamTranslator({ requestedModel: meta.requestedModel });

  return streamSSE(c, async (stream) => {
    const ac = new AbortController();
    const onClientAbort = (): void => ac.abort();
    c.req.raw.signal.addEventListener('abort', onClientAbort);

    let upstreamStatus = 200;
    let upstreamError: string | undefined;

    try {
      // The initial "role: assistant" chunk before any upstream byte arrives.
      await stream.write(translator.emitInitialChunk());

      for await (const event of ctx.anthropic.streamMessage(anthropicReq, { signal: ac.signal })) {
        for (const chunk of translator.handleEvent(event)) {
          await stream.write(chunk);
        }
      }
    } catch (err) {
      if (err instanceof UpstreamRateLimitError) {
        upstreamStatus = 429;
        upstreamError = 'upstream_rate_limit';
        log.warn({ retryAfterSec: err.retryAfterSec }, 'upstream 429 (stream)');
      } else if (err instanceof UpstreamAuthError) {
        upstreamStatus = 502;
        upstreamError = 'upstream_auth_failed';
        log.error('upstream 401 (stream) — OAuth token rejected even after refresh');
      } else if (err instanceof UpstreamError) {
        upstreamStatus = 502;
        upstreamError = `upstream_${err.statusCode}`;
        log.error({ status: err.statusCode, body: err.responseBody }, 'upstream error (stream)');
      } else if (err instanceof UpstreamNetworkError) {
        upstreamStatus = 503;
        upstreamError = 'upstream_network';
        log.error({ cause: (err.upstreamCause as Error)?.message }, 'upstream network (stream)');
      } else {
        upstreamStatus = 500;
        upstreamError = 'internal_error';
        log.error({ err }, 'unexpected error during stream');
      }
      // Write an error-shaped chunk so the client gets a finalizer.
      try {
        await stream.write(
          `data: ${JSON.stringify({
            error: {
              message: upstreamError ?? 'stream error',
              type: 'upstream_error',
            },
          })}\n\n`,
        );
        await stream.write('data: [DONE]\n\n');
      } catch {
        // client likely already disconnected
      }
    } finally {
      c.req.raw.signal.removeEventListener('abort', onClientAbort);
      const usage = translator.getFinalUsage();
      const totalTokens = usage.input_tokens + usage.output_tokens;
      if (totalTokens > 0) ctx.rateLimiter.addTokens(meta.apiKey.id, totalTokens);
      ctx.usage.log({
        apiKeyId: meta.apiKey.id,
        endpoint: 'chat.completions',
        requestedModel: meta.requestedModel,
        upstreamModel: resolveUpstreamModel(meta.requestedModel),
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        latencyMs: Date.now() - meta.started,
        statusCode: upstreamStatus,
        ...(upstreamError ? { errorCode: upstreamError } : {}),
      });
    }
  });
}
