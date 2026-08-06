# iPropy CRM — Project Handover

**Last updated:** 6 August 2026
**Status:** Feature-complete build, verified end-to-end. No work in progress.
**Location:** `/Users/rishabhsinghla/Downloads/iPropy-crm`

> Reference implementation: the original Vtiger PHP source sits at
> `/Users/rishabhsinghla/Downloads/vtigercrm`. It was used as an **architecture
> reference only** — no Vtiger code was copied. iPropy is written from scratch.

---

## 1. What the CRM currently does

iPropy is an AI-native, metadata-driven CRM for Indian real-estate developers and brokerages.
It rebuilds Vtiger's runtime-customisation model (modules, fields, layouts, picklists, custom views,
role hierarchy, sharing rules, workflows, dashboards are all *data*, not code) on a modern stack, and
adds WhatsApp, telephony, portal lead capture and an AI layer.

**Working today:**

| Capability | Detail |
|---|---|
| Lead → booking pipeline | Capture, score, qualify, site visit, negotiate, book, collect payments |
| Runtime customisation | Add modules/fields/blocks/layouts/dropdowns/views without a deploy or DDL |
| Kanban + table + filters | Drag-drop pipeline, nested AND/OR filter builder, saved views with live counts |
| Interactive record view | Header summary, tabbed Overview/Timeline/Related/Files, AI sidebar, notes |
| Unified timeline | Calls, WhatsApp, email, notes, tasks, site visits, payments, files, field changes, AI insights on one feed |
| WhatsApp inbox | Threads, 24-hour window enforcement, delivery receipts, templates, AI reply suggestions |
| Telephony | Click-to-call, inbound routing/screen-pop, recordings, AI call analysis, coaching report |
| Inventory board | Tower × floor stack plan, block/release units, "which buyers match this unit" |
| Dashboards | 5 seeded, 39 widgets: metrics with period deltas, funnel, stacked inventory, leaderboards, AI insight tiles |
| Reports | Ad-hoc summary + tabular with grouping, measures, CSV export |
| Automation | 17 workflows, 14 task types, delayed + field-relative scheduling, assignment rules, SLA tracking |
| Admin panel | Module enable/disable, field builder, layout designer, dropdowns, users, roles, profiles, sharing, workflows, integrations, import, audit |
| AI | Lead scoring, property matching, deal risk, call analysis, drafting, "Ask your CRM" NL→query |
| Permissions | 4-layer: profile → org default → role hierarchy → sharing rules/per-record shares. Enforced in SQL. |

**Verified live metrics (current database):**
77 tables · 12 modules · 430 fields · 54 picklists · 54 views · 36 layouts · 17 workflows ·
5 dashboards / 39 widgets · 16 roles · 9 profiles · 10 users · 304 demo records.
Codebase: 116 source files, ~38,100 lines.

---

## 2. Architecture and technology stack

```
Node 20 (running v22.20.0) + TypeScript + Express 4 + PostgreSQL 16
React 18 + Vite 6 + TailwindCSS 3 + TanStack Query 5 + React Router 6 + Recharts 2
Socket.IO 4 (realtime) · Anthropic SDK (Claude) · Zod (validation) · Pino (logging)
npm workspaces monorepo
```

### The metadata engine — the central idea

Vtiger's real strength is that `vtiger_tab` / `vtiger_blocks` / `vtiger_field` are **rows**, so the
product reshapes itself without a deploy. iPropy keeps that and modernises the storage:

```
ipy_module ──< ipy_block ──< ipy_field        the schema, as data
ipy_record ──  ipy_e_<module>                 the data itself
```

* **`ipy_record`** is Vtiger's `crmentity` equivalent — one UUID id space for ownership, audit,
  comments, tags, attachments, search and polymorphic relations across every module.
* **`ipy_e_leads`, `ipy_e_properties`, …** hold declared columns for hot fields (real indexes, real
  types) **plus a `custom_fields JSONB` bag** for anything an admin adds later.
* **`ipy_field.storage`** (`'column'` | `'json'`) tells the query builder to resolve `t.column` or
  `t.custom_fields->>'key'`. Consequence: **adding a field never runs DDL**, and a custom field
  filters, sorts and reports exactly like a built-in one.

**There is no per-module CRUD code anywhere.** One `recordService` serves all 12 seeded modules and
every module an admin creates afterwards.

