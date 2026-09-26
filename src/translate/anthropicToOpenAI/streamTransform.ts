import { mapFinishReason } from './response.js';
import { encodeOpenAIChunk, SSE_DONE, SSE_KEEPALIVE } from '../../utils/sse.js';
import type { AnthropicStreamEvent } from './streamEvents.js';

export interface StreamTransformOptions {
  /** Client-requested model id (echoed back, not the upstream one). */
  requestedModel: string;
  /** Override clock for tests. */
  now?: () => number;
  /** Override the generated chat id for deterministic tests. */
  id?: string;
}

/**
 * Token usage observed during the stream. Surfaced via `getFinalUsage()` so
 * the route can write a usage_logs row after the stream finishes.
 */
export interface StreamUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * State machine that translates Anthropic SSE events into raw OpenAI-format
 * SSE strings.
 *
 * Each input event yields zero or more output strings (already framed as
 * `data: {...}\n\n`). The route writes each string to the response body
 * verbatim.
 *
 * NOTE: this is a synchronous generator over events — backpressure comes
 * naturally because the route awaits its own `stream.write()` between events.
 */
export class StreamTranslator {
  private readonly chatId: string;
  private readonly created: number;
  private readonly model: string;

  private usage: StreamUsage = { input_tokens: 0, output_tokens: 0 };
  private upstreamMessageId: string | null = null;

  /** Open tool-use blocks by Anthropic content index. */
  private readonly toolCallSeen = new Map<number, { id: string; name: string }>();

  constructor(opts: StreamTransformOptions) {
    this.model = opts.requestedModel;
    this.created = Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
    this.chatId = opts.id ?? `chatcmpl-${randomId()}`;
  }

  /** Emit at the very start, before any upstream byte arrives. */
  emitInitialChunk(): string {
    return this.formatChunk({
      delta: { role: 'assistant', content: '' },
    });
  }

  /**
   * Translate one upstream event into zero or more outbound SSE strings.
   */
  *handleEvent(event: AnthropicStreamEvent): Generator<string> {
    switch (event.type) {
      case 'message_start':
        this.upstreamMessageId = event.message.id;
        this.usage.input_tokens = event.message.usage.input_tokens;
        // We already emitted the initial role chunk; no extra output here.
        return;

      case 'content_block_start':
        if (event.content_block.type === 'tool_use') {
          this.toolCallSeen.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
          });
          yield this.formatChunk({
            delta: {
              tool_calls: [
                {
                  index: event.index,
                  id: event.content_block.id,
                  type: 'function',
                  function: { name: event.content_block.name, arguments: '' },
                },
              ],
            },
          });
        }
        return;

      case 'content_block_delta':
        if (event.delta.type === 'text_delta') {
          yield this.formatChunk({ delta: { content: event.delta.text } });
        } else if (event.delta.type === 'input_json_delta') {
          yield this.formatChunk({
            delta: {
              tool_calls: [
                {
                  index: event.index,
                  function: { arguments: event.delta.partial_json },
                },
              ],
            },
          });
        }
        return;

      case 'content_block_stop':
        return; // OpenAI has no per-block stop marker.

      case 'message_delta':
        if (event.usage?.output_tokens) {
          this.usage.output_tokens = event.usage.output_tokens;
        }
        if (event.delta.stop_reason) {
          yield this.formatChunk({
            delta: {},
            finish_reason: mapFinishReason(event.delta.stop_reason),
          });
        }
        return;

      case 'message_stop':
        yield SSE_DONE;
        return;

      case 'ping':
        // OpenAI clients (including the official SDK) tolerate SSE comment
        // lines as no-ops; this also keeps intermediate proxies from idling.
        yield SSE_KEEPALIVE;
        return;

      case 'error':
        yield this.formatChunk({
          delta: {},
          finish_reason: 'stop',
        });
        yield SSE_DONE;
        return;
    }
  }

  getFinalUsage(): StreamUsage {
    return this.usage;
  }

  getUpstreamMessageId(): string | null {
    return this.upstreamMessageId;
  }

  private formatChunk(over: {
    delta: Record<string, unknown>;
    finish_reason?: string | null;
  }): string {
    const chunk = {
      id: this.chatId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: over.delta,
          finish_reason: over.finish_reason ?? null,
        },
      ],
    };
    return encodeOpenAIChunk(chunk);
  }
}

function randomId(): string {
  return Array.from({ length: 24 }, () =>
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.charAt(
      Math.floor(Math.random() * 62),
    ),
  ).join('');
}
