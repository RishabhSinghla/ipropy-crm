# iPropy CRM — Project Handover

**Last updated:** 7 August 2026
**Status:** Feature-complete build, verified end-to-end. **This session:** Channel Partner portal built (migration 009), DB backup/restore runbook added and verified, Vitest unit suite (107 tests), production hardening (JWT_SECRET/WHATSAPP_APP_SECRET generated, launchd timer installed); then a public, unauthenticated read API (`/api/public/*`) added for a new sibling customer-facing website — see §14. No work in progress.
**Location:** `/Users/rishabhsinghla/Downloads/iPropy-crm`
**Git:** initialised, pushed to `origin/main` (`https://github.com/RishabhSinghla/ipropy-crm.git`).
Latest commit `086e2bc`. Working tree clean.

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
| Dashboard drill-through | Every widget type (metric, gauge, bar, line, area, pie, donut, funnel, stacked, table) clicks through to a correctly pre-filtered record list; funnel uses cumulative stage semantics, filter panel stays closed on arrival |

**Verified live metrics (current database):**
91 tables · 3 modules · 160 fields · 58 picklists · 17 views · 9 layouts · 7 workflows ·
5 dashboards / 23 widgets · 17 roles · 9 profiles · 13 users · 254 records.
32 migrations applied. Backup/restore runbook verified (dump restores to a scratch DB with identical
counts). The module count falls rather than rises on purpose — see §5.

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

### Migrations applied (all nine, verified in `ipy_migration`)

| Migration | Applied | What it does |
|---|---|---|
| `001_core.sql` | 2026-08-06 13:35 | Metadata engine (`ipy_module`/`block`/`field`/`picklist`/`relation`), identity (`ipy_user`/`role`/`profile`/`group`/`session`), `ipy_record` base table + tsvector search, permissions, views, layouts, dashboards, audit/comments/attachments/tags/notifications, settings |
| `002_entities.sql` | 2026-08-06 13:35 | Real-estate payload tables: organizations, contacts, leads, projects, properties, deals, site_visits, bookings, payments, channel_partners, campaigns, activities, documents |
| `003_automation_comms_ai.sql` | 2026-08-06 13:35 | Workflow engine + task queue + logs, assignment rules, SLA, conversations/messages/templates, email log, calls + virtual numbers, AI insights/logs/threads, integrations, webforms, lead inbox, webhooks, API keys, import jobs, reports, targets |
| `004_merge_contacts_into_leads.sql` | 2026-08-06 16:30 | **Merged Contacts into Leads** (see below) + added module enable/disable columns (`disabled_reason`, `disabled_at`, `disabled_by`, `is_core`) |
| `005_integration_settings.sql` | 2026-08-07 | Added the `webform` provider row to `ipy_integration` so the generic web-form capture key is editable from the admin UI like every other credential, not `.env`-only |
| `006_remove_converted_contact_id.sql` | 2026-08-07 | Dropped the dead `ipy_e_leads.converted_contact_id` column and deleted its field metadata (no nulls, no indexes, no views/workflows/dashboards/reports references) |
| `007_dashboard_drag_resize.sql` | 2026-08-07 | Added dashboard drag-to-resize persistence (widget x/y/w/h layout storage) |
| `008_inbound_email_threading.sql` | 2026-08-07 | Unique index on `ipy_email_log.provider_id` for idempotent inbound email sync |
| `009_portal_user_link.sql` | 2026-08-07 | Added `channel_partner_id` to `ipy_user` linking portal users to their channel_partners record (enables Channel Partner portal) |

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
| `STORAGE_DRIVER` + `S3_*` | Files | `local` → `./storage`. Moved into the DB-backed settings — `local` is the fallback, S3 is editable in Admin → Integrations. |
| `ENABLE_SCHEDULER`, `SCHEDULER_TICK_SECONDS` | Background jobs | `true`, 60s |
| `SEED_DEMO_DATA` | Demo records on seed | `true` — **set `false` for production** |

**Every integration degrades gracefully.** With nothing configured (env or UI) the whole product is
demoable: messages and calls are recorded in the CRM and marked sent, so workflows stay testable.

Webhook URLs to hand to providers are listed in-app at **Admin → Integrations → Webhook URLs**
(WhatsApp, Facebook Lead Ads, Google Ads, 99acres, MagicBricks, Housing, NoBroker, Twilio, Exotel,
generic lead capture, email open pixel).

---

## 5. Modules

Three, all seeded and fully editable at runtime. The count has come down twice
on purpose: migration `030` removed eight modules, `031` removed the last two
that were only reachable from inside another record.

| Module | Group | Notes |
|---|---|---|
| **Leads & Contacts** | Sales | **Core.** The single party record; lifecycle Lead→Prospect→Customer→Past Customer. Carries the requirement, the follow-up date, calls, notes and timeline. |
| Properties | Inventory | Units. Full pricing breakdown, formula-computed all-inclusive price. Each carries its development's name (`project_name`) as text. |
| Campaigns | Marketing | Spend, attribution keys, formula-computed CPL and ROI. |

**Core modules** (`is_core = true`): `leads`. It cannot be disabled — the rest of
the CRM reads from it.

**What the removed modules became**

| Was | Now |
|---|---|
| Projects | `properties.project_name`, plus `leads.interested_project` as free text. The public website's `/api/public/projects` aggregates units by name, so its pages, sitemap and structured data still work. |
| Activities | A follow-up date on the lead (`next_followup_at`), a note on its timeline and a notification. One definition, `core/workflow/followUp.ts`. |
| Site Visits | Nothing. They were folded into Activities by `030` and went with it. The lead score no longer has a site-visit input — see §17.3. |
| Deals, Bookings, Payments, Organisations, Channel Partners, Documents, Blog | Removed in `030`. |

---

## 6. Important files and folders