### Two engines, one filter grammar

A `FilterGroup` (defined in `packages/shared/src/uitypes.ts`) is compiled two ways:

* `core/query/builder.ts` → **SQL**, for list views, widgets and reports.
* `core/query/evaluate.ts` → **in-memory**, for workflow conditions and conditional field visibility.

An admin builds a condition once and it means the same thing in both places.

### Request flow

```
Browser → Vite proxy (dev) → Express
  → middleware/auth.ts        JWT → AuthUser + ScopeContext
  → api/routes/*              Zod validation
  → core/permissions          module + field + record scoping (SQL fragment)
  → core/entity/recordService generic CRUD, metadata-driven
  → core/query/builder        FilterGroup → parameterised SQL
  → db/pool                   Postgres
  → core/events/bus           emitted AFTER COMMIT (see §8)
      → workflow engine → tasks → integrations / AI
      → realtime.ts → Socket.IO
```

### Field types (uitypes)

32 uitypes in `packages/shared/src/uitypes.ts`. Each declares storage kind, valid filter operators,
and whether it is computed. Adding one there makes it immediately available in the field builder,
form renderer, list view, filter builder and workflow engine.

Real-estate specific: `currency` (accepts `"1.5 Cr"` → `15000000`), `area`, `score`, `address`,
`geolocation`, plus computed `formula`, `rollup`, `autonumber`.

---

## 3. Database structure and migrations

**Connection:** `postgres://ipropy:ipropy@localhost:5432/ipropy` (Docker container `ipropy-db`).

### Migrations applied (all four, verified in `ipy_migration`)

| Migration | Applied | What it does |
|---|---|---|
| `001_core.sql` | 2026-08-06 13:35 | Metadata engine (`ipy_module`/`block`/`field`/`picklist`/`relation`), identity (`ipy_user`/`role`/`profile`/`group`/`session`), `ipy_record` base table + tsvector search, permissions, views, layouts, dashboards, audit/comments/attachments/tags/notifications, settings |
| `002_entities.sql` | 2026-08-06 13:35 | Real-estate payload tables: organizations, contacts, leads, projects, properties, deals, site_visits, bookings, payments, channel_partners, campaigns, activities, documents |
| `003_automation_comms_ai.sql` | 2026-08-06 13:35 | Workflow engine + task queue + logs, assignment rules, SLA, conversations/messages/templates, email log, calls + virtual numbers, AI insights/logs/threads, integrations, webforms, lead inbox, webhooks, API keys, import jobs, reports, targets |
| `004_merge_contacts_into_leads.sql` | 2026-08-06 16:30 | **Merged Contacts into Leads** (see below) + added module enable/disable columns (`disabled_reason`, `disabled_at`, `disabled_by`, `is_core`) |

The migration runner (`db/migrate.ts`) is forward-only, applies each `.sql` in name order inside its
own transaction, and records it in `ipy_migration`. It is safe to re-run (already-applied files are
skipped).

### Migration 004 — the Contacts merge (important context)

A separate Contacts module duplicated the person: the same human existed twice, conversion copied
fields between them, and the timeline split across two ids. Now **Leads is the single party record**
carrying a lifecycle stage:

```
Lead → Prospect → Customer → Past Customer
```

This merge was clean because **every `contact_id` in the schema references `ipy_record(id)`, not
`ipy_e_contacts`** — so moving a record between modules preserved every foreign key with no
repointing.

What 004 did, verified on live data:
* Widened `ipy_e_leads` with all contact fields (lifecycle_stage, contact_type, organization_id,
  personal details, consent flags, KYC, engagement_score, lifetime_value, requirement).
* Copied 24 contact payloads into `ipy_e_leads` keeping the same `record_id`.
* Re-homed `ipy_record.module_id/module_name` → leads. **All 28 deals / 3 bookings / 21 payments still
  resolve. Zero orphans.**
* Updated `ipy_call`, `ipy_conversation`, `ipy_e_activities`, `ipy_e_documents`, `ipy_audit`,
  `ipy_ai_insight` module references.
* Repointed every `referenceModules` lookup from `contacts` → `leads`; renamed relation
  `org_contacts` → `org_leads`.
* Deleted the contacts module row (cascading its fields/views/layouts/permissions) and **renamed the
  table to `ipy_e_contacts_archived_004`** — the original 24 rows are still recoverable.

