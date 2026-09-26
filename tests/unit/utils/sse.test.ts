import { describe, it, expect } from 'vitest';
import { parseSSEStream, encodeOpenAIChunk, SSE_DONE, SSE_KEEPALIVE } from '../../../src/utils/sse.js';

async function* fromChunks(chunks: string[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  for (const c of chunks) yield enc.encode(c);
}

describe('parseSSEStream', () => {
  it('parses event + data fields from a single record', async () => {
    const stream = fromChunks(['event: hello\ndata: {"a":1}\n\n']);
    const out = [];
    for await (const e of parseSSEStream(stream)) out.push(e);
    expect(out).toEqual([{ event: 'hello', data: { a: 1 } }]);
  });

  it('parses multiple records separated by blank lines', async () => {
    const stream = fromChunks([
      'event: one\ndata: {"x":1}\n\nevent: two\ndata: {"x":2}\n\n',
    ]);
    const out = [];
    for await (const e of parseSSEStream(stream)) out.push(e);
    expect(out).toEqual([
      { event: 'one', data: { x: 1 } },
      { event: 'two', data: { x: 2 } },
    ]);
  });

  it('handles records split across input chunks', async () => {
    const stream = fromChunks(['event: hel', 'lo\ndata: {"a":', '1}\n\n']);
    const out = [];
    for await (const e of parseSSEStream(stream)) out.push(e);
    expect(out).toEqual([{ event: 'hello', data: { a: 1 } }]);
  });

  it('handles CRLF line endings', async () => {
    const stream = fromChunks(['event: x\r\ndata: {"y":2}\r\n\r\n']);
    const out = [];
    for await (const e of parseSSEStream(stream)) out.push(e);
    expect(out).toEqual([{ event: 'x', data: { y: 2 } }]);
  });

  it('ignores comment lines (those starting with :)', async () => {
    const stream = fromChunks([': comment\ndata: 1\n\n']);
    const out = [];
    for await (const e of parseSSEStream(stream)) out.push(e);
    expect(out).toEqual([{ data: 1 }]);
  });

  it('keeps non-JSON data as string', async () => {
    const stream = fromChunks(['data: [DONE]\n\n']);
    const out = [];
    for await (const e of parseSSEStream(stream)) out.push(e);
    expect(out).toEqual([{ data: '[DONE]' }]);
  });

  it('flushes trailing record without final blank line', async () => {
    const stream = fromChunks(['data: {"a":1}']);
    const out = [];
    for await (const e of parseSSEStream(stream)) out.push(e);
    expect(out).toEqual([{ data: { a: 1 } }]);
  });
});

describe('encoders', () => {
  it('encodes an OpenAI chunk as `data: {...}\\n\\n`', () => {
    expect(encodeOpenAIChunk({ hello: 'world' })).toBe('data: {"hello":"world"}\n\n');
  });

  it('SSE_DONE and SSE_KEEPALIVE constants are exact wire bytes', () => {
    expect(SSE_DONE).toBe('data: [DONE]\n\n');
    expect(SSE_KEEPALIVE).toBe(': keepalive\n\n');
  });
});