```
iPropy-crm/
├── PROJECT_HANDOVER.md         ← this file
├── CLAUDE.md                   ← permanent instructions for AI sessions
├── README.md                   ← product/setup docs
├── docker-compose.yml          ← Postgres 16 (+ app/worker behind the 'app' profile)
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
        │   ├── FieldRenderer.tsx  ★★ FieldValue + FieldInput — the heart of the dynamic UI, every
        │   │                        list/detail/form screen renders fields through these two
        │   ├── EditableField.tsx  ★★ universal inline editing — click any field's value anywhere
        │   │                        (list cells, kanban cards, record detail) to change it in place,
        │   │                        no separate edit screen. isInlineEditable() gates by uitype.
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
14. **DB backup + restore runbook** (scripts `db-backup.sh`, `db-restore.sh`, `db-verify-restore.sh`;
    npm `db:backup` / `db:restore` / `db:backup:verify`). Verified end-to-end: a fresh dump restored
    into a throwaway database matched live counts exactly (`ipy_migration` 6, `ipy_user` 10,
    `ipy_record` 306, `ipy_module` 12, `ipy_field` 429) and the scratch DB was dropped — live data
    untouched.
15. **Fixed dashboard drill-through opening the filter panel.** `ListView` auto-opened the filter
    builder whenever a `?filter=` param was present (`setShowFilters(countConditions(seeded) > 0)`),
    so every widget click landed on a filter screen. The filter stays applied; the panel no longer
    pops open on arrival.
16. **Funnel drill-through now uses the funnel's cumulative semantics.** A funnel's per-stage number
    counts records that *reached that stage or later*; clicking a stage filtered to that single stage
    instead (`equals`). The server now returns the ordered stage keys (`keys`) and the client builds
    an `in` filter for every key from the clicked stage onward. Verified live: clicking "Revisit"
    (cumulative 17) drills to 17 deals — the old `equals` returned 4.

**Also done as part of this work, not separately requested:** `git init`, an initial commit, then 12
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
  encrypted at rest (see §4), and `S3_*` storage config is moved into this system as the `s3` provider.
* ~~Workflow builder is read-only in the UI.~~ **Resolved.** Full create/edit composer shipped this
  session (see §7).
* ~~No automated test suite.~~ **Resolved.** Vitest is in the repo — 107 unit tests across the query
  builder, filter evaluator, formula engine and permission engine (see §10). The highest-risk pure
  logic now has repeatable coverage; the write/API paths and UI still rely on live verification.
* ~~Dashboard drag-to-resize not wired.~~ **Resolved.** The grid now renders widgets at their stored
  x/y/w/h via `react-grid-layout` on desktop and persists drags/resizes through the existing
  `saveDashboardLayout` endpoint (see §7).
* ~~Funnel drill-through uses `equals` on the clicked stage.~~ **Resolved.** The server returns the
  ordered stage keys and the client filters `in` every stage from the clicked one onward, matching
  the funnel's cumulative numbers (see §7).

### Bugs (real, currently present, not fixed)

None open. (Migration 006 removed the dead `converted_contact_id` column and its field metadata this
session — the sole real bug is gone.)

### Risks

1. **`JWT_SECRET` is a one-way decision, not just a secret.** It also derives the
   integration-credential encryption key, so rotating it in production means re-entering every
   credential saved through the admin UI. Set the final value before real credentials go in. (The
   server does refuse to boot in production with the dev default.)
2. **`WHATSAPP_APP_SECRET` is unset, so WhatsApp inbound does not work in production.** It fails
   closed, which is the right way round — `verifyWebhookSignature` returns `!config.isProd` when no
   secret is configured, so a deployed server rejects every unsigned webhook rather than trusting it.
   Nothing is exposed; the messages simply never arrive until the secret is set.
3. **The free Render instance sleeps, and the scheduler sleeps with it.** One service runs the API,
   the web app and `ENABLE_SCHEDULER=true`, so overnight and at weekends no follow-up reminder, lead
   escalation or birthday message fires. No error is logged, because nothing runs. The $7/mo Starter
   plan is the fix; see DEPLOYMENT.md.
4. **Backups are automated but not yet switched on.** `.github/workflows/backup.yml` dumps
   production nightly, ships it to R2 and proves it by restoring into a scratch Postgres and counting
   rows — it skips with a warning until `PROD_DATABASE_URL` and the `R2_*` secrets exist. Adding
   those is the single highest-value thing left.
5. **Single-process scheduler.** `FOR UPDATE SKIP LOCKED` makes the queue multi-instance safe, but
   scheduled workflows scan up to 5,000 records per tick in-process — will not scale to large tenants.
6. **Nobody has used it concurrently.** Every check so far is a test suite or one person clicking.
   Run a real pilot — two or three agents, real leads, one week — before the whole desk moves onto it.

### Technical debt

3. **`ipy_e_contacts_archived_004`** (24 rows) retained deliberately for recovery. Drop once the merge
   is confirmed in production.
4. **Speech-to-text, IMAP inbound and rollups ship as graceful-degradation features.** Whisper needs an
   `STT_API_KEY`; the IMAP sync needs real mailbox credentials (the admin "Sync now" button and the
   scheduler hook are the entry points); rollup values are computed on read. None can be exercised
   end-to-end without keys, so they've been verified structurally (typecheck, unit suite, build, API
   no-op paths) rather than against live services.
5. ~~**Web bundle is ~1.2 MB with no route-level code splitting.**~~ **Stale — measured 2026-08-10.**
   Every page is behind `lazy()` in `App.tsx` and Vite splits accordingly. A cold load is
   `react` (54 KB gzip) + `index` (42 KB gzip) ≈ **96 KB**; each screen then pulls its own 3–15 KB.
   The one chunk worth watching is `charts` (recharts) at **115 KB gzip**, which the Dashboard —
   the page you land on after login — needs immediately. That, not the total, is what a phone on
   4G actually waits for.
 6. **`is_converted` and `lifecycle_stage` overlap** post-merge. Both are maintained; consider
    collapsing to lifecycle alone.

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

### Backup & restore (runbook)

Backups are custom-format `pg_dump` files in `backups/` (gitignored), taken via the
docker container so no host Postgres tools are needed. Retention: newest 14
(`BACKUP_KEEP` overrides).

```bash
npm run db:backup             # write backups/ipropy-<timestamp>.dump
npm run db:backup:verify      # restore newest dump into a throwaway DB, compare
                              # key table counts against live, then drop it
