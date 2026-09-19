# CLAUDE.md — permanent instructions for iPropy CRM

Read `PROJECT_HANDOVER.md` for full context (architecture, state, roadmap, known bugs).
Read `RUNBOOK.md` when production is misbehaving — it is the incident path, not the architecture.
This file is the short list of rules that must hold in **every** session.

---

## How Rishabh wants to work — standing instructions

Rishabh Singhla owns this product and is **not a technical person**. These hold in every
session, without being asked for again.

* **Production is the only thing that counts.** He looks at `crm.ipropy.com` and nothing else.
  He will never open localhost. A fix that works locally and has not reached production is not
  a fix yet, so always say plainly what is live and what is still waiting to be merged or
  deployed.
* **Write for someone who does not code.** Short, plain words. No jargon, no filler, no
  preamble. Explain anything unfamiliar with a small everyday analogy, so it lands first time.
* **Being right beats being fast, and beats sounding confident.** Take the time to check.
  Never guess a fact — an id, a number, a file, a cause — and present it as known. When
  something is unverified, say which part is unverified and how it could be checked. He would
  much rather read "I do not know yet" than an apology afterwards.
* **No apologies and no self-flagellation.** Correct the thing and carry on.
* **Smallest possible change.** Touch the least code that does the job. Nothing gets broken or
  churned for tidiness.
* **Check the work before showing it.** Unit, integration and end-to-end as the change
  warrants — he should not have to ask for testing.
* **Keep the docs true.** Any `.md` a change makes stale is updated in the same piece of work.
  That is part of the task, not a follow-up.
* **Decide without asking.** He has granted standing permission for ordinary work. Ask only
  when the choice is genuinely his — money, data loss, or something irreversible.
* **Work on `main`, and do not open pull requests.** He asked for this explicitly on
  15 September 2026: commit to `main` and push, which deploys to `crm.ipropy.com` on its own
  (`autoDeployTrigger: commit` in `render.yaml`). No feature branch, no PR, no waiting for his
  approval to merge. The cost of that speed is real and is the one thing to hold onto: **every
  push to `main` is live within minutes**, so nothing half-finished goes near it, and
  `npm run typecheck`, `npm test` and the repo's own checks pass *before* the push, not after.
* **Use the tooling that is already here** — graft, the skills, the MCP servers, and the
  workflows in `.github/workflows/` that can reach production — rather than waiting to be
  pointed at them.
* **End every reply to Rishabh with a short "What's the status now?"** covering the whole thread
  so far, not just the last step. **Only when he has actually written something.** A hook, a
  timer, a notification or any other automated ping is not him asking: answer those in a line or
  say nothing. Repeating the same status block at a machine is noise he has to scroll past, and
  it has annoyed him once already.
* **If he steps away and asks for the work to continue, continue it** until the goal is met.

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

* `npm test` — 874 unit tests, no DB: 734 in `packages/server` (query builder, filter evaluator,
  formula engine, permissions and role-hierarchy scoping, validation, unstorable characters, seed
  templates, billing decisions, capture time/EXIF offsets, watermark sizing, vision sampling, file
  serving headers), 132 in `packages/web` (colour contrast, safe markdown, header-tab
  arrangement, and the rich-text
  sanitiser that renders the imported Vtiger notes), and 8 in `packages/mcp` (tool-output
  formatting). The web suite runs on `node` except where a file asks for `jsdom` with a
  `@vitest-environment` pragma — the sanitiser leans on the browser's own parser, so testing it
  needs a DOM.
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
packages/server/src/core/media/                    images, video, transcode, ordering, archive
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
* **Error reporting is live.** `GET /api/public/client-config` on production
  serves a real Sentry DSN, environment `production`, checked 13 September 2026.
  This line said a DSN had never been pasted in; it had. Still open: **no
  staging environment**, which remains the real gap — every change is proved
  against production or against a developer's laptop, and there is nothing in
  between.

### Two bugs the restored gate caught immediately

Both were mine, both invisible, and both had been live for a day or more.

* **And two phone specs reported the machine they ran on.** Both long-press a
  dashboard row, and every seeded list widget filters on `owner_id is_me` — so
  on a developer's database the admin owns plenty of leads left behind by
  previous runs, and on a fresh CI seed the demo leads belong to twelve demo
  users and the admin owns none. Green everywhere anybody looked, red on CI
  only, which reads as CI being flaky. `dashboardWithRecordRows` in
  `e2e/helpers.ts` creates the row it needs now. **A spec that depends on what
  is already in the database is a spec that reports the machine it runs on** —
  this is the same rule as the unique markers, applied to a widget's filter.
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
* **Scheduled backups of the deployed database are not on** — the
  launchd timer covers a developer's local Postgres only. The intended fix is Neon's own scheduled
  backups + instant restore (paid Launch plan), *not* a dump job in this repo; that was shipped once
  and deliberately removed. See `DEPLOYMENT.md` §7 before building anything here.
* Speech-to-text, email IMAP inbound, rollup fields and the Channel Partner portal shipped as
  graceful-degradation features — they need real credentials/keys to be exercised end-to-end.
* Dashboard drag-to-resize is wired (react-grid-layout on desktop, persisted via `saveDashboardLayout`).
* **AI answers now.** An OpenRouter key is saved and listing copy, reading photos and voiceover all
  work on production. Six of the eight model jobs pass their Test button.
* **Embed and rerank both work. What is throttling them is the free tier's fifty
  calls a day** — read off production on 16 September 2026 by
  `.github/workflows/ai-failures.yml`, which prints `ipy_ai_log.error` grouped
  by feature. Rerank: 157 successes to 10 failures, so the "unverified" note
  this line used to carry is answered. Embed: 386 successes to **4,480**
  failures, of which 4,318 read *"Rate limit exceeded: free-models-per-day. Add
  5 credits to unlock 1000 free model requests per day"*, with
  `X-RateLimit-Limit: 50`.

  So the id was never the problem, twice over — the old note's reasoning holds
  and is kept: **do not guess replacement ids.** The account is rationed, and
  the CRM was making a hundred and sixty embed attempts a day into a cap of
  fifty, each retried twice more. `media.ts` now holds a model whose day is
  spent until `X-RateLimit-Reset` says otherwise, and a daily ceiling ends the
  retry loop rather than feeding it (`tests/ai/quotaHold.test.ts`). **Five
  dollars of credit on OpenRouter raises the cap to a thousand a day**, and is
  the only thing standing between the search index and being current.
* **The model boxes offer real ids now** (`ai/modelCatalogue.ts`). Each one lists what OpenRouter
  serves for that job, free first, priced in rupees. Three rules encoded there: it stays free text
  so a retired list cannot lock somebody out; "Free" is claimed only for a `:free` id, because an
  empty pricing block means *billed elsewhere* — every video and rerank model has one; and any
  failure returns `[]` so the settings page never depends on a third party being up. Transcribe is
  deliberately absent — it does not go to OpenRouter.
* **Transcription goes to the speech-to-text integration, not OpenRouter** (migration `079`). It was
  wrong twice: wrong service, and JSON with base64 audio where every OpenAI-compatible endpoint
  wants multipart with a `file` part. **The key is in now and it works** — the `stt` row reads
  `connected` with a key against `api.groq.com`, and `whisper-large-v3-turbo` answered three calls
  out of three. This line used to say the row had no key; that was true when written and stopped
  being true without anything saying so. The five older `stt` failures in the log are from August,
  against an NVIDIA ASR id that does not exist.
