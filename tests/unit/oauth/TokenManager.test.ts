import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialsStore } from '../../../src/oauth/credentialsStore.js';
import { TokenManager } from '../../../src/oauth/TokenManager.js';
import type { RefreshClient } from '../../../src/oauth/refreshClient.js';
import type { TokenSet } from '../../../src/oauth/types.js';
import { OAuthRefreshError } from '../../../src/oauth/types.js';

class CountingRefreshClient implements RefreshClient {
  public callCount = 0;
  public seenRefreshTokens: string[] = [];
  constructor(
    private readonly responder: (refreshToken: string, call: number) => Promise<TokenSet>,
  ) {}
  async refresh(refreshToken: string): Promise<TokenSet> {
    this.callCount++;
    this.seenRefreshTokens.push(refreshToken);
    return this.responder(refreshToken, this.callCount);
  }
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tok-mgr-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeExpiredCreds(file: string, refreshToken = 'r-old'): Promise<void> {
  await fs.writeFile(
    file,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'access-expired',
        refreshToken,
        expiresAt: Date.now() - 60_000,
      },
    }),
  );
}

describe('TokenManager — concurrency', () => {
  it('CRITICAL DoD: 50 concurrent getAccessToken calls trigger exactly 1 refresh', async () => {
    const credPath = path.join(tmpDir, 'creds.json');
    await writeExpiredCreds(credPath, 'r-original');

    const store = new CredentialsStore(credPath);
    const refreshClient = new CountingRefreshClient(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return {
        accessToken: 'access-new',
        refreshToken: 'r-rotated-1',
        expiresAt: Date.now() + 3_600_000,
      };
    });
    const tm = new TokenManager({ credentialsStore: store, refreshClient });

    const results = await Promise.all(Array.from({ length: 50 }, () => tm.getAccessToken()));

    expect(refreshClient.callCount).toBe(1);
    expect(results).toHaveLength(50);
    expect(results.every((t) => t === 'access-new')).toBe(true);

    const onDisk = await store.read();
    expect(onDisk.accessToken).toBe('access-new');
    expect(onDisk.refreshToken).toBe('r-rotated-1');
  });

  it('serial calls after refresh use the cached token (no extra refresh)', async () => {
    const credPath = path.join(tmpDir, 'creds.json');
    await writeExpiredCreds(credPath);
    const store = new CredentialsStore(credPath);
    const rc = new CountingRefreshClient(async () => ({
      accessToken: 'fresh',
      refreshToken: 'r2',
      expiresAt: Date.now() + 3_600_000,
    }));
    const tm = new TokenManager({ credentialsStore: store, refreshClient: rc });
    await tm.getAccessToken();
    await tm.getAccessToken();
    await tm.getAccessToken();
    expect(rc.callCount).toBe(1);
  });

  it('only ever passes ONE refresh_token to the upstream (the most recent)', async () => {
    // The critical anti-race property: even with 50 concurrent callers, we never
    // make two refresh calls with the SAME stale refresh token.
    const credPath = path.join(tmpDir, 'creds.json');
    await writeExpiredCreds(credPath, 'r-stale');
    const store = new CredentialsStore(credPath);
    const rc = new CountingRefreshClient(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { accessToken: 'a', refreshToken: 'r-new', expiresAt: Date.now() + 3_600_000 };
    });
    const tm = new TokenManager({ credentialsStore: store, refreshClient: rc });
    await Promise.all(Array.from({ length: 25 }, () => tm.getAccessToken()));
    expect(rc.seenRefreshTokens).toEqual(['r-stale']);
  });
});

describe('TokenManager — long-lived tokens', () => {
  it('never refreshes when expiresAt is > 30 days away (setup-token mode)', async () => {
    const credPath = path.join(tmpDir, 'creds.json');
    await fs.writeFile(
      credPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'long-lived-token',
          refreshToken: 'never-used',
          expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000, // 90 days
        },
      }),
    );
    const store = new CredentialsStore(credPath);
    const rc = new CountingRefreshClient(async () => {
      throw new Error('refresh should never be called for long-lived tokens');
    });
    const tm = new TokenManager({ credentialsStore: store, refreshClient: rc });

    for (let i = 0; i < 10; i++) {
      expect(await tm.getAccessToken()).toBe('long-lived-token');
    }
    expect(rc.callCount).toBe(0);

    const status = await tm.getStatus();
    expect(status.isLongLived).toBe(true);
  });

  it('forceRefresh still works on long-lived tokens (for manual rotation)', async () => {
    const credPath = path.join(tmpDir, 'creds.json');
    await fs.writeFile(
      credPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'old-long',
          refreshToken: 'r1',
          expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
        },
      }),
    );
    const store = new CredentialsStore(credPath);
    const rc = new CountingRefreshClient(async () => ({
      accessToken: 'new-long',
      refreshToken: 'r2',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    }));
    const tm = new TokenManager({ credentialsStore: store, refreshClient: rc });
    await tm.forceRefresh();
    expect(rc.callCount).toBe(1);
    expect(await tm.getAccessToken()).toBe('new-long');
  });
});

describe('TokenManager — fresh tokens', () => {
  it('returns cached access token without I/O when far from expiry', async () => {
    const credPath = path.join(tmpDir, 'creds.json');
    await fs.writeFile(
      credPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'still-fresh',
          refreshToken: 'r1',
          expiresAt: Date.now() + 30 * 60 * 1000, // 30 min from now, well past 5-min buffer
        },
      }),
    );
    const store = new CredentialsStore(credPath);
    const rc = new CountingRefreshClient(async () => {
      throw new Error('should not refresh');
    });
    const tm = new TokenManager({ credentialsStore: store, refreshClient: rc });
    expect(await tm.getAccessToken()).toBe('still-fresh');
    expect(rc.callCount).toBe(0);
  });

  it('refreshes proactively when within the early-refresh window', async () => {
    const credPath = path.join(tmpDir, 'creds.json');
    await fs.writeFile(
      credPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'almost-expired',
          refreshToken: 'r1',
          expiresAt: Date.now() + 60_000, // 1 min from now, inside the 5-min buffer
        },
      }),
    );
    const store = new CredentialsStore(credPath);
    const rc = new CountingRefreshClient(async () => ({
      accessToken: 'replacement',
      refreshToken: 'r2',
      expiresAt: Date.now() + 3_600_000,
    }));
    const tm = new TokenManager({ credentialsStore: store, refreshClient: rc });
    expect(await tm.getAccessToken()).toBe('replacement');
    expect(rc.callCount).toBe(1);
  });
});

describe('TokenManager — circuit breaker', () => {
  it('opens the circuit breaker after 3 consecutive refresh failures', async () => {
    const credPath = path.join(tmpDir, 'creds.json');
    await writeExpiredCreds(credPath);
    const store = new CredentialsStore(credPath);
    const rc = new CountingRefreshClient(async () => {
      throw new OAuthRefreshError('upstream down', 502, 'bad gateway');
    });
    const tm = new TokenManager({
      credentialsStore: store,
      refreshClient: rc,
      circuitBreaker: { threshold: 3, resetMs: 60_000 },
    });

    for (let i = 0; i < 3; i++) {
      await expect(tm.forceRefresh()).rejects.toThrow();
    }
    // 4th call should hit the open breaker, not the upstream.
    await expect(tm.forceRefresh()).rejects.toThrow(/circuit_breaker_open/);
    expect(rc.callCount).toBe(3);

    const status = await tm.getStatus();
    expect(status.circuitBreakerState).toBe('open');
  });
});
