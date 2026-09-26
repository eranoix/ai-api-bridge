import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { AddressInfo } from 'node:net';

export interface MockSSEEvent {
  event?: string;
  data: unknown;
}

export interface MockAnthropicHandle {
  url: string;
  tokenCalls: number;
  messagesCalls: number;
  lastMessagesRequest: unknown;
  lastMessagesHeaders: Record<string, string>;
  setMessagesResponder(fn: (body: unknown) => unknown): void;
  setStreamingScript(events: MockSSEEvent[], opts?: { delayMs?: number }): void;
  setNextTokenResponse(resp: { access_token: string; refresh_token: string; expires_in: number }): void;
  close(): Promise<void>;
}

/** Default SSE script: short text response. */
export function defaultStreamingScript(): MockSSEEvent[] {
  return [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: { id: 'msg_stream', model: 'claude-opus-4-7', usage: { input_tokens: 10, output_tokens: 0 } },
      },
    },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'ping', data: { type: 'ping' } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

/**
 * Mock Anthropic server. Implements:
 *  - POST /v1/messages  (chat completions)
 *  - POST /v1/oauth/token (refresh)
 *
 * Bind the server to port 0 so each test gets a unique port.
 */
export async function startMockAnthropic(): Promise<MockAnthropicHandle> {
  let messagesResponder: (body: unknown) => unknown = (body) => ({
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    model: (body as { model?: string }).model ?? 'claude-opus-4-7',
    content: [{ type: 'text', text: 'mock response' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  let nextTokenResponse: { access_token: string; refresh_token: string; expires_in: number } = {
    access_token: 'mock-access-new',
    refresh_token: 'mock-refresh-new',
    expires_in: 3600,
  };
  let streamingScript: MockSSEEvent[] = defaultStreamingScript();
  let streamingDelayMs = 0;

  const handle: Partial<MockAnthropicHandle> = {
    tokenCalls: 0,
    messagesCalls: 0,
    lastMessagesRequest: null,
    lastMessagesHeaders: {},
    setMessagesResponder(fn) {
      messagesResponder = fn;
    },
    setStreamingScript(events, opts) {
      streamingScript = events;
      streamingDelayMs = opts?.delayMs ?? 0;
    },
    setNextTokenResponse(resp) {
      nextTokenResponse = resp;
    },
  };

  const app = new Hono();

  app.post('/v1/oauth/token', async (c) => {
    handle.tokenCalls = (handle.tokenCalls ?? 0) + 1;
    return c.json(nextTokenResponse);
  });

  app.post('/v1/messages', async (c) => {
    handle.messagesCalls = (handle.messagesCalls ?? 0) + 1;
    const body = (await c.req.json()) as { stream?: boolean };
    handle.lastMessagesRequest = body;
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => (headers[k] = v));
    handle.lastMessagesHeaders = headers;

    if (body.stream) {
      const events = streamingScript;
      const delay = streamingDelayMs;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const ev of events) {
            const lines: string[] = [];
            if (ev.event) lines.push(`event: ${ev.event}`);
            lines.push(`data: ${JSON.stringify(ev.data)}`);
            controller.enqueue(encoder.encode(lines.join('\n') + '\n\n'));
            if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      });
    }

    return c.json(messagesResponder(body));
  });

  let server: ServerType;
  const ready = new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      handle.url = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
  await ready;

  handle.close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return handle as MockAnthropicHandle;
}

/** Tiny helper for the AddressInfo cast. */
export function _port(info: AddressInfo | string | null): number {
  if (!info || typeof info === 'string') return 0;
  return info.port;
}
