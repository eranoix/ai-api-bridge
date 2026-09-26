/**
 * Upstream request headers. The gateway identifies itself and never
 * impersonates another client: forging an official tool's identity breaks the
 * agreement the provider operates under and makes misbehaviour untraceable.
 */

export interface HeaderOptions {
  /** Version string reported in the user agent. */
  version: string;
  /** Anthropic API version pin. */
  anthropicVersion?: string;
  /** Beta feature flags, if the caller needs any. */
  beta?: string[];
}

const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/**
 * Builds the headers for an upstream call. `credential` is either an OAuth
 * access token (sent as a bearer) or a plain API key (sent as `x-api-key`).
 */
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

  // An OAuth access token and an API key go in different places. Guessing
  // wrong produces a 401 that reads like a credential problem rather than a
  // transport one, so the shape of the credential decides.
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