* **The birthday greeting is gone, on the owner's instruction, and the reason it had to go is
  worth keeping.** 16 September 2026: *"get rid of this birthday thing forever, we won't be using
  it ever in this life in the CRM."* It was seeded with `date_of_birth is today`; the live row's
  condition list was **empty**, so a daily rule with a WhatsApp step matched every contact in the
  database. 20,006 messages queued on 13 September, 20,000 on the 16th, **40,515 waiting**, 20,209
  people holding two each, `run_count` 80,467. Nobody received one only because no WhatsApp
  Business account is connected — luck, not a safeguard.
  Removed from the seed and from production (`.github/workflows/remove-birthday-greeting.yml`);
  40,514 queued messages moved to `ipy_device_send_cleared` and deleted, the one legitimate
  hand-queued message left alone. **Do not reintroduce it.**
  The gap it came through is closed in `core/workflow/scheduler.ts`: `seed/pruneFieldRefs.ts`
  already refuses to let a workflow *lose* a condition and act on everybody, but skips one whose
  conditions are **already** empty, because there is nothing left to check. A scheduled workflow
  with no condition at all and a task that reaches a customer is now switched off rather than run
  (`tests/workflow/messagesEverybody.test.ts`). A scheduled rule that only changes the CRM's own
  data is untouched — releasing expired blocks legitimately sweeps everything.
* **The model settings were re-chosen on 16 September, and every id was checked before it was
  saved.** `scripts/set-ai-models.mjs` asks OpenRouter's catalogue **per modality** and refuses to
  write an id it cannot find — `/models` on its own is chat-only, so an embedding id checked
  against it finds nothing and reads as invented, which is how four working ids got written off
  here once. Live now:
  `ai_models.embed` = `baai/bge-m3` ($0.010/M, 8B, multilingual — the notes here are Hinglish and
  the old 1B free model was rationed to fifty calls a day); `ai_models.rerank` =
  `voyageai/rerank-2.5-lite` (free, 32K against the old 10K); `ai_models.copy` =
  `z-ai/glm-5.3-flash` ($0.100/M — it was blank, so listing copy fell back to the vision model);
  and the OpenRouter card's chat model = **`openrouter/auto`**, a router rather than a fixed id,
  because a router cannot be stranded by a retirement. `openrouter/free` is the proven fallback —
  124 calls, 124 successes in this CRM's own log.
  **Changing the embed model does not re-index within the hour, whatever this file
  used to say.** `refreshSemanticIndex` embedded one batch of 32 per visit, throttled to five
  minutes: 48,502 records is five days, and sixteen once the tick moved to fifteen minutes. A
  visit now keeps going for up to a minute of wall clock, stopping early on a short batch —
  which covers both "nothing left" and "the model is out of quota", since a held model embeds
  nothing. Measured before the change: 63 rows in 12 minutes.
* **Music sends only parameters its model accepts.** `modalities` and `audio` were on the request
  and are on no music model's `supported_parameters`, so the whole call was refused in 0.0s.
* **`xiaomi/mimo-v2.5` is not retired, and the 404s were being asked of the wrong provider.**
  OpenRouter's own catalogue lists MiMo-V2.5 at $0.119/$0.238 per million tokens, eighth-most-used
  model for image understanding. The 404s — *"models/xiaomi/mimo-v2.5 is not found for API version
  v1main"* — came from **Gemini**, because `complete()` handed an OpenRouter id to every provider in
  its chain. The same table shows the same model succeeding four times under its own name, which is
  what gave it away. Fixed by `jobModel()` and `CompleteOptions.provider`: a named id goes to the
  provider that serves it, the rest still follow with their own model.
  **This file said "retired" for an hour on 16 September. It was wrong, and the way it was wrong is
  the point** — a failure log that names the wrong model produces a confident wrong diagnosis.
* **Groq's chat defaults in `config.ts` are genuinely retired.** `llama-3.3-70b-versatile` and
  `llama-3.1-8b-instant` both answer "does not exist or you do not have access to it" from Groq
  itself, so every AI call spent a hop failing through Groq before Gemini answered. Defaults moved
  to `openai/gpt-oss-120b`, which is what `ai/models.ts` already names as Groq's primary and which
  OpenRouter lists as the fastest model it serves — **not verified against Groq's live API from
  here**, and cheap to be wrong about: a bad default 404s once and the chain carries on exactly as
  it does today. The id is a text box in Admin → Integrations either way. `complete()` also stands a
  provider down for ten minutes when its model reports itself gone, so a dead id costs one hop
  rather than every call.
* **`ipy_ai_log.model` used to name the wrong model on every failed row.** It fell back to whichever
  model the *settings* name, but `complete()` walks a chain, so a failed Groq attempt was filed
  under Gemini — 252 daily-digest failures against `gemini-flash-lite-latest` whose error text read
  "the model `llama-3.1-8b-instant` does not exist". Fixed; the attempt carries its own model into
  the log. **Any reading of that table from before 16 September 2026 is misattributed.**
* **The daily digest is not daily and was the CRM's largest token consumer** — 6,253 calls in thirty
  days, written afresh on every dashboard open, every AI-panel open and every morning brief, for two
  sentences about three numbers. Cached in `ai/assistant.ts` on the numbers themselves, so it is
  rewritten when a follow-up moves and not when somebody reopens a tab.
* **Semantic search is live.** Checked on production 11 September 2026: 355 rows in
  `ipy_embedding` across both leads and properties, written by
  `nvidia/nemotron-3-embed-1b:free` — the very id the note above records as failing — with the
  newest that morning. Whatever was wrong account-side has been sorted; **do not go hunting for a
  replacement id.** Rerank is verified too now, from the failure log rather than from anything it
  leaves behind: 157 answers to 10 refusals, the refusals being the same daily cap.

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
* **A dropdown option's label and its stored value are two different things, and they have
  drifted.** The label is what the screen shows; the value is what every record holds and what a
  couple of dozen string literals in the code match on (`status = 'Available'`). On 15 September
  25 options across 8 dropdowns stored something other than their label — Lead Status showed
  "Lead Won" on records storing `Contacted`. Seventeen were aligned by
  `npm run picklists:align`; the other eight are named in `VALUES_USED_IN_CODE` and were left
  alone, because renaming `property_status.Available` empties the public website's catalogue.
  **Do not align those.** The confusion they caused is fixed where it actually showed —
  `buildTimeline` resolves a picklist value to its label now, so the feed says what the screen
  says without any record being rewritten. `ipy_picklist_value_alignment` records what each
  aligned option used to store, in case any of it needs putting back.
* **The Team map's tile host is named twice, and both must agree.** `admin/TeamMap.tsx` picks the
  tile server and `applyAppSecurityPolicy` in `app.ts` decides whether the browser may load it.
  Changing one and not the other is a blank grey map whose only trace is the browser console:
  that is exactly what happened moving off CARTO, which now serves a tile stamped API KEY
  REQUIRED to anyone without a key. It is on OpenStreetMap's keyless tiles, and both files say so.
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


## The phone app

`packages/app` is the CRM installed on Android and iPhone — the same React
bundle, wrapped in real native projects, with the phone's camera, location,
notifications and call log wired in. Read `packages/app/README.md` before
touching it.

Four rules that matter here:

* **It runs the metadata engine, it does not reimplement it.** Screens live in
  `packages/web/src/mobile/` and read the same modules, layouts and fields as
  the web. A hand-written native UI would freeze every screen into a release, so
  renaming a field would need a Play Store update. Anything added there must
  come from metadata, not from a constant.
* **The app is not a breakpoint.** `isNative` picks the mobile shell; a phone
  *browser* keeps the responsive web layout unchanged. This also keeps the
  phone-width Playwright specs pointing at what they were written against.
* **Two localhost origins in `allowedOrigins()` are load-bearing.**
  `https://localhost` (Android) and `capacitor://localhost` (iOS) are what a
  Capacitor webview stamps on its requests. They read like a development
  leftover; deleting either stops both apps at the login screen with a CORS
  error, on production only, with every test green.
  `tests/allowedOrigins.test.ts` fails if one goes.
* **The session is native storage, not a cookie.** A third-party cookie from a
  `capacitor://` origin is dropped by both platforms often enough that the team
  would be signed out hourly. The app uses the body path `/api/auth/refresh`
  already accepts.

