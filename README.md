# iPropy CRM

An AI-native, metadata-driven CRM for real-estate developers and brokerages — built from scratch,
taking Vtiger's proven customisation architecture and rebuilding it on a modern stack.

Everything an admin can change in Vtiger (modules, fields, blocks, layouts, picklists, custom views,
role hierarchy, sharing rules, workflows, dashboards) is editable at runtime here too — plus WhatsApp,
telephony, portal lead capture, and an AI layer that scores, matches, drafts and analyses.

```
Node 20 + TypeScript + Express + PostgreSQL 16   ·   React 18 + Vite + Tailwind   ·   Claude (Anthropic)
```

---

## Quick start

```bash
cp .env.example .env
docker compose up -d db
npm install
npm run setup      # build shared types, migrate, seed metadata + demo data
npm run dev        # API on :4000, web on :5173
```

Open <http://localhost:5173> and sign in:

| Account | Role | What it demonstrates |
|---|---|---|
| `admin@ipropy.com` | Administrator | Full access, the admin panel |
| `priya.sharma@ipropy.com` | Sales Head | Sees the whole org via role hierarchy |
| `rahul.mehta@ipropy.com` | Sales Manager | Sees their team's records only |
| `aisha.khan@ipropy.com` | Sales Executive | Sees only their own records |
| `neha.gupta@ipropy.com` | Pre-Sales / Tele-caller | Pricing fields hidden, Bookings blocked |
| `arjun.nair@ipropy.com` | CRM / Post-Sales | Bookings, payments, documentation |
| `sanjay.iyer@ipropy.com` | Finance | Collections and commissions |

Password for all of them: `Admin@123`.

Sign in as two different users side by side — the same screens show genuinely different data and
different fields. That is the permission engine, not a UI trick.

---

## Why it is built this way

### The metadata engine

Vtiger's real strength is that `vtiger_tab` / `vtiger_blocks` / `vtiger_field` are *rows*, so the
product reshapes itself without a deploy. iPropy keeps that idea and modernises the storage:

```
ipy_module  ──<  ipy_block  ──<  ipy_field         the schema, as data
ipy_record  ──   ipy_e_<module>                    the data itself
```

* **`ipy_record`** is Vtiger's `crmentity`: one id space for ownership, audit, comments, tags,
  attachments, search and polymorphic relations across every module.
* **`ipy_e_leads`, `ipy_e_properties`, …** hold declared columns for hot fields (real indexes, real
  types) plus a `custom_fields JSONB` bag for anything an admin adds later.
* `ipy_field.storage` says which of the two a field lives in. The query builder resolves
  `t.column` or `t.custom_fields->>'key'` transparently — so **adding a field never runs DDL**, and a
  custom field filters, sorts and reports exactly like a built-in one.

There is **no per-module CRUD code anywhere in this repo.** One `recordService` serves all thirteen
seeded modules and every module an admin creates afterwards.

### Field types

32 `uitype`s (`packages/shared/src/uitypes.ts`) each declare storage kind, valid filter operators, and
whether they are computed. Adding one there makes it immediately available in the field builder, the
form renderer, the list view, the filter builder and the workflow engine.

Real-estate specific: `currency` (accepts `"1.5 Cr"` and stores `15000000`), `area`, `score`,
`address`, `geolocation`, plus computed `formula`, `rollup` and `autonumber`.

### Permissions

Four layers, evaluated in order — the same model Vtiger uses, enforced in SQL rather than filtered in JS:

1. **Profile** — can this user touch the module at all? which fields?
2. **Org-wide default** — private / public read / public read-write, per module.
3. **Role hierarchy** — managers see their reports' records, via a materialised `path` array.
4. **Sharing rules + per-record shares** — targeted grants sideways.

`recordScopeSql()` emits the WHERE fragment that scopes every list query. Field-level `hidden`
permissions strip values from the API response, not just from the UI.

---

## What's in the box

### Modules (all seeded, all editable)

| | |
|---|---|
| **Sales** | Leads & Customers · Organisations · Deals · Site Visits · Bookings · Channel Partners |
| **Inventory** | Projects · Properties/Units |
| **Marketing** | Campaigns |
| **Finance** | Payments |
| **Productivity** | Activities · Documents |

430 fields, 54 dropdown option sets, 30+ system views, 5 dashboards, 17 workflows — all seeded and all
editable from the admin panel.

### One party record: Leads & Customers

There is no separate Contacts module. A person is a single record that carries a **lifecycle stage**
from first enquiry to repeat buyer:

```
Lead  →  Prospect  →  Customer  →  Past Customer
```

