import type { Logger } from 'pino';
import { LONG_LIVED_TOKEN_THRESHOLD_MS, TOKEN_EARLY_REFRESH_MS } from '../config/constants.js';
import { CircuitBreaker } from './circuitBreaker.js';
import type { CredentialsStore } from './credentialsStore.js';
import type { RefreshClient } from './refreshClient.js';
import { SingleFlight } from './singleFlight.js';
import { withLock } from '../utils/lockfile.js';
import type { TokenSet } from './types.js';

export interface TokenManagerOptions {
  credentialsStore: CredentialsStore;
  refreshClient: RefreshClient;
  logger?: Logger;
  /** Override clock for tests. */
  now?: () => number;
  /** Buffer before expiry to refresh. Default: 5 minutes. */
  earlyRefreshMs?: number;
  /** Tokens valid for longer than this are treated as long-lived (no refresh). */
  longLivedThresholdMs?: number;
  /** Circuit breaker: opens after N consecutive refresh failures. */
  circuitBreaker?: { threshold: number; resetMs: number };
}

export interface TokenStatus {
  accessTokenValid: boolean;
  expiresAt: number;
  expiresInSeconds: number;
  isLongLived: boolean;
  circuitBreakerState: 'closed' | 'open' | 'half-open';
  lastRefreshAt: number | null;
}

/**
 * Owns the OAuth token lifecycle; the ONLY component allowed to write
 * `.credentials.json`. Guards against refresh-token races with an in-memory
 * SingleFlight, a cross-process lockfile, and a re-read from disk inside the lock.
 */
export class TokenManager {
  private readonly credentialsStore: CredentialsStore;
  private readonly refreshClient: RefreshClient;
  private readonly logger?: Logger;
  private readonly clock: () => number;
  private readonly earlyRefreshMs: number;
  private readonly longLivedThresholdMs: number;

  private readonly singleFlight = new SingleFlight<TokenSet>();
  private readonly breaker: CircuitBreaker;

  private cached: TokenSet | null = null;
  private lastRefreshAt: number | null = null;

  constructor(opts: TokenManagerOptions) {
    this.credentialsStore = opts.credentialsStore;
    this.refreshClient = opts.refreshClient;
    this.logger = opts.logger;
    this.clock = opts.now ?? Date.now;
    this.earlyRefreshMs = opts.earlyRefreshMs ?? TOKEN_EARLY_REFRESH_MS;
    this.longLivedThresholdMs = opts.longLivedThresholdMs ?? LONG_LIVED_TOKEN_THRESHOLD_MS;
    this.breaker = new CircuitBreaker({
      threshold: opts.circuitBreaker?.threshold ?? 3,
      resetMs: opts.circuitBreaker?.resetMs ?? 60_000,
      now: this.clock,
    });
  }

  /**
   * Return a valid access token, refreshing transparently if needed.
   * Safe to call concurrently: concurrent callers share one refresh.
   */
  async getAccessToken(): Promise<string> {
    const cached = await this.getCached();
    if (this.isTokenFresh(cached)) {
      return cached.accessToken;
    }
    const refreshed = await this.refreshFlow();
    return refreshed.accessToken;
  }

  /** Force a refresh on the next call (e.g. after upstream 401). */
  async forceRefresh(): Promise<TokenSet> {
    return this.refreshFlow({ force: true });
  }

  async getStatus(): Promise<TokenStatus> {
    let creds: TokenSet | null = null;
    try {
      creds = await this.getCached();
    } catch {
      // missing or corrupt file
    }
    const now = this.clock();
    if (!creds) {
      return {
        accessTokenValid: false,
        expiresAt: 0,
        expiresInSeconds: 0,
        isLongLived: false,
        circuitBreakerState: this.breaker.state,
        lastRefreshAt: this.lastRefreshAt,
      };
    }
    return {
      accessTokenValid: creds.expiresAt > now,
      expiresAt: creds.expiresAt,
      expiresInSeconds: Math.max(0, Math.floor((creds.expiresAt - now) / 1000)),
      isLongLived: this.isLongLived(creds),
      circuitBreakerState: this.breaker.state,
      lastRefreshAt: this.lastRefreshAt,
    };
  }

  private async getCached(): Promise<TokenSet> {
    if (this.cached) return this.cached;
    this.cached = await this.credentialsStore.read();
    return this.cached;
  }

  private isLongLived(tokens: TokenSet): boolean {
    return tokens.expiresAt - this.clock() > this.longLivedThresholdMs;
  }

  private isTokenFresh(tokens: TokenSet): boolean {
    // Long-lived tokens (setup-token, 1 year) are always fresh; never refresh them.
    if (this.isLongLived(tokens)) return true;
    return tokens.expiresAt > this.clock() + this.earlyRefreshMs;
  }

  private async refreshFlow(opts: { force?: boolean } = {}): Promise<TokenSet> {
    return this.singleFlight.run(() => this.doRefresh(opts.force ?? false));
  }

  /**
   * The full refresh dance, protected by the cross-process lockfile.
   */
  private async doRefresh(force: boolean): Promise<TokenSet> {
    return withLock(this.credentialsStore.path, async () => {
      // Layer 3: re-read inside the lock; another process may have refreshed
      // while we were waiting to acquire it.
      const onDisk = await this.credentialsStore.read();

      if (!force && this.isTokenFresh(onDisk)) {
        this.logger?.debug(
          { source: 'lock-reread' },
          'token refreshed by another process while waiting for lock',
        );
        this.cached = onDisk;
        return onDisk;
      }

      // Long-lived tokens skip refresh unless forced (e.g. forceRefresh after a 401).
      if (!force && this.isLongLived(onDisk)) {
        this.cached = onDisk;
        return onDisk;
      }

      this.logger?.info({ expiresAt: onDisk.expiresAt }, 'oauth.refresh.begin');

      const fresh = await this.breaker.execute(async () => {
        return this.refreshClient.refresh(onDisk.refreshToken);
      });

      // CRITICAL: persist atomically BEFORE updating in-memory cache. If the
      // write fails, the next request will re-read the (old) on-disk value
      // and try again, rather than holding a token we never persisted.
      await this.credentialsStore.write(fresh);
      this.cached = fresh;
      this.lastRefreshAt = this.clock();

      this.logger?.info(
        { newExpiresAt: fresh.expiresAt, rotated: fresh.refreshToken !== onDisk.refreshToken },
        'oauth.refresh.success',
      );
      return fresh;
    });
  }
}
