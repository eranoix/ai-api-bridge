import type { AnthropicMessagesResponse } from '../schemas.js';

export interface OpenAIChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface TranslateResponseOptions {
  /** Model the *client* asked for — echoed back unchanged. */
  requestedModel: string;
}

export function translateResponse(
  resp: AnthropicMessagesResponse,
  opts: TranslateResponseOptions,
): OpenAIChatCompletionResponse {
  const texts: string[] = [];
  const toolCalls: NonNullable<
    OpenAIChatCompletionResponse['choices'][number]['message']['tool_calls']
  > = [];

  for (const block of resp.content) {
    if (block.type === 'text') {
      texts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const content = texts.join('');
  const message: OpenAIChatCompletionResponse['choices'][number]['message'] = {
    role: 'assistant',
    content: content.length > 0 ? content : null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: resp.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: opts.requestedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapFinishReason(resp.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: resp.usage.input_tokens,
      completion_tokens: resp.usage.output_tokens,
      total_tokens: resp.usage.input_tokens + resp.usage.output_tokens,
    },
  };
}

export function mapFinishReason(
  reason: AnthropicMessagesResponse['stop_reason'],
): 'stop' | 'length' | 'tool_calls' | 'content_filter' | null {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case null:
      return null;
    default:
      return 'stop';
  }
}