npm run db:restore backups/ipropy-<timestamp>.dump        # ← replaces LIVE data
TARGET_DB=ipropy_staging npm run db:restore backups/ipropy-<timestamp>.dump
```

Restore procedure: stop app writes, take a fresh backup, restore the chosen dump
with `npm run db:restore`, then re-apply any newer migrations (dumps include
migrations, so this only matters if you restore an older dump and the schema has
moved on). `db:backup:verify` exercises the whole pipeline safely — the verified
counts are `ipy_migration`, `ipy_user`, `ipy_record`, `ipy_module`, `ipy_field`.

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

**Vitest is in the repo.** `packages/server/tests/` holds 155 unit tests over the highest-risk pure
logic — `query/builder`, `query/evaluate`, `entity/formula`, `validation` and `permissions` (the DB
and metadata registry are stubbed; no Postgres needed), and `packages/web/tests/` a further 42.
Beyond those: 52 integration tests against a real throwaway Postgres, and 22 Playwright e2e specs.
The smoke scripts (`smoke.mjs`, `verify-merge.mjs`)
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
- [ ] Managed Postgres with automated backups (backup/restore runbook exists — §9 — but nothing
      scheduled; wire into a cron/systemd timer for production)
- [x] ~~Encrypt `ipy_integration.credentials` at rest~~ — done this session (AES-256-GCM, key from `JWT_SECRET`)
- [ ] Decide scheduler ownership if running multiple instances (`ENABLE_SCHEDULER`)

---

## 12. Next tasks, in priority order

Everything that was on this list and got done (git init, the `globalSearch` fix, secrets
encryption, the workflow builder, stale-UI/realtime, module toggle, field hide/unhide, Toggle CSS,
record navigation, quick-edit, dashboard drill-through, the Vitest unit suite, removal of the dead
`converted_contact_id` column, dashboard drag-to-resize, the DB backup/restore runbook, the funnel
drill-through + filter-panel fixes, the rollup aggregation engine, speech-to-text for call
recordings, IMAP inbound email sync, **Channel Partner portal**, **production hardening** (secrets, launchd timer)) has been removed. What's left:

### Correctness and safety

1. **DONE** — Production secrets generated: strong `JWT_SECRET`, `WHATSAPP_APP_SECRET` in `.env`. `npm check:prod` passes.

### Finish partially-built features

2. Add the many-to-many related-list "select existing record" UI (API already supports it).

### Deployment and operations

3. **DONE** — launchd backup timer installed and verified; backup written and restore-verified.

### Product depth

4. Mobile-responsive pass on ListView, RecordDetail and the Inventory board.
5. Collapse `is_converted` into `lifecycle_stage` and simplify conversion logic (§8 technical debt 6).

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

---

## 14. Public property website (new sibling repo)

A separate, customer-facing property showcase site lives at
`/Users/rishabhsinghla/Downloads/ipropy-website` — **not** part of this monorepo, its own git repo,
built with Next.js (App Router) + TypeScript + Tailwind. It shows live Projects/Properties pulled
from this CRM's own database, plus a CarWale-style deep comparison tool.

**What changed here to support it (all additive, nothing existing modified):**

* **`packages/server/src/api/routes/public.ts`** — new unauthenticated router, mounted in `app.ts`
  next to `webhooksRouter` (same "authenticates itself, skips `requireAuth`" pattern). Endpoints:
  `GET /api/public/projects`, `/projects/:id`, `/properties`, `/properties/:id`, `/filters`,
  `/media/:attachmentId`. Every query hand-picks an explicit `SELECT` column whitelist — it never
  goes through `recordService`/the metadata engine — so a sensitive field (`owner_contact_id`,
  `blocked_for_lead_id`, `broker_commission_pct`, admin-added custom JSON fields) can't leak here
  just because it exists on the record. A record is visible when its status qualifies (projects:
  `New Launch | Under Construction | Nearing Possession | Ready To Move`; properties: `Available`)
  **and** its `publish_to_web` field is truthy (JSON-storage custom field, added to both modules in
  `db/seed/modules.ts`, default `true` — no migration). An admin can hide one record from the site
  without changing its status. Own rate limiter (`app.ts`), separate from the general `/api` one.
  `GET /api/public/cities` adds one aggregate query (project count, available units, price range per
  city) backing the site's `/cities` pages, instead of it looping a `city=` filter per picklist value.
* **System user seeded** (`db/seed/rbac.ts::seedSystemUser`, id
  `00000000-0000-0000-0000-000000000000`) — fixes a **real, pre-existing bug** found while wiring
  the website's enquiry form through the existing `POST /api/webhooks/forms/:publicKey` → `captureLead`
  path: unattended lead capture (webforms, portal leads, Facebook/Google Ads — anything using
  `systemContext()` in `integrations/leadsources/capture.ts`) wrote `created_by` as that fixed UUID,
  but no `ipy_user` row existed with that id, so **every unauthenticated capture silently failed**
  on the `ipy_record_created_by_fkey` constraint. Can never log in (no `password_hash`).
* **`coerceValue` fix** (`core/metadata/values.ts`) — a second bug hit by the same test: `last_name`
  on `leads`/`contacts` is `TEXT NOT NULL DEFAULT ''` at the DB level but not marked `mandatory` in
  metadata, and `coerceValue` turned an empty string into `NULL` for every text-like uitype, which
  the NOT NULL constraint then rejected. Fixed the same way rule 9 already handles empty arrays:
  `''` now round-trips as `''` for `string`/`textarea`/`richtext` fields, never promoted to `NULL`.
  Verified safe — both filter engines (`query/builder.ts`'s `is_empty`, `query/evaluate.ts`'s
  `isBlank`) already treated `''` and `NULL` as equivalent, so this changes no query result.
* **`db/seed/automation.ts::seedWebforms`** — idempotently registers a "Website Enquiry" `ipy_webform`
  row (module `leads`, fixed `public_key: 'website-enquiry'`) so the site's enquiry forms work
  out of the box with zero manual admin-panel setup. Submissions become real Leads
  (`lead_source: 'Website'`) through the CRM's existing capture/assignment/SLA pipeline — no new
  lead-capture code path was added.

**Data flow:** the website's own Next.js server calls `/api/public/*` server-to-server (cached
~60s via `fetch(..., { next: { revalidate: 60 } })`) — the browser never talks to this CRM directly,
so none of its CORS/API-key surface had to change. Its enquiry form posts to its own
`/api/enquiry` route, which forwards server-side to `POST /api/webhooks/forms/website-enquiry`.

**Also shipped on the website side this round** (see its own README): JSON-LD structured data,
dynamic per-listing OG images, city landing pages, dark mode, amenity icons, recently-viewed.

**Not done yet:** locality-level (as opposed to city-level) SEO pages; deployment (website currently
only runs locally against this CRM's `localhost:4000`).

---

## 15. Property media pipeline (photos + video, watermark, auto-edit)

Uploading a photo/video against a project or property (from the CRM web app — including mobile
Safari, so an iPhone can shoot and upload directly) now produces web-ready derivatives
automatically, without ever touching the original bytes. Two-stage design: the upload request
stores the original and returns immediately (feels instant regardless of file size); a background
job then generates everything else. Same graceful-degradation shape as `ai/client.ts` throughout —
every stage that depends on an optional capability (ffmpeg installed, a music track present) logs
and skips itself on failure rather than blocking the upload or throwing.

* **Upload**: `POST /api/files` (`api/routes/misc.ts`) now uses a disk-buffered multer instance
  (`mediaUpload`, 2 GB limit) instead of memory-buffering, so a multi-GB 4K phone video never sits
  fully in Node's heap — it streams temp file → `StorageDriver.save()` → gets deleted. The original
  CSV-import `upload` (memory, 25 MB) is untouched, on its own instance. Image/video uploads enqueue
  a row in `ipy_media_job`.
* **Storage**: `StorageDriver` (`core/storage/index.ts`) gained `readToTempFile()` (a real
  filesystem path for ffmpeg — the local driver returns its existing path directly, S3 downloads to
  `os.tmpdir()` first) and `save()` now accepts a `Readable` in addition to `Buffer`, streamed via
  `pipeline()` rather than buffered.
* **Job queue**: `ipy_media_job` (migration `010_media_pipeline.sql`) mirrors `ipy_task_queue`'s
  `FOR UPDATE SKIP LOCKED` claim/retry/backoff pattern exactly — it's deliberately a separate table,
  not shoehorned into the workflow queue it structurally resembles, since it isn't FK'd to a
  workflow/task. Drained by `scheduler.ts`'s `drainMediaQueue()`, called alongside `drainQueue()`
  every tick. `docker-compose.yml`'s `ipropy_storage` volume, previously mounted only on `app`, is
  now also mounted on `worker` — a latent gap (nothing used to run there against local storage) that
  this pipeline made real.
* **Images** (`core/media/images.ts`, `sharp`): EXIF auto-orient, three WebP derivatives
  (thumb 480w / medium 1200w / large 2400w, q~82), IPROPY watermark composited onto medium/large only
  (thumbnails stay clean for dense grids). Derivative keys land in a new `ipy_attachment.variants
  JSONB` column; the original file on disk is never re-encoded or overwritten.
* **Video** (`core/media/video.ts`, ffmpeg via direct `execFile`, not the `fluent-ffmpeg` wrapper —
  see note below): transcodes to H.264/AAC MP4 with `faststart`, caps the longer side at 1920 (never
  upscales — the master is untouched so nothing is lost, this only affects the served derivative),
  overlays the same watermark throughout via the `overlay` filter, prepends a ~3s title card
  rendered from the record's **live** name/price/location (via `sharp`, so it's never stale — pulled
  fresh from `ipy_e_projects`/`ipy_e_properties` in `pipeline.ts::getTitleCardInfo`, joined via
  concat demuxer, `-c copy` since title card and main clip are re-encoded to matching resolution/fps
  first), and mixes in a background track at low volume (~16%, `amix`) under any existing audio —
  **only if** a file exists at `packages/server/assets/music/background.mp3`. No track is bundled;
  see that folder's `README.md` for the licensing convention. This one step silently no-ops without
  it, same as every other optional stage. ffmpeg missing from PATH at all → the whole pipeline
  degrades to "serve the original, unprocessed," logged once, no error surfaced to the uploader.
  Docker: `RUN apk add --no-cache ffmpeg` in the runtime stage.
  * **fluent-ffmpeg pitfall hit and fixed**: `fluent-ffmpeg`'s fluent API validates every `-f <name>`
    input format against its own cached `ffmpeg -formats` capability list before allowing a command
    to run — and on this stack that check rejected `lavfi` (the virtual device the title card's
    silent-audio track needs, `anullsrc=r=44100:cl=stereo`), even though the installed ffmpeg binary
    supports it fine (confirmed directly at the CLI). `.inputFormat('lavfi')` vs
    `.inputOptions(['-f','lavfi'])` made no difference — both hit the same validation layer. Fixed by
    dropping `fluent-ffmpeg` for every actual processing command (`runFfmpeg()`, a thin
    `execFile('ffmpeg', [...])` wrapper) and keeping it only for `ffmpeg.ffprobe()` (probing works
    fine through it — the bug is specific to fluent-ffmpeg's input-format validation, not the package
    generally). If `fluent-ffmpeg` is upgraded later, worth re-testing whether this is still needed.
* **Upload UI**: `FieldRenderer.tsx` gained the previously-missing `'image'` case in `FieldInput` —
  a `GalleryField` (thumbnail grid, per-item remove, concurrency-capped multi-file upload with
  progress, native `<input type="file" multiple accept="image/*,video/*">` — this is what makes iOS
  Safari itself offer "Photo Library / Take Photo or Video", no extra code needed for camera access).
  `<img>` tags can't send an `Authorization` header, so thumbnails use the CRM's pre-existing
  `?access_token=` query-param fallback (`authedImageUrl()` helper — same mechanism CSV export
  already used, not a new auth surface).
* **Public API / website**: `toPublicMedia()` (`api/routes/public.ts`) prefers the `medium` variant
  for list/grid contexts and `large` for detail/lightbox, falling back to the original whenever a
  variant isn't ready yet (still processing) or doesn't exist (video has no image variants) — this
  is the entire mechanism that makes the site faster; no website code changes were needed for images.
  `GET /api/files/:id` and the public media endpoint both gained `?size=thumb|medium|large`.
  `Gallery.tsx` on the website gained a `<video>` branch (detected via `next/image`'s `onError`,
  since the API gives no explicit "is this a video" flag) since a gallery can now include a
  walkthrough clip.

**Verified end-to-end** (real upload → scheduler → derivative, not just unit-level): original file
SHA-256 confirmed byte-identical before/after processing; processed video duration matched
4s source + 3s title card exactly; watermark and title-card frames visually inspected; music-mix
path produced non-silent stereo audio (`volumedetect`); ffmpeg removed from `PATH` confirmed the
pipeline returns `null` without throwing and without ever calling `driver.save()` (original keeps
serving untouched).

**Not done yet:** no music track is actually bundled (intentional — needs a specific
confirmed-license file dropped in by whoever picks one); HEIC/HEIF decode support depends on the
installed `sharp`/`libvips` build and hasn't been verified against a real HEIC file from an iPhone.

---

## 16. Universal inline editing (`EditableField.tsx`)

Before this round, click-to-edit-in-place only existed for `picklist`/`owner` fields, only in a
handful of hardcoded spots (the Kanban pipeline badge, a few header chips), and rendered as a bare
native `<select>` — functional but visually inconsistent with the rest of the app. The user asked
for this to work for **every editable field, everywhere** (list table cells, kanban cards, and —
previously entirely read-only — the record detail page's field grid), with a UX upgrade to match.

`components/EditableField.tsx` replaces the old `isQuickEditable`/`QuickEditField`
(FieldRenderer.tsx) with `isInlineEditable(field)` + `<EditableField>`, wired into
`pages/ListView.tsx` (table cells, kanban owner chip) and `pages/RecordDetail.tsx` (header chips
**and** `OverviewTab`'s field-block `<dl>`, which used to be pure `FieldValue`). Gated on
`meta.permissions.edit` in ListView (module-level; list rows carry no per-record `.can`) and
`record.can?.edit` in RecordDetail (record-level, more precise — a real gap in the old
`QuickEditField` usage, which checked neither).

Four interaction shapes, chosen per uitype by how much commitment a value warrants — not one
generic popover for everything:

* **Instant** (`boolean`): a real toggle switch, click = immediate save. No popover.
* **Inline text** (scalars — string, number, currency, date/datetime/time, textarea/richtext): the
  read value morphs into a bordered input in the same spot (delegates to the existing `FieldInput`).
  Enter/blur commits; Escape reverts the draft without saving.
* **Popover picker** (`picklist`, `owner`/`user`, `reference`, `multipicklist`, `tags`): a floating
  panel opens below the value. Picking writes through immediately (optimistic — UI updates and the
  panel closes for single-value fields before the network call resolves); there's nothing to
  "confirm." Multi-select fields keep the panel open across several picks instead of closing after
  one. `picklist` and `owner`/`user` got genuinely new UI here (`PicklistPopover`, `OwnerPopover` —
  coloured option list / searchable people list with avatars) replacing the native `<select>`, which
  was almost certainly the actual "not soothing" complaint. `reference` and `multipicklist`/`tags`
  reuse the existing `ReferencePicker`/`MultiSelect`/`TagInput` verbatim, just choreographed to
  auto-open and report back when they close (`ReferencePicker` gained `autoOpen`/`onOpenChange` for
  this — small, backward-compatible, existing callers unaffected).
* **Popover form** (`address`, `json`): explicit Save/Cancel — these are compound values, so a stray
  outside click cancels rather than half-committing a partial edit (every other popover type treats
  outside-click as "done," not "cancel").

Not inline-editable, same as before: `autonumber`/`formula`/`rollup` (nothing to write),
`image` (has its own dedicated `GalleryField` uploader that needs more room), `multireference` (no
working editor exists for it anywhere in the app today, including the full record-edit form — no
module actually uses this uitype).

**`reference`/`email`/`phone`/`url` get special handling** (`HAS_OWN_LINK` in EditableField.tsx):
`FieldValue` renders these as a real `<a>`/`Link`, and the naive approach — wrapping the whole read
value in a `<button>` to make it clickable-to-edit — produces invalid interactive-in-interactive
HTML that silently breaks in browsers (confirmed while testing: the phone column's `tel:` link and
its click handler both stopped working). Fixed by keeping the link a plain click and putting editing
behind a small separate pencil icon that fades in on hover, so both "navigate" and "edit" stay
available without either swallowing the other's click.

Every write is optimistic with a quiet success/error ring on the field itself (`pulse-success`/
`pulse-error` keyframes, tailwind.config.js) instead of a toast for the success path — a toast for
every field edit would be noisy at this frequency. A failed save reverts the value and explains why
via toast (which does still fire on error, since that needs more attention than a glance). A
monotonic per-field request counter guards against an out-of-order response from a superseded edit
overwriting a newer one.

**Real bug found and fixed during verification**: `CurrencyInput` (existing component, reused as-is
for the inline-text case) buffers what's typed locally and only calls the parent's `onChange` once,
already-parsed, from its own `onBlur` — it never fires per-keystroke like every other `FieldInput`
sub-editor does. `EditableField`'s Enter-to-commit handler read `draft` (React state) at the moment
Enter fired, which raced against that same-tick, not-yet-flushed `onChange` call — pressing Enter
right after typing a new budget value silently re-saved the *old* value instead (confirmed via a
real PATCH that persisted `10000000` unchanged after typing "1.75 Cr" and hitting Enter). Fixed with
a `useRef` mirror (`draftRef`) updated synchronously alongside `setDraft`, read instead of the state
value at commit time — refs aren't subject to React's batching, so the mirror is always current by
the time a same-tick blur/Enter handler reads it, regardless of ordering between sibling `onBlur`
handlers on the input and its wrapper.

**Verified end-to-end** against the running dev server for every interaction shape (real clicks,
real PATCH requests, DB reads to confirm persistence — not just visual inspection): picklist
popover (Leads pipeline status), owner popover with live search (Leads assigned-to, including a
Teams/People-grouped list), currency inline-text including the race-condition fix, plain-string
inline-text, boolean toggle, and reference popover with auto-open search (Interested Project on a
Lead, confirmed both the write and the resolved display label) — the last three specifically on
`RecordDetail`'s `OverviewTab`, the surface that was pure read-only before this round.

---

## 17. Session of 2026-08-08 — AI providers, dashboards, alerts, viewer, brand

Branch `feat/dashboard-ai-alerts`, three commits, all verified against the running stack
(typecheck clean, 149 unit tests green).

### What shipped

| # | Ask | State |
|---|-----|-------|
| 4 | Rename module to "Leads & Contacts" | Done — migration `011`; module *name* stays `leads` (URL, API path, relation target) |
| 2 | AI without an Anthropic key | Done — Gemini/Groq/OpenRouter/OpenAI-compatible/Ollama via one adapter; migration `012` |
| 1 | Full dashboard customisation | Done — CRUD UI + widget builder + 6 previously-unrenderable widget types |
| 5 | Mobile UI/UX | Done for `RecordDetail` and `Dashboard`; **not yet audited**: Reports, Inbox, Calls, InventoryBoard, admin pages |
| 3 | New-lead highlighting + notifications | Done — `ipy_module_seen` watermark + Web Push; migration `013` |
| 6 | Social links | Done — `social.links` setting, sidebar bar, Admin → Brand & Social; migration `014` |
| 16 | "Builder Floor = iPropy" | Done — `brand.tagline` setting on sign-in + sidebar |
| 9 | Universal document viewer | Done — `components/DocumentViewer.tsx` |

### Still open, and why

**Unblocked, just not started:** #11 blog, #8 creative editor, #14 daily SEO/AEO/GEO.

**Blocked on something code cannot supply — say so plainly rather than half-building:**

* **#7/#10/#12/#13 (WhatsApp, AiSensy/ManyChat replica).** Sending on WhatsApp at all requires a
  Meta-approved business and a dedicated phone number. There is no legal API that mirrors a
  personal WhatsApp inbox; the libraries claiming to do it get numbers permanently banned. The
  Cloud API scaffolding in `integrations/whatsapp/` is ready for credentials.
* **#15 (99acres/MagicBricks/Housing syndication).** No open API for *posting* listings — these are
  commercial contracts per portal. Inbound lead webhooks for all four already exist and work.
* **#17 (call recording).** Android has blocked third-party call recording since Android 10. The
  route that works is server-side recording via cloud telephony (Exotel/Knowlarity, already
  scaffolded in `integrations/telephony/`). Per-state consent rules apply.

### Verification notes for whoever picks this up

* Push was proven without a real device: VAPID keypair generation + persistence + stability, then
  `webpush.generateRequestDetails` confirming a signed VAPID `Authorization` header, `aes128gcm`
  encoding, and that the payload is genuinely encrypted (the lead's name is absent from the wire
  bytes). Subscribe → test → notification row was exercised over HTTP.
* The multi-provider AI adapter was proven end-to-end against a local mock OpenAI-compatible
  server, plus the no-provider degradation path under `env -u ANTHROPIC_API_KEY`.
* The dashboard widget builder was driven through the real UI (leaderboard grouped by lead source),
  and the resulting widget's persisted config and data response were read back from the API.

### Test data left behind

One lead, **LD-00174 "Rohit Verma"**, created to demonstrate the new-lead highlight. Delete it
whenever. Everything else created during the session was cleaned up.

### §17.1 — Second session (2026-08-09)

Mobile PWA fixes from real screenshots, plus three requested features.

**Fixed:** admin panel used a fixed 14rem rail on phones (≈160px left for
content); dashboard title collided with its own controls; dropdown panels ran
off the left edge; report measures row was ~470px unwrappable; Enable/Disable
"referenced by" line unbounded.

**Dropdown viewport clamping — read the comment in `ui.tsx` before changing it.**
Two obvious fixes are wrong: `transform` fights the panel's own open animation
(`slideUp` animates transform), so every measurement differs and React loops
until it throws "Maximum update depth exceeded"; `marginLeft` does nothing at
all to an absolutely positioned element pinned by `right`. Moving the anchoring
offset (`right` / `left`) is what works.

**Added:** platform-coloured social icons; profile photo upload/change/remove;
sign-in by mobile number; passkeys (Face ID / Touch ID) with usernameless
sign-in.

**Auth notes.** `phoneKey()` matches on the last ten digits because the same
number exists as "+919820011000", "098200 11000" and "9820011000" in imported
data. Passkey RP ID is derived from `APP_URL` — it must be the bare hostname,
never a port, so a deployment behind a different domain needs `APP_URL` right
or biometric sign-in silently fails. Signature-counter regression is treated as
a cloned credential and refused.

**Not verified end-to-end:** the WebAuthn biometric ceremony needs real hardware
or a CDP virtual authenticator. Endpoints, option shapes, challenge storage and
replay rejection are verified; the sign/verify round trip is not.

**AI still not configured.** The key supplied on 2026-08-09 was rejected by
Google ("Please pass a valid API key") — it was not in Google AI Studio's key
format (`AIza…`, 39 chars). The `ai_gemini` integration was left inactive so
the CRM keeps using its rule engines rather than failing every AI call.

### §17.2 — Third session (2026-08-09)

Blog (#11), daily SEO audit (#14) and the Studio (#8).

**Blog.** `blog_posts` is an ordinary module (migration `016`), so it inherits
views, roles, sharing and workflows. Slug/word-count/reading-time/publish-date
are derived by the `prepare_blog_post` workflow task, not by a branch in
recordService — the engine must not learn what a blog post is. Slug generation
only fills a *blank* slug; the unique index is partial (published rows only).
Public visibility is enforced in `routes/public.ts`, not the UI.

**SEO audit.** `core/seo/audit.ts`, run daily from the scheduler, guarded on the
last run rather than a cron expression. It fetches the **live site**; auditing
our own templates would only confirm the template is what we wrote. Ships
disabled — set `seo.site_url` in Admin → Settings to switch it on. Proven at
78/100 across 5 pages against a real `next build`.

**Studio** (`pages/Studio.tsx`, `lib/design.ts`, `lib/designTemplates.ts`).
Turns a listing into an Instagram/Facebook/WhatsApp post. The preview *is* the
export: both go through `renderDesign` onto a canvas at full output resolution,
scaled only by CSS, so there is no second rendering path that could disagree.
Canvas has no text wrapping, hence `wrapText` — without it a long project name
runs off the edge, which is the most common way a generated post looks broken.

**Known data issue, not a bug:** the demo seed writes `gallery` URLs pointing at
attachment ids it never creates, so seeded properties have dangling photos.
Templates therefore always draw a brand-colour rect *under* the image, so a
missing photo yields a branded post rather than a near-black one.

**Still not done:** #7/#10/#12/#13 (WhatsApp — Meta approval), #15 (portal
contracts), #17 (call recording). The Studio covers social-post creation only —
not video editing or a general design tool.

### §17.3 — Fourth session (2026-08-09)

Thirteen items from Rishabh, plus a permanent-delete for fields. The theme is
subtraction: fewer modules, and each field asking its question once.

**Projects and Activities are gone** (migration `031`). Payload rows are copied
to `ipy_e_activities_archive` / `ipy_e_projects_archive` before the delete —
207 activities and 6 projects here — because the amount of data was small enough
that keeping it costs nothing and a wrong call costs a restore. Nothing reads
those tables; drop them by hand once you are sure.

What that touched, and why each was not simply deleted:

* **Follow-ups.** Activities' real job was "chase this person on `<date>`", which
  the lead already records. `core/workflow/followUp.ts` is now the single
  definition, used by the workflow `create_task` action, call analysis, WhatsApp
  sequences and a logged callback. It writes the date, a note on the timeline so
  the reason survives, and a notification.
* **Lead scoring.** Site visits carried up to 28 of 100 points and had no store
  left. Removing the input outright would have deflated every score by a quarter
  and made Grade A unreachable, so that weight moved onto answered calls and
  inbound messages (`ai/leadScoring.ts`).
* **The public website.** It is built around Projects — pages, sitemap,
  JSON-LD, compare. `/api/public/projects` therefore still exists but aggregates
  the units sharing a `project_name`; `id` is a slug of the name. Fields a
  project owned alone (RERA number, USPs, brochure, construction progress) now
  return null, so those parts of the site render empty.
* **Assignment.** `least_busy` counted open activities due today; it now counts
  leads whose own follow-up date has arrived.

**Fields on a lead**

* Carpet Area (Min) + (Max) → one **Area** with its unit beside it. Existing
  ranges collapsed to their midpoint. The unit is a real field (`area_unit`)
  rendered inside the control, so it still reports and filters.
* **Country code** stopped being a form row and became the dropdown attached to
  Mobile. It is still stored separately — a silent +91 sends an NRI buyer's
  WhatsApp to a stranger — and the server joins the two into one display value
  in `resolveDisplayValues`, so every list, detail and export agrees.
* Follow-up / last contacted / scored / converted are **DATE** columns now.

**Admin controls for things that were hard-coded**

* Layout Designer: sections (add, rename, reorder, delete), the header's summary
  chips, and which tab a record opens on. Saving sets `ipy_layout.is_customised`
  and `db:seed` skips those, which is what stops a re-seed undoing the work.
* **Fields can be deleted for real.** Previously "Remove" only deactivated a
  seeded field, because `db:seed` rebuilds every module and the row came
  straight back. Migration `032` adds `ipy_field_tombstone`; the seed consults
  it. Delete drops the column too — several are `NOT NULL` with no default, so
  metadata-only deletion breaks every insert. A module's naming or pipeline
  field refuses, with the reason.

**Two traps this session paid for**

1. **`config.__record` fields live on `ipy_record`, not the payload table.**
   The seed grew an `ensureColumn` helper that recreates a column the metadata
   expects; it happily added `owner_id` to `ipy_e_leads`, which does not error —
   it *shadows* the real column in `SELECT r.*, p.*`, and every new record read
   back as unassigned. Integration tests caught it. `ensureColumn` now skips
   `__record` fields.
2. **`git stash` leaves `packages/shared/dist` stale.** The server then fails to
   boot on a missing export. Rebuild shared before starting dev after a stash.

**Also fixed**

* Inline-edit popovers were absolutely positioned inside cards with
  `overflow-hidden`, so a picklist near a card's edge lost its options behind
  it. They portal to `<body>` and flip above when there is no room below. The
  anchor must be the wrapper, not the inner `display: contents` div — that has
  no box, so `getBoundingClientRect()` is all zeros and the panel lands in the
  top-left corner.
* Reports opened on `deals`, grouped by `stage` and measured `amount` — none of
  which had existed since `030`, which is why three dropdowns rendered blank.
  Every default now derives from the loaded metadata.
* Integrations has a **Connect** tab: pick the outcome, follow numbered steps,
  paste one value per step. Verify tokens and webhook keys are generated rather
  than demanded, and saving runs the provider's own test. The field-by-field
  view remains as "All settings".
* Inventory Board removed — page, routes, nav, and its two API endpoints.

**Still open:** #7/#10/#12/#13 (WhatsApp — Meta approval), #15 (portal
contracts), #17 (call recording). No LLM key is configured, so every AI feature
runs on its fallback rule engine.

**E2E suite repaired.** It had been red on `main` for two sessions and nobody
noticed, because the failures were all in the *tests*, not the app:

* `helpers.ts` filled a field labelled `Email`; the label became "Email or
  mobile number" when sign-in by phone shipped, so `auth.setup` timed out and
  took all 21 tests with it.
* Nine specs looked for a "Leads & Customers" nav link, renamed to "Leads &
  Contacts" by migration `011`.
* Two filled `first name` / `last name`, retired by migration `026`.
* The lead-creation specs built a mobile as `+919${Date.now().slice(-9)}` —
  twelve digits, clipped to ten, which discards the digits that made it unique
  and trips the duplicate check on the second run.
* Both expected quick-create to open the new record; it deliberately stays on
  the list (see ListView's `onSaved`).
* `modules.spec` asserted `routes.length > 5`, written when there were thirteen
  modules. It now names the three it expects, so it tests the nav rather than a
  product decision.

Two of the fixes were real app bugs the suite caught once it could run:

* The portalled inline editor rendered its first frame `visibility: hidden` to
  measure itself — and **nothing inside a `visibility: hidden` element can take
  focus**, so autoFocus silently failed and clicking a field left no cursor.
  It uses `opacity: 0` for that frame instead.
* The picklist popover was a stack of plain buttons. Portalled to the end of
  `<body>`, "the button that says New" matched a table cell before it matched an
  option. It is now `role="listbox"` / `role="option"` with `aria-selected`,
  which is what it always should have been for screen readers.

**Running e2e locally:** stop `npm run dev` first. `reuseExistingServer` means a
dev server you started will be used as-is, without the raised `API_RATE_LIMIT`
the config sets — the suite then trips the 600/min limiter and the mobile
project fails on an empty shell that looks exactly like a broken drawer.

### §17.4 — Field rules an admin can actually set (2026-08-10)

The engine has always enforced more than the admin panel could express. Adding a
field gave you a plain box; how it should *behave* was only settable by editing
`db/seed/modules.ts`. This closes that gap — a "Rules" section on the field
editor, collapsed by default because most fields need none of it.

* **Only show this field when…** — `config.visibleWhen`. This one was not
  merely unexposed, it was **never implemented**: the key existed in the types
  and on `ipy_block`, and nothing evaluated it. `core/query/evaluate.ts` moved
  to `packages/shared` so the form and the API run the same evaluator, for the
  reason `collectFieldErrors` already lives there — a second copy drifts.
* **Compare against another field** — `notAfterField` / `notBeforeField`.
* **Must look like** — `pattern` + `patternMessage`, behind named presets (PAN,
  GST, pincode, Aadhaar last-4, IFSC) so nobody writes a regex to validate a
  PAN. The message matters as much as the pattern: "invalid" tells a user
  nothing, "A PAN looks like ABCDE1234F" tells them what to type.
* **The unit and country-code lists** — `unitOptions` / `countryCodes`, editable
  rather than hardcoded in the seed.

**A hidden field must not block a save.** `validateRequired` now skips a
mandatory field whose condition is unmet, evaluated against the stored record
merged with the payload — a rule can depend on a value the payload doesn't
carry. Covered by an integration test.

**Two bugs found while building this, both pre-existing:**

1. The field editor rebuilt `config` from scratch on save, so editing *any*
   field's label silently discarded every setting the form doesn't render.
   Editing Mobile would have wiped its digit rules and country codes. It now
   starts from the stored config.
2. `PATCH /api/meta/fields/:id` **merges** config — correct, so a caller
   patching only `label` cannot wipe validation, but it left no way to *remove*
   a setting. An explicit `null` now means "delete this key", which is what
   clearing a rule in the editor sends.

### §17.5 — Three things the running system was doing wrong (2026-08-10)

Found by reading a dev-server log rather than by testing, which is the point:
none of the three showed up as a failing check.

* **Logging a call by hand returned 500.** `logManualCall` bound `$7` into an
  integer column *and* into `($7 || ' seconds')::interval`, so Postgres refused
  to deduce a type: `inconsistent types deduced for parameter $7`. Now
  `make_interval(secs => $7::int)`. This is the fourth appearance of the
  parameter-binding trap in CLAUDE.md rule 8 — the first one with an integration
  test behind it, because nothing typechecks a SQL string.
* **A rate-limited AI provider was called every minute, forever.** Free-tier
  Gemini returns 429 once its daily quota is gone; `fetchWithRetry` then tried
  twice more, several features a minute, all night. `ai/client.ts` now sets a
  rate-limited provider aside for ten minutes. The cooldown is keyed on the last
  characters of the API key, so pasting a new key — the actual fix — takes
  effect immediately without a restart, and "Test connection" is never paused
  because it calls the transports directly.
* **Admin → List View Tabs was missing its page padding.** Every other admin
  screen wraps in `p-4 sm:p-6`; this one did not, so the heading sat against the
  nav divider and the rows bled off the right edge of a desktop window, putting
  the delete button a mile from the name it belonged to. Also: the grip icon on
  each row had never been draggable. It is now — the arrows stay for keyboard
  and touch — and a hidden tab says "hidden" rather than only being faded.