Conversion doesn't copy the person into a second module — it advances the same record's stage and
opens a Deal against it. The consequence is that every call, WhatsApp thread, site visit, booking and
file stays on **one id** for the whole relationship, instead of splitting at conversion. The stage
advances automatically: a completed site visit promotes a Lead to Prospect; a booking promotes a
Prospect to Customer (both are ordinary, editable workflows).

Migration `004` performs this merge on an existing database: it widens the leads table, moves each
contact's record across (every `contact_id` FK targets the shared record table, so nothing repoints),
re-homes calls/conversations/documents, repoints lookup fields, and archives the old contacts table
rather than dropping it. Verified on live data: 24 contacts merged into 60 leads, all 28 deals / 3
bookings / 21 payments still resolving, zero orphans.

### Enabling and disabling modules

**Admin → Modules** lists every module with its field and record counts and lets you switch off what
you don't use. Disabling hides a module everywhere — navigation, global search, reports and the API
(the endpoint 404s) — but **keeps its data**, so re-enabling restores it exactly. Each module shows
which others reference it (a lookup dependency), and **Leads** and **Activities** are marked core and
cannot be disabled because the rest of the CRM reads from them.

### Screens

| Screen | Notes |
|---|---|
| **Dashboard** | 5 seeded dashboards. Metric tiles with period-over-period deltas, funnel with cumulative conversion, stacked inventory, leaderboards, AI insight tiles. |
| **List view** | Metadata-driven table + drag-and-drop kanban, saved views with live counts, nested AND/OR filter builder, column chooser, bulk edit/reassign/delete, CSV export. |
| **Record detail** | Header summary, tabbed Overview / Timeline / Related / Files, AI sidebar, notes, one-click call and WhatsApp. |
| **Timeline** | Calls, WhatsApp, email, notes, tasks, site visits, payments, files, field changes and AI insights merged into one feed. |
| **Inbox** | WhatsApp threads with the 24-hour window enforced, delivery receipts, AI reply suggestions. |
| **Calls** | Call log with recordings, AI summary/sentiment/objections, and a coaching report. |
| **Inventory board** | Tower × floor stack plan, colour-coded by status, block/release a unit, "which buyers match this unit". |
| **Reports** | Ad-hoc summary and tabular reports with grouping, measures and CSV export. |
| **Admin** | Module & field builder, drag-drop layout designer, dropdown editor, users, roles, profiles, sharing, workflows, integrations, import, audit log. |

### Automation

17 seeded workflows, all editable. Triggers: `on_create`, `on_modify`, `on_field_change`,
`on_delete`, `scheduled`, `on_inbound_message`, `on_call_end`. 14 task types including
`update_fields`, `create_record`, `send_whatsapp`, `send_email`, `assign_owner`, `webhook` and
`ai_action`.

Tasks can be delayed absolutely (`after 30 minutes`) or **relative to a field**
(`2 hours before {scheduled_at}`) — which is what makes site-visit reminders possible.

Also: round-robin / load-balanced / least-busy lead assignment with daily caps, and SLA policies with
first-response tracking and escalation.

### Integrations

| | Status without credentials |
|---|---|
| WhatsApp (Meta Cloud API) | Messages logged and marked sent — flows stay testable |
| Telephony (Twilio, Exotel) | Calls logged; click-to-call is a no-op |
| Facebook Lead Ads, Google Ads | Webhook endpoints live; no inbound traffic |
| 99acres, MagicBricks, Housing, NoBroker | Generic portal normaliser per source |
| Email (SMTP/IMAP) | Logged with open tracking |
| Web forms | Embeddable endpoint, works immediately |

Every integration **degrades gracefully**. The whole product is demoable with an empty `.env`.

Webhook URLs are listed in **Admin → Integrations → Webhook URLs**.

### AI

Every AI feature pairs a deterministic engine with an LLM pass. **Without `ANTHROPIC_API_KEY` the
rule engines still run** — scoring, matching and routing keep working, you just lose the narrative.

| Feature | Rule engine | LLM adds |
|---|---|---|
| Lead scoring | Timeline, source quality, budget-to-inventory fit, engagement, recency, response speed | Reads notes/calls/messages, adjusts within ±30, writes reasons and next actions |
| Property matching | Budget fit, configuration, location, area, possession alignment | Writes the pitch per unit, grounded in the data |
| Deal risk | Stage ageing, silence, discount pressure, missing site visit, unit taken | Explains and picks the single highest-leverage action |
| Call analysis | — | Summary, sentiment, objections, next actions, talk ratio; extracts stated budget/timeline into empty fields only |
| Ask your CRM | — | Natural language → a real, permission-scoped `FilterGroup`, validated against metadata before it runs |
| Drafting | — | WhatsApp / email / call scripts from the record's actual history |

