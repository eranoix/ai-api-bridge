#!/bin/bash
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/ai-api-bridge}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/ai-api-bridge}"
RETENTION_COPIES=30

CREDS="$DATA_DIR/credentials.json"
DB="$DATA_DIR/gateway.db"

mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"

ts="$(date +%Y%m%d-%H%M%S)"

if [ -f "$CREDS" ]; then
    flock -x "$CREDS.lock" -c "cp -a '$CREDS' '$BACKUP_DIR/credentials-$ts.json'"
fi

if [ -f "$DB" ]; then
    sqlite3 "$DB" ".backup '$BACKUP_DIR/db-$ts.db'"
fi

ls -1t "$BACKUP_DIR"/credentials-*.json 2>/dev/null | tail -n +$((RETENTION_COPIES + 1)) | xargs -r rm
ls -1t "$BACKUP_DIR"/db-*.db 2>/dev/null | tail -n +$((RETENTION_COPIES + 1)) | xargs -r rm
