# iPropy CRM — Project Handover

**Last updated:** 7 August 2026
**Status:** Feature-complete build, verified end-to-end. **This session:** Vitest unit suite (107 tests),
dead `converted_contact_id` column removed (migration 006), and **dashboard drag-to-resize wired**. No work in progress.
**Location:** `/Users/rishabhsinghla/Downloads/iPropy-crm`
**Git:** initialised, pushed to `origin/main` (`https://github.com/RishabhSinghla/ipropy-crm.git`).
Latest commit `01ce186`. Working tree clean.

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
| Admin panel | Module enable/disable, field builder, layout designer, dropdowns, users, roles, profiles, sharing, **field permissions per profile**, workflows (**full create/edit composer**), **integrations (editable in-UI, encrypted credentials)**, import, audit |
| AI | Lead scoring, property matching, deal risk, call analysis, drafting, "Ask your CRM" NL→query |
| Permissions | 4-layer: profile → org default → role hierarchy → sharing rules/per-record shares. Enforced in SQL, **including per-field hidden/readonly, with a UI to set it.** |
| Realtime | Socket.IO client now actually connected — record edits, workflow/AI writes and metadata changes push live to every open screen, no refresh needed |
| Record navigation | Prev/next via on-screen buttons or ← → keys through whatever list you last viewed, on every module |
| Inline quick-edit | Click any picklist or owner field (status, pipeline stage, rating, assigned-to) on a list, kanban card or record header to change it without opening the edit form |
| Dashboard drill-through | Every widget type (metric, gauge, bar, line, area, pie, donut, funnel, stacked, table) clicks through to a correctly pre-filtered record list |

**Verified live metrics (current database):**
77 tables · 12 modules · 430 fields · 54 picklists · 54 views · 36 layouts · 17 workflows ·
5 dashboards / 39 widgets · 16 roles · 9 profiles · 10 users · ~305 demo records.
6 migrations applied. Codebase has grown by ~10 files / ~2,800 lines this session (see §7).

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

### Migrations applied (all six, verified in `ipy_migration`)

| Migration | Applied | What it does |
|---|---|---|
| `001_core.sql` | 2026-08-06 13:35 | Metadata engine (`ipy_module`/`block`/`field`/`picklist`/`relation`), identity (`ipy_user`/`role`/`profile`/`group`/`session`), `ipy_record` base table + tsvector search, permissions, views, layouts, dashboards, audit/comments/attachments/tags/notifications, settings |
| `002_entities.sql` | 2026-08-06 13:35 | Real-estate payload tables: organizations, contacts, leads, projects, properties, deals, site_visits, bookings, payments, channel_partners, campaigns, activities, documents |
| `003_automation_comms_ai.sql` | 2026-08-06 13:35 | Workflow engine + task queue + logs, assignment rules, SLA, conversations/messages/templates, email log, calls + virtual numbers, AI insights/logs/threads, integrations, webforms, lead inbox, webhooks, API keys, import jobs, reports, targets |
| `004_merge_contacts_into_leads.sql` | 2026-08-06 16:30 | **Merged Contacts into Leads** (see below) + added module enable/disable columns (`disabled_reason`, `disabled_at`, `disabled_by`, `is_core`) |
| `005_integration_settings.sql` | 2026-08-07 | Added the `webform` provider row to `ipy_integration` so the generic web-form capture key is editable from the admin UI like every other credential, not `.env`-only |
| `006_remove_converted_contact_id.sql` | 2026-08-07 | Dropped the dead `ipy_e_leads.converted_contact_id` column and deleted its field metadata (no nulls, no indexes, no views/workflows/dashboards/reports references) |

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

**As of this session, every integration credential is also editable from Admin → Integrations →
Providers — `.env` is no longer the only way to configure them.** `core/settings/integrations.ts` is
the resolver: it reads `ipy_integration.config`/`credentials` first and falls back to the matching
`.env` variable below only when no DB value is set. Credentials are encrypted at rest (AES-256-GCM,
key derived from `JWT_SECRET` via scrypt — no new required env var). Saving a credential through the
UI auto-activates that provider; a per-provider "Test connection" button does a real, read-only
connectivity probe (WhatsApp/Twilio/Exotel/SMTP/Anthropic).

