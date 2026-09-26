import type { Db } from '../storage/db.js';

export interface RateLimits {
  rpm: number;
  tpm: number;
  /** Optional 24h token cap, applied separately. */
  dailyTokens?: number | null;
}

export interface CheckResult {
  allowed: boolean;
  /** Requests counted in the rolling window. */
  requestsInWindow: number;
  /** Tokens counted in the rolling window. */
  tokensInWindow: number;
  /** Tokens counted in the trailing 24h, if dailyTokens is set. */
  tokensInDay?: number;
  /** Reason for denial (only when !allowed). */
  reason?: 'rpm_exceeded' | 'tpm_exceeded' | 'daily_budget_exceeded';
  /** Approx seconds until enough quota frees up. */
  resetSec: number;
}

/**
 * Fixed-bucket sliding window rate limiter persisted in SQLite.
 *
 * The 60s window is divided into 10s buckets. To check, we sum the
 * `request_count` and `token_count` of all buckets whose `bucket_start`
 * falls within the last 60s. Counters are eventually consistent (a
 * concurrent request between SELECT and UPSERT can let one extra through),
 * which is fine for single-user scale.
 */
export class SlidingWindowLimiter {
  private readonly db: Db;
  private readonly windowMs: number;
  private readonly bucketMs: number;
  private readonly dayMs = 24 * 60 * 60 * 1000;

  private readonly nowFn: () => number;

  private readonly sumStmt;
  private readonly daySumStmt;
  private readonly upsertStmt;
  private readonly addTokensStmt;
  private readonly cleanupStmt;

  constructor(db: Db, opts: { windowMs?: number; bucketMs?: number; now?: () => number } = {}) {
    this.db = db;
    this.windowMs = opts.windowMs ?? 60_000;
    this.bucketMs = opts.bucketMs ?? 10_000;
    this.nowFn = opts.now ?? Date.now;

    this.sumStmt = db.prepare(`
      SELECT COALESCE(SUM(request_count), 0) AS reqs,
             COALESCE(SUM(token_count), 0)   AS toks
      FROM rate_limit_buckets
      WHERE api_key_id = ? AND bucket_start >= ?
    `);
    this.daySumStmt = db.prepare(`
      SELECT COALESCE(SUM(token_count), 0) AS toks
      FROM rate_limit_buckets
      WHERE api_key_id = ? AND bucket_start >= ?
    `);
    this.upsertStmt = db.prepare(`
      INSERT INTO rate_limit_buckets (api_key_id, bucket_start, request_count, token_count)
      VALUES (?, ?, 1, 0)
      ON CONFLICT(api_key_id, bucket_start) DO UPDATE SET
        request_count = request_count + 1
    `);
    this.addTokensStmt = db.prepare(`
      INSERT INTO rate_limit_buckets (api_key_id, bucket_start, request_count, token_count)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(api_key_id, bucket_start) DO UPDATE SET
        token_count = token_count + excluded.token_count
    `);
    this.cleanupStmt = db.prepare(`
      DELETE FROM rate_limit_buckets WHERE bucket_start < ?
    `);
  }

  /**
   * Check whether a new request is permitted, and reserve a request slot
   * atomically if so. Token usage is recorded separately via `addTokens()`
   * after the upstream returns.
   */
  checkAndReserve(apiKeyId: number, limits: RateLimits): CheckResult {
    const now = this.nowFn();
    const windowStart = now - this.windowMs;
    const bucketStart = Math.floor(now / this.bucketMs) * this.bucketMs;
    const txn = this.db.transaction((): CheckResult => {
      const sum = this.sumStmt.get(apiKeyId, windowStart) as { reqs: number; toks: number };

      if (sum.reqs >= limits.rpm) {
        return {
          allowed: false,
          requestsInWindow: sum.reqs,
          tokensInWindow: sum.toks,
          reason: 'rpm_exceeded',
          resetSec: Math.ceil((this.bucketMs - (now % this.bucketMs)) / 1000),
        };
      }
      if (sum.toks >= limits.tpm) {
        return {
          allowed: false,
          requestsInWindow: sum.reqs,
          tokensInWindow: sum.toks,
          reason: 'tpm_exceeded',
          resetSec: Math.ceil((this.bucketMs - (now % this.bucketMs)) / 1000),
        };
      }

      if (limits.dailyTokens && limits.dailyTokens > 0) {
        const day = this.daySumStmt.get(apiKeyId, now - this.dayMs) as { toks: number };
        if (day.toks >= limits.dailyTokens) {
          return {
            allowed: false,
            requestsInWindow: sum.reqs,
            tokensInWindow: sum.toks,
            tokensInDay: day.toks,
            reason: 'daily_budget_exceeded',
            resetSec: Math.ceil(this.dayMs / 1000),
          };
        }
      }

      this.upsertStmt.run(apiKeyId, bucketStart);
      return {
        allowed: true,
        requestsInWindow: sum.reqs + 1,
        tokensInWindow: sum.toks,
        resetSec: Math.ceil((this.windowMs - (now - windowStart)) / 1000),
      };
    });
    return txn();
  }

  /** Charge tokens after a successful upstream call. Best-effort. */
  addTokens(apiKeyId: number, tokens: number): void {
    if (tokens <= 0) return;
    const now = this.nowFn();
    const bucketStart = Math.floor(now / this.bucketMs) * this.bucketMs;
    try {
      this.addTokensStmt.run(apiKeyId, bucketStart, tokens);
    } catch {
      // never block the response on bookkeeping
    }
  }

  /** Delete buckets older than 1 day. Safe to call periodically. */
  cleanup(): number {
    const cutoff = this.nowFn() - this.dayMs;
    return this.cleanupStmt.run(cutoff).changes;
  }
}
