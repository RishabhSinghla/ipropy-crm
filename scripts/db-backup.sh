#!/usr/bin/env bash
# Backup the iPropy Postgres database to backups/ as a compressed custom-format
# dump (pg_restore input). Runs inside the docker container so no host Postgres
# tools are needed. Retention: newest $BACKUP_KEEP dumps (default 14).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${IPROPY_DB_CONTAINER:-ipropy-db}"
DB_USER="${POSTGRES_USER:-ipropy}"
DB_NAME="${POSTGRES_DB:-ipropy}"
BACKUP_DIR="$ROOT/backups"
KEEP="${BACKUP_KEEP:-14}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$BACKUP_DIR/ipropy-$STAMP.dump"

docker exec "$CONTAINER" pg_dump -U "$DB_USER" -Fc "$DB_NAME" > "$FILE"

# Prune old dumps, keeping the newest $KEEP.
ls -1t "$BACKUP_DIR"/ipropy-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "Backup written: $FILE"
ls -lh "$FILE"
