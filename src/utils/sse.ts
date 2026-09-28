export interface ParsedSSEEvent {
  event?: string;
  data: unknown;
}

export async function* parseSSEStream(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<ParsedSSEEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });

    let idx: number;
    while ((idx = findRecordBoundary(buffer)) !== -1) {
      const record = buffer.slice(0, idx);
      buffer = buffer.slice(idx).replace(/^(\r?\n){1,2}/, '');
      const parsed = parseRecord(record);
      if (parsed) yield parsed;
    }
  }

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

export function encodeOpenAIChunk(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export const SSE_DONE = 'data: [DONE]\n\n';

export const SSE_KEEPALIVE = ': keepalive\n\n';
