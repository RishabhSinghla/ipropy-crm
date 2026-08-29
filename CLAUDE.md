# CLAUDE.md — permanent instructions for iPropy CRM

Read `PROJECT_HANDOVER.md` for full context (architecture, state, roadmap, known bugs).
This file is the short list of rules that must hold in **every** session.

---

## What this project is

iPropy is an AI-native, **metadata-driven** CRM for Indian real estate. Modules, fields, layouts,
picklists, views, roles, sharing rules, workflows and dashboards are **data, not code** — admins
reshape the product at runtime with no deploy and no DDL.

Stack: Node 20 + TypeScript + Express + PostgreSQL 16 · React 18 + Vite + Tailwind + TanStack Query ·
Socket.IO · Claude. npm workspaces: `packages/{shared,server,web,mcp}`.

Vtiger (at `../vtigercrm`) is an **architecture reference only**. No Vtiger code is used.

---

## Critical rules — violating these breaks the system

1. **Version control is in place.** The repo is a git repository (branch `main`, remote `origin`). Commits are the only undo — be careful with destructive commands.

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
* **There are two modules:** `leads` (labelled "Leads & Contacts") and `properties`.
  Migrations `030`, `031` and `048` removed the other eleven. Do not reintroduce one to hold a field —
  Projects and Activities both died because they existed only to carry a value the lead or the unit
  could hold itself.
* **There is no separate Contacts module.** Leads is the single party record carrying
  `lifecycle_stage`: `Lead → Prospect → Customer → Past Customer`. Conversion promotes the record
  **in place** — it does not create a second person.
* **A follow-up is a date on the record, not a task record.** `core/workflow/followUp.ts` is the one
  definition of "chase them on `<date>`" — it writes the date, a timeline note and a notification.
  Every caller that used to create an Activity goes through it.
* **Core modules** (`leads`) have `is_core = true` and cannot be disabled.
* **Fields live in two places:** `ipy_field.storage` is `'column'` (real column, real index) or
  `'json'` (key in `custom_fields` JSONB). The query builder resolves both. Admin-created fields are
  always `'json'` — that is why adding a field needs no DDL.
* **A field with `config.__record` lives on `ipy_record`, not the module's payload table.** `owner_id`
  is the one that matters. Creating a same-named column on the payload table does **not** error — it
  shadows the real one in `SELECT r.*, p.*`, and every record silently reads back as unassigned.
  This has been hit once; `seed/helpers.ts ensureColumn` guards against it.
* **Deleting a seeded field needs a tombstone.** The seed rebuilds every module on each run, so a
  deleted `ipy_field` row comes straight back. `ipy_field_tombstone` (migration `032`) is what makes
  the deletion durable, and `upsertModule`/`seedDefaultLayouts` consult it. A permanent delete also
  drops the column: several are `NOT NULL` with no default, so metadata-only deletion breaks inserts.
* **Deleting a dropdown option needs a tombstone too.** Same trap, same fix:
  `ipy_picklist_tombstone` (migration `049`), consulted by `upsertPicklist`. A row with `value = ''`
  tombstones the whole dropdown. Adding the option back clears its tombstone — that is a decision,
  not an accident.
* **A dropdown option is a string on every record that chose it, not a foreign key.** Renaming the
  *stored value* without rewriting those records orphans them: still stored, no longer offered,
  matched by no filter, invisible until somebody runs a report. `core/metadata/picklists.ts` is the
  one place that does both halves — records (column and `custom_fields`, single and multi) plus the
  saved views, widget configs and workflow conditions that name the value. The editor sends
  `previousValue` so the server can tell a rename from a delete-and-add.
* **A layout an admin edited is off-limits to the seed.** `ipy_layout.is_customised` is set by
  `PUT /api/meta/layouts/:id`; `seedDefaultLayouts` skips those rows. Without it, re-seeding silently
  undoes the sections, header fields and default tab somebody arranged.
* **The timeline is human events only.** `buildTimeline` merges audit, comments, messages, calls,
  emails and attachments — deliberately *not* `ipy_ai_insight`. A score the model recalculates on
  every change is not something that happened to the customer, and interleaving it buried the calls
  and notes the page exists to show. Insights render in the AI Insights panel beside the feed.
