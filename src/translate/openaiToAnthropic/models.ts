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

export function resolveUpstreamModel(requested: string): string {
  return ALIAS_MAP[requested] ?? requested;
}

export function listKnownModels(): string[] {
  return Object.keys(ALIAS_MAP);
}
