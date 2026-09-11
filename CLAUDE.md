# CLAUDE.md — permanent instructions for iPropy CRM

Read `PROJECT_HANDOVER.md` for full context (architecture, state, roadmap, known bugs).
This file is the short list of rules that must hold in **every** session.

---

## What this project is

iPropy is an AI-native, **metadata-driven** CRM for Indian real estate. Modules, fields, layouts,
picklists, views, roles, sharing rules, workflows and dashboards are **data, not code** — admins
reshape the product at runtime with no deploy and no DDL.

Stack: Node 20 + TypeScript + Express + PostgreSQL 16 · React 19 + Vite + Tailwind + TanStack Query ·
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
* **There are two modules:** `leads` (labelled "Contacts" since migration `096` — the *name*
  stays `leads`, because it is the URL, the API path and the key inside every saved view,
  workflow condition and bookmark) and `properties`.
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
  tombstones the whole dropdown. Adding the option back clears its tombstone — but **only when the
  caller asks for it by name** (`restore: [...]` on the values PUT). It used to be cleared for every
  value in the payload, and since the editor sends its whole list on every save, a list loaded
  before a deletion and saved after silently re-created the option and wiped the tombstone keeping
  it gone. Anything tombstoned and not named in `restore` is skipped and returned in `skipped`.
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
bash scripts/automation-up.sh       # start n8n + the media worker
python3 scripts/check-deployed.py   # and check both against this repo
```

**The automation's settings live outside this repo, in `~/.ipropy/automation.env`
(chmod 600).** `automation-up.sh` recreates both containers from that file, so
the containers are disposable and the settings are not. `MEDIA_`-prefixed names
go to the media worker with the prefix stripped; the rest go to n8n — one file
for two containers that both want a variable called `CRM_URL` and do not mean
the same thing by it.

That file is the only copy of the n8n API key. A key cannot be read back out of
the CRM, only rotated (`Rotate API key`), and losing it stops media *delivery*
while the polling still succeeds — so it fails silently. The container name
matters too: n8n reaches the worker at `http://ipropy-media:8080`.

**Two walkers, and they check different promises.** `definition-of-done.mjs`
walks what the product promises an *administrator* — create a field and it is
everywhere, rename it and nothing breaks, delete and restore it and the data
comes back. `daily-paths.mjs` walks what it promises a *rep*: add the person
you just spoke to, change their status, leave a note, run your list, send a
unit to a buyer, and let the phone file the calls you made.

```bash
API=http://localhost:4000 node scripts/definition-of-done.mjs   # 20 checks
API=http://localhost:4000 node scripts/daily-paths.mjs          # 19 checks
```

Neither may be pointed at production — both create records. The second exists
because four of those paths were broken on production at once on 11 September
2026 (logging a call, the device call sync, the WhatsApp send, lead scoring),
each failing quietly in its own way, with every unit and integration test green.
**Run both against a database mirrored to production's shape**
(`scripts/mirror-prod-shape.sh`), not a fresh seed — on a fresh seed every one
of those four passes.

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

## Going live — the state of it, 2026-09-01

* **The deploy gate is back on.** `autoDeployTrigger: checksPass` in both
  `render.yaml` and the Render dashboard, and **they must agree** — they
  disagreed for nine days and a blueprint sync would have silently reverted the
  dashboard. GitHub Actions minutes reset on the 1st; the first green CI run
  since 23 August was `9c4dbd5`.
* **Backups exist.** The nightly job had never once succeeded — every attempt
  failed in three seconds for want of minutes. Triggered by hand on 1 September
  and it completed every step, including **"Prove it restores"**, which restores
  the dump into a scratch database before uploading. All five R2 secrets were
  already present; it was only ever the minutes.
