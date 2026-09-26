/**
 * Rich metadata for the Claude models we route to.
 *
 * Pricing fields are Anthropic's public API rates (USD per million tokens) as
 * of the model launch. They're shown in the dashboard so the user can estimate
 * what the same volume would cost if they were paying API rates — relevant
 * because the whole point of this proxy is to NOT pay API rates while you have
 * a flat-rate Max subscription.
 */

export interface ModelCapabilities {
  streaming: boolean;
  vision: boolean;
  toolUse: boolean;
  computerUse: boolean;
  promptCaching: boolean;
  extendedThinking: boolean;
}

export interface ModelMetadata {
  /** Real Anthropic model id, what we send upstream. */
  id: string;
  /** Display name shown in the dashboard. */
  displayName: string;
  family: 'opus' | 'sonnet' | 'haiku';
  description: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  /** USD per 1M tokens. */
  pricing: {
    inputPerMTok: number;
    outputPerMTok: number;
    cacheWritePerMTok: number;
    cacheReadPerMTok: number;
  };
  capabilities: ModelCapabilities;
  /** OpenAI-style names users can request that map to this model. */
  aliases: string[];
}

const FULL: ModelCapabilities = {
  streaming: true,
  vision: true,
  toolUse: true,
  computerUse: true,
  promptCaching: true,
  extendedThinking: true,
};

const STANDARD: ModelCapabilities = {
  streaming: true,
  vision: true,
  toolUse: true,
  computerUse: false,
  promptCaching: true,
  extendedThinking: false,
};

export const MODELS: ModelMetadata[] = [
  {
    id: 'claude-opus-4-7',
    displayName: 'Claude Opus 4.7',
    family: 'opus',
    description:
      "Anthropic's most capable model. Best for complex reasoning, agentic workflows, hard code, and tasks demanding deep analysis.",
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_000,
    pricing: {
      inputPerMTok: 15,
      outputPerMTok: 75,
      cacheWritePerMTok: 18.75,
      cacheReadPerMTok: 1.5,
    },
    capabilities: FULL,
    aliases: ['gpt-4o', 'gpt-4', 'gpt-4-turbo', 'gpt-5', 'opus', 'claude-opus-4-7'],
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    family: 'sonnet',
    description:
      'Balanced speed, intelligence, and cost. The default for most production workloads — fast enough for chat, strong enough for non-trivial code.',
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_000,
    pricing: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheWritePerMTok: 3.75,
      cacheReadPerMTok: 0.3,
    },
    capabilities: FULL,
    aliases: ['gpt-4o-mini', 'gpt-3.5-turbo', 'gpt-5-mini', 'sonnet', 'claude-sonnet-4-6'],
  },
  {
    id: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5',
    family: 'haiku',
    description:
      'Fastest and cheapest. Use for high-volume simple tasks, classification, summarization, or as a router in front of bigger models.',
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_000,
    pricing: {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheWritePerMTok: 1.25,
      cacheReadPerMTok: 0.1,
    },
    capabilities: STANDARD,
    aliases: ['gpt-4o-nano', 'gpt-5-nano', 'haiku', 'claude-haiku-4-5-20251001'],
  },
];

export function getModelMetadata(id: string): ModelMetadata | undefined {
  return MODELS.find((m) => m.id === id || m.aliases.includes(id));
}
