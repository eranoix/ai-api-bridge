import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../../../src/storage/db.js';
import { SlidingWindowLimiter } from '../../../src/ratelimit/slidingWindow.js';
import { ApiKeyStore } from '../../../src/auth/apiKeyStore.js';

let tmpDir: string;
let db: Db;
let keyId: number;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rl-'));
  db = await openDb({ dbPath: path.join(tmpDir, 'rl.db') });
  const store = new ApiKeyStore(db);
  const { row } = await store.create({ name: 'k1' });
  keyId = row.id;
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('SlidingWindowLimiter — RPM', () => {
  it('allows up to N requests, then rejects with rpm_exceeded', () => {
    const limiter = new SlidingWindowLimiter(db);
    for (let i = 0; i < 5; i++) {
      expect(limiter.checkAndReserve(keyId, { rpm: 5, tpm: 100_000 }).allowed).toBe(true);
    }
    const res = limiter.checkAndReserve(keyId, { rpm: 5, tpm: 100_000 });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('rpm_exceeded');
    expect(res.requestsInWindow).toBe(5);
  });

  it('window slides: requests outside the trailing window do not count', () => {
    let clock = 1_000_000;
    const limiter = new SlidingWindowLimiter(db, {
      windowMs: 60_000,
      bucketMs: 10_000,
      now: () => clock,
    });
    limiter.checkAndReserve(keyId, { rpm: 5, tpm: 100_000 });
    limiter.checkAndReserve(keyId, { rpm: 5, tpm: 100_000 });
    limiter.checkAndReserve(keyId, { rpm: 5, tpm: 100_000 });

    // Move clock 70s ahead: the old bucket falls out of the window.
    clock += 70_000;

    for (let i = 0; i < 5; i++) {
      expect(limiter.checkAndReserve(keyId, { rpm: 5, tpm: 100_000 }).allowed).toBe(true);
    }
    expect(limiter.checkAndReserve(keyId, { rpm: 5, tpm: 100_000 }).allowed).toBe(false);
  });
});

describe('SlidingWindowLimiter — TPM', () => {
  it('blocks when accumulated tokens in window exceed tpm', () => {
    const limiter = new SlidingWindowLimiter(db);
    expect(limiter.checkAndReserve(keyId, { rpm: 100, tpm: 10_000 }).allowed).toBe(true);
    limiter.addTokens(keyId, 12_000); // overshoots tpm

    const res = limiter.checkAndReserve(keyId, { rpm: 100, tpm: 10_000 });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('tpm_exceeded');
  });
});

describe('SlidingWindowLimiter — daily budget', () => {
  it('rejects with daily_budget_exceeded when 24h token total is reached', () => {
    let clock = 1_700_000_000_000;
    const limiter = new SlidingWindowLimiter(db, { now: () => clock });
    limiter.checkAndReserve(keyId, { rpm: 100, tpm: 100_000, dailyTokens: 1000 });
    limiter.addTokens(keyId, 1500);
    const res = limiter.checkAndReserve(keyId, { rpm: 100, tpm: 100_000, dailyTokens: 1000 });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('daily_budget_exceeded');
    expect(res.tokensInDay).toBeGreaterThanOrEqual(1500);

    // Advance > 24h: budget resets.
    clock += 25 * 60 * 60 * 1000;
    const res2 = limiter.checkAndReserve(keyId, { rpm: 100, tpm: 100_000, dailyTokens: 1000 });
    expect(res2.allowed).toBe(true);
  });

  it('ignores daily budget if not set', () => {
    const limiter = new SlidingWindowLimiter(db);
    for (let i = 0; i < 20; i++) {
      limiter.checkAndReserve(keyId, { rpm: 100, tpm: 100_000 });
      limiter.addTokens(keyId, 10_000);
    }
    const res = limiter.checkAndReserve(keyId, { rpm: 100, tpm: 1_000_000 });
    expect(res.allowed).toBe(true);
  });
});

describe('SlidingWindowLimiter — cleanup', () => {
  it('deletes buckets older than 1 day', () => {
    let clock = 1_700_000_000_000;
    const limiter = new SlidingWindowLimiter(db, { now: () => clock });
    limiter.checkAndReserve(keyId, { rpm: 100, tpm: 100_000 });
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM rate_limit_buckets').get() as { c: number }).c,
    ).toBeGreaterThan(0);

    clock += 25 * 60 * 60 * 1000;
    limiter.cleanup();
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM rate_limit_buckets').get() as { c: number }).c,
    ).toBe(0);
  });
});