The standalone `companion-android/` call-sync app is folded in. Its engine came
across unchanged except for one fix worth knowing: **all three call-log queries
appended a row cap to the sort order**, which from Android 11 the call-log
provider refuses outright (`Invalid token LIMIT`). Both callers catch and carry
on, so the symptom is a handset that pairs, reports itself healthy and uploads
nothing, ever — which is the likeliest explanation for the three handsets paired
since August that never synced. `queryCalls` uses `QUERY_ARG_LIMIT` now. The
second half of the same bug was quieter: `currentHighestId` returned 0 on
failure, indistinguishable from an empty call log, and 0 means *start from the
beginning* — so fixing the read alone would have uploaded every rep's personal
call history. It returns null on failure and pairing refuses rather than guesses.

Building needs **JDK 21** (not 17 — Capacitor 8 plugins declare a Java 21
toolchain and Gradle will not substitute another). iPhone needs Xcode and an
Apple Developer account, neither of which is on this machine; the project is
complete and unbuilt.

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

## WhatsApp is gone. Do not rebuild it without being asked.

**Removed on 2026-09-17, on the owner's instruction:** *"whatever whatsapp thing we have
in our codebase and over in crm.ipropy.com just completely rip it off and I will later on
begin working at it after a fresh start some time later."*

All three doors are now shut. What went: the Meta Cloud API provider and service, the
`wa.me` hand-off and its `ipy_device_send` queue, the auto-reply, the broadcast engine,
the new-lead greeting, the WhatsApp Web accounts, the record's WhatsApp Chat tab, the
compose modal's WhatsApp side, the template editor's WhatsApp tab, the `meta_whatsapp`
integration card and guide, the `send_whatsapp` workflow step, the `whatsapp.*` settings
and the `WHATSAPP_*` environment variables. `.github/workflows/remove-whatsapp.yml` is the
production half — seeding is create-only, so the live rows had to be deleted by hand,
and it copies everything to `*_removed` tables before it does.

**What deliberately stayed, and why:**

* **`ipy_conversation` / `ipy_message` rows on channel `whatsapp`.** Real conversations
  with real customers. The Inbox still reads them; it just cannot send on that channel.
  `Channel` in `shared/src/types.ts` therefore still lists `'whatsapp'`.
* **`ipy_channel_optout` rows on channel `whatsapp`.** Somebody asked not to be messaged.
  That request outlives the integration, and `ConsentChannel` keeps the value.
* **The capabilities `whatsapp.send` and `whatsapp.templates`.** They gate SMS, RCS and
  email templates too, and they are stored on live profile rows — renaming the keys would
  mean rewriting those rows to keep the team's access. The *labels* say "Send messages"
  and "Manage message templates" now.
* **The `whatsapp_number` field on leads**, and the "WhatsApp" options in Lead Source and
  Activity Type. Those are a phone number and two business facts, not the integration.
  Deleting a seeded field drops its column; deleting a dropdown option orphans every
  record that chose it.
* **`wa.me` share buttons** — Share Links, the matching tab, the shared-matches page and
  the mobile swipe. Those are a link a *person* taps to send a property from their own
  phone; nothing in the CRM sends anything. Say so before removing them, because that is
  how a unit reaches a buyer today.
* **Every table.** No migration drops anything, so a rebuild later starts from data.

**A door was already removed once before, on 2026-08-18 (migration `060`).** A linked phone,
the WhatsApp Web mechanism, run through a `wa-bridge/` process: the rep's own number, no
approval, no fee, against WhatsApp's terms. It worked, and working is what killed it —
pointed at a real handset it imported 821 chats, which is a person's private life in a
business database. Scoping them per-user (migration `056`) hid them from colleagues, and
holding them was still the wrong thing.

Removed with it: `ipy_wa_link`, `wa_link_id`/`claimed_at`/`priority`/`message_id` on the
queue, `private_to_user_id` on conversations, the bridge endpoints, the WhatsApp sidebar
page and the `whatsapp_linked` provider. The owner asked for a clean slate so it can be
rebuilt deliberately later.

### The QR-code road was built, and then removed

**2026-09-17:** the owner sent a specification for *Agent Linked WhatsApp* — each rep
links their own number by scanning a QR code, sends and receives inside the CRM. It was
built, under `integrations/whatsapp/agent/`, with a Baileys socket per agent, the linked
device's keys in the database, a history policy, and a Chats screen.

**2026-09-19 it was removed, on the owner's instruction:** *"remove that whatsapp agent
base QR code scan connection that is there in settings there is tab just completely rip
that off, and there is chats dropdown ... remove that chats thing too."* The reason it
could never have stayed is the one already written down when the first version went in
2026-08-18: QR-linking a personal account is WhatsApp's linked-device mechanism, it is
against their terms, and it risks the rep's own number. **The official business route
below is the only WhatsApp road now.** Do not build the QR one a third time.

What went: `integrations/whatsapp/agent/` (authState, claim, historyPolicy, service,
session, store), `api/routes/whatsappAgent.ts` and its `/api/whatsapp` prefix, the boot
hooks in `index.ts`, `web/src/components/WhatsAppLink.tsx` and the Settings → WhatsApp
tab it lived on, `web/src/pages/Chats.tsx`, every `api.whatsapp*` client call, and the
`@whiskeysockets/baileys` and `qrcode` dependencies.

**One file survived the deletion and matters: `integrations/whatsapp/matchContact.ts`.**
It was `agent/matchContact.ts`, and `business/thread.ts`, `business/inbound.ts` and
`business/send.ts` all import it — matching a number to a contact by its last ten digits
is the official road's job too. It moved up a directory rather than being deleted with
its neighbours.

**What deliberately stayed:**

* **Every table**, including `ipy_wa_account` and the messages the agent road wrote.
  No migration drops anything. `ipy_message.route` still reads `'agent'` on those rows,
  and the contact's WhatsApp tab still says which phone each one went through.
* **WhatsApp templates** — asked for by name (*"whatsapp template to keep"*). Admin →
  WhatsApp Templates is untouched and belongs to the official route anyway.
* **`/chats`**, which now renders `BusinessChats` — the official number's shared inbox.
  It is no longer a header tab and no longer in the drawer; the WhatsApp icon beside a
  phone number is the way in, and the page says so itself when no provider is connected.

**`HeaderTab['kind']` no longer has `'chats'`, and production's saved arrangement still
names it.** `arrangeHeaderTabs` therefore drops any kind this build does not have, rather
than rendering a tab that goes nowhere — pinned by `tests/headerTabs.test.ts`. Anything
fixed *added* to that header later still needs its own append line, for the opposite
reason: an arrangement saved before a page existed cannot have meant to leave it out.

**Two WhatsApp controls, and they deliberately go to different places** — the owner asked
for this on 17 September. The small **icon beside a number** stays inside the CRM: the
composer over the record where there is one, `/chats?to=…` otherwise, where a manager can
read the thread and the timeline records it. The labelled **button on the record header**
leaves: `https://api.whatsapp.com/send/?phone=…` through `openExternal`, so the rep writes
in WhatsApp itself. Only that button leaves. `openExternal` and not a plain link, because
`window.open` returns null inside the phone app and the tap does nothing at all.

**A destination that lives only in the header's module switcher is invisible on most
screens** — the switcher is `lg:block`, so below 1024px it is not on the screen at all.
Anything a rep needs on a laptop or a phone goes in the drawer too.

## The official WhatsApp Business route, through a BSP

**18 September 2026, the owner:** *"The feature of Personal whatsapp Agent wise not use to
me, i need Bussiness API Integration."* So the CRM now has both, and the official one is
what the business will use. The agent-linked route is **not** deleted — his own §13 asks
for the two to stay separate with the route recorded on every message, and `ipy_message.route`
('business' | 'agent', migration `158`) is that record.

