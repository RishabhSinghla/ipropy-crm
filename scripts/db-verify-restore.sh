#!/usr/bin/env bash
# End-to-end restore check. Restores the newest backup (or the one passed) into
# a scratch database, compares key table counts against the live DB, then drops
# the scratch database. Touches nothing in the live database.
#
#   usage: db-verify-restore.sh [backup.dump]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${IPROPY_DB_CONTAINER:-ipropy-db}"
DB_USER="${POSTGRES_USER:-ipropy}"
LIVE_DB="${POSTGRES_DB:-ipropy}"
SCRATCH="ipropy_restore_check"
BACKUP_DIR="$ROOT/backups"
DUMP="${1:-$(ls -1t "$BACKUP_DIR"/ipropy-*.dump 2>/dev/null | head -1)}"

[ -n "$DUMP" ] && [ -f "$DUMP" ] || {
  echo "No backup found in $BACKUP_DIR — run 'npm run db:backup' first." >&2
  exit 1
}

docker exec "$CONTAINER" dropdb --if-exists -U "$DB_USER" "$SCRATCH" >/dev/null 2>&1 || true
docker exec "$CONTAINER" createdb -U "$DB_USER" "$SCRATCH"
docker exec -i "$CONTAINER" pg_restore -U "$DB_USER" -d "$SCRATCH" < "$DUMP"

FAIL=0
for T in ipy_migration ipy_user ipy_record ipy_module ipy_field; do
  LIVE=$(docker exec "$CONTAINER" psql -U "$DB_USER" -tA -d "$LIVE_DB" -c "SELECT count(*) FROM $T" | tr -d '[:space:]')
  REST=$(docker exec "$CONTAINER" psql -U "$DB_USER" -tA -d "$SCRATCH" -c "SELECT count(*) FROM $T" | tr -d '[:space:]')
  if [ "$LIVE" = "$REST" ]; then
    echo "$T: live=$LIVE restored=$REST OK"
  else
    echo "$T: live=$LIVE restored=$REST MISMATCH" >&2
    FAIL=1
  fi
done

docker exec "$CONTAINER" dropdb -U "$DB_USER" "$SCRATCH"

if [ "$FAIL" -eq 0 ]; then
  echo "Restore verified against $(basename "$DUMP"). Scratch database dropped."
else
  echo "Restore check FAILED (see mismatches above)." >&2
  exit 1
fi
