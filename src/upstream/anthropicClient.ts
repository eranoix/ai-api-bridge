import { Pool, type Dispatcher } from 'undici';
import type { TokenManager } from '../oauth/TokenManager.js';
import type {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
} from '../translate/schemas.js';
import type { AnthropicStreamEvent } from '../translate/anthropicToOpenAI/streamEvents.js';
import { parseSSEStream } from '../utils/sse.js';
import { buildHeaders } from './headers.js';
import {
  UpstreamAuthError,
  UpstreamError,
  UpstreamNetworkError,
  UpstreamRateLimitError,
} from './errors.js';

export interface AnthropicClientOptions {
  baseUrl: string;
  tokenManager: TokenManager;
  version: string;
  /** Override dispatcher for tests (mock pool). */
  dispatcher?: Dispatcher;
}

/**
 * Calls the upstream messages API. Single source of truth for upstream HTTP, so
 * retries, error mapping and header construction exist in exactly one place.
 */

/** Plain async sleep, used by the bounded retry below. */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class AnthropicClient {
  private readonly pool: Pool;
  private readonly tokenManager: TokenManager;
  private readonly version: string;

  constructor(opts: AnthropicClientOptions) {
    this.tokenManager = opts.tokenManager;
    this.version = opts.version;
    this.pool =
      (opts.dispatcher as Pool | undefined) ??
      new Pool(opts.baseUrl, {
        connections: 10,
        pipelining: 1,
        keepAliveTimeout: 60_000,
        keepAliveMaxTimeout: 600_000,
        bodyTimeout: 300_000,
        // headersTimeout matches bodyTimeout: on a large non-streaming request the
        // provider sends no header until the whole reply is generated, often past 60s.
        headersTimeout: 300_000,
      });
  }

  async createMessage(body: AnthropicMessagesRequest): Promise<AnthropicMessagesResponse> {
    return this.requestWith401Retry(body);
  }

  /**
   * Open a streaming connection to `/v1/messages` and yield parsed SSE events.
   * 401-retry applies only before bytes are sent (upstream sends the status before
   * any SSE data). Pass `signal` so a client disconnect aborts the upstream.
   */
  async *streamMessage(
    body: AnthropicMessagesRequest,
    opts: { signal?: AbortSignal } = {},
  ): AsyncGenerator<AnthropicStreamEvent> {
    const stream = await this.openStream(body, opts.signal, 0);
    for await (const event of parseSSEStream(stream)) {
      yield event.data as AnthropicStreamEvent;
    }
  }

  private async openStream(
    body: AnthropicMessagesRequest,
    signal: AbortSignal | undefined,
    attempt: number,
  ): Promise<AsyncIterable<Uint8Array>> {
    const accessToken = await this.tokenManager.getAccessToken();
    const headers = buildHeaders(accessToken, { version: this.version });
    headers.accept = 'text/event-stream';

    let res;
    try {
      const reqOpts: Parameters<Pool['request']>[0] = {
        path: '/v1/messages',
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, stream: true }),
      };
      if (signal) reqOpts.signal = signal;
      res = await this.pool.request(reqOpts);
    } catch (err) {
      throw new UpstreamNetworkError(
        `network error opening Anthropic stream: ${(err as Error).message}`,
        err,
      );
    }

    if (res.statusCode === 401 && attempt === 0) {
      // Drain body before retry to free the connection.
      await res.body.text().catch(() => {});
      await this.tokenManager.forceRefresh();
      return this.openStream(body, signal, 1);
    }

    if (res.statusCode === 401) {
      const text = await res.body.text();
      throw new UpstreamAuthError(text);
    }
    if (res.statusCode === 429) {
      const text = await res.body.text();
      const retryAfterHeader = res.headers['retry-after'];
      const retryAfter =
        typeof retryAfterHeader === 'string' ? parseInt(retryAfterHeader, 10) : null;
      throw new UpstreamRateLimitError(text, Number.isFinite(retryAfter) ? retryAfter : null);
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const text = await res.body.text();
      throw new UpstreamError(`upstream returned ${res.statusCode}`, res.statusCode, text);
    }

    return res.body;
  }

  /**
   * Performs the upstream request. On 401, force a refresh and retry once
   * (covers the case where the cached token expired or was revoked while
   * we were holding it).
   */
  private async requestWith401Retry(
    body: AnthropicMessagesRequest,
    attempt = 0,
  ): Promise<AnthropicMessagesResponse> {
    const accessToken = await this.tokenManager.getAccessToken();
    const headers = buildHeaders(accessToken, { version: this.version });

    let res;
    try {
      res = await this.pool.request({
        path: '/v1/messages',
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, stream: false }),
      });
    } catch (err) {
      throw new UpstreamNetworkError(`network error calling Anthropic: ${(err as Error).message}`, err);
    }

    const text = await res.body.text();

    if (res.statusCode === 401 && attempt === 0) {
      await this.tokenManager.forceRefresh();
      return this.requestWith401Retry(body, 1);
    }

    if (res.statusCode === 401) {
      throw new UpstreamAuthError(text);
    }
    if (res.statusCode === 429) {
      const retryAfterHeader = res.headers['retry-after'];
      const retryAfter =
        typeof retryAfterHeader === 'string' ? parseInt(retryAfterHeader, 10) : null;
      throw new UpstreamRateLimitError(
        text,
        Number.isFinite(retryAfter) ? retryAfter : null,
      );
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new UpstreamError(
        `upstream returned ${res.statusCode}`,
        res.statusCode,
        text,
      );
    }

    try {
      return JSON.parse(text) as AnthropicMessagesResponse;
    } catch {
      throw new UpstreamError(
        'upstream returned non-JSON success body',
        res.statusCode,
        text,
      );
    }
  }

  /**
   * Generic passthrough: forwards a body verbatim to a path under the upstream
   * base URL with the configured credential. Returns `body` as parsed JSON
   * (application/json) or as a raw byte stream (text/event-stream).
   */
  async passthroughJson(
    method: 'POST' | 'GET',
    upstreamPath: string,
    body?: unknown,
  ): Promise<{ statusCode: number; json: unknown }> {
    // Bounded retry for TRANSIENT failures only (network errors, 429, 5xx): up to 3
    // attempts with a short backoff. Other responses return immediately, since
    // retrying them would only be slower.
    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const r = await this.jsonWith401Retry(method, upstreamPath, body, 0);
        if ((r.statusCode === 429 || r.statusCode >= 500) && attempt < maxAttempts) {
          await sleep(500 * attempt);
          continue;
        }
        return r;
      } catch (err) {
        lastError = err; // UpstreamNetworkError (network/timeout): transient
        if (attempt < maxAttempts) {
          await sleep(500 * attempt);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  private async jsonWith401Retry(
    method: 'POST' | 'GET',
    upstreamPath: string,
    body: unknown,
    attempt: number,
  ): Promise<{ statusCode: number; json: unknown }> {
    const accessToken = await this.tokenManager.getAccessToken();
    const headers = buildHeaders(accessToken, { version: this.version });
    let res;
    try {
      res = await this.pool.request({
        path: upstreamPath,
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new UpstreamNetworkError(
        `network error on ${method} ${upstreamPath}: ${(err as Error).message}`,
        err,
      );
    }

    const text = await res.body.text();

    if (res.statusCode === 401 && attempt === 0) {
      await this.tokenManager.forceRefresh();
      return this.jsonWith401Retry(method, upstreamPath, body, 1);
    }

    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        // upstream returned non-JSON; passthrough as-is via string
        json = text;
      }
    }
    return { statusCode: res.statusCode, json };
  }

  /**
   * Open a raw streaming connection — forwards bytes without parsing. Used
   * for the Anthropic-native `/v1/messages` passthrough so clients using the
   * official Anthropic SDK get the wire format Anthropic itself emits.
   */
  async passthroughStream(
    upstreamPath: string,
    body: unknown,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ statusCode: number; bodyStream: AsyncIterable<Uint8Array> }> {
    // The client's body goes upstream untouched: this is a protocol
    // gateway, so the request belongs to the caller.
    return this.streamWith401Retry(upstreamPath, body, opts.signal, 0);
  }

  private async streamWith401Retry(
    upstreamPath: string,
    body: unknown,
    signal: AbortSignal | undefined,
    attempt: number,
  ): Promise<{ statusCode: number; bodyStream: AsyncIterable<Uint8Array> }> {
    const accessToken = await this.tokenManager.getAccessToken();
    const headers = buildHeaders(accessToken, { version: this.version });
    headers.accept = 'text/event-stream';

    let res;
    try {
      const reqOpts: Parameters<Pool['request']>[0] = {
        path: upstreamPath,
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      };
      if (signal) reqOpts.signal = signal;
      res = await this.pool.request(reqOpts);
    } catch (err) {
      throw new UpstreamNetworkError(
        `network error opening passthrough stream: ${(err as Error).message}`,
        err,
      );
    }

    if (res.statusCode === 401 && attempt === 0) {
      await res.body.text().catch(() => {});
      await this.tokenManager.forceRefresh();
      return this.streamWith401Retry(upstreamPath, body, signal, 1);
    }

    return { statusCode: res.statusCode, bodyStream: res.body };
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}
