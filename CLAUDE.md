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
* **There are three modules:** `leads` (labelled "Leads & Contacts"), `properties`, `campaigns`.
  Migrations `030` and `031` removed the other ten. Do not reintroduce one to hold a field —
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
* **A layout an admin edited is off-limits to the seed.** `ipy_layout.is_customised` is set by
  `PUT /api/meta/layouts/:id`; `seedDefaultLayouts` skips those rows. Without it, re-seeding silently
  undoes the sections, header fields and default tab somebody arranged.
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
npm test                      # unit suites (no DB needed)
npm run test:integration      # API + recordService against a real throwaway Postgres
npm run test:e2e              # Playwright against a real browser and the dev stack
```

Login: `admin@ipropy.com` / `Admin@123`. Other demo users in `PROJECT_HANDOVER.md` §9.

**Verification:** three layers, fastest first.

* `npm test` — 349 unit tests, no DB: 303 in `packages/server` (query builder, filter evaluator,
  formula engine, permissions and role-hierarchy scoping, validation, unstorable characters, seed
  templates, billing decisions, capture time/EXIF offsets, watermark sizing, vision sampling, file
  serving headers) and 46 in `packages/web` (`tests/color.test.ts`, the
  contrast guarantee behind the colour tokens, and `tests/markdown.test.ts`).
* `npm run test:integration` — creates and drops its own `ipropy_itest` database, plus
  `ipropy_itest_control` (the customer list) and `ipropy_itest_tenant` (a customer provisioned into
  it during the control-plane suite). Never point it at a database you care about; `vitest.config.ts` deliberately excludes `tests/integration/**` from
  `npm test` so the unit run cannot touch a real DB.
* `npm run test:e2e` — Playwright. Runs against the **developer's own database** on purpose, so
  specs create records with unique markers and never assert on global counts.

`npm run typecheck` must still be clean before finishing any change.

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
```

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
* **No LLM provider is configured.** Every AI feature runs on its fallback rule engine until a key
  is added in Admin → Integrations. Gemini/Groq/OpenRouter have free tiers; see §"AI providers".
  This now includes shoot descriptions — with no key a capture group shows thumbnails and times only.
* **Capture has never been used on a real site visit.** Verified in a browser at 390px and against a
  stand-in OpenAI-compatible server. Sunlight, one hand, no signal and EXIF offsets from a real
  camera are the assumptions it rests on, and none have been tested where they apply.
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

**The bug it found, and the shape to watch for.** `matchBuyersForProperty` pre-filtered with
`ORDER BY ai_score DESC LIMIT 400`. At 99 leads that is everybody; at 60,000 it is the four
hundred best leads *in the business*, which says nothing about whether any of them wants a
4 BHK in Baner. Ten buyers per unit became zero, silently, from identical code. Any
`ORDER BY <global ranking> LIMIT <n>` feeding an in-memory scorer has this defect — the
ordering has to encode relevance to the specific thing being matched.

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