### Key table groups (77 tables total)

| Group | Tables |
|---|---|
| Metadata | `ipy_module`, `ipy_block`, `ipy_field`, `ipy_picklist(_value/_dependency/_role_access)`, `ipy_relation`, `ipy_record_link` |
| Records | `ipy_record` (base), 12 × `ipy_e_*` payload tables, `ipy_sequence` |
| Identity/permissions | `ipy_user`, `ipy_role`, `ipy_profile`, `ipy_group(_member)`, `ipy_session`, `ipy_profile_module_perm`, `ipy_profile_field_perm`, `ipy_module_sharing`, `ipy_sharing_rule`, `ipy_record_share` |
| UI config | `ipy_view`, `ipy_layout(_profile)`, `ipy_dashboard(_widget)`, `ipy_report` |
| Automation | `ipy_workflow(_task/_log/_state)`, `ipy_task_queue`, `ipy_assignment_rule`, `ipy_sla_policy/_tracker` |
| Comms | `ipy_conversation`, `ipy_message`, `ipy_whatsapp_template`, `ipy_email_template/_log`, `ipy_call`, `ipy_virtual_number` |
| AI | `ipy_ai_insight`, `ipy_ai_log`, `ipy_ai_thread`, `ipy_scoring_model` |
| Integrations | `ipy_integration`, `ipy_webform`, `ipy_lead_inbox`, `ipy_webhook`, `ipy_api_key`, `ipy_import_job` |
| Misc | `ipy_audit`, `ipy_comment`, `ipy_attachment`, `ipy_tag(_link)`, `ipy_notification`, `ipy_starred`, `ipy_recent_view`, `ipy_setting`, `ipy_target`, `ipy_migration` |

---

## 4. Environment variables and integrations

Config is centralised in `packages/server/src/config.ts`; the template is `.env.example`.
**Only `DATABASE_URL` and `JWT_SECRET` are required to boot.**

| Variable | Purpose | Current state |
|---|---|---|
| `DATABASE_URL` | Postgres connection | Set — Docker local |
| `JWT_SECRET` | Token signing | **Dev default. Server refuses to start in production with it.** |
| `ANTHROPIC_API_KEY` | Claude | **Empty → AI runs rule-based fallback** |
| `AI_MODEL` / `AI_MODEL_FAST` | Model selection | `claude-sonnet-5` / `claude-haiku-4-5-20251001` |
| `WHATSAPP_*` | Meta Cloud API (phone id, token, verify token, **app secret**) | Empty → simulation mode |
| `TELEPHONY_PROVIDER` + `TWILIO_*` / `EXOTEL_*` | Voice | `none` → logs only |
| `SMTP_*` / `IMAP_*` | Email | Empty → logged with open tracking |
| `FACEBOOK_*`, `GOOGLE_ADS_WEBHOOK_KEY`, `WEBFORM_PUBLIC_KEY` | Lead capture | Endpoints live, no traffic |
| `STORAGE_DRIVER` + `S3_*` | Files | `local` → `./storage` |
| `ENABLE_SCHEDULER`, `SCHEDULER_TICK_SECONDS` | Background jobs | `true`, 60s |
| `SEED_DEMO_DATA` | Demo records on seed | `true` — **set `false` for production** |

**Every integration degrades gracefully.** With an empty `.env` the whole product is demoable:
messages and calls are recorded in the CRM and marked sent, so workflows stay testable.

Webhook URLs to hand to providers are listed in-app at **Admin → Integrations → Webhook URLs**
(WhatsApp, Facebook Lead Ads, Google Ads, 99acres, MagicBricks, Housing, NoBroker, Twilio, Exotel,
generic lead capture, email open pixel).

---

## 5. Modules completed

All 12 are seeded and fully editable at runtime.

| Module | Group | Notes |
|---|---|---|
| **Leads & Customers** | Sales | **Core.** Single party record; lifecycle Lead→Prospect→Customer→Past Customer. 82 fields, 11 blocks, 6 relations. |
| Organisations | Sales | Developers, corporates, investors |
| Deals | Sales | Pipeline with stage probability, AI risk scoring |
| Site Visits | Sales | Scheduling, feedback, AI summary/sentiment; promotes lifecycle to Prospect |
| Bookings | Sales | Payment plan generation; promotes lifecycle to Customer |
| Channel Partners | Sales | Brokers, commission slabs, performance rollups |
| Projects | Inventory | RERA, towers, amenities, USPs, connectivity |
| Properties/Units | Inventory | Full pricing breakdown, formula-computed all-inclusive price |
| Campaigns | Marketing | Spend, attribution keys, formula-computed CPL and ROI |
| Payments | Finance | Milestone instalments, overdue tracking, reminders |
| **Activities** | Productivity | **Core.** Tasks/calls/meetings, polymorphic `related_to` |
| Documents | Productivity | Typed documents, share tokens, AI extraction fields |

