import { describe, it, expect } from 'vitest';
import { translateResponse, mapFinishReason } from '../../../src/translate/anthropicToOpenAI/response.js';
import type { AnthropicMessagesResponse } from '../../../src/translate/schemas.js';

function fakeResp(over: Partial<AnthropicMessagesResponse> = {}): AnthropicMessagesResponse {
  return {
    id: 'msg_abc',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-7',
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 3 },
    ...over,
  };
}

describe('translateResponse', () => {
  it('echoes the requested model (not the upstream one)', () => {
    const out = translateResponse(fakeResp(), { requestedModel: 'gpt-4o' });
    expect(out.model).toBe('gpt-4o');
  });

  it('joins multiple text blocks into a single string', () => {
    const out = translateResponse(
      fakeResp({
        content: [
          { type: 'text', text: 'A' },
          { type: 'text', text: 'B' },
          { type: 'text', text: 'C' },
        ],
      }),
      { requestedModel: 'gpt-4o' },
    );
    expect(out.choices[0]?.message.content).toBe('ABC');
  });

  it('emits tool_calls when the model produced tool_use blocks', () => {
    const out = translateResponse(
      fakeResp({
        content: [
          { type: 'text', text: 'calling tool' },
          { type: 'tool_use', id: 'tu_1', name: 'lookup', input: { id: 42 } },
        ],
        stop_reason: 'tool_use',
      }),
      { requestedModel: 'gpt-4o' },
    );
    const choice = out.choices[0]!;
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.tool_calls).toEqual([
      {
        id: 'tu_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"id":42}' },
      },
    ]);
  });

  it('maps usage tokens correctly', () => {
    const out = translateResponse(
      fakeResp({ usage: { input_tokens: 100, output_tokens: 50 } }),
      { requestedModel: 'gpt-4o' },
    );
    expect(out.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
  });

  it('maps stop reasons', () => {
    expect(mapFinishReason('end_turn')).toBe('stop');
    expect(mapFinishReason('stop_sequence')).toBe('stop');
    expect(mapFinishReason('max_tokens')).toBe('length');
    expect(mapFinishReason('tool_use')).toBe('tool_calls');
    expect(mapFinishReason(null)).toBe(null);
  });

  it('returns null content when only tool_use blocks were emitted', () => {
    const out = translateResponse(
      fakeResp({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'x', input: {} }],
        stop_reason: 'tool_use',
      }),
      { requestedModel: 'gpt-4o' },
    );
    expect(out.choices[0]?.message.content).toBeNull();
    expect(out.choices[0]?.message.tool_calls).toHaveLength(1);
  });
});
