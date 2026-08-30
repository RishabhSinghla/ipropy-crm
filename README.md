# iPropy CRM

An AI-native, metadata-driven CRM for real-estate developers and brokerages — built from scratch,
taking Vtiger's proven customisation architecture and rebuilding it on a modern stack.

Everything an admin can change in Vtiger (modules, fields, blocks, layouts, picklists, custom views,
role hierarchy, sharing rules, workflows, dashboards) is editable at runtime here too — plus WhatsApp,
telephony, portal lead capture, and an AI layer that scores, matches, drafts and analyses.

```
Node 20 + TypeScript + Express + PostgreSQL 16   ·   React 19 + Vite + Tailwind   ·   pluggable AI providers
```

---

## Current release status

The CRM and public website are deployed, and site capture runs end to end: a property finished in
the CRM reaches n8n, the media worker names, finishes, cuts every social shape, watermarks, builds
the reel and the walkthrough, and the finished pictures come back onto the record and onto the
public site.

The application code is ready for a controlled team pilot. What stands between that and real client
data is not code:

* **Two fields were removed from the production model on purpose** — `city` and `project_name` on
  properties. This business sells builder floors in one area, so neither grouping earns its place.
  The projects catalogue and the cities list are consequently empty, which is the correct answer,
  and the website no longer offers those sections rather than linking to empty pages. Nothing to
  restore here.
* **No model answers.** A provider key is saved, but the model ids in Admin → Settings → AI models
  are OpenRouter ones and override the provider's own. Photo naming, listing copy, voiceover and
  semantic search are all inert until that is settled — quietly, by design.
* Storage, backups, always-on hosting and real accounts are deployment checks owned outside this
  repository.

**Every push to `main` deploys straight to production until 1 September 2026.** The CI gate is off
because the free Actions minutes ran out; `render.yaml` goes back to `autoDeployTrigger: checksPass`
on the 1st. Until then, `npm run typecheck`, `npm test`, `npm run test:integration` and a
`linux/amd64` Docker build all have to pass locally before anything is pushed, and
`python3 scripts/check-deployed.py` has to pass afterwards — n8n and the media worker deploy
separately and have drifted silently twice.

See [`DEPLOYMENT.md`](DEPLOYMENT.md) and **Admin → System & Audit → Go live** before importing real
data.

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
| `neha.gupta@ipropy.com` | Pre-Sales / Tele-caller | Restricted fields and lead access |
| `arjun.nair@ipropy.com` | CRM / Post-Sales | Legacy profile retained for permission testing |
| `sanjay.iyer@ipropy.com` | Finance | Legacy profile retained for permission testing |
| `rakesh.bhandari@ipropy.com` | Channel Partner | Restricted portal-style profile |
| `sunita.menon@ipropy.com` | Channel Partner | Restricted portal-style profile |

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

There is **no per-module CRUD code anywhere in this repo.** One `recordService` serves every seeded
module and every module an admin creates afterwards.

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
| **Sales** | Leads & Contacts |
| **Inventory** | Properties/Units |

Three, and the count has come down twice on purpose. The CRM started with
thirteen; migrations `030` and `031` removed ten of them. Each one died the same
way — it existed to hold a value the lead or the unit could hold itself, so a
salesperson had to create a second record to record one fact. A project became
the unit's `project_name`; an activity became the lead's follow-up date.

160 fields, 58 dropdown option sets, system views, 5 dashboards and 7 workflows —
all seeded and all editable from the admin panel.

### One party record: Leads & Contacts

There is no separate Contacts module. A person is a single record that carries a **lifecycle stage**
from first enquiry to repeat buyer:

```
Lead  →  Prospect  →  Customer  →  Past Customer
```

Conversion doesn't copy the person into a second module — it advances the same record's stage. The
consequence is that every call, WhatsApp thread, note and file stays on **one id** for the whole
relationship, instead of splitting at conversion.

Migration `004` performs this merge on an existing database: it widens the leads table, moves each
contact's record across (every `contact_id` FK targets the shared record table, so nothing repoints),
re-homes calls/conversations/documents, repoints lookup fields, and archives the old contacts table
rather than dropping it. Verified on live data: 24 contacts merged into 60 leads, all 28 deals / 3
bookings / 21 payments still resolving, zero orphans.

