#!/usr/bin/env bash
# Restore an iPropy backup. By default targets the live database — that REPLACES
# the live data, so prefer TARGET_DB=<scratch> to restore elsewhere, or use
# `npm run db:backup:verify` which restores into a throwaway database.
#
#   usage: db-restore.sh <backup.dump> [target_db]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${IPROPY_DB_CONTAINER:-ipropy-db}"
DB_USER="${POSTGRES_USER:-ipropy}"
DB_NAME="${TARGET_DB:-ipropy}"
DUMP="${1:?usage: db-restore.sh <backup.dump> [target_db]}"

[ -f "$DUMP" ] || { echo "Backup file not found: $DUMP" >&2; exit 1; }

echo "Restoring $DUMP into database '$DB_NAME' ..."
docker exec -i "$CONTAINER" pg_restore --clean --if-exists -U "$DB_USER" -d "$DB_NAME" < "$DUMP"
echo "Restore complete."