**Core modules** (`is_core = true`): `leads`, `activities` — cannot be disabled; the rest of the CRM
reads from them.

---

## 6. Important files and folders

```
iPropy-crm/
├── PROJECT_HANDOVER.md         ← this file
├── CLAUDE.md                   ← permanent instructions for AI sessions
├── README.md                   ← product/setup docs
├── docker-compose.yml          ← Postgres 16 + Redis (Redis unused so far)
├── .env / .env.example
└── packages/
    ├── shared/src/
    │   ├── uitypes.ts          ★ 32 field types, filter grammar — the vocabulary everything shares
    │   ├── types.ts            ★ RecordEnvelope, ModuleMeta, Workflow, Dashboard, etc.
    │   ├── constants.ts        real-estate domain constants (statuses, amenities, states)
    │   └── format.ts           Indian currency/area/phone formatting (₹1.45 Cr)
    ├── server/src/
    │   ├── core/
    │   │   ├── metadata/registry.ts   ★ cached metadata mirror — invalidate() after any admin change
    │   │   ├── metadata/values.ts     value coercion/validation per uitype
    │   │   ├── query/builder.ts       ★ FilterGroup → SQL
    │   │   ├── query/evaluate.ts      ★ FilterGroup → in-memory (workflows)
    │   │   ├── entity/recordService.ts ★★ THE generic CRUD engine — all modules
    │   │   ├── entity/conversion.ts   lead conversion (in-place promotion) + merge
    │   │   ├── entity/timeline.ts     unified activity feed
    │   │   ├── entity/formula.ts      safe recursive-descent formula parser (NOT eval)
    │   │   ├── permissions/index.ts   ★★ 4-layer permission engine
    │   │   ├── workflow/engine.ts     event-driven workflow execution
    │   │   ├── workflow/tasks.ts      14 task types
    │   │   ├── workflow/scheduler.ts  queue drain + scheduled workflows + housekeeping
    │   │   └── analytics/widgets.ts   widget + report query engine
    │   ├── db/
    │   │   ├── pool.ts         ★★ query/transaction + onCommit() after-commit hook
    │   │   ├── migrate.ts      forward-only migration runner
    │   │   ├── migrations/     4 × .sql
    │   │   └── seed/           modules.ts (the data model), picklists, rbac, dashboards, automation, demo
    │   ├── api/routes/         auth, metadata, records, views, dashboards, admin, comms, telephony, ai, webhooks, misc
    │   ├── integrations/       whatsapp, telephony, email, leadsources
    │   ├── ai/                 client, leadScoring, matching, dealRisk, callAnalysis, drafting, assistant, actions
    │   ├── app.ts / index.ts / realtime.ts / config.ts
    └── web/src/
        ├── components/
        │   ├── FieldRenderer.tsx  ★★ FieldValue + FieldInput — the heart of the dynamic UI
        │   ├── RecordForm.tsx     layout-driven form with validation + duplicate detection
        │   ├── FilterBuilder.tsx  nested AND/OR builder
        │   ├── Layout.tsx         app shell, sidebar, global search, notifications
        │   └── ui.tsx             design-system primitives
        ├── lib/api.ts          ★ typed API client with token refresh
        ├── lib/store.ts        zustand app state + toasts
        └── pages/              Dashboard, ListView, RecordDetail, RecordEdit, Inbox, Calls,
                                InventoryBoard, Reports, Settings, Login, admin/*
```

★ = read before changing related behaviour · ★★ = highest-blast-radius files

---

## 7. Current unfinished task and exact current state

**There is no task in progress. The last requested work is complete and verified.**

Most recent session delivered two changes, both finished:
1. **Contacts merged into Leads** (migration 004 + seed + conversion + integrations + UI).
2. **Module enable/disable** (`Admin → Modules`, API, registry guard).

### Exact runtime state right now