### Enabling and disabling modules

**Admin → Modules** lists every module with its field and record counts and lets you switch off what
you don't use. Disabling hides a module everywhere — navigation, global search, reports and the API
(the endpoint 404s) — but **keeps its data**, so re-enabling restores it exactly. Each module shows
which others reference it (a lookup dependency), and **Leads** is marked core and cannot be disabled
because the rest of the CRM reads from it.

### Screens

| Screen | Notes |
|---|---|
| **Dashboard** | 5 seeded dashboards. Metric tiles with period-over-period deltas, funnel with cumulative conversion, stacked inventory, leaderboards, AI insight tiles. |
| **List view** | Metadata-driven table + drag-and-drop kanban, saved views with live counts, nested AND/OR filter builder, column chooser, bulk edit/reassign/delete, CSV export. |
| **Record detail** | Header summary (fields chosen per module in the layout designer), tabbed Overview / Timeline / Calls / Files, notes and AI sidebar, one-click call and WhatsApp. |
| **Timeline** | Calls, WhatsApp, email, notes, files, field changes and AI insights merged into one feed. |
| **Inbox** | WhatsApp threads with the 24-hour window enforced, delivery receipts, AI reply suggestions. |
| **Calls** | Call log with recordings, AI summary/sentiment/objections, and a coaching report. |
| **Reports** | Ad-hoc summary and tabular reports with grouping, measures and CSV export. |
| **Capture** | Built for standing at a gate: name the property, tap Start, shoot with the normal camera. Writes to IndexedDB and returns — it never waits for the network, so a visit with no signal still lands. Details can be **spoken** rather than typed. |
| **Shoots** | The evening list of visits that still have no name — thumbnails first, because nobody can tell "9:03–9:21, 12 photos" from "9:48–10:04, 14 photos", but everybody recognises their own pictures. One box both finds a property and creates one. |
| **Capture review** | Confirm what you said at the gate. Read a line, glance at the parsed values, tap Confirm — ten properties in about two minutes, sitting down. |
| **Shared property** (`/s/:token`) | The buyer's page. One property, one unguessable URL, no sign-in, revocable. Loads zero auth-only modules. |
| **Admin** | Module & field builder (hide or permanently delete a field), layout designer (sections, header chips, default tab), dropdown editor, users, roles, profiles, sharing, workflows, guided integration setup, import, audit log. |

### Site capture — photos onto the right property, without typing

The identity of a property is known at the instant the shutter is pressed, and thrown away
immediately. Everything after that — sorting, filing, captioning, sending — is a person
re-deriving a fact they already had. Capture records it once, at the gate.

A **shoot session** binds a property to a window of time. Every photo taken inside that window is
filed against it automatically, matched on **EXIF time, not GPS** — adjacent builder floors are ten
to twenty metres apart, well inside the error of a phone fix, so the clock is the exact instrument
and location is only good for segmenting a day into visits.

The tap that opens a session is **optional**. Photos belonging to no session are grouped by the clock
alone — a 40-minute gap means the photographer drove somewhere — which yields a group with no name,
exactly the state one tap in the evening fixes. Missing a tap costs nothing.