**One contract, four adapters, and nothing hard-coded to a vendor**
(`integrations/whatsapp/business/`). `WhatsAppBusinessProvider` extends the same
`WhatsAppProvider` contract in `providers/types.ts`, which outlived the agent route that
first needed it: a provider asked for a capability it lacks throws `NotSupportedError`
rather than returning quietly, because a send that silently does nothing is the failure
mode that let 40,000 birthday messages queue unnoticed.
Moving from AiSensy to Gupshup is an admin switching an integration card; no conversation
moves, because the history was never the vendor's to hold — provider ids sit *beside* the
CRM's own ids, never instead of them.

**What each adapter can do is what its own live documentation says, checked on the day:**

* **Meta Cloud API** — `POST /{phone-number-id}/messages`, text, media, templates, status
  webhooks, mark-read. The graph version and base URL are **settings, not constants**:
  Meta retires versions on a schedule, and a hard-coded one is a dead integration on a date
  nobody has in their calendar. Written from knowledge and **not verified against the live
  reference from here** — `developers.facebook.com` is blocked by this container's egress
  proxy — so the Test Connection button is what proves it against the real account.
* **AiSensy** — `POST https://backend.aisensy.com/campaign/t1/api/v2`, which sends an
  **approved template and nothing else**. So its adapter declares `templates` and *not*
  `text`, and a rep typing a free reply is told before they press send rather than after.
* **Gupshup** — `POST https://api.gupshup.io/wa/api/v1/msg`, form-encoded, key in an
  `apikey` header: text, media and templates, and a template list to sync.
* **whatsmarketing.in** — **the one the business actually bought**, and it has a real
  adapter now (`business/whatsMarketing.ts`), written from their own API documentation
  v1.0, which the owner sent on 19 September 2026. Until then it was the Cloud-API-shaped
  guess, and **the guess was wrong in four ways**: the token goes in the form body as
  `apiToken` rather than a Bearer header, requests are form-encoded rather than JSON, the
  paths are `/whatsapp/send` and friends rather than `/{version}/{phone-number-id}/messages`,
  and — the expensive one — **a refused message answers HTTP 200** with `{"status":"0"}`.
  An adapter that trusts `res.ok` records every refusal as a send, and a rep watches a tick
  appear for a message the customer never got. `tests/whatsMarketing.test.ts` opens on that
  case for exactly that reason.

  **Their replies are polled, not pushed** (`business/pollInbound.ts`, every
  scheduler tick). This is not a nicety: the CRM works the 24-hour window out
  from its own record of the last inbound message, so with nothing ever
  arriving `window_expires_at` is never set, every conversation reads as
  permanently shut, and **a rep cannot reply to a customer who has just
  written** — the composer offers templates only and `sendOnBusinessNumber`
  refuses the send. That was found the moment the owner connected it and tried.
  The poller reads `/whatsapp/subscriber/list` (ordered by most recent) then
  `/whatsapp/get/conversation`, and hands each message to `receiveInbound` —
  **the same function the webhook calls**, so there is one place that matches a
  contact, opens the window and notifies an agent, and so re-reading a thread
  is free. Two things in it are pinned by `tests/whatsMarketingPoll.test.ts`
  because they fail silently: a row from `sender: 'bot'` must never be replayed
  as something the customer said, and the watermark moves to when the visit
  *started*, less a second, since their timestamps carry no sub-second part and
  an exact boundary would otherwise drop a message for ever.

  Two more things worth knowing before touching it. Their templates are addressed by a
  numeric `template_id` from their dashboard, so a name is resolved through their list
  endpoint first and a miss is refused *naming the template* rather than posting a blank id.
  And **their documentation has no inbound webhook section at all** — §17 says delivery
  webhooks need their support team. So `parseWebhook` reads the two shapes it can recognise
  without inventing one, and **logs the body** of anything else rather than dropping it:
  an unrecognised delivery has to become a fact somebody can read, not a customer's message
  that quietly never arrived. Until they enable a callback, replies do not reach the CRM.

  `cloudCompatibleProvider` stays in `resellers.ts` — it is still the right answer for the
  next reseller that genuinely does proxy the Cloud API.

**The webhook is `/api/webhooks/whatsapp/:slug`, one door per provider**, and every delivery
is verified by the adapter that owns it — Meta's `hub.challenge` handshake and an app-secret
signature over the **raw** body (re-serialising the parsed JSON changes the bytes and reads
exactly like a wrong secret), a constant-time shared token for the resellers. It answers 200
first and works second, because every provider retries anything it does not hear a prompt
200 for.

**Three rules the inbound path is built on**, all pinned by
`tests/integration/whatsappBusinessWebhook.test.ts`:

* **Seen once.** `ipy_wa_webhook_event` claims a delivery by unique insert — the insert *is*
  the check, because a SELECT-then-INSERT lets two racing deliveries both through. Meta
  retries for days; without this the agent is notified twice for one sentence.
* **Never a silent duplicate contact.** An unknown number opens a thread with no record
  attached and waits for create / link / ignore.
* **A status only moves forward.** Providers deliver them out of order, and a late "sent"
  would otherwise un-read a message the customer has plainly read.

**One trap this cost a test run to find, and it is rule 8's cousin:** a parameter used both
as a timestamp and as the left side of `+ interval` deduces two types and Postgres refuses
the whole statement — *"inconsistent types deduced for parameter $2"*, at runtime, with a
customer's message in hand. Every position is `$2::timestamptz` now.

**Built so far:** the provider layer, the four adapters, the webhook (verify, dedupe,
inbound, status), sending text and templates with the 24-hour window and opt-out enforced
*before* the provider is called, the four integration cards with their secrets encrypted,
and `GET /api/whatsapp-business/status` so a screen can ask what the live provider can
actually do before offering a control.

**A seeded integration card with no `PROVIDER_FIELDS` entry is a card nobody can fill
in.** The four rows in `db/seed/automation.ts` existed for a day while
`admin/IntegrationsAdmin.tsx` had no fields and no guide for them, so the Integrations tab
showed four WhatsApp cards with nothing to type into — which reads exactly like the
feature not being there, and is how the owner reported it. Both halves are in now, and
every key named is one the adapter actually reads (`metaCloud.ts`, `resellers.ts`): a
field the server never asks for is worse than a missing one, because somebody fills it in,
presses Test, and the failure says nothing about why.

**The Chats screen and the contact tab are on this route now** (`pages/BusinessChats.tsx`).
Three columns: the queue, the conversation, and the CRM contact **linked rather than
copied** — a lead's budget repeated on this screen is a second copy to keep in step, and the
first time the two disagree nobody knows which is true. `/chats` **is** the business inbox now — the per-agent
screen it used to fall back to was removed on 19 September 2026. It is no longer a header
tab; the WhatsApp icon beside a phone number is the way in.

**The inbox is shared, and who sees what is the rule that matters.** An admin sees every
thread; everybody else sees their own and the unassigned queue, and **not** one another rep
is working — two people answering one customer is what a shared inbox exists to prevent.
A manager who needs to read it uses the contact's WhatsApp tab, where the CRM's ordinary
record permissions decide, as everywhere else. Take / assign / transfer / mark unread /
open / pending / resolved are all there, a hand-over tells the person losing the thread, and
the header shows who else is looking (in memory, 45 seconds, because it is true for half a
minute and nobody wants to read it tomorrow).

**Rule 8 again, the fifth time, and an integration test caught it rather than production.**
The inbox list bound the user id even for an admin, whose visibility clause is `TRUE` and
names no parameter — Postgres refuses the whole statement with *"could not determine data
type of parameter $1"*, which on screen is an empty inbox for admins only. The clause and
its parameters travel together now (`visibility()` in `business/inbox.ts`).

**The contact's WhatsApp tab shows both roads in one column**, with a line saying which
number each message went through: one customer had one conversation even if it reached them
two ways.