| | |
|---|---|
| Postgres | Docker container `ipropy-db`, **up and healthy**, all 4 migrations applied |
| Dev servers | **Running** — `tsx watch` (API :4000) and `vite` (web :5173) |
| Build | Clean — all three packages typecheck and build |
| Tests | **63/63** full smoke + **25/25** merge & toggle verification passing |
| Demo data | Clean (304 records; test residue removed) |
| Git | **NOT a git repository — no version control initialised** (see §8) |
| AI | `ANTHROPIC_API_KEY` empty → rule-based fallback active |

Verification scripts live in the session scratchpad (**not** in the repo):
`/private/tmp/claude-501/-Users-rishabhsinghla-Downloads-vtigercrm/5b5172d8-d447-491d-94cd-3684b2d575ff/scratchpad/`
— `smoke.mjs` and `verify-merge.mjs`. **These will be lost when the temp dir is cleared** — see task 3
in §12.

---

## 8. Known bugs, risks and technical debt

### Bugs (real, currently present, not fixed)

1. **`globalSearch` applies one module's sharing scope to a cross-module search.**
   `core/entity/recordService.ts` → `globalSearch()` calls
   `recordScopeSql(ctx, modules[0].name, params)` and applies that single fragment to results from
   *all* modules. If modules have different org-wide defaults (they do — leads/deals are `private`,
   projects/properties are `public_read`), global search can under- or over-return. **Treat as a
   potential data-exposure issue.** Fix: scope per module and UNION, or filter post-query.

2. **`ipy_e_leads.converted_contact_id` is a dead column.** Migration 004 nulled it (verified: 0
   non-null) and it is no longer written, but the column and its hidden field metadata remain.

### Risks

3. **No version control.** The project is not a git repository. There is no history, no branches, no
   way to revert. **This is the single highest risk.** Initialise git before any further work.
4. **No automated test suite.** Verification is two hand-written `.mjs` smoke scripts that live in a
   temp directory and will vanish.
5. **Production hardening not done.** `JWT_SECRET` is the dev default (the server does refuse to boot
   in production with it). `WHATSAPP_APP_SECRET` is unset — webhook signature verification is skipped
   outside production. No TLS, no rate-limit tuning, no backups configured.
6. **Single-process scheduler.** `FOR UPDATE SKIP LOCKED` makes the queue multi-instance safe, but
   scheduled workflows scan up to 5,000 records per tick in-process — will not scale to large tenants.
7. **Secrets in `ipy_integration.credentials`** are stored as plain JSONB. Encrypt at rest before
   real credentials go in.

### Technical debt

8. **`ipy_e_contacts_archived_004`** (24 rows) retained deliberately for recovery. Drop once the merge
   is confirmed in production.
9. **Dashboard drag-to-resize not wired.** `saveDashboardLayout` exists in `lib/api.ts` and the server
   endpoint works, but **no page calls it** — the grid is responsive-only.
10. **Workflow builder is read-only in the UI.** Workflows are fully editable via API and seeded
    declaratively; the admin screen lists/inspects/enables/deletes but cannot compose a new one.
11. **Speech-to-text not bundled.** Call analysis needs a transcript from the provider or pasted in.
12. **Web bundle is ~1 MB** (198 KB gzipped) — no route-level code splitting yet.
13. **`is_converted` and `lifecycle_stage` overlap** post-merge. Both are maintained; consider
    collapsing to lifecycle alone.
14. **Redis is in `docker-compose.yml` but unused.** Either use it (caching/queue) or remove it.

---

## 9. Commands — start everything

### First-time setup

```bash
cd /Users/rishabhsinghla/Downloads/iPropy-crm
cp .env.example .env          # only if .env is missing
docker compose up -d db       # Postgres 16 on :5432
npm install
npm run setup                 # build shared → migrate → seed
```

### Daily start

```bash
docker compose up -d db       # if not already running
npm run dev                   # API :4000 + web :5173, both hot-reload
```

Open <http://localhost:5173>. Sign in `admin@ipropy.com` / `Admin@123`.

### Individually

```bash
npm run dev:server            # API only  (tsx watch, :4000)
npm run dev:web               # web only  (vite, :5173)
docker compose up -d db       # database
docker compose down           # stop containers (data persists in volume)
docker compose down -v        # stop AND DESTROY the database volume
```

### Database

