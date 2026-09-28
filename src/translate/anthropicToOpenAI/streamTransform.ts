import { mapFinishReason } from './response.js';
import { encodeOpenAIChunk, SSE_DONE, SSE_KEEPALIVE } from '../../utils/sse.js';
import type { AnthropicStreamEvent } from './streamEvents.js';

export interface StreamTransformOptions {
  requestedModel: string;
  now?: () => number;
  id?: string;
}

export interface StreamUsage {
  input_tokens: number;
  output_tokens: number;
}

export class StreamTranslator {
  private readonly chatId: string;
  private readonly created: number;
  private readonly model: string;

  private usage: StreamUsage = { input_tokens: 0, output_tokens: 0 };
  private upstreamMessageId: string | null = null;

  private readonly toolCallSeen = new Map<number, { id: string; name: string }>();

  constructor(opts: StreamTransformOptions) {
    this.model = opts.requestedModel;
    this.created = Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
    this.chatId = opts.id ?? `chatcmpl-${randomId()}`;
  }

  emitInitialChunk(): string {
    return this.formatChunk({
      delta: { role: 'assistant', content: '' },
    });
  }

  *handleEvent(event: AnthropicStreamEvent): Generator<string> {
    switch (event.type) {
      case 'message_start':
        this.upstreamMessageId = event.message.id;
        this.usage.input_tokens = event.message.usage.input_tokens;
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
        return;

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