**Approved templates and what fills their blanks** (`business/templates.ts`, Admin →
WhatsApp Templates). Meta approves the wording and freezes it, so the only CRM decision is
what goes in each `{{n}}` — and that is **metadata, not code**: a mapping names a field
through the same Field Manager every screen reads, checked against the module when it is
saved rather than when a customer is waiting. The other three sources are the agent
sending it, the business name (`org.name`, the one the header reads) and a literal.

Three rules, pinned by `tests/integration/whatsappTemplateMapping.test.ts`:

* **A sync never touches a mapping.** The provider owns the wording, status and category;
  the CRM owns the blanks. `ON CONFLICT DO UPDATE` deliberately omits `variable_map`,
  because syncing to pick up one new template must not empty the other twelve.
* **A picklist fills with its label**, never its stored value — those two have drifted on
  this database before, and the customer would read the wrong one.
* **An empty blank is named, not sent.** WhatsApp refuses the message anyway, and "failed"
  sends a rep hunting; `{{2}} field:email is empty on this record` is fixable in ten
  seconds. The composer previews the filled text before it goes, because a positional
  template is unreadable in the abstract.

**The nine templates seeded before the removal are still in the database**, and they map in
the *old* vocabulary (`contact.first_name`). `resolveTemplate` reports those as "needs
setting again" rather than slicing the prefix off blindly — which would have produced
nonsense, looked up nothing and sent a blank. Their wording is still useful, so they are
listed for re-mapping rather than deleted.

Parameters are filled **server-side** through `recordService`: a screen that posted them
back could send a customer a budget its user is not allowed to read.

**The icon beside a number is a composer now** (`components/WhatsAppComposer.tsx`). The
Chats screen is the right place to *work* an inbox and the wrong place to answer one
question about the person already on screen, so with a record in view the icon opens a
small dialog over it: the last few lines of the thread, a box, Send. Provided by
`WhatsAppComposerProvider` beside `CallDispositionProvider` on the record page and the
split view, so it knows which record the number belongs to.

Four rules it holds to:

* **Nothing is offered that WhatsApp would refuse.** `composerMode()` in `lib/whatsapp.ts`
  needs both halves — inside the 24-hour window *and* a provider that can send free text.
  AiSensy can never, window or no window, so there the box is replaced by the template
  list with the finished wording shown first.
* **Looking writes nothing** (`business/thread.ts`, `GET /threads/by-number`). A
  conversation created on a glance would put an empty thread in the team's shared queue
  for every number anybody hovered over. `sendOnBusinessNumber` creates it, on the first
  message that actually goes.
* **The record is the gate, not the thread.** Messages come back only when the caller
  names a record and `recordService.getRecord` allows it — the same rule as the contact's
  WhatsApp tab. Without one the answer still carries the window state: enough to choose a
  control, nothing to read.
* **With no provider switched on, nothing changes.** `WhatsAppComposerProvider` supplies
  no context until `status.connected`, so the icon stays the link to Chats it is today
  rather than opening a dialog that can only apologise. `e2e/whatsappComposer.spec.ts`
  pins that fallback, because it is what production is running right now and it is easy to
  lose while adding the thing that replaces it.

**The composer itself has never been opened in a browser** — no provider is connected
anywhere this can be tested, so what is proved is the thread lookup
(`tests/integration/whatsappComposerThread.test.ts`), the mode decision
(`tests/whatsappComposer.test.ts`) and the fallback.

`waDigits` moved from `components/WhatsAppButton.tsx` to `lib/whatsapp.ts` for a reason
worth repeating: a component that imports the app's store cannot be loaded by a `node`
test at all, because the store reads `localStorage` as it is constructed. Importing one
helper out of a component pulled the whole store in and broke an unrelated suite.

## Photos, documents and voice notes

**The rule this phase exists for is one line of his specification: the CRM's history must
never depend on the provider's dashboard.** A webhook hands over a media id that expires,
or a URL that needs the account's own token. A CRM that stores either has a photo album
that empties itself — the picture a customer sent is gone the day the business changes
vendor, silently, with nothing that looks like an error until somebody opens an old chat
and finds a broken square.

So an inbound file is fetched **once, now**, and stored as an ordinary `ipy_attachment`
with `category = 'whatsapp'` — the same row a file dragged onto the record gets. It
appears on the contact's Files tab, it gets the image pipeline's derivatives, and it
survives every vendor decision made afterwards. The provider's own id stays *beside* the
CRM's in `ipy_message.media`, never instead of it: it is what a support conversation with
the vendor is about, and it costs one key.

`keepInboundMedia` runs **after** the message row is committed and never throws
(`business/media.ts`). Collecting a 15MB video is a round trip to the vendor, and a
provider that does not hear a prompt 200 sends the whole delivery again — so a fetch that
fails leaves the message and its caption standing rather than losing both and earning a
retry that delivers the conversation twice. Pinned by
`tests/integration/whatsappMedia.test.ts`.

**Going out, the two halves of the world disagree and neither is a choice:**

* **Meta takes an upload.** `uploadMedia` posts the bytes as multipart, Meta answers with
  its own id, and `sendMediaById` sends that. Nothing of the customer's is published. Two
  traps: the part must be a real `Blob` with a name (a bare Buffer is sent as a plain
  field and answered 400), and the lookaside URL Meta hands back for a *download* still
  needs the Authorization header — fetching it without one answers 401, which reads
  exactly like a wrong access token rather than a missing header.
* **Every reseller fetches a link** and none of them offers an upload. So the CRM has to
  publish the file where they can reach it: `GET /api/public/whatsapp-media/:id`, signed
  with an HMAC over the id **and** the expiry so neither can be edited, valid fifteen
  minutes, `Cache-Control: private, no-store`, and through `applyFileSecurityHeaders` like
  every other byte-serving route. Not a row in a table — there is nothing to look up later
  and nothing to revoke that expiry does not already cover. It is a real exposure for that
  window, it is the vendors' design rather than this one's, and it is the strongest
  argument for Meta direct of the four.

**A file is named by attachment id, never by URL.** `POST /send` takes `attachmentId`;
a caller who could name any link could make the CRM fetch and republish whatever it can
reach. The sender must also be able to *view* the record the file hangs on
(`assertMaySendFile`), which is what stops a rep forwarding a document off a lead they
cannot see.

**WhatsApp's ceilings are lower than people expect** and are checked before the provider
is called: 5MB an image, 16MB audio or video, 100MB a document. A file over them is
refused with its real size named — "will not carry a video over 16MB, and this one is
90MB" — rather than failing two minutes later as a vendor error code. The limits are from
knowledge, not from Meta's page (blocked by this container's proxy), and being slightly
low is the cheap direction to be wrong in.

**One renderer for all three screens** (`components/WhatsAppMedia.tsx`): the Chats inbox,
the contact's WhatsApp tab and the composer. Three copies drift, and the way they drift is
that one keeps rendering the vendor's expiring URL while the others moved to the CRM's
copy — a photo that shows on one screen and is broken on another, months later, for
reasons nobody can reconstruct. `readMessageMedia` (in `lib/whatsapp.ts`, so a `node` test
can reach it without the store) returns null without an `attachmentId` for the same
reason: a row carrying only the vendor's id renders as nothing rather than as a link that
works today.

**Never built and worth knowing:** nothing here has been exercised against a real
provider, because none is connected. What is proved is the storing, the signing, the size
refusal and both transports against a stub
(`tests/integration/whatsappMedia.test.ts`, 8 tests).

## Sending a unit from the chat, and chasing them about it

**Both halves already existed and neither is reimplemented** (`business/share.ts`). A share
link is `core/sharing/shareLinks.ts`, which mints a fresh token every time on purpose so a
view count means something and revoking one buyer's link does not revoke another's. A
follow-up is `core/workflow/followUp.ts`, the one definition of "chase them on `<date>`" —
the date on the record, a note in the timeline, a notification to whoever owns the lead. A
chat is not a reason to grow a second of either.

