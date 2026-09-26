/**
 * Model alias mapping. Clients call with OpenAI-style names; we route to
 * Claude models upstream. The response echoes the *requested* model back so
 * clients don't see the swap.
 *
 * Aliases are intentionally tied to "latest stable" SKUs so this file is the
 * single place to bump versions when Anthropic ships new models.
 */

const ALIAS_MAP: Record<string, string> = {
  'gpt-4o': 'claude-opus-4-7',
  'gpt-4': 'claude-opus-4-7',
  'gpt-4-turbo': 'claude-opus-4-7',
  'gpt-5': 'claude-opus-4-7',

  'gpt-4o-mini': 'claude-sonnet-4-6',
  'gpt-3.5-turbo': 'claude-sonnet-4-6',
  'gpt-5-mini': 'claude-sonnet-4-6',

  'gpt-4o-nano': 'claude-haiku-4-5-20251001',
  'gpt-5-nano': 'claude-haiku-4-5-20251001',

  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

/**
 * Returns the upstream model id to send to Anthropic. If the requested model
 * is unknown, pass it through verbatim — that way calls using fully-qualified
 * Claude model ids still work without the alias table needing every variant.
 */
export function resolveUpstreamModel(requested: string): string {
  return ALIAS_MAP[requested] ?? requested;
}

export function listKnownModels(): string[] {
  return Object.keys(ALIAS_MAP);
}