| Variable | Purpose | Current state |
|---|---|---|
| `DATABASE_URL` | Postgres connection | Set — Docker local |
| `JWT_SECRET` | Token signing | **Dev default. Server refuses to start in production with it.** Also the source key for integration-credential encryption. |
| `ANTHROPIC_API_KEY` | Claude | **Empty → AI runs rule-based fallback**. Also settable via Admin → Integrations → Anthropic. |
| `AI_MODEL` / `AI_MODEL_FAST` | Model selection | `claude-sonnet-5` / `claude-haiku-4-5-20251001` |
| `WHATSAPP_*` | Meta Cloud API (phone id, token, verify token, **app secret**) | Empty → simulation mode. Editable in-UI. |
| `TELEPHONY_PROVIDER` + `TWILIO_*` / `EXOTEL_*` | Voice | `none` → logs only. Editable in-UI (provider auto-selected from whichever of Twilio/Exotel is active). |
| `SMTP_*` / `IMAP_*` | Email | Empty → logged with open tracking. Editable in-UI. |
| `FACEBOOK_*`, `GOOGLE_ADS_WEBHOOK_KEY`, `WEBFORM_PUBLIC_KEY` | Lead capture | Endpoints live, no traffic. Editable in-UI (migration 005 added the `webform` provider row). |
| `STORAGE_DRIVER` + `S3_*` | Files | `local` → `./storage`. **Not yet moved into the DB-backed settings — still `.env` only.** |
| `ENABLE_SCHEDULER`, `SCHEDULER_TICK_SECONDS` | Background jobs | `true`, 60s |
| `SEED_DEMO_DATA` | Demo records on seed | `true` — **set `false` for production** |

