#!/bin/bash
# Back up the OAuth credentials file and the SQLite DB. If credentials.json is
# lost or corrupted, the refresh token is gone and a full re-login is needed.
#
# Install:
#   sudo cp deploy/backup-credentials.sh /usr/local/bin/ai-api-bridge-backup
#   sudo chmod 0755 /usr/local/bin/ai-api-bridge-backup
#   sudo crontab -e   # add:
#     0 */6 * * * /usr/local/bin/ai-api-bridge-backup
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/ai-api-bridge}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/ai-api-bridge}"
RETENTION_COPIES=30

CREDS="$DATA_DIR/credentials.json"
DB="$DATA_DIR/gateway.db"

mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"

ts="$(date +%Y%m%d-%H%M%S)"

# flock so the file is not copied mid-rotation.
if [ -f "$CREDS" ]; then
    flock -x "$CREDS.lock" -c "cp -a '$CREDS' '$BACKUP_DIR/credentials-$ts.json'"
fi

# DB — use SQLite's online .backup so WAL state is consistent.
if [ -f "$DB" ]; then
    sqlite3 "$DB" ".backup '$BACKUP_DIR/db-$ts.db'"
fi

ls -1t "$BACKUP_DIR"/credentials-*.json 2>/dev/null | tail -n +$((RETENTION_COPIES + 1)) | xargs -r rm
ls -1t "$BACKUP_DIR"/db-*.db 2>/dev/null | tail -n +$((RETENTION_COPIES + 1)) | xargs -r rm
