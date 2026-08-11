#!/bin/sh
# Production container boot: bring the schema up to date, refresh system
# metadata, then start the server. All three steps are safe to repeat on
# every deploy and every cold start.
#
#   migrate  forward-only, each file recorded in ipy_migration — already-applied
#            files are skipped, so this is a no-op once the DB is current.
#   seed     create-only for admin-editable content (see db/seed/index.ts), so
#            running it here is safe even though a free-tier instance cold-starts
#            several times a day. It is what makes a brand-new database
#            self-provision, and what adds newly-defined modules/fields after a
#            deploy that changed db/seed/templates/. It will NOT push edits to a
#            dashboard, workflow or template that already exists — those belong
#            to the admin. Before migration 033 it did, and every cold start
#            silently reset them.
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