**Every integration degrades gracefully.** With nothing configured (env or UI) the whole product is
demoable: messages and calls are recorded in the CRM and marked sent, so workflows stay testable.

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
    │   │   ├── analytics/widgets.ts   widget + report query engine — client drill-through reads
    │   │   │                          WidgetConfig straight off this (module/groupBy/filter/dateField)
    │   │   └── settings/integrations.ts ★ DB-first, env-fallback resolver for every integration
    │   │                          credential. AES-256-GCM at rest, key derived from JWT_SECRET.
    │   │                          Synchronous getSettings() snapshot, reloaded on admin save.
    │   ├── db/
    │   │   ├── pool.ts         ★★ query/transaction + onCommit() after-commit hook
    │   │   ├── migrate.ts      forward-only migration runner
    │   │   ├── migrations/     6 × .sql
    │   │   └── seed/           modules.ts (the data model), picklists, rbac, dashboards, automation, demo
    │   ├── api/routes/         auth, metadata, records, views, dashboards, admin, comms, telephony, ai, webhooks, misc
    │   ├── integrations/       whatsapp, telephony, email, leadsources — all resolve credentials via
    │   │                       core/settings/integrations.ts now, not process.env directly
    │   ├── ai/                 client, leadScoring, matching, dealRisk, callAnalysis, drafting, assistant, actions
    │   ├── app.ts / index.ts / realtime.ts / config.ts
    └── web/src/
        ├── components/
        │   ├── FieldRenderer.tsx  ★★ FieldValue + FieldInput + QuickEditField/isQuickEditable —
        │   │                        the heart of the dynamic UI, including inline click-to-edit
        │   ├── RecordForm.tsx     layout-driven form with validation + duplicate detection
        │   ├── FilterBuilder.tsx  nested AND/OR builder — also what dashboard drill-through renders
        │   ├── Layout.tsx         app shell, sidebar, global search, notifications, useRealtime() mount
        │   └── ui.tsx             design-system primitives (Modal now sets role="dialog"; Toggle fixed)
        ├── lib/api.ts          ★ typed API client with token refresh
        ├── lib/store.ts        zustand app state + toasts
        ├── lib/realtime.ts     ★ Socket.IO client — useRealtime() (app-wide) / useWatchRecord() (per record)
        ├── lib/invalidate.ts   ★ shared invalidateRecordQueries()/invalidateMetadataQueries() — call
        │                        after every write instead of hand-picking query keys
        ├── lib/listNav.ts      sessionStorage-backed id order for RecordDetail's prev/next nav
        └── pages/              Dashboard (★ drill-through helpers), ListView, RecordDetail (★ prev/next
                                + quick-edit), RecordEdit, Inbox, Calls, InventoryBoard, Reports,
                                Settings, Login, admin/* (★ WorkflowAdmin composer, IntegrationsAdmin,
                                RolesProfiles field-permissions card)
```

★ = read before changing related behaviour · ★★ = highest-blast-radius files

---

## 7. Current unfinished task and exact current state

**There is no task in progress. The last requested work is complete, verified live, and pushed.**

### This session's work (7 August 2026)

The user reported the enable/disable toggle looked broken, then asked for a batch of fixes and
features. All ten items shipped, each verified against the running app (not just typechecked) before
committing:

1. **Fixed module re-enable permanently hiding the module from the sidebar.** The toggle handler
   clobbered `show_in_menu` on disable and never restored it on re-enable; nav already filters on
   `is_active` alone, so the clobber was redundant *and* the bug. Two already-corrupted rows
   (`organizations`, `campaigns`) repaired live.
2. **Fixed the `globalSearch` cross-module permission leak from §8 below** — it's gone, see §8 bugs
   for what was verified.
3. **Moved every integration credential into the admin UI** (`core/settings/integrations.ts` +
   `IntegrationsAdmin.tsx`). See §4.
4. **Fixed stale UI requiring a manual refresh.** The Socket.IO *client* had never been written —
   `socket.io-client` was an installed, unused dependency. Added `lib/realtime.ts`, mounted it in
   `Layout.tsx`, and added a `module:changed` broadcast server-side for writes that previously only
   notified the single record's own room (list/kanban views were never told anything changed).
   Centralised invalidation into `lib/invalidate.ts` and fixed `RecordEdit`/`RecordForm`, which
   previously saved and navigated **without invalidating any query** — the page you landed on after
   saving showed the pre-edit data until a manual reload.
5. **Fixed field hide/unhide** — three separate bugs: (a) no "unhide" existed anywhere despite the
   confirm dialog promising "you can re-enable it later"; (b) a hidden field's metadata (label,
   uitype, config) still leaked via the describe endpoint even though its *value* was correctly
   stripped; (c) the standard per-profile field permission UI (editable/readonly/hidden) didn't exist
   at all — added to Roles & Profiles.
6. **Fixed the Toggle switch component app-wide.** Root cause: the thumb `<span>` had no explicit
   `left`, and Tailwind Preflight sets `text-align:center` on every `<button>`; for an absolutely
   positioned empty inline element that resolves its static position to the button's centre, so the
   translate-x stacked on a bogus 18px offset and the thumb rendered outside the pill when checked.
   One shared-component fix, visible everywhere immediately.
7. **Built the workflow create/edit composer** — trigger, conditions (reuses `FilterBuilder`), all 14
   task types with structured fields, scheduling, per-task delay. Previously read-only in the UI
   despite the engine and API fully supporting it.
8. **Prev/next record navigation** — arrow keys and on-screen buttons, generic across every module,
   via `lib/listNav.ts` + `RecordDetail.tsx`.
9. **Inline quick-edit** for picklist/owner fields (status, pipeline stage, rating, assigned-to) on
   list tables, kanban cards and record headers — `FieldRenderer.tsx`'s `QuickEditField`, generic by
   uitype, not hardcoded to any module.
10. **Dashboard drill-through** — every widget type now clicks through to a correctly pre-filtered
    record list, including two-dimension filters on the stacked inventory widget. `ListView.tsx`
    gained the ability to seed its filter from a `?filter=` URL param, which didn't exist before.
11. **Brought in the test framework** — Vitest (`npm test`), with 107 unit tests over the four
    highest-risk pure-logic modules: `query/builder` (operator SQL, column vs json storage,
    identifier hardening, cross-module reference joins), `query/evaluate` (operator parity with the
    SQL engine), `entity/formula` (grammar, functions, real-estate helpers, error handling) and
    `permissions` (module/field/record scoping, sharing rules, admin short-circuits — DB and metadata
    registry stubbed, no Postgres needed). Tests live in `packages/server/tests/`, outside `src/`, so
    they never compile into the server build.
12. **Removed the dead `converted_contact_id` column** (migration 006). Pre-flight verified 0 non-null
    values, no index, no references in views/workflows/dashboards/reports/field permissions; dropped
    the column and its field metadata. Verified live after a server reload: describe no longer lists
    the field (77 fields), list and lookup still work.
13. **Wired dashboard drag-to-resize (and drag-to-rearrange).** The dashboard grid was responsive-only
    and the persisted layout (x/y/w/h per widget) was never editable or even rendered by position.
    Now on desktop (≥1024 px) the grid renders widgets at their stored positions via
    `react-grid-layout` and persists drags/resizes through the existing `saveDashboardLayout` endpoint
    (one round trip, server already supported it). Editing is gated on `canEdit`, drags start only off
    interactive elements (links/buttons), and below lg the page keeps its responsive auto-flow grid.
    Verified live: swapped two widgets through the layout API and confirmed the round trip.

**Also done as part of this work, not separately requested:** `git init`, an initial commit, then 11
more commits, and `git push` to `origin/main`. Version control — previously the #1 listed risk in
this document — now exists.

### Exact runtime state right now

| | |
|---|---|
| Postgres | Docker container `ipropy-db`, **up and healthy**, all 6 migrations applied |
| Dev servers | **Running** — `tsx watch` (API :4000) and `vite` (web :5173) |
| Build | Clean — all three packages typecheck and build |
| Tests | **Vitest added this session** — 107 unit tests pass via `npm test` (no DB needed); feature work still verified live |
| Demo data | Clean — all test records/workflows/credentials created during verification were deleted or reverted afterward |
| Git | **Initialised, pushed to `origin/main`.** Latest commit `01ce186`. Working tree clean. |
| AI | `ANTHROPIC_API_KEY` empty → rule-based fallback active (also configurable now via Admin → Integrations) |

---

## 8. Known bugs, risks and technical debt

### Fixed this session (kept here so the history isn't lost, not because they're still open)

* ~~`globalSearch` applies one module's sharing scope to a cross-module search.~~ **Fixed.** Each
  allowed module is now scoped independently in `recordService.ts::globalSearch()` and the branches
  are ORed together. Verified live: flipping `leads` to `public_read` grew a restricted user's lead
  results 7→20 while `deals` and `site_visits` (still `private`) stayed unchanged — under the old code
  they would have leaked to admin-level counts.
* ~~No version control.~~ **Resolved.** Git initialised, pushed to `origin/main`.
* ~~Secrets in `ipy_integration.credentials` stored as plain JSONB.~~ **Resolved.** Now AES-256-GCM
  encrypted at rest (see §4). `S3_*` storage config was **not** moved into this system — still `.env` only.
* ~~Workflow builder is read-only in the UI.~~ **Resolved.** Full create/edit composer shipped this
  session (see §7).
* ~~No automated test suite.~~ **Resolved.** Vitest is in the repo — 107 unit tests across the query
  builder, filter evaluator, formula engine and permission engine (see §10). The highest-risk pure
  logic now has repeatable coverage; the write/API paths and UI still rely on live verification.
* ~~Dashboard drag-to-resize not wired.~~ **Resolved.** The grid now renders widgets at their stored
  x/y/w/h via `react-grid-layout` on desktop and persists drags/resizes through the existing
  `saveDashboardLayout` endpoint (see §7).

### Bugs (real, currently present, not fixed)

None open. (Migration 006 removed the dead `converted_contact_id` column and its field metadata this
session — the sole real bug is gone.)

### Risks

1. **Production hardening not done.** `JWT_SECRET` is the dev default (the server does refuse to boot
   in production with it) — **and now also derives the integration-credential encryption key**, so
   rotating it in production will require re-entering every credential saved via the admin UI.
   `WHATSAPP_APP_SECRET` is unset — webhook signature verification is skipped outside production. No
   TLS, no rate-limit tuning, no backups configured.
2. **Single-process scheduler.** `FOR UPDATE SKIP LOCKED` makes the queue multi-instance safe, but
   scheduled workflows scan up to 5,000 records per tick in-process — will not scale to large tenants.

### Technical debt

3. **`ipy_e_contacts_archived_004`** (24 rows) retained deliberately for recovery. Drop once the merge
   is confirmed in production.
4. **Speech-to-text not bundled.** Call analysis needs a transcript from the provider or pasted in.
5. **Web bundle is ~1.2 MB** (~244 KB gzipped, grew this session with the workflow composer, dashboard
   drill-through and now `react-grid-layout`) — no route-level code splitting yet.
6. **`is_converted` and `lifecycle_stage` overlap** post-merge. Both are maintained; consider
   collapsing to lifecycle alone.
7. **Redis is in `docker-compose.yml` but unused.** Either use it (caching/queue) or remove it.
8. **`S3_*` storage config was not moved into the DB-backed integration settings** added this
   session — still `.env`-only, inconsistent with every other integration.
9. **Funnel widget drill-through uses `equals` on the clicked stage**, not the cumulative "reached
   this stage or later" semantics the funnel's own numbers represent (a funnel counts a lead as
   having reached every earlier stage too). Correct behaviour would need the server to also return
   the ordered stage-key list so the client can build an `in` filter; scoped out as beyond "make it
   clickable".

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

**Vitest is in the repo.** `packages/server/tests/` holds 107 unit tests over the highest-risk pure
logic — `query/builder`, `query/evaluate`, `entity/formula` and `permissions` (the DB and metadata
registry are stubbed; no Postgres needed). The smoke scripts (`smoke.mjs`, `verify-merge.mjs`)
referenced by older handovers lived in a session scratchpad and were never recovered — do not assume
they still exist.

```bash
npm test                      # vitest run — 107 tests, no DB required
npm run typecheck             # all three packages — MUST be clean before committing
npm run build                 # full build incl. Vite production bundle

curl -s http://localhost:4000/api/health      # {"status":"ok","database":"connected",...}
```

Write/API flows, permissions end-to-end and the UI still have no automated coverage — those are
verified live (real API calls and browser interaction), with any test data reverted afterward.

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
- [x] ~~Encrypt `ipy_integration.credentials` at rest~~ — done this session (AES-256-GCM, key from `JWT_SECRET`)
- [ ] Decide scheduler ownership if running multiple instances (`ENABLE_SCHEDULER`)

---

## 12. Next tasks, in priority order

Everything that was on this list and got done this session (git init, the `globalSearch` fix, secrets
encryption, the workflow builder, stale-UI/realtime, module toggle, field hide/unhide, Toggle CSS,
record navigation, quick-edit, dashboard drill-through, the Vitest unit suite, removal of the dead
`converted_contact_id` column, dashboard drag-to-resize) has been removed. What's left:

### Correctness and safety

1. Production-harden secrets: strong `JWT_SECRET` for production, set `WHATSAPP_APP_SECRET`. Note
   `JWT_SECRET` now also derives the integration-credential encryption key (§8 risk 1) — rotating it
   means re-entering every credential saved via Admin → Integrations.
2. Add DB backup + restore runbook; verify a restore actually works.
3. Move `S3_*` storage config into the DB-backed integration settings for consistency with every
   other integration (§8 technical debt 8) — currently the one credential still `.env`-only.

### Finish partially-built features

4. Add speech-to-text so call analysis runs without a manual transcript.
5. Add the many-to-many related-list "select existing record" UI (API already supports it).
6. Build the Channel Partner portal (restricted profile exists and is seeded; no portal UI).
7. Make funnel-widget drill-through use the funnel's actual cumulative "reached this stage or
   later" semantics instead of `equals` on the single stage (§8 technical debt 9) — needs the
   server to also return the ordered stage-key list.

### Deployment and operations

8. Write a Dockerfile + docker-compose for the full app; set up CI (typecheck → build → test).
9. Add structured error reporting (Sentry or equivalent) and request tracing.
10. Move the scheduler to a dedicated worker process/queue so it scales past one instance.

### Product depth

11. Route-level code splitting — the web bundle is now ~1.2 MB / ~244 KB gzipped, having grown with
    the workflow composer, dashboard drill-through and `react-grid-layout` this session.
12. Mobile-responsive pass on ListView, RecordDetail and the Inventory board.
13. Email inbound (IMAP) sync into the timeline — outbound works, inbound does not. Credentials are
    now configurable via Admin → Integrations; the sync itself still isn't built.
14. Rollup fields (`uitype: 'rollup'` is declared and typed but the aggregation engine is not
    implemented — currently a no-op).
15. Collapse `is_converted` into `lifecycle_stage` and simplify conversion logic (§8 technical debt 6).

---

## 13. What a new session must know

Read this before touching anything.

### Non-negotiables

1. **Git exists now — use it properly.** Initialised and pushed to `origin/main` this session.
   Create real commits for real changes; don't let this regress back into an uncommitted pile.
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
   call `stripHidden()`. A regression here leaks data — it happened once already, and the *describe*
   endpoint leaking a hidden field's metadata (not its value) was a second, separate instance of the
   same failure class, fixed this session (§7 item 5b).
6. **Never build SQL from user-supplied identifiers.** Field references resolve through metadata
   (`resolveFieldPath`), and `quoteIdent()` rejects anything outside `[A-Za-z_][A-Za-z0-9_]*`.
7. **`ANTHROPIC_API_KEY` is empty.** Every AI feature must keep working without it — the rule engines
   are the fallback, not a stub. Do not write AI code that throws when the key is missing. It's also
   now settable via Admin → Integrations, resolved through `core/settings/integrations.ts` — read
   credentials through `getSettings()`, never `process.env` directly, for any integration.
8. **After any write anywhere in the web app, call `invalidateRecordQueries()` /
   `invalidateMetadataQueries()` from `lib/invalidate.ts`.** Don't hand-pick query keys to invalidate
   — `RecordForm`'s save path used to invalidate nothing at all, which is why edits looked like they
   needed a manual refresh (§7 item 4). The realtime socket (`lib/realtime.ts`) also depends on the
   server actually broadcasting `record.deleted`/`record.restored`/`record.owner_changed`, not just
   `record.updated`/`record.created` — check `realtime.ts`'s `wireEvents()` if a new mutation type
   needs to show up live elsewhere.

### Postgres gotchas that already bit this codebase

* **Unused bound parameters break queries.** `UPDATE ... SET a=$3 WHERE id=$4` with 4 params where
  `$1`/`$2` are never referenced fails with `could not determine data type of parameter $1`. This
  occurred three separate times (seed helpers, workflow seed, conversion re-parenting). Always bind
  exactly what the statement references.
* **Empty arrays must not become NULL.** The `*_locations` / `configuration` style columns are
  `jsonb NOT NULL DEFAULT '[]'`. `coerceValue` special-cases empty arrays for
  `multipicklist`/`multireference`/`tags` — don't "simplify" that away.

### Frontend gotchas that already bit this codebase

* **Absolutely-positioned elements inside a `<button>` need an explicit inset.** Tailwind Preflight
  sets `text-align: center` on every `<button>`. An absolutely-positioned child with no explicit
  `left`/`right` resolves its static position to the button's *centre*, not its edge — this silently
  broke the Toggle component's thumb (§7 item 6) app-wide, in a way that "looked slightly off" rather
  than obviously broken. Always pin `left-*`/`top-*` explicitly on absolutely-positioned children of
  a button; never rely on default static position inside one.
* **`Modal` (`components/ui.tsx`) sets `role="dialog"` now — it didn't before.** If code needs to
  detect "is a modal currently open" (e.g. to suppress a global keyboard shortcut), that's the
  reliable selector (`document.querySelector('[role="dialog"]')`); it was silently absent before this
  session, so any prior such check would never have matched.
* **Dashboard widgets carry everything needed for drill-through already.** `WidgetConfig` (module,
  groupBy, filter, dateField, interval, stackBy) rides along on every `DashboardWidget`, and every
  `series`/`stage`/`segment` item's `key` is the *raw* stored field value (picklist value, or a UUID
  for reference/owner/user groupings), not its display label — safe to drop straight into a
  `FilterCondition.value`. Building a new widget type that should drill through needs no new API;
  see `Dashboard.tsx`'s `withCondition`/`drillPath`/`bucketRange` helpers.
* **Recharts `dot`/`activeDot` don't forward arbitrary extra props.** A per-point click handler on a
  `Line`/`Area` has to be a function/component that closes over the handler in its own scope
  (`Dashboard.tsx`'s `clickableDot`), not a prop passed through the chart's own API.

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
