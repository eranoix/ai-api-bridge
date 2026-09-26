CREATE TABLE IF NOT EXISTS api_keys (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,
  key_hash        TEXT NOT NULL UNIQUE,
  key_prefix      TEXT NOT NULL,
  rate_limit_rpm  INTEGER NOT NULL DEFAULT 60,
  rate_limit_tpm  INTEGER NOT NULL DEFAULT 100000,
  daily_token_budget INTEGER,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  revoked_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash_active
  ON api_keys(key_hash)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS usage_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id    INTEGER NOT NULL,
  ts            INTEGER NOT NULL,
  endpoint      TEXT NOT NULL,
  requested_model TEXT,
  upstream_model  TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  latency_ms    INTEGER,
  status_code   INTEGER,
  error_code    TEXT,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
);

CREATE INDEX IF NOT EXISTS idx_usage_logs_key_ts ON usage_logs(api_key_id, ts);

CREATE TABLE IF NOT EXISTS oauth_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  event       TEXT NOT NULL,
  expires_at  INTEGER,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_audit_ts ON oauth_audit(ts);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  api_key_id    INTEGER NOT NULL,
  bucket_start  INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  token_count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_buckets_cleanup ON rate_limit_buckets(bucket_start);