* **A deploy can fail where CI passes, and it is intermittent.** `9c4dbd5`
  passed all three checks and Render's build failed after 16 minutes; `d941460`,
  with the same setup and more code, succeeded. A clean
  `docker build --no-cache --platform linux/amd64` passes locally either way, so
  it is not the code — it is the free tier's build resources, and it will happen
  again. `node_modules` is 456 MB. **The symptom is a fix that never reaches
  production while everything looks green**, so check
  `gh api repos/OWNER/REPO/deployments` and its `/statuses` before assuming a
  deploy is merely slow. A retry usually works. The paid instance since 4 September should stop it, but
  that is an expectation rather than something observed yet.
* **A markdown-only commit CAN deploy, and this file used to say the opposite.**
  CI has `paths-ignore: '**/*.md'` so it does not run on a docs commit — that
  part was right. The conclusion drawn from it was wrong: `checksPass` waits for
  whatever check suites report on the commit, and it accepts **any** of them, not
  specifically CI. `a8eca56` on 4 September was CLAUDE.md alone, CI never ran, a
  scheduled *Production user audit* reported success on that SHA, and Render
  auto-deployed twenty-nine seconds later.
  So the gate is weaker than its name suggests: a workflow that has nothing to do
  with whether the code compiles can satisfy it. Worth knowing before trusting it
  to hold back a bad commit.
* **`gh run list` is not the whole story on why something deployed.** Render's
  own deploys page names the trigger, and the answers there are not always
  "Auto-Deploy": `fefa721` shows twice on 4 September, once as **Manual — by
  you** and once as **Compute plan updated**. A red CI run next to a deploy of
  the same commit looked like the gate failing, and it was neither.
* **Render is on the paid instance, and the sleeping is measured as gone.**
  `render.yaml` declares `plan: 0.5c-512mb` ($7/month), paid 4 September 2026;
  Render's deploys page records the changeover as a deploy triggered by "Compute
  plan updated". Verified by leaving production completely alone for 21 minutes
  and reading `/api/health`: uptime went 772s → 2032s, a difference of exactly
  1260s, so it ran continuously through a window the free tier would have slept
  in twice.
  Two earlier attempts to measure this concluded the opposite, both wrong, both
  because a deploy restarted the service mid-test and uptime resetting looks
  identical either way. **If you measure this again, stop pushing first**, and
  check the deploys page before reading a reset as a sleep.
  What it buys is not speed. The scheduler shares this process, so a sleeping
  instance meant no follow-up reminders, no lead escalation and no birthday
  messages overnight and at weekends — silently, with nothing logged.
* **The demo logins are gone from production.** `go-live:users` has been run: the
  4 September deploy seeded `users ✓ (1)`, a single real account. The twelve
  demo users sharing a password published in this repo no longer exist there.
* **Production answers on `crm.ipropy.com`**, with `ipropy-crm.onrender.com` still
  working alongside it. DNS is at **Wix**, not GoDaddy — GoDaddy is only the
  registrar, its DNS page is ignored, and a record typed there does nothing. The
  subdomain is one CNAME to `ipropy-crm.onrender.com`, and `APP_URL` must list
  every origin the app answers on or the browser is refused and **passkey sign-in
  breaks**, since the relying-party check reads that list.
* Still open: no error-reporting DSN pasted in (the Sentry code is complete and
  applies a pasted DSN without a redeploy), and no staging environment.

### Two bugs the restored gate caught immediately

Both were mine, both invisible, and both had been live for a day or more.

* **The mobile browser suite had been failing since 29 August.** A test helper
  was pointed at a `data-record-card` marker for phone-sized screens and the
  marker was never added to the app. Seven tests, every run, 30-second timeouts
  each. Not noticed because the suite was never run whole — only two spec files
  at a time. **`npx playwright test` with no arguments, or it does not count.**
* **Lead scoring failed on every lead for a day.** Removing the AI grade took
  `ai_grade = $3` out of an UPDATE and renumbered what followed, except `rating`,
  which stayed `$5` with four values bound. Postgres refuses the whole statement
  (42P18) and the caller is a workflow task that logs and carries on, so scores
  simply stopped moving. **This is rule 8, and it is now the fourth occurrence.**
  `tests/integration/leadScoringPersists.test.ts` runs it against a real
  database and asserts the row changed — a mocked `db.query` accepts any
  parameter list, and the SQL is a string, so neither typecheck nor a unit test
  can see it.

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
* **AI answers now.** An OpenRouter key is saved and listing copy, reading photos and voiceover all
  work on production. Six of the eight model jobs pass their Test button.
