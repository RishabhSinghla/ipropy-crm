# CLAUDE.md — permanent instructions for iPropy CRM

Read `PROJECT_HANDOVER.md` for full context (architecture, state, roadmap, known bugs).
This file is the short list of rules that must hold in **every** session.

---

## What this project is

iPropy is an AI-native, **metadata-driven** CRM for Indian real estate. Modules, fields, layouts,
picklists, views, roles, sharing rules, workflows and dashboards are **data, not code** — admins
reshape the product at runtime with no deploy and no DDL.

Stack: Node 20 + TypeScript + Express + PostgreSQL 16 · React 18 + Vite + Tailwind + TanStack Query ·
Socket.IO · Claude. npm workspaces: `packages/{shared,server,web}`.

Vtiger (at `../vtigercrm`) is an **architecture reference only**. No Vtiger code is used.

---

## Critical rules — violating these breaks the system

1. **No version control yet.** The repo is not a git repository. There is no undo. Be careful with
   destructive commands; propose `git init` early if the user hasn't.

2. **Never write per-module CRUD.** All record reads/writes go through
   `core/entity/recordService.ts`. Module differences are expressed as metadata or workflow hooks.
   If you find yourself writing `if (module === 'leads')` in the engine, stop.

3. **Never emit a domain event inside an open transaction.** Use `onCommit(conn, fn)` from
   `db/pool.ts`. Emitting inline **deadlocks**: a workflow task updating the same row uses a
   different pooled connection and blocks on the uncommitted row lock. This bug has already been hit
   and fixed once — do not reintroduce it.

4. **Invalidate caches after metadata writes.** `registry.invalidate()` + `invalidatePermissions()`
   (or `invalidateAll()` in `api/routes/metadata.ts`). The registry is read on nearly every request.

5. **Enforce field permissions on data, not just metadata.** `getRecord`/`listRecords` call
   `stripHidden()`. Hiding a field only in the describe endpoint leaks it via the API — this
   regression has happened before.

6. **Never interpolate user input into SQL.** Field references resolve through metadata
   (`resolveFieldPath`); identifiers pass `quoteIdent()`, which rejects anything outside
   `[A-Za-z_][A-Za-z0-9_]*`.

7. **AI must degrade gracefully.** `ANTHROPIC_API_KEY` is usually empty in dev. Every AI feature
   pairs a deterministic rule engine with an optional LLM pass. Never write AI code that throws or
   returns nothing when the key is missing.

8. **Bind exactly the parameters a statement references.** Postgres fails with
   `could not determine data type of parameter $1` if a bound param is unused — e.g. reusing an
   INSERT's params array for an UPDATE. This has bitten this codebase three times.

9. **Empty arrays are values, not nulls.** JSONB list columns are `NOT NULL DEFAULT '[]'`.
   `coerceValue` special-cases empty arrays for `multipicklist`/`multireference`/`tags`. Keep it.

---

## Data model facts that surprise people

* **`ipy_record` is the shared id space.** Every `*_id` reference (including `contact_id`) points at
  `ipy_record(id)`, never at a payload table. This is why the Contacts→Leads merge preserved every
  foreign key without repointing.
* **There is no Contacts module.** Leads is the single party record ("Leads & Customers") carrying
  `lifecycle_stage`: `Lead → Prospect → Customer → Past Customer`. Conversion promotes the record
  **in place** and opens a Deal — it does not create a second person.
* **Core modules** (`leads`, `activities`) have `is_core = true` and cannot be disabled.
* **Fields live in two places:** `ipy_field.storage` is `'column'` (real column, real index) or
  `'json'` (key in `custom_fields` JSONB). The query builder resolves both. Admin-created fields are
  always `'json'` — that is why adding a field needs no DDL.
* **One filter grammar, two engines:** `core/query/builder.ts` → SQL (lists, widgets, reports);
  `core/query/evaluate.ts` → in-memory (workflow conditions, conditional visibility). Keep them in
  step.

---

## Working commands

```bash
docker compose up -d db       # Postgres :5432 (container ipropy-db)
npm run dev                   # API :4000 + web :5173
npm run typecheck             # MUST be clean before finishing any change
npm run build                 # full build
npm run db:migrate            # apply pending migrations
npm run db:seed               # idempotent; refreshes metadata, demo data only if DB empty
npm run db:reset              # DESTRUCTIVE: drops schema, re-migrates, re-seeds
npm run db:backup             # pg_dump to backups/ (gitignored); retention 14
npm run db:backup:verify      # restore newest dump into scratch DB, compare counts, drop it
npm run db:restore <dump>     # DESTRUCTIVE: replaces the live DB (see PROJECT_HANDOVER.md §9)
```

Login: `admin@ipropy.com` / `Admin@123`. Other demo users in `PROJECT_HANDOVER.md` §9.

**Verification:** `npm test` runs the Vitest unit suite (107 tests over the query builder, filter
evaluator, formula engine and permissions — no DB needed). There is no integration/e2e coverage, so
verify feature work with `npm run typecheck && npm run build` plus manual API checks against the
running server.

---

## Conventions

* **Seeding is idempotent.** To change the data model, edit `db/seed/modules.ts` and re-run
  `npm run db:seed`. System views/layouts/workflows (`is_system`) are refreshed; user content is not.
* **Migrations are forward-only**, numbered `00N_name.sql`, each applied in its own transaction and
  recorded in `ipy_migration`. Write them defensively (`IF EXISTS`) so they no-op on a fresh DB.
* **Comments explain why, not what.** Match surrounding density. Don't narrate obvious code.
* **British spelling** in user-facing copy: "Organisation", "customise", "prioritise".
* **Indian real-estate domain**: lakhs/crores (`₹1.45 Cr`), carpet vs super built-up area, RERA,
  Vastu, channel partners, token → agreement → registration → possession.
* **Money in `NUMERIC`, read as JS numbers** (the pg type parser is configured for this in
  `db/pool.ts`). Format with `formatIndianPrice` from `@ipropy/shared`.

---

## Read these first when orienting

```
packages/shared/src/uitypes.ts                     the vocabulary (32 field types, filter grammar)
packages/server/src/core/entity/recordService.ts   the generic CRUD engine
packages/server/src/core/query/builder.ts          filters → SQL
packages/server/src/core/permissions/index.ts      4-layer access control
packages/server/src/db/seed/modules.ts             the real-estate data model
packages/web/src/components/FieldRenderer.tsx      metadata → UI
```

---

## Known open issues (details in PROJECT_HANDOVER.md §8)

* Production hardening is not done: `JWT_SECRET` is the dev default, `WHATSAPP_APP_SECRET` is unset,
  no scheduled backups, nothing deployed.
* Speech-to-text, email IMAP inbound, rollup fields and the Channel Partner portal shipped as
  graceful-degradation features — they need real credentials/keys to be exercised end-to-end.
* Dashboard drag-to-resize is wired (react-grid-layout on desktop, persisted via `saveDashboardLayout`).
