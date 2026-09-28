export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
}

export interface CredentialsFile {
  claudeAiOauth: TokenSet;
}

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
