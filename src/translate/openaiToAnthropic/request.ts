import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicToolResultBlock,
  OpenAIChatCompletionRequest,
  OpenAIMessage,
  OpenAITool,
} from '../schemas.js';
import { resolveUpstreamModel } from './models.js';
import { parseImageUrl } from './multimodal.js';

export interface TranslateOptions {
  /** Default `max_tokens` if the client did not specify one. */
  defaultMaxTokens: number;
}

/**
 * Translate an OpenAI chat-completions request body into the upstream
 * messages-API request body.
 */
export function translateRequest(
  req: OpenAIChatCompletionRequest,
  opts: TranslateOptions,
): AnthropicMessagesRequest {
  const { system, messages } = splitSystem(req.messages);
  const anthropicMessages = toAnthropicMessages(messages);

  const maxTokens = req.max_completion_tokens ?? req.max_tokens ?? opts.defaultMaxTokens;

  const upstreamModel = resolveUpstreamModel(req.model);
  const out: AnthropicMessagesRequest = {
    model: upstreamModel,
    max_tokens: maxTokens,
    messages: anthropicMessages,
  };

  if (system) out.system = system;

  // Opus 4.7 (and newer reasoning-style models) reject `temperature` and `top_p`.
  // Drop them silently: OpenAI clients send `temperature` by default.
  if (!modelRejectsSamplingParams(upstreamModel)) {
    if (typeof req.temperature === 'number') out.temperature = req.temperature;
    if (typeof req.top_p === 'number') out.top_p = req.top_p;
  }
  if (req.stop) {
    out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  }
  if (typeof req.stream === 'boolean') out.stream = req.stream;
  if (req.user) out.metadata = { user_id: req.user };
  if (req.tools && req.tools.length > 0) out.tools = req.tools.map(toAnthropicTool);
  if (req.tool_choice) {
    const tc = toAnthropicToolChoice(req.tool_choice);
    if (tc) out.tool_choice = tc;
  }

  return out;
}

/**
 * Pulls system messages out of the message array and concatenates them into
 * the Anthropic `system` top-level field (Anthropic doesn't allow `system`
 * inside `messages[]`).
 */
function splitSystem(messages: OpenAIMessage[]): {
  system: string | undefined;
  messages: OpenAIMessage[];
} {
  const systemParts: string[] = [];
  const rest: OpenAIMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(stringifyContent(m.content));
    } else {
      rest.push(m);
    }
  }
  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: rest,
  };
}

function stringifyContent(content: OpenAIMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

function toAnthropicMessages(messages: OpenAIMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  for (const m of messages) {
    if (m.role === 'tool') {
      // OpenAI `tool` role → wrap as tool_result block inside a user turn.
      const block: AnthropicToolResultBlock = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content: stringifyContent(m.content),
      };
      out.push({ role: 'user', content: [block] });
      continue;
    }

    if (m.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      const text = stringifyContent(m.content);
      if (text) blocks.push({ type: 'text', text });
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            // If the model emitted invalid JSON, forward raw under a "_raw" key.
            parsedArgs = { _raw: tc.function.arguments };
          }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parsedArgs });
        }
      }
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] });
      continue;
    }

    if (typeof m.content === 'string' || m.content == null) {
      out.push({
        role: 'user',
        content: [{ type: 'text', text: typeof m.content === 'string' ? m.content : '' }],
      });
    } else {
      // Array content (multimodal): text parts and image_url parts.
      const blocks: AnthropicContentBlock[] = [];
      for (const part of m.content) {
        if (part.type === 'text') {
          blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          const url = typeof part.image_url === 'string' ? part.image_url : part.image_url.url;
          blocks.push(parseImageUrl(url));
        }
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
      out.push({ role: 'user', content: blocks });
    }
  }

  return out;
}

function toAnthropicTool(t: OpenAITool): AnthropicTool {
  const out: AnthropicTool = {
    name: t.function.name,
    input_schema: t.function.parameters ?? { type: 'object', properties: {} },
  };
  if (t.function.description) out.description = t.function.description;
  return out;
}

function toAnthropicToolChoice(
  tc: NonNullable<OpenAIChatCompletionRequest['tool_choice']>,
): AnthropicToolChoice | null {
  if (tc === 'none') return { type: 'none' };
  if (tc === 'auto') return { type: 'auto' };
  if (tc === 'required') return { type: 'any' };
  if (typeof tc === 'object') return { type: 'tool', name: tc.function.name };
  return null;
}

/**
 * Models that reject `temperature` / `top_p` upstream (reasoning-style
 * models, e.g. Opus 4.7). Anthropic returns 400
 * "`temperature` is deprecated for this model." otherwise.
 */
function modelRejectsSamplingParams(upstreamModel: string): boolean {
  return /^claude-opus-4/i.test(upstreamModel);
}
