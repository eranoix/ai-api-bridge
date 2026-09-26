import { request } from 'undici';
import { OAuthRefreshError, type OAuthRefreshResponse, type TokenSet } from './types.js';

export interface RefreshClientOptions {
  tokenUrl: string;
  clientId: string;
}

export interface RefreshClient {
  refresh(refreshToken: string): Promise<TokenSet>;
}

/**
 * POSTs to `https://console.anthropic.com/v1/oauth/token` with
 * `grant_type=refresh_token`. The Anthropic OAuth server **rotates** the
 * refresh_token on every call — the response always contains a NEW
 * refresh_token that callers must persist (otherwise the next refresh fails).
 */
export class HttpRefreshClient implements RefreshClient {
  constructor(private readonly opts: RefreshClientOptions) {}

  async refresh(refreshToken: string): Promise<TokenSet> {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.opts.clientId,
    });

    let res;
    try {
      res = await request(this.opts.tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
      });
    } catch (err) {
      throw new OAuthRefreshError(
        `network error contacting OAuth endpoint: ${(err as Error).message}`,
        null,
        null,
      );
    }

    const responseText = await res.body.text();

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new OAuthRefreshError(
        `refresh failed with status ${res.statusCode}`,
        res.statusCode,
        responseText,
      );
    }

    let payload: OAuthRefreshResponse;
    try {
      payload = JSON.parse(responseText) as OAuthRefreshResponse;
    } catch {
      throw new OAuthRefreshError('refresh response was not valid JSON', res.statusCode, responseText);
    }

    if (
      typeof payload.access_token !== 'string' ||
      typeof payload.refresh_token !== 'string' ||
      typeof payload.expires_in !== 'number'
    ) {
      throw new OAuthRefreshError(
        'refresh response missing required fields',
        res.statusCode,
        responseText,
      );
    }

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: Date.now() + payload.expires_in * 1000,
    };
  }
}
