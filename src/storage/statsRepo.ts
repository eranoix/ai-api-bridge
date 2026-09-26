import type { Db } from './db.js';

export interface OverallStats {
  windowStart: number;
  windowEnd: number;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  successCount: number;
  errorCount: number;
}

export interface ModelLatency {
  model: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface PerKeyUsage {
  apiKeyId: number;
  name: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

interface RawRow {
  latency_ms: number | null;
  status_code: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  requested_model: string | null;
  api_key_id: number;
}

/**
 * Reads aggregations from `usage_logs`. Sized for single-user traffic, where
 * full table scans are fine.
 */
export class StatsRepo {
  constructor(private readonly db: Db) {}

  overall(sinceMs: number): OverallStats {
    const now = Date.now();
    const row = this.db
      .prepare<[number], {
        n: number;
        in_tokens: number | null;
        out_tokens: number | null;
        ok: number;
        err: number;
      }>(
        `SELECT
           COUNT(*) AS n,
           SUM(input_tokens) AS in_tokens,
           SUM(output_tokens) AS out_tokens,
           SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS ok,
           SUM(CASE WHEN status_code IS NULL OR status_code >= 400 THEN 1 ELSE 0 END) AS err
         FROM usage_logs WHERE ts >= ?`,
      )
      .get(sinceMs);
    return {
      windowStart: sinceMs,
      windowEnd: now,
      totalRequests: row?.n ?? 0,
      totalInputTokens: row?.in_tokens ?? 0,
      totalOutputTokens: row?.out_tokens ?? 0,
      successCount: row?.ok ?? 0,
      errorCount: row?.err ?? 0,
    };
  }

  /**
   * Latency percentiles per requested_model. Computed in-process — SQLite has
   * no built-in percentile aggregate. For our scale this is cheap.
   */
  latencyByModel(sinceMs: number): ModelLatency[] {
    const rows = this.db
      .prepare<[number], RawRow>(
        `SELECT requested_model, latency_ms, status_code, input_tokens, output_tokens, api_key_id
         FROM usage_logs WHERE ts >= ? AND latency_ms IS NOT NULL`,
      )
      .all(sinceMs);
    const grouped = new Map<string, number[]>();
    for (const r of rows) {
      const model = r.requested_model ?? '(unknown)';
      const arr = grouped.get(model) ?? [];
      arr.push(r.latency_ms as number);
      grouped.set(model, arr);
    }
    const out: ModelLatency[] = [];
    for (const [model, samples] of grouped) {
      samples.sort((a, b) => a - b);
      out.push({
        model,
        count: samples.length,
        p50Ms: percentile(samples, 0.5),
        p95Ms: percentile(samples, 0.95),
        p99Ms: percentile(samples, 0.99),
      });
    }
    return out.sort((a, b) => b.count - a.count);
  }

  perKey(sinceMs: number): PerKeyUsage[] {
    const rows = this.db
      .prepare<[number], {
        api_key_id: number;
        name: string;
        n: number;
        in_tokens: number | null;
        out_tokens: number | null;
      }>(
        `SELECT u.api_key_id AS api_key_id,
                k.name AS name,
                COUNT(*) AS n,
                SUM(u.input_tokens) AS in_tokens,
                SUM(u.output_tokens) AS out_tokens
         FROM usage_logs u
         JOIN api_keys k ON k.id = u.api_key_id
         WHERE u.ts >= ?
         GROUP BY u.api_key_id, k.name
         ORDER BY n DESC`,
      )
      .all(sinceMs);
    return rows.map((r) => ({
      apiKeyId: r.api_key_id,
      name: r.name,
      requests: r.n,
      inputTokens: r.in_tokens ?? 0,
      outputTokens: r.out_tokens ?? 0,
    }));
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx] as number;
}
