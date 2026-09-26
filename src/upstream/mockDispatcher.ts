/**
 * In-process mock upstream, enabled with MOCK_UPSTREAM=1, so the gateway runs with
 * no provider account or credentials. It uses the client's injectable `dispatcher`
 * (the test seam), so only the network call at the far end is replaced.
 */

import { MockAgent, type Dispatcher } from 'undici';

const CANNED_TEXT =
  'This reply comes from the built-in mock upstream. The request travelled ' +
  'through the real routing, validation, translation and rate-limiting path; ' +
  'only the provider call itself was replaced. Unset MOCK_UPSTREAM to talk to ' +
  'a live provider.';

function messagesResponse(model: string) {
  return {
    id: 'msg_mock_0000000000',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: CANNED_TEXT }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 24, output_tokens: 48 },
  };
}

/** Server-sent events mirroring the shape of a real streamed reply. */
function streamBody(model: string): string {
  const ev = (type: string, data: unknown) =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const words = CANNED_TEXT.split(' ');
  return (
    ev('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_mock_0000000000',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        usage: { input_tokens: 24, output_tokens: 0 },
      },
    }) +
    ev('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }) +
    words
      .map((w, i) =>
        ev('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: i === 0 ? w : ` ${w}` },
        }),
      )
      .join('') +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: words.length },
    }) +
    ev('message_stop', { type: 'message_stop' })
  );
}

/**
 * Returns a MockPool, not the MockAgent: the client calls `.request({ path })`
 * with no origin, which a top-level MockAgent cannot route (it surfaces as
 * "upstream unreachable"). MockPool is bound to the origin.
 */
export function createMockDispatcher(baseUrl: string): Dispatcher {
  const agent = new MockAgent();
  agent.disableNetConnect();

  const pool = agent.get(new URL(baseUrl).origin);
  pool
    .intercept({ path: /\/v1\/messages$/, method: 'POST' })
    .reply((opts) => {
      let model = 'claude-sonnet-4-5';
      let stream = false;
      try {
        const body = JSON.parse(String(opts.body ?? '{}'));
        model = body.model ?? model;
        stream = Boolean(body.stream);
      } catch {
        // A malformed body is the caller's problem and is reported upstream of
        // here; the mock just falls back to defaults rather than throwing.
      }
      return stream
        ? {
            statusCode: 200,
            data: streamBody(model),
            responseOptions: { headers: { 'content-type': 'text/event-stream' } },
          }
        : {
            statusCode: 200,
            data: JSON.stringify(messagesResponse(model)),
            responseOptions: { headers: { 'content-type': 'application/json' } },
          };
    })
    .persist();

  // `agent.get()` is typed as Interceptable; it is a MockPool at runtime and
  // satisfies the Dispatcher contract the client consumes.
  return pool as unknown as Dispatcher;
}
