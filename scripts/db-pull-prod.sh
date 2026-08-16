#!/usr/bin/env bash
# Replace the local development database with a copy of production.
#
# The point of this is a loop, not a one-off: production is where fields get
# added, dropdowns get pruned and leads get created and deleted, so local work
# that starts from a stale seed is fixing bugs in a CRM nobody is using. Pull
# prod, reproduce the bug against the data it actually happened to, fix it,
# push to main, and pull again next time.
#
#   PROD_DATABASE_URL='postgresql://…neon.tech/neondb?sslmode=require' \
#     npm run db:pull-prod
#
# What it does, in order:
#   1. dumps production, read-only, into backups/prod-<stamp>.dump
#   2. backs up whatever is in the local database first, so this is undoable
#   3. drops and recreates the local database and restores the prod dump
#   4. applies any migrations that exist on this branch but not yet in prod
#
# Two things it deliberately does not do:
#   * It never writes to production. The only prod operation is `pg_dump`.
#   * It does not copy uploaded photos or videos. Those are files on Render's
#     disk (or R2), not rows, so images will 404 locally. The records, fields,
#     dropdowns, views, workflows and users all come across.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${IPROPY_DB_CONTAINER:-ipropy-db}"
DB_USER="${POSTGRES_USER:-ipropy}"
DB_NAME="${POSTGRES_DB:-ipropy}"
BACKUP_DIR="$ROOT/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [ -z "${PROD_DATABASE_URL:-}" ]; then
  cat >&2 <<'USAGE'
PROD_DATABASE_URL is not set.

Get it from Neon (Console → your project → Connection string) or from Render
(the iPropy service → Environment → DATABASE_URL), then:

  PROD_DATABASE_URL='postgresql://…' npm run db:pull-prod

Keep it out of .env. A dev server pointed at the deployed database will seed
into it, run workflows against it and message real leads — see CLAUDE.md.
USAGE
  exit 1
fi

# Guard against the obvious catastrophe: a local DATABASE_URL that is actually
# production, which would make "restore into local" a restore into prod.
LOCAL_URL="${DATABASE_URL:-}"
if [ -n "$LOCAL_URL" ] && [ "$LOCAL_URL" = "$PROD_DATABASE_URL" ]; then
  echo "DATABASE_URL and PROD_DATABASE_URL are the same database. Refusing." >&2
  exit 1
fi

if ! docker exec "$CONTAINER" true 2>/dev/null; then
  echo "Local Postgres container '$CONTAINER' is not running. Start it with:" >&2
  echo "  docker compose up -d db" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
PROD_DUMP="$BACKUP_DIR/prod-$STAMP.dump"
LOCAL_DUMP="$BACKUP_DIR/local-before-prod-pull-$STAMP.dump"

# pg_dump runs *inside* the container so its version matches the server that
# will restore it, and so no Postgres client tools are needed on the Mac.
echo "→ Dumping production (read-only)…"
docker exec -i "$CONTAINER" pg_dump -Fc --no-owner --no-acl "$PROD_DATABASE_URL" > "$PROD_DUMP"
echo "  $(ls -lh "$PROD_DUMP" | awk '{print $5}')  $PROD_DUMP"

echo "→ Backing up the current local database first…"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -Fc "$DB_NAME" > "$LOCAL_DUMP" || {
  echo "  (nothing to back up)"
}

echo "→ Replacing the local database…"
# Dropping and recreating rather than pg_restore --clean: a clean restore leaves
# behind anything prod does not have, which is exactly the drift this is meant
# to remove.
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid();" >/dev/null
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" >/dev/null
docker exec -i "$CONTAINER" pg_restore --no-owner --no-acl -U "$DB_USER" -d "$DB_NAME" < "$PROD_DUMP"

echo "→ Applying migrations this branch has and production does not…"
(cd "$ROOT" && npm run --silent db:migrate)

RECORDS="$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tA -c \
  "SELECT count(*) FROM ipy_record WHERE is_deleted = false" 2>/dev/null || echo '?')"

cat <<DONE

Local is now a copy of production. $RECORDS live records.

  Sign in with your production credentials — the demo accounts are not seeded
  in production, so admin@ipropy.com will not exist unless it does there.
  Photos and videos will not load: their bytes live on Render's disk, not in
  the database. Everything else — fields, dropdowns, layouts, views, workflows,
  users, leads, properties — is what prod has.

  To undo:  npm run db:restore $LOCAL_DUMP
DONE
