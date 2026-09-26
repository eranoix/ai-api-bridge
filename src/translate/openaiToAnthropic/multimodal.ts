import type { AnthropicImageBlock } from '../schemas.js';

/**
 * Convert an OpenAI `image_url.url` value into an Anthropic image block source.
 *
 * Accepted inputs:
 *   - `data:image/<type>;base64,<payload>` — decoded into a base64 source block
 *   - `http(s)://...` — passed through as a `{ type: "url", url }` source
 *
 * Other schemes (file://, ftp, etc.) are rejected — the proxy never reads
 * arbitrary local files on behalf of clients.
 */
export class MultimodalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultimodalError';
  }
}

export function parseImageUrl(url: string): AnthropicImageBlock {
  const trimmed = url.trim();

  if (trimmed.startsWith('data:')) {
    return parseDataUrl(trimmed);
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return { type: 'image', source: { type: 'url', url: trimmed } };
  }
  throw new MultimodalError(
    `unsupported image_url scheme — only data: and http(s): are accepted`,
  );
}

const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/i;

function parseDataUrl(dataUrl: string): AnthropicImageBlock {
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) {
    throw new MultimodalError('invalid data URL — must be `data:<media-type>;base64,<payload>`');
  }
  const mediaType = (match[1] as string).toLowerCase();
  const data = match[2] as string;

  if (!isSupportedImageType(mediaType)) {
    throw new MultimodalError(`unsupported image media type: ${mediaType}`);
  }
  if (!isValidBase64(data)) {
    throw new MultimodalError('image data is not valid base64');
  }
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data },
  };
}

const SUPPORTED_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

function isSupportedImageType(mediaType: string): boolean {
  return SUPPORTED_MEDIA_TYPES.has(mediaType);
}

function isValidBase64(s: string): boolean {
  // Permissive check; the upstream will perform the real validation.
  return /^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 0;
}
