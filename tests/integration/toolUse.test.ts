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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-it-'));
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
  const created = await apiKeys.create({ name: 'tools-test' });
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

const weatherTool = {
  type: 'function' as const,
  function: {
    name: 'get_weather',
    description: 'Get the weather for a location',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string' },
        unit: { type: 'string', enum: ['c', 'f'] },
      },
      required: ['location'],
    },
  },
};

describe('tool use — non-streaming', () => {
  it('forwards OpenAI tools schema as Anthropic tools with input_schema', async () => {
    mock.setMessagesResponder((body) => {
      // Mock just echoes a simple text response; we want to inspect the request shape.
      return {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: (body as { model: string }).model,
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      };
    });
    await app.fetch(
      new Request('http://test.local/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [weatherTool],
          tool_choice: 'auto',
        }),
      }),
    );
    const upstream = mock.lastMessagesRequest as {
      tools?: Array<{ name: string; description?: string; input_schema: unknown }>;
      tool_choice?: { type: string };
    };
    expect(upstream.tools).toHaveLength(1);
    expect(upstream.tools?.[0]).toMatchObject({
      name: 'get_weather',
      description: 'Get the weather for a location',
      input_schema: {
        type: 'object',
        properties: {
          location: { type: 'string' },
          unit: { type: 'string', enum: ['c', 'f'] },
        },
        required: ['location'],
      },
    });
    expect(upstream.tool_choice).toEqual({ type: 'auto' });
  });

  it('translates Anthropic tool_use response into OpenAI tool_calls', async () => {
    mock.setMessagesResponder((body) => ({
      id: 'msg_call',
      type: 'message',
      role: 'assistant',
      model: (body as { model: string }).model,
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { location: 'Paris', unit: 'c' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 15 },
    }));
    const res = await app.fetch(
      new Request('http://test.local/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'weather in Paris?' }],
          tools: [weatherTool],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
        finish_reason: string;
      }>;
    };
    const choice = body.choices[0]!;
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.content).toBe('Let me check.');
    expect(choice.message.tool_calls).toHaveLength(1);
    const call = choice.message.tool_calls![0]!;
    expect(call.id).toBe('toolu_1');
    expect(call.function.name).toBe('get_weather');
    expect(JSON.parse(call.function.arguments)).toEqual({ location: 'Paris', unit: 'c' });
  });

  it('completes the round-trip: tool_result from client becomes a user turn with tool_result block', async () => {
    mock.setMessagesResponder((body) => ({
      id: 'msg_final',
      type: 'message',
      role: 'assistant',
      model: (body as { model: string }).model,
      content: [{ type: 'text', text: "It's 18°C and sunny in Paris." }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 40, output_tokens: 12 },
    }));
    const res = await app.fetch(
      new Request('http://test.local/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            { role: 'user', content: 'weather in Paris?' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'toolu_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"location":"Paris","unit":"c"}' },
                },
              ],
            },
            {
              role: 'tool',
              tool_call_id: 'toolu_1',
              content: JSON.stringify({ tempC: 18, sky: 'sunny' }),
            },
          ],
          tools: [weatherTool],
        }),
      }),
    );
    expect(res.status).toBe(200);

    const upstream = mock.lastMessagesRequest as {
      messages: Array<{ role: string; content: Array<{ type: string; tool_use_id?: string; id?: string; input?: unknown }> }>;
    };

    // Round-trip in upstream:
    //   user(text) → assistant(tool_use) → user(tool_result)
    expect(upstream.messages).toHaveLength(3);
    expect(upstream.messages[0]?.role).toBe('user');
    expect(upstream.messages[1]?.role).toBe('assistant');
    expect(upstream.messages[1]?.content.find((b) => b.type === 'tool_use')).toMatchObject({
      type: 'tool_use',
      id: 'toolu_1',
      input: { location: 'Paris', unit: 'c' },
    });
    expect(upstream.messages[2]?.role).toBe('user');
    expect(upstream.messages[2]?.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
    });

    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("It's 18°C and sunny in Paris.");
  });

  it('maps tool_choice variants (function-name → tool, none, required)', async () => {
    mock.setMessagesResponder((body) => ({
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: (body as { model: string }).model,
      content: [{ type: 'text', text: 'x' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));

    const call = async (tool_choice: unknown) => {
      await app.fetch(
        new Request('http://test.local/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'x' }],
            tools: [weatherTool],
            tool_choice,
          }),
        }),
      );
      return (mock.lastMessagesRequest as { tool_choice?: unknown }).tool_choice;
    };

    expect(await call({ type: 'function', function: { name: 'get_weather' } })).toEqual({
      type: 'tool',
      name: 'get_weather',
    });
    expect(await call('none')).toEqual({ type: 'none' });
    expect(await call('required')).toEqual({ type: 'any' });
  });
});

describe('tool use — streaming', () => {
  it('emits tool_calls progressively and yields valid JSON when concatenated', async () => {
    mock.setStreamingScript([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { id: 'msg_stream', model: 'claude-opus-4-7', usage: { input_tokens: 20, output_tokens: 0 } } },
      },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check.' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_42', name: 'get_weather', input: {} },
        },
      },
      // Tool arguments arrive split across multiple deltas
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"loc' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ation":"Paris"' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ',"unit":"c"}' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 25 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);

    const res = await app.fetch(
      new Request('http://test.local/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'weather?' }],
          tools: [weatherTool],
          stream: true,
        }),
      }),
    );
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
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

    const payloads = records
      .map((r) => {
        const m = /^data: (.+)$/m.exec(r);
        return m ? m[1] : null;
      })
      .filter((s): s is string => s !== null);

    // Locate the initial tool_call open chunk (carries id + name).
    const toolOpen = payloads
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .find((d): d is { choices: Array<{ delta: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }> } => {
        if (!d || typeof d !== 'object' || !('choices' in d)) return false;
        const dd = d as { choices: Array<{ delta: { tool_calls?: Array<{ id?: string }> } }> };
        return Boolean(dd.choices[0]?.delta.tool_calls?.[0]?.id);
      });
    expect(toolOpen?.choices[0]?.delta.tool_calls?.[0]?.id).toBe('toolu_42');
    expect(toolOpen?.choices[0]?.delta.tool_calls?.[0]?.function?.name).toBe('get_weather');

    const argParts: string[] = [];
    for (const s of payloads) {
      try {
        const d = JSON.parse(s) as {
          choices?: Array<{ delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
        };
        const a = d.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments;
        if (typeof a === 'string') argParts.push(a);
      } catch {
        // skip [DONE] and non-json lines
      }
    }
    const concatenated = argParts.join('');
    // First "open" chunk has arguments: "" — that's fine, the rest concatenate.
    expect(JSON.parse(concatenated)).toEqual({ location: 'Paris', unit: 'c' });

    const finalChunk = payloads
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .find((d): d is { choices: Array<{ finish_reason: string | null }> } => {
        if (!d || typeof d !== 'object' || !('choices' in d)) return false;
        return Boolean((d as { choices: Array<{ finish_reason: string | null }> }).choices[0]?.finish_reason);
      });
    expect(finalChunk?.choices[0]?.finish_reason).toBe('tool_calls');

    expect(payloads[payloads.length - 1]).toBe('[DONE]');
  });
});
