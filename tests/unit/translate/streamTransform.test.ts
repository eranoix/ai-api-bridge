import { describe, it, expect } from 'vitest';
import { StreamTranslator } from '../../../src/translate/anthropicToOpenAI/streamTransform.js';
import type { AnthropicStreamEvent } from '../../../src/translate/anthropicToOpenAI/streamEvents.js';

function consume(t: StreamTranslator, events: AnthropicStreamEvent[]): string[] {
  const out: string[] = [t.emitInitialChunk()];
  for (const e of events) {
    for (const chunk of t.handleEvent(e)) out.push(chunk);
  }
  return out;
}

function parseChunk(line: string): Record<string, unknown> {
  const m = /^data: (.+)\n\n$/.exec(line);
  if (!m) throw new Error(`not a data chunk: ${JSON.stringify(line)}`);
  if (m[1] === '[DONE]') return { __done: true };
  return JSON.parse(m[1]) as Record<string, unknown>;
}

describe('StreamTranslator — text streaming', () => {
  it('emits a role:assistant chunk first, then content deltas, then [DONE]', () => {
    const t = new StreamTranslator({ requestedModel: 'gpt-4o', id: 'chatcmpl-test', now: () => 1700_000_000_000 });
    const out = consume(t, [
      {
        type: 'message_start',
        message: { id: 'msg_1', model: 'claude-opus-4-7', usage: { input_tokens: 7, output_tokens: 0 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 3 },
      },
      { type: 'message_stop' },
    ]);

    const parsed = out.map(parseChunk);
    expect((parsed[0] as { choices: Array<{ delta: { role: string } }> }).choices[0]?.delta.role).toBe('assistant');
    const contents = parsed
      .slice(1, -2)
      .map((p) => (p as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content)
      .filter(Boolean);
    expect(contents.join('')).toBe('Hi there');
    expect((parsed[parsed.length - 2] as { choices: Array<{ finish_reason: string }> }).choices[0]?.finish_reason).toBe(
      'stop',
    );
    expect(parsed[parsed.length - 1]).toEqual({ __done: true });
  });

  it('echoes requested model (not upstream)', () => {
    const t = new StreamTranslator({ requestedModel: 'gpt-4o' });
    const out = consume(t, [
      {
        type: 'message_start',
        message: { id: 'm', model: 'claude-opus-4-7', usage: { input_tokens: 1, output_tokens: 0 } },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'X' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]);
    const parsed = out.map(parseChunk);
    for (const p of parsed) {
      if ((p as { model?: string }).model) {
        expect((p as { model: string }).model).toBe('gpt-4o');
      }
    }
  });

  it('emits a keepalive SSE comment on ping (not a chunk)', () => {
    const t = new StreamTranslator({ requestedModel: 'gpt-4o' });
    const out: string[] = [];
    for (const c of t.handleEvent({ type: 'ping' })) out.push(c);
    expect(out).toEqual([': keepalive\n\n']);
  });

  it('tracks final usage (input + output tokens) for billing', () => {
    const t = new StreamTranslator({ requestedModel: 'gpt-4o' });
    consume(t, [
      { type: 'message_start', message: { id: 'm', model: 'x', usage: { input_tokens: 100, output_tokens: 0 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 42 } },
      { type: 'message_stop' },
    ]);
    expect(t.getFinalUsage()).toEqual({ input_tokens: 100, output_tokens: 42 });
  });

  it('translates tool_use blocks: id+name first chunk, then partial_json deltas', () => {
    const t = new StreamTranslator({ requestedModel: 'gpt-4o' });
    const out: string[] = [];
    for (const c of t.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'lookup', input: {} },
    }))
      out.push(c);
    for (const c of t.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"id":' },
    }))
      out.push(c);
    for (const c of t.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '42}' },
    }))
      out.push(c);

    const parsed = out.map(parseChunk);
    expect((parsed[0] as { choices: Array<{ delta: { tool_calls: Array<{ id: string; function: { name: string } }> } }> }).choices[0]?.delta.tool_calls?.[0]).toMatchObject({
      id: 'tu_1',
      function: { name: 'lookup', arguments: '' },
    });
    const args = parsed
      .slice(1)
      .map((p) => (p as { choices?: Array<{ delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }> }).choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments)
      .filter(Boolean)
      .join('');
    expect(args).toBe('{"id":42}');
    expect(JSON.parse(args)).toEqual({ id: 42 });
  });

  it('on error event, emits a finish chunk and [DONE]', () => {
    const t = new StreamTranslator({ requestedModel: 'gpt-4o' });
    const out: string[] = [];
    for (const c of t.handleEvent({ type: 'error', error: { type: 'overloaded', message: 'busy' } })) {
      out.push(c);
    }
    const parsed = out.map(parseChunk);
    expect((parsed[0] as { choices: Array<{ finish_reason: string }> }).choices[0]?.finish_reason).toBe('stop');
    expect(parsed[1]).toEqual({ __done: true });
  });
});