The NL query path is worth calling out: the model produces a filter, the server **discards any field
that doesn't exist in metadata**, then runs it through the normal permission-scoped query engine. The
numbers in an AI answer are the same numbers a list view would show.

---

## Project layout

```
packages/
  shared/    uitypes, field/module types, filter grammar, Indian currency formatting
  server/
    core/
      metadata/    registry (cached), value coercion & validation
      query/       SQL builder + in-memory filter evaluator (same grammar, two engines)
      entity/      recordService, conversion/merge, timeline, formula parser, numbering
      permissions/ the four-layer engine
      workflow/    engine, 14 task types, assignment, scheduler
      analytics/   widget + report query engine
    integrations/  whatsapp, telephony, email, lead sources
    ai/            client, scoring, matching, drafting, call analysis, assistant
    api/routes/    auth, metadata, records, views, dashboards, admin, comms, telephony, ai, webhooks
  web/
    components/    FieldRenderer (the heart), RecordForm, FilterBuilder, AiAssistant, ui kit
    pages/         Dashboard, ListView, RecordDetail, Inbox, Calls, Inventory, Reports, admin/*
```

Two details worth knowing if you extend this:

* **The filter grammar has two engines.** `core/query/builder.ts` compiles a `FilterGroup` to SQL for
  list views; `core/query/evaluate.ts` evaluates the same shape in memory for workflow conditions and
  conditional field visibility. An admin builds a condition once and it means the same thing in both.
* **Events fire after commit.** `db/pool.ts` exposes `onCommit(conn, fn)`. Emitting a domain event
  inside an open transaction deadlocks — a workflow task updating the same row uses a different
  pooled connection and blocks on the uncommitted row lock. This bit us during development; the
  after-commit queue is the fix.

---

## Commands

```bash
npm run dev            # both servers, hot reload
npm run build          # typecheck + build all three packages
npm run typecheck      # types only
npm run db:migrate     # apply pending migrations
npm run db:seed        # (re)seed metadata; demo data only if the DB is empty
npm run db:reset       # drop everything and start over
```

Seeding is idempotent — re-run `db:seed` after changing module definitions to refresh metadata
without touching tenant data.

---

## Configuration

Only `DATABASE_URL` and `JWT_SECRET` are required to boot. See `.env.example` for the rest:
Anthropic, WhatsApp, Twilio/Exotel, SMTP/IMAP, Facebook/Google lead capture, S3 storage, scheduler.

Set `SEED_DEMO_DATA=false` for a clean production install — you get all the metadata, none of the
sample records.

**Before deploying:** set a real `JWT_SECRET` (the server refuses to start in production with the dev
default), set `WHATSAPP_APP_SECRET` (webhook signatures are only skipped outside production), and put
the API behind TLS.

---

## Verification

`npm run build` typechecks and builds all three packages. The engine was exercised end-to-end against
a live Postgres — 63 checks covering auth, metadata, list/kanban/filters, detail, timeline, the write
path (create → update → audit → duplicate detection → convert → delete), inbox, telephony, inventory,
reports, the full admin surface, and permission enforcement across three profiles.

Three real bugs were found and fixed during that pass, all noted in the code:

1. **Transaction deadlock** — events emitted inside the write transaction blocked forever when a
   workflow task updated the same row. Fixed with the after-commit queue in `db/pool.ts`.
2. **Field-level permission bypass** — `hidden` fields were stripped from metadata but not from the
   API response, so values were one raw request away. Now stripped in `getRecord`/`listRecords`.
3. **`records.view_all` inconsistency** — the capability was honoured by list scoping but not the
   per-record check, so a Sales Head could list records they couldn't open.

---

## What is deliberately not here

Honest scope notes:

* **Speech-to-text is not bundled.** Call analysis works from a transcript — supplied by your
  telephony provider, an external STT service, or pasted into the call detail screen.
* **Dashboard drag-to-resize is desktop-only.** On ≥1024 px widgets can be dragged and resized and
  the layout persists to the server; below that the grid falls back to responsive auto-flow (see the
  README of `react-grid-layout` if you want finer control over the handles).
* **The workflow builder is read-only in the UI.** Workflows are fully editable through the API and
  seeded declaratively; the admin screen lists, inspects, enables and deletes them but does not yet
  compose a new one visually.
* **Unit tests cover the server core only.** A Vitest suite (`npm test`) covers the query builder,
  filter evaluator, formula engine and permission engine; the API, write paths and UI are verified
  live rather than by automated tests.
