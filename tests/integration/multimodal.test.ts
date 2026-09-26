import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { startMockAnthropic, type MockAnthropicHandle } from './mockAnthropic.js';
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-it-'));
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
  const created = await apiKeys.create({ name: 'mm-test' });
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

  mock.setMessagesResponder((body) => ({
    id: 'msg_vision',
    type: 'message',
    role: 'assistant',
    model: (body as { model: string }).model,
    content: [{ type: 'text', text: 'I see a cat.' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 250, output_tokens: 5 },
  }));
});

afterEach(async () => {
  await ctx.close();
  await mock.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

describe('multimodal — image_url translation in /v1/chat/completions', () => {
  it('round-trips a vision request with a data URL', async () => {
    const res = await app.fetch(
      new Request('http://test.local/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'What is this?' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
              ],
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe('I see a cat.');

    const upstream = mock.lastMessagesRequest as {
      messages: Array<{ content: Array<{ type: string; source?: { type: string; media_type?: string; data?: string } }> }>;
    };
    const blocks = upstream.messages[0]?.content ?? [];
    expect(blocks.find((b) => b.type === 'text')).toEqual({
      type: 'text',
      text: 'What is this?',
    });
    const imageBlock = blocks.find((b) => b.type === 'image');
    expect(imageBlock?.source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: PNG_BASE64,
    });
  });

  it('passes through http image URLs as url source', async () => {
    await app.fetch(
      new Request('http://test.local/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: 'https://cdn.example.com/x.jpg' } }],
            },
          ],
        }),
      }),
    );
    const upstream = mock.lastMessagesRequest as {
      messages: Array<{ content: Array<{ type: string; source?: { type: string; url?: string } }> }>;
    };
    const imageBlock = upstream.messages[0]?.content.find((b) => b.type === 'image');
    expect(imageBlock?.source).toEqual({ type: 'url', url: 'https://cdn.example.com/x.jpg' });
  });

  it('returns 400 with clear message on malformed data URL', async () => {
    const res = await app.fetch(
      new Request('http://test.local/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: 'data:image/pdf;base64,abc' } }],
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/unsupported image/i);
  });

  it('returns 400 on unsupported scheme (file://)', async () => {
    const res = await app.fetch(
      new Request('http://test.local/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: 'file:///etc/passwd' } }],
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 413 when Content-Length exceeds the 25MB body cap', async () => {
    const res = await app.fetch(
      new Request('http://test.local/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'content-length': String(30 * 1024 * 1024),
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
    );
    expect(res.status).toBe(413);
  });
});
