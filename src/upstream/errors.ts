/**
 * Errors emitted by the upstream layer.
 */

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody: string,
    public readonly errorType: string = 'upstream_error',
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export class UpstreamAuthError extends UpstreamError {
  constructor(responseBody: string) {
    super('upstream rejected OAuth token (401)', 401, responseBody, 'authentication_error');
    this.name = 'UpstreamAuthError';
  }
}

export class UpstreamRateLimitError extends UpstreamError {
  constructor(responseBody: string, public readonly retryAfterSec: number | null) {
    super('upstream rate limit (429)', 429, responseBody, 'rate_limit_error');
    this.name = 'UpstreamRateLimitError';
  }
}

export class UpstreamNetworkError extends Error {
  public readonly upstreamCause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'UpstreamNetworkError';
    this.upstreamCause = cause;
  }
}