* **Two jobs still fail, and it is not the id and not the request.** Search (embed) and
  Reorder (rerank) both go to endpoints that exist (`/embeddings` and `/rerank` answer 401
  unauthenticated, where a made-up path answers 404), with ids OpenRouter itself lists under those
  exact modalities, in the request shape its own documentation prints. All three were checked. So
  what is left is account-side — most likely the free NVIDIA endpoints needing the data-policy
  setting under OpenRouter's privacy page, or a key without access to them. **The Test button
  repeats the provider's own words**, so one click names it. Do not guess replacement ids; that is
  how the four wrong defaults shipped.
* **The model boxes offer real ids now** (`ai/modelCatalogue.ts`). Each one lists what OpenRouter
  serves for that job, free first, priced in rupees. Three rules encoded there: it stays free text
  so a retired list cannot lock somebody out; "Free" is claimed only for a `:free` id, because an
  empty pricing block means *billed elsewhere* — every video and rerank model has one; and any
  failure returns `[]` so the settings page never depends on a third party being up. Transcribe is
  deliberately absent — it does not go to OpenRouter.
* **Transcription goes to the speech-to-text integration, not OpenRouter** (migration `079`). It was
  wrong twice: wrong service, and JSON with base64 audio where every OpenAI-compatible endpoint
  wants multipart with a `file` part. **The `stt` row still has no API key**, so it fails with "Add
  one in Admin → Integrations" until a Groq key is pasted in. Base URL and model are already right.
* **Music sends only parameters its model accepts.** `modalities` and `audio` were on the request
  and are on no music model's `supported_parameters`, so the whole call was refused in 0.0s.
* **Semantic search is live.** Checked on production 11 September 2026: 355 rows in
  `ipy_embedding` across both leads and properties, written by
  `nvidia/nemotron-3-embed-1b:free` — the very id the note above records as failing — with the
  newest that morning. Whatever was wrong account-side has been sorted; **do not go hunting for a
  replacement id.** Rerank is still unverified, because it runs at query time and leaves nothing
  behind to look at.

  The model settings live in `ipy_setting` under `ai_models.*`, not `ai.model*`, and
  `scripts/../.github/workflows/check-prod.yml` prints them along with the embedding count.
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

### Verified security findings, 2026-08-30 — all closed

An external review raised eight. Each was checked against the code rather than
taken on trust, and **every one was true**. All are now fixed; this is kept as
the record of what was wrong and why the fixes are shaped as they are.

* **Public file routes served an uploaded mime type raw.** `applyFileSecurityHeaders`
  existed and ran only on the signed-in route. Four public byte-serving sites
  never called it, so a published SVG ran scripts on the CRM's own origin. Fixed;
  `tests/publicFileHeaders.test.ts` fails if a fifth route appears without it.
* **Telephony webhooks authenticated nobody.** Twilio now verifies a real
  `X-Twilio-Signature` HMAC over the **forwarded** URL — Render terminates TLS,
  so signing over `req.protocol`/`req.get('host')` refuses every genuine request
  and looks exactly like a wrong auth token. Others carry a per-provider shared
  secret. **The SSRF chain the review described does not exist** and was repeated
  here once before being checked: `analyseCallRecording` reads the `transcript`
  column and nothing else, and the only server-side fetches in
  `telephony/service.ts` go to the provider's own API on configured settings.
  Nothing anywhere downloads `recording_url`. What was real: anyone could rewrite
  call records, invent calls, and get an agent's phone number from `/incoming` —
  and a hostile URL stored on a call is a link a rep might click. All closed.
* **Lead webhooks failed open.** `if (key && provided !== key)` meant a blank key
  skipped the check entirely. Google and the portals both refuse when
  unconfigured now.
