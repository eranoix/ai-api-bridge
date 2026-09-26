-- expires_at: epoch ms; NULL means no expiration

ALTER TABLE api_keys ADD COLUMN expires_at INTEGER;