```bash
npm run db:migrate            # apply pending migrations
npm run db:seed               # (re)seed metadata; demo data only if DB is empty
npm run db:reset              # DROP public schema, re-migrate, re-seed  ← destructive
docker exec -it ipropy-db psql -U ipropy -d ipropy    # psql shell
```

### Demo accounts (all password `Admin@123`)

| Email | Role | Demonstrates |
|---|---|---|
| `admin@ipropy.com` | Administrator | Full access, admin panel |
| `priya.sharma@ipropy.com` | Sales Head | Whole-org visibility via role hierarchy |
| `rahul.mehta@ipropy.com` | Sales Manager | Team-only visibility |
| `aisha.khan@ipropy.com` | Sales Executive | Own records only |
| `neha.gupta@ipropy.com` | Pre-Sales | Pricing fields hidden, Bookings blocked |
| `arjun.nair@ipropy.com` | CRM/Post-Sales | Bookings, payments, documentation |
| `sanjay.iyer@ipropy.com` | Finance | Collections, commissions |

---

## 10. Testing commands

**There is no automated test suite.** Current verification:

```bash
npm run typecheck             # all three packages — MUST be clean before committing
npm run build                 # full build incl. Vite production bundle

curl -s http://localhost:4000/api/health      # {"status":"ok","database":"connected",...}
```

Two smoke scripts (in the session scratchpad, **not in the repo** — see §7 for the path):

```bash
node <scratchpad>/smoke.mjs          # 63 checks: auth, metadata, list/kanban/filters, detail,
                                     # write path, inbox, telephony, inventory, reports, admin,
                                     # permission enforcement across 3 profiles
node <scratchpad>/verify-merge.mjs   # 25 checks: Contacts→Leads merge + module enable/disable
```

Both require the dev servers running (they hit `http://localhost:5173` through the Vite proxy).
**They write and delete real records** — run against dev only, and clean residue afterwards:

```sql
DELETE FROM ipy_record WHERE label LIKE 'Smoke Test%' OR label LIKE 'Merge Check%';
```

**Task 3 in §12 is to move these into the repo as a proper test suite.**

---

## 11. Deployment process

**Not yet deployed anywhere.** No Dockerfile for the app, no CI/CD. The intended process:

```bash
npm ci
npm run build                 # → packages/{shared,server,web}/dist
npm run db:migrate            # against the production DATABASE_URL
npm run db:seed               # metadata only — set SEED_DEMO_DATA=false first
node packages/server/dist/index.js
```

Serve `packages/web/dist` as static files (nginx/CDN), proxying `/api` and `/socket.io` to the Node
process.

**Pre-deployment checklist (none of these are done):**