What is new is the join, and the rules in it:

* **The message is composed on the server, never in the browser.** The facts come off the
  property through `recordService`, so a rep who cannot open a unit cannot send it and a
  screen cannot post a link to a floor its user was never shown. `shareMessage` is
  exported and tested because the wording *is* the product here: the rep's own line, the
  unit, then only the facts somebody decides on — configuration, locality, size, price,
  status — and the link **last and alone**, because WhatsApp previews a link it can see
  the end of and nobody taps one buried mid-sentence. It also has to still say something
  when a property has almost nothing filled in, which is what both live properties look
  like today.
* **A send that fails revokes the link it minted.** This is the ordinary path, not a rare
  one: outside WhatsApp's 24-hour window a free-text message cannot go at all, so without
  the cleanup every refused attempt would leave a working link to this morning's draft
  floor behind it. `tests/integration/whatsappShareProperty.test.ts` is mostly about this.
* **The link is labelled with who it went to** (`WhatsApp · <contact>`). The label never
  reaches the visitor; it is what makes the property's Share tab readable a month later,
  because eleven links with view counts and no names is a list nobody can act on.
* **A follow-up needs a record.** A number nobody has claimed has nothing to put a date
  on, and the route says so rather than quietly doing nothing. It also needs *edit*, not
  view: a follow-up writes to the record.

**The picker offers this contact's own matches first** (`components/SharePropertyDialog.tsx`),
through the matching that already exists, with search for the unit somebody has in mind
anyway. The control is a plain date input in the conversation header rather than a dialog —
deciding to chase somebody on Tuesday has to take one tap, and anything longer gets skipped
mid-conversation, which is how follow-ups stop happening.

**Never opened in a browser**, for the same reason as the composer: the business Chats
screen only renders when a provider is connected, and none is. Proved instead against a
real database — the wording, the label, the revoke-on-failure, the permission refusal and
both follow-up guards (7 tests).

**Still to build, in his order:** campaigns, then reports.

**The avatar on the row stayed, and a percentage chip that replaced it was rolled back the
same day** (18 September). The owner asked for the chip, saw it on production, and asked for
it back the way it was — so the row leads with the face and its ring again, and the number
rides in the ring's corner. `StrengthChip` was removed with it rather than left behind
unused. Worth knowing before proposing it again: the request and the reversal are both his,
hours apart, and the second is the one that stands.

**The list's pinned quick-actions column is gone** (17 September, owner's instruction), and
with it `e2e/quickActions.spec.ts`. It was one hover-only Call button in a column pinned to
the right of every row. The name column is pinned to the *left* instead — a wide grid
scrolled right left every row anonymous, because the column saying who this is scrolled
away with the rest. `.list-stick-select` / `.list-stick-first` in `styles.css`, pinned by
`e2e/stickyName.spec.ts`.

**And the trap that was hiding in plain sight: `.list-head` says `sticky top-0`, and the
header cell also carried Tailwind's `relative`.** A utility wins on source order, so every
column heading in the CRM was `position: relative` and the whole header row scrolled away
with its rows — reported as "the menu bar is movable". `relative` is gone from the cell (a
sticky cell is a positioned cell, so the resize handle still anchors), and the two pinned
header cells state `position: sticky` themselves under two class names. Both halves are
pinned by two specs: `e2e/listHeaderStaysPut.spec.ts` walks **every** header cell on both
modules — measuring `.first()` was how the bug hid, since the checkbox column was the one
column still pinned — and `e2e/stickyName.spec.ts` covers the two columns frozen to the
left. Both assert the computed style *and* measure that nothing moves; a class that is
present while the cell still slides is exactly the bug.

**If it is rebuilt, the things that cost a night to learn:** history arrives exactly once
during the handshake after a scan and cannot be re-requested; Baileys must be on the
`latest` dist-tag, since a year-old client is refused the moment it asks for a full sync
(presenting as an endless 428 with no QR); history must never be replayed through
`handleInbound`, which would auto-reply to every customer about something they said months
ago; and pacing belongs in the CRM, never in a laptop script that forgets on restart. It
must also decide, up front, that a business CRM has no business storing a rep's personal
chats.

## Lists open on the split view

**18 September 2026, the owner's instruction:** it is the default for everybody in both
modules, and anybody may switch for themselves. `lib/listMode.ts` ranks the three sources
in one place — **this person's own choice on this module, then a saved view that
explicitly names kanban or ipropy, then the split view**. A view that says `table` is
treated as never having chosen, because every saved view predates it and says that by
default; the only way to get the table is to click it, and clicking it is remembered.

Remembered in the browser rather than on the record: it changes several times a day, it is
nobody else's business, and a per-user setting that needs a round trip to say which way you
like your list is slow at exactly the wrong moment.

**It was called the iPROPY desk until 19 September**, when the owner renamed it: *"Please
change the name of IPROPY view to split view."* The *stored* value is still `ipropy` and
must stay that way — it is the key in every saved view, in every browser that has
remembered a choice and in `e2e/auth.setup.ts`, so renaming it would make all of them read
as "never chosen" and move the whole team back to the default. Same rule as the `leads`
module still being called `leads` while the screen says Contacts.

### Everything happens in it, and nothing leaves it

**19 September 2026, the owner, at length:** *"this split view is made so that life becomes
easy and fast of the team, so no clicking of edit button, no opening of any other sort of
things, just write then and there… Never need to open any sort of page in the split view."*

So the Edit button is gone, the dialog it opened is gone, and the button beside Delete that
opened the record's own page is gone. What replaced them:

* **The whole record is fetched by id**, on the same query key the record page uses. A list
  row carries only the values the *list* asked for, so every field that is not a column
  read back blank — which is exactly why Contact Type was missing and why the card looked
  emptier than the record page. The row still stands in while the record loads, so the pane
  never blanks between two selections.
* **`surface` is `record`, not `list`.** The "editing from a list" setting exists because
  turning a value into an edit box under a cursor *on a list* is how a live mobile number
  gets changed by somebody who only meant to read it. This pane is not that: the record was
  picked out of the queue on purpose. Gating it on that setting — which ships **off** — is
  what put an Edit button there in the first place.
* **The whole cell is the click target.** `EditableField` takes the click on its own box,
  which is only as wide as the value, so on an empty field that box is a dash in the middle
  of a wide cell and a click anywhere else hits nothing. The cell forwards to the field's
  own "Change …" control, so there is still exactly one thing that opens an editor.
* **The header is the record page's header**, read from the same `layout.headerFields` an
  admin arranged, every value editable in place, plus four appended: phone, follow-up,
  status, and the module's own identifying field. The assignment field is deliberately not
  among them — it sits on the name line, between the name and when the record was last
  touched.
* **The Overview renders the layout's blocks**, so Property Information and Unit Details
  appear here exactly as they do on the record page rather than as one flat card.

**The header said "Unassigned" on every record however it was assigned**, and the cause is
worth keeping: `RecordEnvelope.ownerName` is populated by **nothing** except the phone
app's caller lookup (`assignedNumberLookup`) and global search. Neither `listRecords` nor
`getRecord` fills it in, so `active.ownerName ?? 'Unassigned'` could only ever print the
fallback. The assignment field is drawn the way the record page draws it — found by
uitype through `assignmentField`, shown by its display value, edited in place.

**The queue's second line is the module's own fact, not an id.** *"I don't need the ID
there"* — a contact's **Type**, a unit's **Unit Number** (`queueSubtitleField`). An id
identifies a row to a database and nothing to a person. `withQueueSubtitle` adds that field
to the list's requested columns while the split view is showing, because otherwise the line
is blank on any view whose columns do not happen to include it — which reads as the feature
not working rather than as a column being absent.

