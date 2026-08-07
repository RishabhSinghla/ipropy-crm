#!/bin/sh
# Production container boot: bring the schema up to date, refresh system
# metadata, then start the server. All three steps are safe to repeat on
# every deploy and every cold start.
#
#   migrate  forward-only, each file recorded in ipy_migration — already-applied
#            files are skipped, so this is a no-op once the DB is current.
#   seed     idempotent by design (see CLAUDE.md): refreshes is_system views/
#            layouts/workflows and inserts demo data ONLY when the DB is empty.
#            Running it here is what makes a brand-new database self-provision,
#            and what keeps system metadata in step after a deploy that changed
#            db/seed/modules.ts.
#
# Failing fast matters: a container that starts with a half-migrated schema
# would serve errors on nearly every request, which is harder to diagnose than
# a deploy that visibly refuses to come up.
set -e

echo "→ applying database migrations…"
node packages/server/dist/db/migrate.js

echo "→ seeding metadata (idempotent)…"
node packages/server/dist/db/seed/index.js

echo "→ starting iPropy…"
exec node packages/server/dist/index.js