Where a model is configured, it **describes** each nameless group ("3 BHK builder floor — marble
flooring, modular kitchen, covered parking") so naming a three-day-old shoot is reading rather than a
memory test. It never writes to the record: a model can see a modular kitchen, it cannot see that
this is B-110 and not B-112.

Getting them back out is a **share link** — one property, one unguessable URL, made by somebody who
could already see the record, revocable, and independent of whether the unit is ready for the public
website. Naming a link after who it went to turns an anonymous counter into *"the one I sent Rajesh
has been opened four times"*.

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
| WhatsApp via a linked phone (`wa-bridge/`) | Off until a number is linked; sends fall back to the one-tap queue |
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

**Nothing the AI proposes is ever applied on its own.** Every action lands in `ipy_ai_action` as
`pending` and stays there until a person confirms it — enforced by a CHECK constraint, not by
convention, so there is no code path that skips it.

For how this maps onto the wider AI vocabulary — gateways, RAG, vector databases, agentic memory,
guardrails, evals, observability — and for which frameworks would undo work already done here, see
[`AI-ARCHITECTURE.md`](AI-ARCHITECTURE.md).

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
      workflow/    engine, 14 task types, assignment, scheduler, follow-ups
      analytics/   widget + report query engine
      capture/     shoot sessions, EXIF time matching, auto-grouping, voice, vision
      media/       watermark, image/video derivatives — the processing pipeline
      sharing/     share links (one property, one unguessable URL)
      notifications/ notify()/notifyMany() — row + socket + Web Push, never a raw INSERT
    integrations/  whatsapp, telephony, email, lead sources
    ai/            client (Anthropic + any OpenAI-compatible), scoring, matching, drafting,
                   call analysis, assistant
    api/routes/    auth, metadata, records, views, dashboards, admin, comms, telephony, ai,
                   webhooks, capture, public, outreach, passkeys, device
  web/
    components/    FieldRenderer (the heart), RecordForm, FilterBuilder, AiAssistant,
                   ShareLinks, ui kit
    pages/         Dashboard, ListView, RecordDetail, Inbox, Calls, Reports, Outreach,
                   Capture, CaptureShoots, CaptureReview, SharedProperty, admin/*
  mcp/         permission-scoped CRM tools for assistants, over stdio or HTTP
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
npm run build          # build shared, MCP, server and web workspaces
npm run typecheck      # types only
npm run db:migrate     # apply pending migrations
npm run db:seed        # (re)seed metadata; demo data only if the DB is empty
npm run db:reset       # drop everything and start over
npm run db:backup      # pg_dump the DB to backups/ipropy-<timestamp>.dump
npm run db:backup:verify  # restore newest dump to a scratch DB, compare counts, drop it
npm run db:restore <dump> # replace the live DB from a backup (see PROJECT_HANDOVER.md §9)

npm test               # 374 unit tests, no database needed
npm run test:integration  # API + recordService against a real throwaway Postgres
npm run test:e2e       # Playwright, against a real browser and the dev stack
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

Three layers, fastest first:

| | |
|---|---|
| `npm test` | **374 unit tests**, no database — 320 server, 46 web and 8 MCP |
| `npm run test:integration` | **274 tests** against real throwaway Postgres databases; never point it at a database you care about |
| `npm run test:e2e` | **28 Playwright tests** across desktop and mobile browser projects |
| `npm audit --audit-level=moderate` | Dependency advisory gate, including build tooling |
| `docker build --platform linux/amd64 -t ipropy-crm:local .` | The production image Render actually builds |

`npm run build` typechecks and builds all four workspaces, and `npm run typecheck` must be clean
before any change is finished.

The engine was also exercised end-to-end against a live Postgres — 63 checks covering auth, metadata,
list/kanban/filters, detail, timeline, the write path (create → update → audit → duplicate detection
→ convert → delete), inbox, telephony, inventory, reports, the full admin surface, and permission
enforcement across three profiles.

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

* **Speech-to-text needs a provider.** A dedicated Whisper-compatible connection wins; otherwise a
  configured Groq or OpenAI provider is reused for transcription. With neither, audio stays intact
  and the feature reports that transcription is unavailable.
* **Dashboard drag-to-resize is desktop-only.** On ≥1024 px widgets can be dragged and resized and
  the layout persists to the server; below that the grid falls back to responsive auto-flow (see the
  README of `react-grid-layout` if you want finer control over the handles).
* **The workflow builder is fully editable in the UI.** Workflows are seeded declaratively; the admin screen lists, inspects, enables, deletes and composes new ones visually.
* **No LLM provider ships configured.** Every AI feature pairs a deterministic rule engine with an optional model pass and runs on the fallback until a key is added in Admin → Integrations. That includes shoot descriptions — with no key, a capture group shows its thumbnails and times and nothing else. Gemini, Groq and OpenRouter all have free tiers; any OpenAI-compatible endpoint or a local Ollama works too.
* **Capture has not been used on a real site visit.** It is verified in a browser at 390px and against a stand-in provider. Sunlight, one hand, no signal and EXIF offsets from a real camera are the assumptions it is built on, and none of them have been tested where they actually apply.