**The divider drags** (`SplitHandle`), pointer events so a finger on a tablet works, with
the pointer captured so a fast drag does not let go halfway across the screen, and arrow
keys for anyone not using a mouse. The width is per browser like the view choice itself, and
clamped — a queue narrower than 240px is unreadable and one wider than 620px is a list with
a keyhole beside it. Below `xl` the panes stack and the width is ignored entirely; the
handle is `xl:block`, because a divider you cannot see is not one you can drag.

**The WhatsApp and Call buttons are icons here** (`iconOnly`), and only here. The words cost
a third of the header strip for two buttons everybody recognises by shape; the record page
keeps its labels, where there is room.

**Every spec in `e2e/` that is about the table signs in with `table` already stored**
(`auth.setup.ts`), because they are about the table. `e2e/listDefaultView.spec.ts` is the
one place the real default is proved, and it clears the key by loading, removing and
reloading — an init script clears it on the reload too, which reads exactly like the
preference failing to stick and cost a debugging round to see. It also pins the three
things above: a value typed in where it stands and read back after a reload, neither
removed button present, and the divider moving and being remembered. **The inline editor
floats in a portal on `body`**, so a locator rooted in the workspace finds nothing at all —
that cost a round too.

### Two panes, a face and a bar

**19 September 2026, the owner, against a screenshot of his own.** Ten changes, all of them
inside the split view and in both modules. What each one is, and the one thing in it worth
knowing:

* **Notes moved in beside Basic Information**, and the third pane and its divider went with
  them: *"we work only in two split panes in future"*. A note is written about what is on
  screen, so it belongs next to it rather than in a column competing for width. Beside from
  `xl` up; below that it stacks, like everything else here.
* **The header is sticky.** The name, the assignment and the tabs stay put while the fields
  scroll under them — each pane scrolls inside itself now rather than the page scrolling as
  one.
* **The white gap under the queue is gone, and the cause was a guess.** The panes were
  `calc(100vh - 13rem)`, a stand-in for whatever toolbar sits above, and it was about a
  hundred pixels out — so the queue stopped short and the page kept going. The shell now
  measures its own distance from the top of the page and takes the rest, which is exact and
  stays exact when the toolbar above grows a row.
* **The score ring became an avatar and a bar** (`StrengthBar`). The face identifies the
  person; how complete the record is is a different question and now reads as a proportion
  at a glance. **It is on the record only** — he asked for it off the queue hours later, and
  he is right about which side it belongs to: it is a fact about the *record*, and the queue
  is about the people in it.
* **The chevron at the end of every queue row is gone** — *"it been irritating"*. It pointed
  at nothing: the record opens in the pane already on screen.
* **The date and the status share one column** on the right of each queue row, the status
  under the date and ending where it ends. Two chips on two lines with two different right
  edges is what makes a queue look ragged. A row with no follow-up prints a dash in the
  date's place, so the status stays on its own line rather than jumping up one.
  **Which field that status is, is `pipelineFieldOf` and nothing else** — Lead Status on a
  contact, Property Status on a unit, found by name *or column* because production's leads
  module says `status` and has called that field `lead_status` since a rename. It briefly
  fell back to "the first field whose name contains status", and both modules carry others
  — `kyc_status` on a contact, `possession_status` on a unit, each empty on nearly every
  record. A guess that lands on one of those shows a queue of blanks, which reads as the
  feature being broken rather than as the wrong field being read. There is no fallback now:
  a module with no pipeline field has no stage to show.
  Its value is requested as a column too (`withQueueSubtitle`), for the same reason the
  subtitle is — a row carries only what the list asked for.
  **And it is a `Badge`, not a tint computed in this file.** It used to paint the admin's
  raw hex as text on a 12% wash of itself, which is the pattern the Conventions section
  names: that lands around 2–3:1, so how readable a status came out depended entirely on
  which colour somebody had picked for it. `Badge` fills the chip and `lib/color.ts`
  guarantees the pair clears AA in both themes.
  **What is not established:** the owner reported the chip missing from production on
  19 September, and it could not be reproduced here — a local database reshaped to
  production's exact field naming still drew it. So the fixes above are the two things that
  *could* produce a blank (the wrong field, or an unrequested column) rather than a
  diagnosis of what did.
* **A checkbox beside the module's name** ticks everything on the page, which is what the
  bulk-edit bar the list already carries needs in order to appear. There was no way to make
  a selection from this view at all.
* **The bare word STATUS in that header became one sorting menu** — name, the module's own
  facts, status, task soonest first. It drives `ListView`'s own `sortBy`/`sortDir`, **not a
  second ordering of its own**, or the screen and an export would disagree about what the
  list is. It briefly also chose *which* follow-ups to show and that half is gone: the
  toolbar above already has that control, and two ways to ask one question is how they come
  to disagree.
* **Assignment moved onto the name line**, between the name and *Updated …*, still edited in
  place.
* **The action icons are plain circles at the end of the name's own line** (`ACTION_CIRCLE`,
  and `round` on `WhatsAppButton` and `CallButton`). **This is the one his words and his
  screenshot disagreed about, and the screenshot won on the second pass.** They were built
  above the name, left-aligned, because that is what he wrote; he sent the screenshot back
  the same day. So: when the two disagree here, build the screenshot.
  They are one weight of grey, not one colour each — four tinted circles in a row read as
  four warnings rather than four ordinary controls.
  Two mechanical notes, both of which cost a test run. `ml-auto` inside a `flex-wrap` row
  puts them on a line of *their own* the moment that row wraps, so they are a sibling of the
  whole name block rather than the last thing in it. And `page.locator('main')` matches the
  app shell's `<main>` as well as this pane's, whose first heading is not the record's name.

* **The queue's second line is `config.listSubtitle`, and it is a *list* of fields.** It used
  to be `contact_type ?? unit_number` named in `lib/fields.ts`, which could only ever show
  one; `subtitleFieldsOf` already existed, already ordered them, and is what the table and
  the phone cards read. So a contact reads `Buyer — 304` and a unit reads its Unit Number
  without either name appearing in the code. **If a fact does not show there, the field is
  unflagged rather than the feature broken** — `probe-prod-schema.yml` prints which fields
  each module flags, and production's answer on 19 September was `contact_type` then
  `unit_no` on leads, `contact_type` then `unit_number` on properties. Only 2,476 of 22,988
  contacts hold a unit number, so most of that queue still reads `Buyer` alone: that is the
  data, not the screen.
* **The toolbar counts the page as well as the total** — `25 of 22,970 records`. The total
  alone says nothing about how much of it is on screen. It counts rows delivered, not the
  page size, so the last page says 20 rather than 25.
  **That wording is load-bearing in eleven spec files**: `/^[\d,]+ records$/` is how nine
  of them wait for a list to finish loading, so changing it turned twenty-seven passing
  tests red at once with no bug behind any of them. Anything that edits that line edits
  those specs in the same commit.

Pinned by five more tests in `e2e/listDefaultView.spec.ts`: the completeness bar **off** the
queue and still on the record, the missing chevron, the actions **measured** onto the name's
line, the select-all and the sorting menu with no follow-up section in it, and the notes
**measured** to be beside the fields rather than read off a class name — a class that is
present while the card still sits underneath is exactly the bug.

### The header is one line, and the actions beside it

**19 September 2026, the owner:** *"In the Head Tab Mobile, Budget, Next Followup, Status,
Unit Number etc. are shown in two row Please set all in one row, so that we can see narrow
header and wide Timeline etc view. If more then line should make it in dash … so that we can
choose only option from master as i need in a single line."*

* **The field strip never wraps.** It is one row, clipped, and a `…` appears at its end when
  something is out of sight — which is the cue to go and shorten the list in Admin → Split
  View rather than a silent loss. Measured with a `ResizeObserver` on the strip itself: a
  window listener is not enough, because the strip also narrows when the queue's divider is
  dragged and that moves no window.
