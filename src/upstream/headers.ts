export interface HeaderOptions {
  version: string;
  anthropicVersion?: string;
  beta?: string[];
}

const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

export function buildHeaders(
  credential: string,
  opts: HeaderOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'anthropic-version': opts.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
    'user-agent': `ai-api-bridge/${opts.version}`,
  };

  if (credential.startsWith('sk-ant-')) {
    headers['x-api-key'] = credential;
  } else {
    headers.authorization = `Bearer ${credential}`;
  }

  if (opts.beta?.length) {
    headers['anthropic-beta'] = opts.beta.join(',');
  }

  return headers;
}
