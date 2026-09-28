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
  dispatcher?: Dispatcher;
}

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
        headersTimeout: 300_000,
      });
  }

  async createMessage(body: AnthropicMessagesRequest): Promise<AnthropicMessagesResponse> {
    return this.requestWith401Retry(body);
  }

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

  async passthroughJson(
    method: 'POST' | 'GET',
    upstreamPath: string,
    body?: unknown,
  ): Promise<{ statusCode: number; json: unknown }> {
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
        lastError = err;
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
        json = text;
      }
    }
    return { statusCode: res.statusCode, json };
  }

  async passthroughStream(
    upstreamPath: string,
    body: unknown,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ statusCode: number; bodyStream: AsyncIterable<Uint8Array> }> {
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
