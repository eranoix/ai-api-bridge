import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { startMockAnthropic, type MockAnthropicHandle, defaultStreamingScript } from './mockAnthropic.js';
import { openDb, type Db } from '../../src/storage/db.js';
import { ApiKeyStore } from '../../src/auth/apiKeyStore.js';
import { CredentialsStore } from '../../src/oauth/credentialsStore.js';
import { HttpRefreshClient } from '../../src/oauth/refreshClient.js';
import { TokenManager } from '../../src/oauth/TokenManager.js';
import { AnthropicClient } from '../../src/upstream/anthropicClient.js';
import { UsageLogger } from '../../src/storage/usageLogger.js';
import { SlidingWindowLimiter } from '../../src/ratelimit/slidingWindow.js';
import { chatCompletionsRoutes } from '../../src/routes/chatCompletions.js';
import type { AppContext } from '../../src/appContext.js';

let tmpDir: string;
let mock: MockAnthropicHandle;
let db: Db;
let ctx: AppContext;
let app: Hono;
let apiKey: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-it-'));
  mock = await startMockAnthropic();
  const credPath = path.join(tmpDir, 'creds.json');
  await fs.writeFile(
    credPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'mock-access-initial',
        refreshToken: 'mock-refresh-initial',
        expiresAt: Date.now() + 3_600_000,
      },
    }),
  );
  db = await openDb({ dbPath: path.join(tmpDir, 'test.db') });
  const apiKeys = new ApiKeyStore(db);
  const created = await apiKeys.create({ name: 'stream-test' });
  apiKey = created.plaintext;

  const credentialsStore = new CredentialsStore(credPath);
  const refreshClient = new HttpRefreshClient({
    tokenUrl: `${mock.url}/v1/oauth/token`,
    clientId: 'test-client',
  });
  const tokenManager = new TokenManager({ credentialsStore, refreshClient });
  const anthropic = new AnthropicClient({
    baseUrl: mock.url,
    tokenManager,
    version: '0.1.0',
  });
  ctx = {
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: 0,
      LOG_LEVEL: 'fatal',
      CREDENTIALS_PATH: credPath,
      ANTHROPIC_BASE_URL: mock.url,
      ANTHROPIC_OAUTH_TOKEN_URL: `${mock.url}/v1/oauth/token`,
      CLAUDE_CLIENT_ID: 'test-client',
      GATEWAY_VERSION: '0.1.0',
      DATABASE_PATH: path.join(tmpDir, 'test.db'),
      DEFAULT_MAX_TOKENS: 4096,
      ALLOWED_ORIGINS: '',
      ADMIN_TOKEN: '',
    },
    db,
    apiKeys,
    tokenManager,
    anthropic,
    usage: new UsageLogger(db),
    rateLimiter: new SlidingWindowLimiter(db),
    async close() {
      await anthropic.close();
      db.close();
    },
  };
  app = new Hono();
  app.route('/', chatCompletionsRoutes(ctx));
});

afterEach(async () => {
  await ctx.close();
  await mock.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function readSSE(res: Response): Promise<string[]> {
  if (!res.body) throw new Error('no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const records: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      records.push(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (buf.trim()) records.push(buf);
  return records;
}

function parseData(record: string): unknown {
  const m = /^data: (.+)$/m.exec(record);
  if (!m) return null;
  if (m[1] === '[DONE]') return '[DONE]';
  try {
    return JSON.parse(m[1] as string);
  } catch {
    return m[1];
  }
}

describe('POST /v1/chat/completions — streaming', () => {
  it('returns SSE chunks ending with [DONE] for a text response', async () => {
    const res = await app.fetch(
      new Request('http://test.local/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/event-stream/);

    const records = await readSSE(res);
    const payloads = records.map(parseData).filter((d) => d !== null);

    // First data chunk: role assistant (initial chunk we synthesize)
    const first = payloads[0] as { choices: Array<{ delta: { role: string } }> };
    expect(first.choices[0]?.delta.role).toBe('assistant');

    const text = payloads
      .filter((d): d is { choices: Array<{ delta: { content?: string } }> } =>
        typeof d === 'object' && d !== null && 'choices' in d,
      )
      .map((d) => d.choices[0]?.delta.content ?? '')
      .join('');
    expect(text).toBe('Hello world');

    const beforeDone = payloads[payloads.length - 2] as
      | { choices: Array<{ finish_reason: string }> }
      | undefined;
    expect(beforeDone?.choices[0]?.finish_reason).toBe('stop');

    expect(payloads[payloads.length - 1]).toBe('[DONE]');
  });

  it('forwards ping events as keepalive SSE comments', async () => {
    const res = await app.fetch(
      new Request('http://test.local/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      }),
    );
    const records = await readSSE(res);
    const keepalive = records.find((r) => r.startsWith(': keepalive'));
    expect(keepalive).toBeDefined();
  });

  it('sends stream:true to upstream and uses real SSE there', async () => {
    const res = await app.fetch(
      new Request('http://test.local/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      }),
    );
    // Drain so the route fully initiates and reaches the mock.
    await readSSE(res);
    expect((mock.lastMessagesRequest as { stream?: boolean }).stream).toBe(true);
  });

  it('writes a usage_logs row after the stream completes with the observed token counts', async () => {
    const res = await app.fetch(
      new Request('http://test.local/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      }),
    );
    await readSSE(res);
    const row = db
      .prepare('SELECT * FROM usage_logs ORDER BY id DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    expect(row?.endpoint).toBe('chat.completions');
    expect(row?.status_code).toBe(200);
    expect(row?.input_tokens).toBe(10);
    expect(row?.output_tokens).toBe(8);
  });

  it('chunks arrive progressively (not buffered to the end)', async () => {
    // Crank up delay between events to verify chunks come out as they arrive,
    // not all at once after the upstream finishes.
    mock.setStreamingScript(defaultStreamingScript(), { delayMs: 40 });
    const start = Date.now();
    const res = await app.fetch(
      new Request('http://test.local/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      }),
    );
    if (!res.body) throw new Error('no body');
    const reader = res.body.getReader();
    const firstByteAt = await reader.read().then(() => Date.now());
    const totalTime = await (async () => {
      let last = firstByteAt;
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
        last = Date.now();
      }
      return last - start;
    })();

    // First byte should arrive well before the script finishes (8 events × 40ms = 320ms).
    expect(firstByteAt - start).toBeLessThan(150);
    // Total time should be in the same order of magnitude as the script length.
    expect(totalTime).toBeGreaterThan(100);
  });
});
