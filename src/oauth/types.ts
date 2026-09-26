/**
 * Token stored in `.credentials.json` (camelCase, Claude Code convention).
 */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch millis when accessToken expires. */
  expiresAt: number;
  /** Optional metadata preserved when reading/writing. */
  scopes?: string[];
  subscriptionType?: string;
}

/**
 * Shape on disk: `~/.claude/.credentials.json`.
 */
export interface CredentialsFile {
  claudeAiOauth: TokenSet;
}

/**
 * Raw response from `POST https://console.anthropic.com/v1/oauth/token`.
 * OAuth standard snake_case.
 */
export interface OAuthRefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

export class OAuthRefreshError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null,
    public readonly responseBody: string | null,
  ) {
    super(message);
    this.name = 'OAuthRefreshError';
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`circuit_breaker_open (retry after ${retryAfterMs}ms)`);
    this.name = 'CircuitBreakerOpenError';
  }
}