- [ ] Set a strong `JWT_SECRET` — the server refuses to boot in production with the dev default
- [ ] Set `WHATSAPP_APP_SECRET` — signature verification is skipped without it outside production
- [ ] `SEED_DEMO_DATA=false`
- [ ] `NODE_ENV=production`
- [ ] TLS termination in front of the API
- [ ] `APP_URL` set to the real origin (CORS + Socket.IO allow-list read from it)
- [ ] Switch `STORAGE_DRIVER=s3` and configure the bucket (local disk won't survive a container)
- [ ] Managed Postgres with automated backups
- [ ] Encrypt `ipy_integration.credentials` at rest
- [ ] Decide scheduler ownership if running multiple instances (`ENABLE_SCHEDULER`)

---

## 12. Next 20 tasks, in priority order

### Do these before anything else

1. **Initialise git and make an initial commit.** No version control exists — there is currently no
   way to revert a mistake. `git init && git add -A && git commit`.
2. **Fix the `globalSearch` permission-scoping bug** (§8.1). Potential data exposure.
3. **Move the two smoke scripts into the repo** (`packages/server/test/`) and wire `npm test`. They
   live in a temp directory and will be lost.

### Correctness and safety

4. Add a real test framework (Vitest) with unit coverage for the highest-risk pure logic:
   `query/builder`, `query/evaluate`, `entity/formula`, `permissions`.
5. Production-harden secrets: strong `JWT_SECRET`, set `WHATSAPP_APP_SECRET`, encrypt
   `ipy_integration.credentials` at rest.
6. Remove the dead `converted_contact_id` column and its field metadata (migration 005).
7. Add DB backup + restore runbook; verify a restore actually works.

### Finish partially-built features

8. Wire dashboard drag-to-resize to the existing `saveDashboardLayout` endpoint.
9. Build the visual workflow builder (create/edit) — currently read-only in the UI.
10. Add speech-to-text so call analysis runs without a manual transcript.
11. Add the many-to-many related-list "select existing record" UI (API already supports it).
12. Build the Channel Partner portal (restricted profile exists and is seeded; no portal UI).

### Deployment and operations

13. Write a Dockerfile + docker-compose for the full app; set up CI (typecheck → build → test).
14. Add structured error reporting (Sentry or equivalent) and request tracing.
15. Move the scheduler to a dedicated worker process/queue so it scales past one instance.

### Product depth

16. Route-level code splitting to cut the ~1 MB web bundle.
17. Mobile-responsive pass on ListView, RecordDetail and the Inventory board.
18. Email inbound (IMAP) sync into the timeline — outbound works, inbound does not.
19. Rollup fields (`uitype: 'rollup'` is declared and typed but the aggregation engine is not
    implemented — currently a no-op).
20. Collapse `is_converted` into `lifecycle_stage` and simplify conversion logic (§8.13).

---

## 13. What a new session must know

Read this before touching anything.

### Non-negotiables

1. **This is not a git repository.** There is no undo. Initialise git first, or be extremely careful.
2. **Never add a per-module CRUD path.** Everything goes through `core/entity/recordService.ts`.
   If a module needs different behaviour, express it as metadata or a workflow hook.
3. **Never emit a domain event inside an open transaction.** Use `onCommit(conn, fn)` from
   `db/pool.ts`. Emitting inline deadlocks: a workflow task updating the same row runs on a different
   pooled connection and blocks on the uncommitted row lock. **This bug was hit during development
   and is the reason the after-commit queue exists.**
4. **Call `registry.invalidate()` (and `invalidatePermissions()`) after any metadata write.**
   The metadata registry is an in-memory cache read on nearly every request. `invalidateAll()` in
   `api/routes/metadata.ts` does both.
5. **Field-level permissions must be enforced on data, not just metadata.** `getRecord`/`listRecords`
   call `stripHidden()`. A regression here leaks data — it happened once already.
6. **Never build SQL from user-supplied identifiers.** Field references resolve through metadata
   (`resolveFieldPath`), and `quoteIdent()` rejects anything outside `[A-Za-z_][A-Za-z0-9_]*`.
7. **`ANTHROPIC_API_KEY` is empty.** Every AI feature must keep working without it — the rule engines
   are the fallback, not a stub. Do not write AI code that throws when the key is missing.

### Postgres gotchas that already bit this codebase

* **Unused bound parameters break queries.** `UPDATE ... SET a=$3 WHERE id=$4` with 4 params where
  `$1`/`$2` are never referenced fails with `could not determine data type of parameter $1`. This
  occurred three separate times (seed helpers, workflow seed, conversion re-parenting). Always bind
  exactly what the statement references.
* **Empty arrays must not become NULL.** The `*_locations` / `configuration` style columns are
  `jsonb NOT NULL DEFAULT '[]'`. `coerceValue` special-cases empty arrays for
  `multipicklist`/`multireference`/`tags` — don't "simplify" that away.

### Conventions

* Seeding is **idempotent** — re-run `npm run db:seed` after changing `db/seed/modules.ts` to refresh
  metadata without touching tenant data. Demo records are only created when the DB has none.
* `db/seed/modules.ts` is the source of truth for the seeded data model. Adding a field there is the
  normal way to extend a module.
* System views/layouts/workflows are marked `is_system` and are pruned/refreshed on re-seed; user
  content is never touched.
* Comments explain **why**, not what. Match the surrounding density.
* British spelling in user-facing copy ("Organisation", "customise").
* Indian real-estate domain: lakhs/crores, carpet vs super built-up area, RERA, Vastu, channel
  partners, token → agreement → registration.

### Fast orientation

To understand the system quickly, read in this order:

```
packages/shared/src/uitypes.ts            the vocabulary
packages/server/src/core/entity/recordService.ts   the engine
packages/server/src/core/query/builder.ts          how filters become SQL
packages/server/src/core/permissions/index.ts      how access is decided
packages/server/src/db/seed/modules.ts             the real-estate data model
packages/web/src/components/FieldRenderer.tsx      how metadata becomes UI
```