* **One filter grammar, two engines:** `core/query/builder.ts` → SQL (lists, widgets, reports);
  `core/query/evaluate.ts` → in-memory (workflow conditions, conditional visibility). Keep them in
  step.
* **A photo finds its property by the clock, never by GPS.** A shoot session
  (`ipy_shoot_session`) binds a property to a window of time; a photo taken inside that window is
  filed against it. Location is recorded and is good for segmenting a day into visits, but adjacent
  builder floors are ten to twenty metres apart — well inside a phone fix's error. Don't be tempted.
* **EXIF `DateTimeOriginal` carries no UTC offset.** It is local wall-clock time and the tag does not
  say where. Read as UTC in India every photo lands 5½ hours early — a day's drift is one or two
  properties' worth, filing against the wrong floor. Resolution order is `OffsetTimeOriginal` → the
  organisation's configured timezone (through `Intl`, not hardcoded) → UTC. Video is different:
  `ffprobe`'s `creation_time` is already zoned, so it is taken at face value and **not** offset again.
* **A shoot with no name is a normal state, not an error.** `origin` is `'manual'` (somebody tapped
  Start) or `'auto'` (inferred from a 40-minute gap between photos). Manual always outranks auto: a
  guessed group yields its photos to a visit somebody actually opened, but **never once it has been
  named** — that is a decision, not a guess.
* **Shoot vision never writes to the record.** A model can see a modular kitchen; it cannot see that
  this is B-110 and not B-112. It also only looks at *nameless* shoots, and a worker that spends an
  attempt when it finds no provider burns its three retries in three minutes and marks everything
  permanently failed — the tests pin this.
* **A lead's name is one field and its phone is two.** `full_name` is mandatory; `country_code` is a
  picklist and `mobile` holds national digits with a per-country length (`digitsMap`). Migration
  `026` made both changes and `integrations/leadsources/capture.ts` kept writing the old
  `first_name`/`last_name` pair and a full E.164 number, so **every** automated lead — website form,
  Facebook, Google, the portals, email — failed validation and was thrown away. Nothing showed it:
  the public form answers 200 with its success message regardless, and the only trace was
  `ipy_lead_inbox.status = 'failed'`. `splitPhone` in `@ipropy/shared` is the inverse of
  `toInternational` and is what any new source must use.
* **A share link is not the public website.** `/api/public/properties` is a catalogue (`Available` +
  published); the property somebody wants to send is usually this morning's draft. Every share-link
  failure — revoked, expired, mistyped, deleted — must resolve to **the same 404**. Its photos come
  from the record's attachments, not the `gallery` field, which is empty on anything from capture.
  Note `/:module/:id/share` and `/shares` already exist and mean *granting a user access*; the link
  routes are `/share-links`.

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
PROD_DATABASE_URL='…' npm run db:pull-prod
                              # DESTRUCTIVE (local only): make localhost a copy of production,
                              # backing up local first. Never writes to prod; does not copy
                              # uploaded files, only rows.