* **Three AI writes had no switch.** `ai_features.fill_fields_from_calls` and
  `ai_features.follow_up_from_calls`, both defaulting on. Lead scoring is left
  alone deliberately: a score that needs confirming is a task, not a score.
  `AI-ARCHITECTURE.md` used to claim nothing writes on its own and now lists
  what does.
* **A switched-off AI provider was still used.** Now `ai.use_disabled_providers`.
  **It defaults to ON on purpose** — `ai_openrouter` is `is_active = false` while
  holding the key, so defaulting it off would take every AI feature down to close
  a hole nobody is standing in. Switch it off after enabling the cards you want.
* **Refresh tokens were plaintext and never rotated.** Migration `083` hashes in
  place (nobody is signed out), rotation mints a replacement on each exchange,
  and a replay past the grace window revokes that user's whole session family.
  **The 60-second grace window is load-bearing**: two tabs hitting a 401 together
  present the same token, and without it rotation is a random logout generator.
  The client must store the returned `refreshToken` or the next refresh reads as
  theft.

**Still open and worth doing:** both tokens live in `localStorage`; there is no
prompt-injection or AI-quality eval suite; tokens are counted in `ipy_ai_log` and
never become rupees; the largest files (`RecordDetail.tsx` at 2,727 lines) want
splitting before a second developer arrives. (The CSP gap is closed: helmet's
global policy stays off because the media routes carry their own stricter one,
and the HTML document gets a strict hand-applied policy — `applyAppSecurityPolicy`
in `app.ts`, live in production, no inline script, no framing.)

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

## Every request appears twice in development, and once in production

`main.tsx` wraps the app in `React.StrictMode`, which double-invokes effects in
development so that effects which are not idempotent show themselves. So the
network tab on `localhost:5173` shows `/api/auth/me`, `/api/meta/modules`, the
record, its comments, its neighbours and both AI panels each fetched twice, and
a full Playwright run can trip the 600-per-minute rate limit and log 429s.

**None of that happens in production.** Measured 5 September by running the
container and reading the same page: one request each. React strips StrictMode
from a production build.

Recorded because it looks exactly like an over-fetching bug and is not one.
Removing StrictMode to "fix" it would throw away the thing that surfaces real
effect bugs, in exchange for nothing.

The rate limit itself is fine: `API_RATE_LIMIT` is 600 a minute and is keyed
**per user** (`apiRateLimitKey` in `app.ts`), not per IP, so one busy person
cannot throttle the team. A test suite hits it only because a hundred specs share
one admin account.

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

Measured at that size, 11 September 2026: lists 32ms, deep paging 71ms, text search 37ms,
record detail 8ms, dashboard 4ms, **matching 28ms one way and 150ms the other**.

Two things to know about that line, because it was wrong for a while and nobody could
tell:

* **`scripts/load-test-data.sql` had stopped working** and the figures could not be
  reproduced by anybody who tried. It named `country_code`, `lifecycle_stage`,
  `budget_min`, `budget_max`, `ai_score`, `name`, `configuration` and `carpet_area`,
  none of which the model still has, so it errored after inserting 60,000 `ipy_record`
  rows and left the database half built. Fixed; if it breaks again the symptom is a
  loader that exits non-zero with leads loaded and properties empty.
* **`to_jsonb(row)` is what makes a query slow here.** It is the pattern that keeps a
  query safe when an admin deletes a field — a dropped column answers NULL instead of
  raising 42703 — and it builds a JSON object out of *every* column of *every* row
  considered. Reverse matching was 2043ms, the caller lookup the phone app makes was
  1556ms, and the duplicate check on every inbound lead was 1511ms. Reading one column
  at a time through `fieldText`/`fieldJson` in `core/entity/payloadColumns.ts` keeps the
  same protection and the same answer: 150ms, 35ms and 52ms.

  Use those helpers rather than `to_jsonb(x)->>'…'` in anything that filters or sorts.
  `#>>'{}'` and not `::text`, because the two disagree on timestamps. And watch rule 8
  on the way: dropping a `to_jsonb` read often drops the last reference to a bound
  parameter, and Postgres refuses a statement with a parameter it never names.

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
