/**
 * Minimal SSE parser for upstream Anthropic streaming responses.
 *
 * Anthropic's wire format is:
 *
 *   event: message_start
 *   data: {"type":"message_start",...}
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta",...}
 *
 *   event: ping
 *   data: {"type":"ping"}
 *
 * We don't use the `event:` field — the `type` inside the JSON payload is the
 * authoritative tag (and matches Anthropic SDK conventions). We yield each
 * parsed `data:` payload's object.
 */

export interface ParsedSSEEvent {
  /** The `event:` field, if present. May be absent. */
  event?: string;
  /** The parsed JSON object from `data:`, or the raw string if not JSON. */
  data: unknown;
}

/**
 * Parse an upstream SSE byte stream into discrete events.
 *
 * `source` is an async iterable of Uint8Array (e.g. undici response body).
 * Yields one event per blank-line-separated record.
 */
export async function* parseSSEStream(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<ParsedSSEEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });

    let idx: number;
    // Records are separated by a blank line: \n\n or \r\n\r\n.
    // Accept either by normalizing CRLF first.
    while ((idx = findRecordBoundary(buffer)) !== -1) {
      const record = buffer.slice(0, idx);
      buffer = buffer.slice(idx).replace(/^(\r?\n){1,2}/, '');
      const parsed = parseRecord(record);
      if (parsed) yield parsed;
    }
  }

  // Flush any trailing record (no terminating blank line).
  if (buffer.trim().length > 0) {
    const parsed = parseRecord(buffer);
    if (parsed) yield parsed;
  }
}

function findRecordBoundary(buf: string): number {
  const lf = buf.indexOf('\n\n');
  const crlf = buf.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function parseRecord(record: string): ParsedSSEEvent | null {
  let eventName: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of record.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0 || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;

  const dataStr = dataLines.join('\n');
  let data: unknown = dataStr;
  try {
    data = JSON.parse(dataStr);
  } catch {
    // keep as string
  }
  const out: ParsedSSEEvent = { data };
  if (eventName !== undefined) out.event = eventName;
  return out;
}

/**
 * Encode an OpenAI-style chunk as an SSE record (`data: {...}\n\n`).
 */
export function encodeOpenAIChunk(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** The terminal marker OpenAI clients expect. */
export const SSE_DONE = 'data: [DONE]\n\n';

/** SSE comment line: clients ignore it but proxies see traffic. */
export const SSE_KEEPALIVE = ': keepalive\n\n';
