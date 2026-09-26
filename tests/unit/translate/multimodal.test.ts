import { describe, it, expect } from 'vitest';
import { parseImageUrl, MultimodalError } from '../../../src/translate/openaiToAnthropic/multimodal.js';
import { translateRequest } from '../../../src/translate/openaiToAnthropic/request.js';
import { openaiChatCompletionRequestSchema } from '../../../src/translate/schemas.js';

describe('parseImageUrl', () => {
  it('parses a data URL into a base64 image source', () => {
    const url = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==';
    const block = parseImageUrl(url);
    expect(block).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==',
      },
    });
  });

  it('handles PNG and WebP media types case-insensitively', () => {
    const png = parseImageUrl('data:IMAGE/PNG;base64,iVBORw0KGgo=');
    expect((png.source as { media_type: string }).media_type).toBe('image/png');
    const webp = parseImageUrl('data:image/webp;base64,UklGRiQAAABXRUJQ');
    expect((webp.source as { media_type: string }).media_type).toBe('image/webp');
  });

  it('passes http(s) URLs through as url source', () => {
    expect(parseImageUrl('https://example.com/cat.jpg')).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/cat.jpg' },
    });
    expect(parseImageUrl('http://example.com/cat.jpg')).toEqual({
      type: 'image',
      source: { type: 'url', url: 'http://example.com/cat.jpg' },
    });
  });

  it('trims whitespace before parsing', () => {
    const block = parseImageUrl('   https://example.com/x.png   ');
    expect((block.source as { url: string }).url).toBe('https://example.com/x.png');
  });

  it('rejects unsupported media types', () => {
    expect(() => parseImageUrl('data:application/pdf;base64,JVBERi0=')).toThrow(MultimodalError);
  });

  it('rejects malformed data URLs', () => {
    expect(() => parseImageUrl('data:image/jpeg,no-base64-tag')).toThrow(MultimodalError);
    expect(() => parseImageUrl('data:image/jpeg;base64,')).toThrow(MultimodalError);
  });

  it('rejects non-base64 payloads', () => {
    expect(() => parseImageUrl('data:image/jpeg;base64,~~~not-base64~~~')).toThrow(MultimodalError);
  });

  it('rejects unsupported schemes (file://, ftp, etc.)', () => {
    expect(() => parseImageUrl('file:///etc/passwd')).toThrow(MultimodalError);
    expect(() => parseImageUrl('ftp://example.com/x.jpg')).toThrow(MultimodalError);
    expect(() => parseImageUrl('about:blank')).toThrow(MultimodalError);
  });
});

describe('translateRequest — multimodal content', () => {
  it('converts a user message with text + image into Anthropic blocks', () => {
    const req = openaiChatCompletionRequestSchema.parse({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
          ],
        },
      ],
    });
    const out = translateRequest(req, { defaultMaxTokens: 4096 });
    expect(out.messages).toHaveLength(1);
    const blocks = out.messages[0]!.content;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: 'What is in this image?' });
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    });
  });

  it('passes through http image URLs as url source', () => {
    const req = openaiChatCompletionRequestSchema.parse({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } },
          ],
        },
      ],
    });
    const out = translateRequest(req, { defaultMaxTokens: 4096 });
    expect(out.messages[0]!.content[0]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/cat.jpg' },
    });
  });

  it('supports image_url as a bare string', () => {
    const req = openaiChatCompletionRequestSchema.parse({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: 'https://example.com/cat.jpg' }],
        },
      ],
    });
    const out = translateRequest(req, { defaultMaxTokens: 4096 });
    expect(out.messages[0]!.content[0]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/cat.jpg' },
    });
  });

  it('throws MultimodalError on bad data URLs (caught by route layer)', () => {
    const req = openaiChatCompletionRequestSchema.parse({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,~~~bad~~~' } }],
        },
      ],
    });
    expect(() => translateRequest(req, { defaultMaxTokens: 4096 })).toThrow(MultimodalError);
  });
});
