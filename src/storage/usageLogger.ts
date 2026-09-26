import type { Db } from './db.js';

export interface UsageLogEntry {
  apiKeyId: number;
  endpoint: string;
  requestedModel?: string;
  upstreamModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  statusCode: number;
  errorCode?: string;
}

export class UsageLogger {
  private readonly insertStmt;

  constructor(db: Db) {
    this.insertStmt = db.prepare(
      `INSERT INTO usage_logs
         (api_key_id, ts, endpoint, requested_model, upstream_model,
          input_tokens, output_tokens, latency_ms, status_code, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  log(entry: UsageLogEntry): void {
    try {
      this.insertStmt.run(
        entry.apiKeyId,
        Date.now(),
        entry.endpoint,
        entry.requestedModel ?? null,
        entry.upstreamModel ?? null,
        entry.inputTokens ?? null,
        entry.outputTokens ?? null,
        entry.latencyMs ?? null,
        entry.statusCode,
        entry.errorCode ?? null,
      );
    } catch {
      // Logging never blocks the request path.
    }
  }
}
