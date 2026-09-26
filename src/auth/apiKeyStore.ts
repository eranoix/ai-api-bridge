import type { Db } from '../storage/db.js';
import { generateApiKey, hashApiKey, keyPrefix, verifyApiKey } from './hash.js';

export interface ApiKeyRow {
  id: number;
  name: string;
  keyPrefix: string;
  rateLimitRpm: number;
  rateLimitTpm: number;
  dailyTokenBudget: number | null;
  enabled: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  /** Epoch ms when this key stops working. NULL = never. */
  expiresAt: number | null;
}

export interface CreateApiKeyOptions {
  name: string;
  rateLimitRpm?: number;
  rateLimitTpm?: number;
  dailyTokenBudget?: number | null;
  /** Epoch ms. NULL/undefined = never expires. */
  expiresAt?: number | null;
}

export interface CreateApiKeyResult {
  /** The plaintext key — printed once, never stored. */
  plaintext: string;
  row: ApiKeyRow;
}

interface RawRow {
  id: number;
  name: string;
  key_hash: string;
  key_prefix: string;
  rate_limit_rpm: number;
  rate_limit_tpm: number;
  daily_token_budget: number | null;
  enabled: number;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  expires_at: number | null;
}

function rowFromRaw(raw: RawRow): ApiKeyRow {
  return {
    id: raw.id,
    name: raw.name,
    keyPrefix: raw.key_prefix,
    rateLimitRpm: raw.rate_limit_rpm,
    rateLimitTpm: raw.rate_limit_tpm,
    dailyTokenBudget: raw.daily_token_budget,
    enabled: raw.enabled === 1,
    createdAt: raw.created_at,
    lastUsedAt: raw.last_used_at,
    revokedAt: raw.revoked_at,
    expiresAt: raw.expires_at,
  };
}

export class ApiKeyStore {
  constructor(private readonly db: Db) {}

  async create(opts: CreateApiKeyOptions): Promise<CreateApiKeyResult> {
    const plaintext = generateApiKey();
    const hash = await hashApiKey(plaintext);
    const prefix = keyPrefix(plaintext);
    const now = Date.now();

    const stmt = this.db.prepare(
      `INSERT INTO api_keys (name, key_hash, key_prefix, rate_limit_rpm, rate_limit_tpm,
         daily_token_budget, enabled, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    const info = stmt.run(
      opts.name,
      hash,
      prefix,
      opts.rateLimitRpm ?? 60,
      opts.rateLimitTpm ?? 100_000,
      opts.dailyTokenBudget ?? null,
      now,
      opts.expiresAt ?? null,
    );
    const row = this.db
      .prepare<[number | bigint], RawRow>('SELECT * FROM api_keys WHERE id = ?')
      .get(info.lastInsertRowid);
    if (!row) throw new Error('apiKeyStore: failed to read back inserted row');
    return { plaintext, row: rowFromRaw(row) };
  }

  list(): ApiKeyRow[] {
    const rows = this.db
      .prepare<[], RawRow>('SELECT * FROM api_keys ORDER BY created_at DESC')
      .all();
    return rows.map(rowFromRaw);
  }

  /**
   * Look up an active (non-revoked, enabled, non-expired) key by plaintext.
   * Pre-filters by key_prefix; expected scale is <50 keys.
   */
  async findByPlaintext(plaintext: string): Promise<ApiKeyRow | null> {
    const prefix = keyPrefix(plaintext);
    const now = Date.now();
    const candidates = this.db
      .prepare<[string, number], RawRow & { key_hash: string }>(
        `SELECT * FROM api_keys
         WHERE key_prefix = ?
           AND revoked_at IS NULL
           AND enabled = 1
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .all(prefix, now);

    for (const c of candidates) {
      if (await verifyApiKey(plaintext, c.key_hash)) {
        return rowFromRaw(c);
      }
    }
    return null;
  }

  revoke(name: string): boolean {
    const info = this.db
      .prepare('UPDATE api_keys SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL')
      .run(Date.now(), name);
    return info.changes > 0;
  }

  revokeById(id: number): boolean {
    const info = this.db
      .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(Date.now(), id);
    return info.changes > 0;
  }

  /**
   * Update the mutable fields of a key; fields absent from `opts` are left as is.
   * Plaintext and prefix are immutable (rotation = revoke + create new).
   * Returns the updated row, or null if no row with that id exists.
   */
  updateById(
    id: number,
    opts: {
      rateLimitRpm?: number;
      rateLimitTpm?: number;
      dailyTokenBudget?: number | null;
      expiresAt?: number | null;
    },
  ): ApiKeyRow | null {
    const fragments: string[] = [];
    const params: Array<number | null> = [];
    if (typeof opts.rateLimitRpm === 'number') {
      fragments.push('rate_limit_rpm = ?');
      params.push(opts.rateLimitRpm);
    }
    if (typeof opts.rateLimitTpm === 'number') {
      fragments.push('rate_limit_tpm = ?');
      params.push(opts.rateLimitTpm);
    }
    if (opts.dailyTokenBudget !== undefined) {
      fragments.push('daily_token_budget = ?');
      params.push(opts.dailyTokenBudget);
    }
    if (opts.expiresAt !== undefined) {
      fragments.push('expires_at = ?');
      params.push(opts.expiresAt);
    }
    if (fragments.length === 0) {
      const row = this.db
        .prepare<[number], RawRow>('SELECT * FROM api_keys WHERE id = ?')
        .get(id);
      return row ? rowFromRaw(row) : null;
    }
    params.push(id);
    const info = this.db
      .prepare(`UPDATE api_keys SET ${fragments.join(', ')} WHERE id = ?`)
      .run(...params);
    if (info.changes === 0) return null;
    const row = this.db
      .prepare<[number], RawRow>('SELECT * FROM api_keys WHERE id = ?')
      .get(id);
    return row ? rowFromRaw(row) : null;
  }

  markUsed(id: number): void {
    this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
  }
}
