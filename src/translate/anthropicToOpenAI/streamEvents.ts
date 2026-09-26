/**
 * Anthropic streaming event shapes. Only the fields we actually consume are
 * typed — everything else is allowed via the `unknown` index.
 */

import type { AnthropicContentBlock } from '../schemas.js';

export interface AnthMessageStart {
  type: 'message_start';
  message: {
    id: string;
    model: string;
    usage: { input_tokens: number; output_tokens: number };
  };
}

export interface AnthContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block: AnthropicContentBlock;
}

export interface AnthTextDelta {
  type: 'content_block_delta';
  index: number;
  delta: { type: 'text_delta'; text: string };
}

export interface AnthInputJsonDelta {
  type: 'content_block_delta';
  index: number;
  delta: { type: 'input_json_delta'; partial_json: string };
}

export type AnthContentBlockDelta = AnthTextDelta | AnthInputJsonDelta;

export interface AnthContentBlockStop {
  type: 'content_block_stop';
  index: number;
}

export interface AnthMessageDelta {
  type: 'message_delta';
  delta: {
    stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
    stop_sequence: string | null;
  };
  usage: { output_tokens: number };
}

export interface AnthMessageStop {
  type: 'message_stop';
}

export interface AnthPing {
  type: 'ping';
}

export interface AnthError {
  type: 'error';
  error: { type: string; message: string };
}

export type AnthropicStreamEvent =
  | AnthMessageStart
  | AnthContentBlockStart
  | AnthContentBlockDelta
  | AnthContentBlockStop
  | AnthMessageDelta
  | AnthMessageStop
  | AnthPing
  | AnthError;