npm test                      # unit suites (no DB needed)
npm run test:integration      # API + recordService against a real throwaway Postgres
npm run test:e2e              # Playwright against a real browser and the dev stack
```

Login: `admin@ipropy.com` / `Admin@123`. Other demo users in `PROJECT_HANDOVER.md` §9.

**Verification:** three layers, fastest first.

* `npm test` — 374 unit tests, no DB: 320 in `packages/server` (query builder, filter evaluator,
  formula engine, permissions and role-hierarchy scoping, validation, unstorable characters, seed
  templates, billing decisions, capture time/EXIF offsets, watermark sizing, vision sampling, file
  serving headers), 46 in `packages/web` (colour contrast and safe markdown), and 8 in
  `packages/mcp` (tool-output formatting).
* `npm run test:integration` — creates and drops its own `ipropy_itest` database, plus
  `ipropy_itest_control` (the customer list) and `ipropy_itest_tenant` (a customer provisioned into
  it during the control-plane suite). Never point it at a database you care about; `vitest.config.ts` deliberately excludes `tests/integration/**` from
  `npm test` so the unit run cannot touch a real DB.
* `npm run test:e2e` — Playwright. Runs against the **developer's own database** on purpose, so
  specs create records with unique markers and never assert on global counts.

`npm run typecheck` must still be clean before finishing any change.

**A green local run does not mean the deploy works.** Render clones the repo and builds from
source; a developer's machine builds on top of whatever is already in `packages/*/dist`. Those are
different builds, and only one of them is what the team actually gets.

Two traps, both of which have already cost a full day of failed deploys:

* **Workspace build order.** `packages/server` imports `@ipropy/mcp`, whose types come from
  `dist/lib.d.ts`. The root `build` and `pretypecheck` scripts must build a workspace *before*
  anything that imports it — `shared`, `mcp`, `server`, `web`. Locally the stale `dist` hides a
  wrong order completely; from a clean checkout it is an immediate `TS2307`.
* **`.dockerignore` matches full paths from the context root.** A bare `dist` excludes `/dist` and
  leaves every `packages/*/dist` in place, so `COPY . .` ships the developer's build output into
  the image and `npm run build` there can no longer fail. Anything that can appear inside a
  workspace needs `**/` — `**/dist`, `**/node_modules`, `**/*.tsbuildinfo`.

To check the real thing before pushing:

```bash
docker build --platform linux/amd64 -t ipropy-crm:local .   # what Render runs; CI runs this too
```

And after pushing, ask the running site rather than assuming:

```bash
scripts/verify-deploy.sh 'a string only the new code has'
```

**The automation half is deployed separately and drifts silently.** n8n and the media
worker run in containers on a machine, not from this repo, so nothing here fails when
they fall behind. Twice they have: a media container months out of date that reported
`ok: true` with four of its seven steps missing, and an n8n workflow pointing at a folder
that no longer exists, which made every picture correctly and delivered none of them for
six days. Both looked healthy from every angle a test can see.

```bash
python3 scripts/check-deployed.py   # live n8n + media container vs this repo
```

It compares node by node and file by file, and fails when a workflow is switched **off** —
which `n8n import:workflow` does every time it runs, in a line that is easy to miss. Always
follow an import with `n8n update:workflow --id=<id> --active=true` and `docker restart n8n`.

**CI is the deploy gate, not advice** — except right now, and the exception has a
date on it. `render.yaml` normally sets `autoDeployTrigger: checksPass`, so a red run
means Render never builds while the container happily restarts for other reasons, which
looks exactly like a slow deploy. Check `gh run list` before concluding one is stuck.

> **Until 1 September 2026 it is `commit`.** GitHub's free Actions minutes ran out on
> 23 August (a health check billed at a whole minute, 96 times a day — see
> `.github/workflows/health.yml`), so no check could run and nothing could deploy. The
> minute usage is fixed and the allowance resets on the 1st; put both `render.yaml` **and
> the Render dashboard** back to `checksPass` then. While it is `commit`, **every push to
> main goes straight to production**, so nothing half-finished may be pushed, and
> `npm run typecheck`, `npm test`, `npm run test:integration` and a real
> `docker build --platform linux/amd64` all have to pass locally first. Two traps the script exists to encode: `grep` on a fetched bundle needs `-a` (BSD
grep calls it binary and silently prints nothing), and the lazy route chunks are **not**
named in `index.html` — their filenames live inside the entry chunk, so checking only what
the HTML references finds nothing and reads as a failed deploy.

Adding a workspace also means adding its `package.json` to the Dockerfile's `deps` stage. npm still
links a missing workspace from the lockfile, so leaving it out fails quietly rather than loudly.

---

## Conventions

* **Seeding is idempotent and create-only.** To change the data model, edit
  `db/seed/templates/realEstate.ts` and re-run `npm run db:seed`. Anything an admin can edit in the
  UI — dashboards, workflows, views, assignment rules, templates, picklist values, profiles, sharing
  — is written only when absent and never rewritten, because `docker-entrypoint.sh` re-seeds on every
  cold start and used to reset all of it several times a day (migration `033`). Consequence to know:
  **editing a seed definition does not reach a database that already has that row.** To change one,
  change it in the UI, or delete the row and re-seed. Module/field/relation structure is the
  exception and still upserts — `ipy_field.is_customised` is what protects an edited field's label,
  validation and visibility from that upsert.
* **Migrations are forward-only**, numbered `00N_name.sql`, each applied in its own transaction and
  recorded in `ipy_migration`. Write them defensively (`IF EXISTS`) so they no-op on a fresh DB.
* **Colour goes through tokens, not raw palette steps.** Secondary copy is `text-muted`; up/down
  deltas are `text-positive`/`text-negative`; anything tinted from an admin-chosen hex (badges,
  status chips, module tiles, metric values) goes through `badgeVars`/`tintedTextVars` in
  `web/src/lib/color.ts`, never `` `${color}18` `` inline. Painting a raw hue as text on a tint of
  itself lands around 2–3:1; the helpers keep the hue and move lightness until it clears WCAG AA.
  `tests/color.test.ts` asserts the ratios and the a11y e2e spec scans both themes, so a regression
  fails the build rather than shipping.
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
packages/server/src/db/seed/templates/          starting data models, one file per trade
packages/web/src/components/FieldRenderer.tsx      metadata → UI
packages/server/src/core/capture/                  shoot sessions, EXIF matching, grouping, vision
packages/server/src/ai/client.ts                   two transports; `images` is what carries photos
AI-ARCHITECTURE.md                                 what the AI stack already has, and what it must not grow
```

**Before adding any AI framework, read [`AI-ARCHITECTURE.md`](AI-ARCHITECTURE.md).** It maps every
name in the current AI vocabulary — gateways, RAG, agentic memory, guardrails, observability,
vector databases — onto the thing in this repo that already does that job, names the three genuine
gaps, and says which additions would actively undo work already done. LangGraph is the clearest
example: the pipeline order deliberately lives in n8n, on a canvas an admin can edit, and pulling it
back into TypeScript would reverse that.

---

## Known open issues (details in PROJECT_HANDOVER.md §8)

* Deployed on Render from `render.yaml` (see `DEPLOYMENT.md`); every push to `main` redeploys.
  Production generates its own `JWT_SECRET` and sets `SEED_DEMO_DATA=false` — that gate must stay
  false, since the demo seed creates ~12 users sharing a password published in this repo. **Local
  dev still uses the committed defaults**, so never point a dev `.env` at the deployed database.
* `WHATSAPP_APP_SECRET` is unset. **Scheduled backups of the deployed database are not on** — the
  launchd timer covers a developer's local Postgres only. The intended fix is Neon's own scheduled
  backups + instant restore (paid Launch plan), *not* a dump job in this repo; that was shipped once
  and deliberately removed. See `DEPLOYMENT.md` §7 before building anything here.
* Speech-to-text, email IMAP inbound, rollup fields and the Channel Partner portal shipped as
  graceful-degradation features — they need real credentials/keys to be exercised end-to-end.
* Dashboard drag-to-resize is wired (react-grid-layout on desktop, persisted via `saveDashboardLayout`).
* **A provider key is saved, but no model answers.** Gemini and Groq are active in
  Admin → Integrations, and the media worker still gets `No AI provider answered` from production.
  The reason is not a missing key: `complete()` uses `opts.model ?? ai.model`, so the id in
  Admin → Settings → AI models **overrides the provider's own model**, and the shipped ids are
  OpenRouter ones. An OpenRouter id sent to Gemini is a 404. Two ways out, and only one costs
  anything: add an OpenRouter key, **or** paste a Gemini id into those boxes and the existing key
  does the work. Each box has a **Test** button that makes the real call.
* **Semantic search is built and has never been switched on.** pgvector 0.8.6 is installed,
  `ipy_embedding` exists, and it holds zero rows, because indexing needs the embedding model above.
  Searching by meaning across leads, notes, messages and calls is inert until that is fixed — and it
  fails quietly, as ordinary keyword search.
* **Site capture now runs end to end and is proved.** A property finished in the CRM reaches n8n,
  the worker names, finishes, cuts every shape, watermarks, builds the reel and the walkthrough,
  and the finished pictures come back onto the record. Run 4733 is the reference. What has *still*
  never happened is a real site visit: sunlight, one hand, no signal and EXIF offsets from a real
  camera are assumptions, not observations.
* **`properties.city` and `properties.project_name` were removed on purpose. Do not restore them,
  and do not protect them.** The owner's words: *"I deliberately removed those two fields."* He sells
  builder floors in one area, so a project grouping and a city filter are both noise on his own site.
  `/api/public/projects` and `/api/public/cities` correctly answer with nothing as a result, and the
  website no longer offers those sections — its header and footer ask the CRM what exists. Both were
  on `FIELDS_USED_IN_CODE` for one day, on the assumption the removal was an accident; that is
  reverted, and `tests/fieldsUsedInCode.test.ts` pins their absence so it does not come back.
* **Prices on the two published properties are `0`.** The public site reads that as "Price on
  request" rather than "₹0", and `propertyFacts` drops it so no reel prints ₹0 on its title card.
  Filling them in is still an admin job.
* Branches `fix/watermark-retry-loop` and `feat/property-share-links` were squash-merged on
  12 August but still exist on the remote — an agent session's git credentials can't delete them.
* **Social links in `social.links` were found by web search, not supplied by the business.** Two
  iPropy Instagram accounts exist. Treat them as unverified until someone confirms each one.
* Browser push works but **nobody has subscribed a device yet** — Settings → Alerts, per device.

---

## AI providers

`ai/client.ts` has two transports: the Anthropic SDK, and one `fetch` adapter speaking the OpenAI
chat-completions shape that covers **Gemini, Groq, OpenRouter, any OpenAI-compatible endpoint and a
local Ollama**. Resolution lives in `core/settings/integrations.ts` (`resolveAi`): an explicitly
activated provider wins, then `AI_PROVIDER`, then first-with-a-key in `AI_PROVIDER_ORDER`.

Two traps worth knowing:

* **Claude Code's own shell exports `ANTHROPIC_API_KEY`.** A server started from an agent session
  can therefore look like it has AI configured when `npm run dev` in a normal terminal does not.
  Use `env -u ANTHROPIC_API_KEY` when testing the no-provider path.
* `getAiProviderSettings(provider)` exists so the admin panel's "Test connection" tests the card the
  admin clicked, not whichever provider happens to have won resolution. Don't reach for
  `getSettings().ai` there.

---

## Connected apps (MCP)

`packages/mcp` exposes the CRM to Claude, ChatGPT or any MCP client. It holds **no**
business logic and **never** touches the database: every call goes out through the
CRM's own HTTP API carrying a personal API key, so profile permissions, the role
hierarchy, sharing rules, field visibility, validation, workflows and the audit trail
all apply unchanged. A direct query would have none of them — that is the whole reason
this is safe to point at real customer data.

Three rules the server side enforces, in `middleware/auth.ts`:

* `requireAuth` accepts an `x-api-key` as well as a session token, and records which
  one it was in `req.authSource` → `ipy_audit.source`, so an assistant's writes are
  distinguishable from a person's.
* `blockApiKey` shuts the admin router and every non-GET metadata route. A key can
  read the schema (an assistant needs the field names); it can never reshape it, and
  it can never administer the CRM — including when the key belongs to an admin.
* The records router refuses `DELETE` and `mass-delete` from a key entirely. A key
  reads, creates and updates. Nothing else.

Two transports, one set of tools (`createMcpServer` in `packages/mcp/src/server.ts`,
so they cannot drift): **stdio** for an assistant launched on a laptop, and **HTTP** at
`/api/mcp` on the CRM itself for remote clients. The HTTP one is stateless — a session
map would live in the memory of a container Render restarts at will, so a redeploy would
404 every open assistant — and its tools reach the CRM over loopback rather than calling
`recordService` directly, deliberately: one enforcement path, not two.

Both start **read-only**. Writing is opt-in per connection: `IPROPY_READ_ONLY=false` for
stdio, an `x-ipropy-write: allow` header for HTTP. See `packages/mcp/README.md`.

**Still to build:** OAuth 2.1, which is what a one-click connector in the Claude or
ChatGPT apps requires. The API-key path works today with Claude Code and anything that
can set a header.

---

## WhatsApp: two doors, one queue

1. **Meta Cloud API** (`integrations/whatsapp/provider.ts`) — sanctioned, unconfigured,
   needs approval and a paid BSP. Templates only outside the 24-hour window.
2. **`wa.me` hand-off** (`integrations/whatsapp/deviceSend.ts`) — the CRM writes the
   message, a person taps send. The floor, and it never goes away.

Both fill and drain `ipy_device_send`.

**A third door existed and was removed on 2026-08-18 (migration `060`).** A linked phone,
the WhatsApp Web mechanism, run through a `wa-bridge/` process: the rep's own number, no
approval, no fee, against WhatsApp's terms. It worked, and working is what killed it —
pointed at a real handset it imported 821 chats, which is a person's private life in a
business database. Scoping them per-user (migration `056`) hid them from colleagues, and
holding them was still the wrong thing.

Removed with it: `ipy_wa_link`, `wa_link_id`/`claimed_at`/`priority`/`message_id` on the
queue, `private_to_user_id` on conversations, the bridge endpoints, the WhatsApp sidebar
page and the `whatsapp_linked` provider. The owner asked for a clean slate so it can be
rebuilt deliberately later.

**If it is rebuilt, the things that cost a night to learn:** history arrives exactly once
during the handshake after a scan and cannot be re-requested; Baileys must be on the
`latest` dist-tag, since a year-old client is refused the moment it asks for a full sync
(presenting as an endless 428 with no QR); history must never be replayed through
`handleInbound`, which would auto-reply to every customer about something they said months
ago; and pacing belongs in the CRM, never in a laptop script that forgets on restart. It
must also decide, up front, that a business CRM has no business storing a rep's personal
chats.

## Scale

`scripts/load-test-data.sql` loads a realistic year — 60,000 leads, 8,000 units, 272,000
audit rows — into a **throwaway** database in about fifteen seconds. Never point it at a
database you care about; it inserts directly, so no validation or workflows run.

```bash
docker exec ipropy-db psql -U ipropy -d postgres -c "CREATE DATABASE ipropy_scale;"
DATABASE_URL='postgresql://ipropy:ipropy@localhost:5432/ipropy_scale' npm run db:migrate
DATABASE_URL='postgresql://ipropy:ipropy@localhost:5432/ipropy_scale' npm run db:seed
docker exec -i ipropy-db psql -U ipropy -d ipropy_scale < scripts/load-test-data.sql
```

Measured at that size, all well indexed: lists 59ms, deep paging 73ms, text search 42ms,
matching 33ms, comparables 8ms, dashboard 4ms.

**The shape to watch for**, which has now been found four times in this codebase: a
bounded slice, ordered by something unrelated to what is done with it afterwards.

* `matchBuyersForProperty` — `ORDER BY ai_score DESC LIMIT 400`. At 99 leads that is
  everybody; at 60,000 it is the four hundred best leads *in the business*, which says
  nothing about whether any wants a 4 BHK in Baner. Ten buyers per unit became zero.
* **The scheduler** — every scheduled workflow walked `ORDER BY updated_at DESC LIMIT
  5000`. Worse than truncation: each of those rules is about *neglect*, so the records
  they exist to catch are the least recently updated and fall out of that slice first.
  A lead untouched for sixty days ranked 60,075th of 60,085. Conditions are pushed into
  SQL now via `buildWhere`; the in-memory pass still gates, so SQL only narrows.
* **Inbound email** — a 5,000-row address map with no ORDER BY, so replies from anyone
  outside it stopped threading. Now resolved per sender, memoised per poll.
* `candidateInventory` — the sixty *cheapest* units in budget, then scored. Now ordered
  by configuration and locality first, price as tiebreak.

The rule: if a query takes `LIMIT n` and the rows are then filtered or scored in memory,
the ORDER BY must encode relevance to *that specific decision*, and the cap must log when
it bites. A silent cap is how all four of these hid.

---

## Notifications

**Never `INSERT INTO ipy_notification` directly.** Everything goes through `notify()` /
`notifyMany()` in `core/notifications/index.ts`, which writes the row, pings the socket, *and*
fans out a Web Push to that user's devices. There were nine hand-rolled copies of that INSERT;
all are converted and `notify()` is now the only writer. A new one is a regression — the row
would appear in the bell and reach no phone, which looks like working code and isn't.

VAPID keys are generated once and stored in `ipy_integration` under provider `web_push`. **Rotating
them silently invalidates every subscription already issued**, which is why they are not
per-process and not regenerated on boot.

---

## "New since you last looked"

`core/entity/unseen.ts`. A record is new for a user when it was created after that user's
`ipy_module_seen` watermark **and** they have never opened it (`ipy_recent_view`). Both halves
matter: no watermark means first login lights up every historical record; no open-check means a
lead you already worked stays bold forever.

Deliberately *not* part of `listRecords` — that engine is shared with exports, reports, widgets and
the portal, none of which have a reader for something to be unread for.
