import { describe, it, expect } from 'vitest';
import { translateRequest } from '../../../src/translate/openaiToAnthropic/request.js';
import { resolveUpstreamModel } from '../../../src/translate/openaiToAnthropic/models.js';
import { openaiChatCompletionRequestSchema } from '../../../src/translate/schemas.js';

const DEFAULTS = { defaultMaxTokens: 4096 };

describe('translateRequest', () => {
  it('lifts system messages into the system top-level field and concatenates multiples', () => {
    const req = openaiChatCompletionRequestSchema.parse({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are concise.' },
        { role: 'system', content: 'Answer in English.' },
        { role: 'user', content: 'Hello' },
      ],
    });
    const out = translateRequest(req, DEFAULTS);
    expect(out.system).toBe('You are concise.\n\nAnswer in English.');
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]?.role).toBe('user');
  });

  it('resolves gpt-4o → claude-opus-4-7 and echoes max_tokens default', () => {
    const req = openaiChatCompletionRequestSchema.parse({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const out = translateRequest(req, DEFAULTS);
    expect(out.model).toBe('claude-opus-4-7');
    expect(out.max_tokens).toBe(4096);
  });

  it('respects max_tokens and stop options', () => {
    // gpt-4o-mini maps to sonnet, which accepts temperature/top_p.
    // (gpt-4o maps to opus, which doesn't — see the dedicated test below.)
    const req = openaiChatCompletionRequestSchema.parse({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 250,
      stop: ['END', 'STOP'],
      temperature: 0.3,
      top_p: 0.95,
    });
    const out = translateRequest(req, DEFAULTS);
    expect(out.max_tokens).toBe(250);
    expect(out.stop_sequences).toEqual(['END', 'STOP']);
    expect(out.temperature).toBe(0.3);
    expect(out.top_p).toBe(0.95);
  });

  it('drops temperature/top_p for Opus 4.7 (model rejects sampling params)', () => {
    const req = openaiChatCompletionRequestSchema.parse({
      model: 'gpt-4o', // maps to claude-opus-4-7
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.5,
      top_p: 0.9,
    });
    const out = translateRequest(req, DEFAULTS);
    expect(out.model).toBe('claude-opus-4-7');
    expect(out.temperature).toBeUndefined();
    expect(out.top_p).toBeUndefined();
  });

  it('normalizes a single stop string into stop_sequences array', () => {
    const req = openaiChatCompletionRequestSchema.parse({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x' }],
      stop: 'END',
    });
    const out = translateRequest(req, DEFAULTS);
    expect(out.stop_sequences).toEqual(['END']);
  });

  it('passes through user → assistant turns', () => {
    const req = openaiChatCompletionRequestSchema.parse({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'three' },
      ],
    });
    const out = translateRequest(req, DEFAULTS);
    expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect((out.messages[0]?.content[0] as { text: string }).text).toBe('one');
  });

  it('translates OpenAI tools into Anthropic tools with input_schema', () => {
    const req = openaiChatCompletionRequestSchema.parse({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'What time?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_time',
            description: 'Returns the current time',
            parameters: {
              type: 'object',
              properties: { tz: { type: 'string' } },
              required: ['tz'],
            },
          },
        },
      ],
      tool_choice: 'auto',
    });
    const out = translateRequest(req, DEFAULTS);
    expect(out.tools).toHaveLength(1);
    expect(out.tools?.[0]).toEqual({
      name: 'get_time',
      description: 'Returns the current time',
      input_schema: {
        type: 'object',
        properties: { tz: { type: 'string' } },
        required: ['tz'],
      },
    });
    expect(out.tool_choice).toEqual({ type: 'auto' });
  });

  it('maps tool_choice "required" → Anthropic { type: any }', () => {
    const req = openaiChatCompletionRequestSchema.parse({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: 'required',
    });
    const out = translateRequest(req, DEFAULTS);
    expect(out.tool_choice).toEqual({ type: 'any' });
  });

  it('maps assistant tool_calls + tool role into Anthropic blocks', () => {
    const req = openaiChatCompletionRequestSchema.parse({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'use it' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_time', arguments: '{"tz":"UTC"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '12:00 UTC' },
      ],
    });
    const out = translateRequest(req, DEFAULTS);
    expect(out.messages).toHaveLength(3);

    const assistantTurn = out.messages[1];
    expect(assistantTurn?.role).toBe('assistant');
    const toolUseBlock = assistantTurn?.content.find((b) => b.type === 'tool_use');
    expect(toolUseBlock).toMatchObject({
      type: 'tool_use',
      id: 'call_1',
      name: 'get_time',
      input: { tz: 'UTC' },
    });

    const toolResultTurn = out.messages[2];
    expect(toolResultTurn?.role).toBe('user');
    expect(toolResultTurn?.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'call_1',
      content: '12:00 UTC',
    });
  });

  it('uses passthrough for unknown model names', () => {
    expect(resolveUpstreamModel('claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(resolveUpstreamModel('something-experimental')).toBe('something-experimental');
  });

  it('rejects streaming on the schema as a boolean (handled downstream)', () => {
    const req = openaiChatCompletionRequestSchema.parse({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
    });
    const out = translateRequest(req, DEFAULTS);
    expect(out.stream).toBe(true);
  });
});