* **The name line stopped wrapping too**, which is where most of the height was going: a long
  name pushed *Updated …* onto a second row, so the header grew by a line for nothing. The
  name gives way first (`truncate`) and everything beside it holds its width.
* **The delete circle is gone.** Delete is in the three-dot menu a few pixels away, and one
  destructive action offered twice, a thumb's width from Call, is one more chance to hit it
  by accident than it is worth.
* **The tag icon works now** (`components/TagButton.tsx`) — *"give an operational tag icon,
  which is missing from header"*. **One component, used by the record page and the split
  view.** The cheap answer was a second copy of the record page's dialog, and two copies of
  one dialog drift: one learns about a new colour, or stops going through
  `invalidateRecordQueries`, and the same action behaves differently depending on which
  screen you were on. Moving it out of `RecordDetail.tsx` removed four pieces of state and a
  modal from the largest file in the repo.

**Two test traps this round, both of which made a spec pass while doing nothing:**

* **The token is `localStorage['ipropy.token']`, a bare string.** Two specs read
  `JSON.parse(localStorage['ipropy.auth']).token`, which is undefined, so every API call they
  made was unauthenticated — and `fetch` does not throw on a 401. `splitViewAdmin.spec.ts`'s
  `afterAll` therefore never restored the global setting it changes, and the header spec's
  tag was never created, which presented as a dialog that did not list it. `e2e/helpers.ts`
  has had the right key all along.
* **`hasText` matches a descendant's text**, so `header.locator('span', { hasText: /:$/ })`
  also caught the *name line's* "Assigned To:" — a line above by design — and the one-line
  assertion failed against correct markup. The strip carries `data-testid="header-fields"`
  and the spec measures its direct children.

### One split view for the whole team

**19 September 2026, the owner:** *"can you create a master in admin for Split view, so that
we can set key and key value for Left pane and Right pane for header and form as we had used
in table view."*

**Admin → Split View**, beside Table View and built the same way: one arrangement for
everybody, stored in `ui.split_view` as `{ module: { queue, header, form } }`, three ordered
lists of field names.

* **queue** — the line under each name in the left pane, joined with a hyphen.
* **header** — the strip beside the open record's name.
* **form** — the fields below it, in one card called Details.

**Every list left empty keeps exactly what the CRM shipped**, and that fallback is the whole
safety of the setting: the queue falls back to the fields flagged `config.listSubtitle`, and
the header and the form to the Layout Designer's arrangement. A module nobody has arranged
looks as it did before the screen existed, and clearing a list gives the fallback back
rather than a blank pane. The row is seeded `{}` for that reason — it changes nothing on the
day it lands.

Three things this cost, all worth keeping:

* **A brand-new settings key lands in the wrong category, and the symptom is a page that
  saves and reads back empty.** `PUT /api/admin/settings` inserts a key it has never seen
  with no category, so it goes to `general`; the admin screen asks for `ui` and never sees
  it again. Migration `160` creates the row under `ui` up front. **Any new `ui.*` setting
  needs the same line.**
* **A settings response that arrives after the first paint wipes what was ticked in the
  gap** — no error, nothing on screen, and it reads exactly like a checkbox that does not
  work. `SplitViewAdmin` renders nothing until the saved arrangement has loaded.
  `TableViewAdmin` has the same shape and has never been reported; it is the same bug
  waiting.
* **The queue's fields have to be asked for.** A list row carries only the columns the list
  requested, so `withQueueSubtitle` now appends the admin's own queue list when there is one
  — otherwise the line is blank on any view whose columns do not happen to include it, which
  reads as the setting not working.

Pinned by `tests/listColumns.test.ts` (`readSplitView`: an unsaved list reads as empty
rather than refusing the module, and a module with nothing chosen anywhere is dropped) and
`e2e/splitViewAdmin.spec.ts`, which does the round trip against a real browser — choose a
field, save, see it in the queue, clear it, see the shipped answer come back. That spec
writes a **global** setting, so it restores it in `afterAll` whatever happens.

## Pressing Call at a desk rings the rep's own phone

**18 September 2026, the owner's report:** clicking Call on a Mac showed Chrome's
*"Open Phone? https://crm.ipropy.com wants to open this application"* — the `tel:`
hand-off asking which app should take the number. A laptop cannot place a phone call, so
the CRM asks the paired handset instead.

* `POST /api/telephony/dial` queues a `dial` command on `ipy_device_command` (migration
  `157`) against the signed-in user's most recently synced active phone, and emits
  `device:dial` to `user:<id>`. Picking "most recent" is safe **here and nowhere else** —
  every device considered belongs to the same person, so the worst case is their spare
  handset. The WhatsApp rebuild carries the same shape as a warning, because there the
  accounts were different people's.
* **The command expires in ninety seconds** (`expires_at`, swept on the next queue). A
  phone back from a flat battery must never ring a customer for a button pressed the
  night before. That rule is the reason this is a queue with a clock and not a push.
* The app's own webview holds the socket, so the instruction arrives in the same second
  and `CallSync.placeCall` fires `ACTION_CALL` — `CALL_PHONE` is asked for the first time
  somebody presses Call, never at pairing. The result is posted back with the **device**
  token, which only the native side holds; a browser session cannot speak for a handset.
* **The CRM waits for that result before claiming anything.** Five seconds of polling
  `GET /api/telephony/dial/:id`; anything other than `done` says so and falls back to the
  desk hand-off. The two ordinary ways it goes quiet are a phone that is off and **an app
  one version behind that has never heard of `placeCall`** — which is every installed
  copy until somebody rebuilds and re-installs it.
* **The Android half is written and has never been compiled here.** There is a JDK but no
  Android SDK in this container, so `placeCall`, the manifest permission and the result
  post are unproven against a real handset. `tests/integration/dialFromTheCrm.test.ts`
  covers the server end — queue, expiry, the phone closing a command, and one handset
  being unable to close another's.
* **And the desk fallback froze the page, which is how it was found.** When the paired
  phone does not take the call the CRM hands the number to the browser, and a browser with
  no application registered for `tel:` starts that navigation, aborts it, and from then on
  delivers **no mouse events to the page at all** — so the outcome form that has just
  opened cannot be saved and every button on the record is dead until a reload. A hidden
  iframe behaves identically; it is the navigation, not where it starts. `dial()` hands it
  to a new tab on the web now and keeps `location.href` for the app, where a webview always
  has a dialler. The symptom to recognise: a click that Playwright reports as successful
  while no `pointerdown` or `click` reaches the document, and a programmatic
  `dispatchEvent('click')` on the same button working perfectly. `e2e/callOutcome.spec.ts`
  had been failing on exactly this since the dial feature landed.

What is **not** possible, whatever a CRM claims: hearing a call as it happens. Android
closed third-party call recording in Android 10 and no permission reopens it. What works
is what `RecordingFinder` already does — the OEM recorder's file, read from a folder the
rep grants once, uploaded **after** the call ends and matched on the last ten digits plus
a time window. The player with play/pause is already in the timeline and the Calls tab.

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

**The shape to watch for**, which has now been found **five** times in this codebase: a
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
* **The semantic index backfill** — `candidates()` took the thirty-two most recently
  *updated* records needing work, so the backlog was permanently last: a record nobody has
  touched for months is exactly the one missing from the index, and every nudge from a
  workflow or a rep jumped ahead of it with text that had not changed, so the batch embedded
  nothing and asked again. Measured on production 17 September 2026: **27,376 rows for 47
  minutes with no growth and 17,061 records still unembedded**, while `updated_at` kept
  moving — not slow, going nowhere. And a database kept awake going nowhere is where the Neon
  bill goes: the burn rose from 0.32 CU to 0.50 CU average across that window. Now
  `ORDER BY (e.id IS NULL) DESC, r.updated_at DESC`, pinned by
  `tests/search/backlogFirst.test.ts`.

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
