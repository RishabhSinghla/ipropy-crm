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

**Android Studio is not required and never was — the SDK is.** This container
has JDK 21 and no Android SDK, and its egress proxy refuses
`dl.google.com`, so it cannot get one. A GitHub runner has both,
which makes `.github/workflows/build-the-app.yml` the way to build the app
without anybody's laptop: web bundle, `cap sync`, `assembleRelease`, the
version read back out of the APK, and a check that `placeCall` and
`CALL_PHONE` are actually inside the build before it is published — their
absence is invisible until a rep presses Call.

**The one thing a runner cannot invent is the signing key.** Android refuses
an update signed by a different key from the version already on the phone, and
2.1.0 was signed on a developer's Mac, so the workflow needs that same
keystore as `ANDROID_KEYSTORE_BASE64` plus its three passwords. It refuses
rather than falling back to the debug key, for the reason `build.gradle`
already states: a debug-signed release installs perfectly and then blocks
every properly signed update after it, months later, on somebody else's phone.

**And the note that said every installed copy predates `placeCall` is out of
date.** The APK published on 20 September 2026 — 2.1.0, versionCode 3 —
**contains it**, along with the `CALL_PHONE` permission and the pending-dial
poll. Read out of the published APK itself (`unzip`, then `grep -a` the dex and
`strings -el` the binary manifest), not assumed.

**The phones are the half nobody had checked, and `ipy_device.app_version`
records it.** Read off production the same day
(`.github/workflows/which-app-version.yml`, read-only): **every handset that
has ever synced reports `1.0.0`**, against 2.1.0 on the download page. Fifteen
paired rows, three of them ever syncing; the Redmi Note 7 Pro uploaded 63
calls at 14:02 that afternoon, so pairing and call sync work perfectly on
1.0.0 — it is only the dialling half that is missing. Dial instructions now
stand at **162, none collected, none reporting how**.

So the thing standing between a desk Call and a ringing phone is **a reinstall
on each handset, not a rebuild and not Android Studio**. Nothing in this repo
can do it: somebody has to open the CRM on each phone and install 2.1.0. Until
then the fixes above are correct and unreachable, which is its own trap —
`app_version` is the field that tells you which.

---

## Two developers, one repo, and whose Claude made the commit

**20 September 2026, the owner:** *"I see my name everywhere why not other dev name
so we get to know this deployment to prod be his code or my code."*

Both developers work from their own Claude Code account, and every commit read
`Claude <noreply@anthropic.com>` — so the commit list, the deployments page and
`git log` all said `claude` for both of them, and nothing said whose change went live.

`CLAUDE_CODE_USER_EMAIL` is the one thing that genuinely differs between the two
sessions, so `.claude/helpers/git-identity.cjs` (a SessionStart hook) reads it and
sets `user.name` / `user.email` **repo-locally** — not globally, because this is the
only repo the two accounts share and a global change would follow a session into
somebody else's work. Adding a teammate is one line in its `PEOPLE` table; an account
nobody has added still gets a distinct name derived from its address rather than a
wrong one, because a commit attributed to the wrong person is worse than one
attributed to an email. The name keeps "(via Claude)" on purpose — a log that reads
as if a person typed every line misleads whoever reads it next.

**The GitHub "Verified" tick is given up, and it was a decision rather than an
oversight.** That badge checks the *committer* against the key that signed the
commit, and these are SSH-signed by the Claude account's key. Measured both ways
rather than assumed:

| what changed | GitHub links it to | verification |
|---|---|---|
| author **and** committer | the developer | `false` — `unknown_key` |
| author only | the developer | `true` — `valid` |

The second row is strictly better and is **not reachable automatically**: git has no
`committer.name` config key — it reads `GIT_COMMITTER_*` from the environment and
falls back to `user.*` — and the shells this tool runs are non-interactive and source
no profile, so there is nowhere to put those exports that every commit would read.
A `.bashrc` block was tried and did nothing. A name that is always right beat a tick
that appears only when somebody remembers a prefix. `main` does not require signed
commits (an unverified one pushed cleanly), so nothing breaks. To have both on one
commit: `GIT_COMMITTER_NAME=Claude GIT_COMMITTER_EMAIL=noreply@anthropic.com git commit …`

**What this does not fix, and cannot from here:** the *deployments* page says
"Deployed by RishabhSinghla" on every row regardless. That is Render's GitHub
integration acting under whoever authorised it, not anything this repo controls. The
commit each row links to now carries the right author, which is the readable half.

**And the bug this file caused on its way in, because it is the house pattern:** the
hook wrapped everything in a `try` that exited 0 silently, so when an edit removed the
name table it looked like it had run while every commit still said `Claude`. A hook is
the easiest place in the repo for a silent failure to hide. It says why it failed now.

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
  as something the customer said, and **identity decides what is stored, never
  the clock**.

  That second one cost 20 September 2026 and is the rule to keep. The poller
  remembered when it last looked and skipped anything stamped earlier — correct
  only if a message becomes readable the moment it is stamped, and
  WhatsMarketing's does not. The owner's "hey" was stamped 07:27:30 UTC, was
  still invisible to a visit at 07:45, and first appeared at 07:48. By then the
  watermark was past it, so it was skipped, and would have been skipped for
  ever. **The poller reported success every single minute throughout.**

  Widening the window was tried twice — fifteen minutes, then forty-five — and
  both are the same bug with a longer fuse: any window is a bet on somebody
  else's worst lag, and losing it is silent. So the window is gone. Every visit
  offers everything it can see and `receiveInbound`'s unique insert on the
  provider message id decides what is new. Identity is a fact; a timestamp is a
  guess about another company's clock. Two bounds keep it cheap rather than
  honest-but-expensive: `HISTORY_FLOOR_DAYS` (a *floor*, measured from now and
  a week back, so it can never creep past something unseen — it exists only so
  a vendor returning a year of history does not import a year) and a `seen`
  set seeded once per process from `ipy_wa_webhook_event`, which makes both the
  repeat visit and the restart free. `seen` is an optimisation and never the
  guarantee.

  **Store everything, announce what is fresh.** `ANNOUNCE_WITHIN_MS` in
  `business/inbound.ts` is six hours: a message older than that is written to
  the inbox, the record and the timeline, and rings nobody. Without it the
  first visit after a vendor is connected — or after its lag catches up — buzzes
  the team's phones about conversations from Tuesday, and a team that switches
  notifications off is how the useful ones get lost.

  **What a customer actually sends, read from their live API on 20 September
  2026 rather than from anybody's documentation:** WhatsMarketing store the
  *entire Meta webhook envelope* against an inbound row —
  `{object:'whatsapp_business_account', entry:[{changes:[{value:{messages:[…]}}]}]}`
  — and a small `{messaging_product, to, text}` against an outbound one. A
  customer's row says `sender: "user"`; ours says `sender: "bot"` with the
  agent id in `agent_name`. Their PDF says none of this, which is why six of
  the owner's messages read as unreadable while the poller reported success
  every minute. The envelope goes to `metaCloudProvider.parseWebhook`, the
  parser the CRM already has for exactly that shape — **one parser, so the
  webhook door and the polling door learn a new message type together.** A
  copy would drift, and the way it drifts is that one of them quietly stops
  understanding a customer.

  **`handle` is a matching key and must never be a destination.** Every
  free-text reply this CRM ever attempted failed on that, and the error said
  something else entirely. `ipy_conversation.handle` is the last ten digits on
  purpose — it is what matches a contact whose mobile might be stored as
  `9891222206`, `+919891222206` or `0 9891 222206` — and `sendOnBusinessNumber`
  was handing it to the provider as the number to send to. WhatsApp read ten
  digits as a different person from the `919891222206` who had just written in,
  found no session for them, and refused with *"Sending message outside 24 hour
  window is not allowed. You can only send template message to this user."*
  Which reads exactly like a window bug and is not one: read off production on
  20 September 2026, `window_expires_at` was the following morning and the send
  was refused anyway.
  Migration `163` adds `ipy_conversation.wa_id`, WhatsApp's own id, written from
  every inbound message so threads that predate it heal themselves the first
  time their customer writes again. `dialableNumber` in `business/send.ts`
  prefers it, then a number the caller already gave in full, then the record's
  `country_code` + `mobile` through `toInternational` — and **refuses rather
  than assuming +91**, because a silent Indian default sends an NRI buyer's
  message to a stranger and cannot be taken back.
  The two sends that did work, on 18 September, went to handles that happened
  to be longer than ten digits. That is the whole reason this looked
  intermittent.

  **The same rows carry delivery receipts for what *we* sent**, also
  undocumented: `message_status`, `delivery_status_updated_at`, `read_time`
  and `failed_reason` on a `sender: "bot"` row. `readOutboundStatus` hands
  them to `applyStatus` — the webhook's own function, which only moves a
  status forward and claims each one once, so re-reading a thread every minute
  is free. Without this the CRM knows only that it handed a message over, and
  **a campaign report could count attempts and never arrivals** — "sent 900"
  meaning nothing at all.

  **Their template listing contains a live Meta access token**, in
  `template_json` and `raw_data`, and on 20 September it reached a GitHub
  Actions run log before anybody noticed. That log was deleted and the token
  must be treated as exposed. `test-whatsmarketing.yml` now pipes every
  response through a `redact` filter — the credential-bearing fields by name,
  plus Meta's `EAA…` prefix generically. **A vendor's response is not ours to
  trust with a log**, and this is the second time a third party's payload has
  carried something it should not; assume the next one does too.

  **The diagnosis came from the poller's own report, not from the vendor.**
  `whatsapp.last_poll` carries the handle the newest visible message came from,
  how many were already held, and what was dropped, by cause. Before that,
  "stored 0" covered five different failures. The raw-thread probe was tried
  first and cannot work: it needs a repository secret that is not set, and the
  live key exists only encrypted inside the CRM — printing a credential to
  fetch a diagnosis is the wrong trade.

  **A template row carries two ids and their documentation names neither as
  the one to send with.** `template_id` is Meta's long id
  (`1574812586925817`); `id` is their own row (`340813`). The adapter sent
  Meta's, on the strength of the send parameter sharing its name, and on
  20 September their API answered *"Message template not found."* about a
  template that had synced from them minutes earlier — a red bubble in front
  of the owner. Both are kept now (`otherId`), and `sendTemplate` retries with
  the other one **once, only on that exact refusal**: a blanket retry would
  double every real failure, and this one is narrow enough that the worst case
  is a second refusal nobody sees. When it works the log says which id did it
  — `whatsmarketing accepted the other template id` — and **that is the line
  to come back and write down here**, because it is the only way this stops
  being a guess.

  **`org.country_code` (migration `164`) is the other half of the dialling
  rule.** Refusing a number with no country code is right — `toE164` assumes
  India, and an unseen Indian default sends an NRI buyer's message to a
  stranger — but on 20 September the owner met the other end of it: most of
  the 22,988 contacts were imported with a ten-digit mobile and no
  `country_code`, so **every one of them was unreachable**, refused before the
  provider was called. What the warning is about is a default *nobody can
  see*. This is a row with a label in Admin → Settings, seeded `91`, and a
  contact carrying its own code still wins over it.

  **And the refusal after that one is not ours, which is the point of writing
  it down.** The owner sent the same template twice on 20 September: 10:52 UTC
  answered *"Message template not found."*, and 11:00 UTC reached Meta and came
  back *"(Error Code : 131049 )In order to maintain a healthy ecosystem
  engagement, the message failed to be delivered."* — read off production, not
  from the screen. **131049 is Meta limiting how many marketing messages one
  person may receive**, and nothing on this side lifts it: the customer writing
  in first (which opens the 24-hour window) or a utility-category template are
  the only two ways past it. What changed between the two attempts is **not
  established** — either the template-id retry reaching production or a sync
  refreshing the minute-long `templateCache` would produce it, and both are
  possible in that gap.

  `business/whyItFailed.ts` puts a plain sentence in front of the codes we
  recognise and **keeps the provider's own words after it**, because the
  original is what a support conversation with the vendor is about and an
  unrecognised code must stay readable. An unknown code is passed through
  untouched rather than guessed at (`tests/whyWhatsAppRefused.test.ts`).

  **Their `category` is useless for this and it looks useful.** All ten synced
  templates read `general` — WhatsMarketing's own word, from `check_wp_type` —
  so the CRM cannot tell a marketing template from a utility one, which is
  exactly the fact 131049 turns on. Do not read that column as Meta's category.

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

**It wears the split view's clothes, and that was an instruction.** 20 September 2026,
against a screenshot of the leads page: *"you've got this page and the beauty of this page
right, similar beauty and type I want for my whatsapp module page also"*. So the queue row
**is** the split view's row rather than something like it — the open one marked by a `span`
and not a `border-l` (two `border-*` utilities on one row let Tailwind's stylesheet order
pick the colour, and the marker came out slate on slate once), a bold name, the last
message under it, and the time above one chip on the right. Two lines each side; two chips
on two lines with two different right edges is what makes a queue look ragged.

The conversation header is the record header: avatar, one name line that truncates rather
than wraps, a fact strip under it that never wraps, and the actions as the same grey
circles that fill with their own colour on hover. It was five bordered buttons and two
dropdowns wrapping onto a second row, which is what he was looking at when he asked.
`ACTION_BASE` / `ACTION_REST` / `ACTION_CIRCLE` moved out of `IpropyWorkspace.tsx` into
**`lib/actionCircle.ts`** for the reason this repo keeps re-learning: a second copy of
three class strings is a second thing to keep in step, and the first time they disagree
the same button looks different depending on which page you arrived from. The `*_REST`
string stays separate from the shape because a button that is *on* needs its own
background, and a later `bg-*` in the same class list does not win.

**The whole contact sits beside the conversation now, and one set of
components draws it everywhere.** 20 September 2026, the owner: *"I don't
need it there instead all those details … I do not want to switch screen
during whatsapp chat and then and there I want all info of that record
everything in the right pane."* The pane used to hold two summary cards and a
link, so answering "what is their budget" meant leaving the chat and coming
back to two new messages.

Three pieces came out of `IpropyWorkspace.tsx` rather than being copied, which
is the whole point:

* **`lib/recordPanes.ts` — `useRecordPanes(module)`** decides which fields a
  record's header strip and field cards show: Admin → Split View first, the
  Layout Designer second, the module's own flags last. **No screen names a
  field.** A copy of this reasoning would drift, and the way it drifts is that
  one screen learns about a new Split View setting and the other does not, so
  the same record reads differently depending on where you came from.
* **`components/RecordBlocks.tsx` — `FieldBlock`, `NotesPanel`,
  `HeaderFieldStrip`.** The strip owns its own `ResizeObserver` and the
  count-what-fits rule (invisible rather than unmounted, or the measurement
  that produced the count stops being true). `data-testid="header-fields"` is
  still on it, so `e2e/splitViewHeader.spec.ts` measures the same element.
* **`components/ChatRecordPane.tsx`** puts those cards in the Chats right
  column, on **the same query keys** the record page and the split view use —
  so an edit made in the chat invalidates the record page, and opening one
  warms the other.

The chat header carries the same strip (`ChatHeaderFields`), which is a
component of its own only because `useRecordPanes` is a hook and the header
renders inside a conditional.

**Unproven in a browser**, like everything else on this screen: the Chats
pane only renders when a provider is connected and none is on a developer's
database. What is proved is that the split view is unchanged — typecheck,
967 unit tests and the full build are green, and its specs still find the
strip they measure.

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

**The record's WhatsApp tab finds its thread by number, not only by link.**
`matchContact` attaches a conversation to a record when a message arrives,
which is the right moment to *try* and the wrong moment to depend on: the
contact may not exist yet, two records may share the number, or it may sit in
a field the matcher does not read (it reads `uitype = 'phone'` **and**
`storage = 'column'`, so an admin-created phone field — always `json` — is
invisible to it). On production, 20 September 2026, a thread from 9811533633
sat unlinked beside a contact holding that exact number, and the tab showed
nothing, which reads as WhatsApp being broken. The route now matches
`c.record_id = $1 OR c.handle = ANY($2)`, the handles coming off the record
`getRecord` has already authorised — so nobody reads a thread whose contact
they cannot open, and linking becomes tidiness for the shared inbox rather
than the thing the tab depends on. The empty-array guard matters: an unguarded
`= ANY('{}')` is not an error, it simply matches nothing, and the day somebody
inverts that condition it would match everything.
**And sending from a record takes the link** (`conversationFor` in
`business/send.ts`): a person pressing Send is the one moment all three
failure cases are settled, and `COALESCE` means it never steals a thread that
already belongs to another record.

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

### Three bugs the owner found in an hour, 20 September

All three were live, and two of them had never run at all.

* **Moving a record between the modules had never once worked.** *"Bug in Move to Lead"* —
  the dialog answered "Lead Status is required" and the record stayed where it was.
  `moveRecord` deliberately drops both modules' stage values (*"Available" is not a thing a
  person can be*) and left the destination to "apply its own mandatory default".
  **Neither module's stage field has a default**: both are mandatory with an empty
  `default_value`, so every move in both directions failed validation, silently, since the
  day it was written. It now sets the destination's **first dropdown option**, read off the
  picklist rather than the word "New" written into the file — a hardcoded value is a move
  that breaks the day somebody edits a dropdown. The stage field is also found by name *or
  column* now, the same `lead_status`/`status` drift as everywhere else.
  `tests/integration/moveBetweenModules.test.ts` moves one each way.
* **Every WhatsApp send died on the opt-out check.** *"Unknown field referenced in the
  request"* is the error handler's wording for Postgres 42703, and the cause was
  `SELECT id FROM ipy_channel_optout` — a table keyed on `(handle, channel)` that **has no
  `id` column and never has**. It is `SELECT 1` now.
  **Why it survived is the part worth keeping:** nothing had ever run it. The composer has
  never been opened against a live provider, and every test that calls
  `sendOnBusinessNumber` expects it to refuse *earlier*, at "no provider is switched on" —
  so the first thing to reach that line was a customer waiting for a message.
  `tests/integration/whatsappSendReachesTheProvider.test.ts` switches a provider on for
  exactly that reason: it is the only way to make those queries execute.
  **The lesson generalises.** A guard that every test trips over is a guard that hides
  everything behind it. Where a path is gated on configuration this CRM does not have in a
  test database, the test has to supply the configuration, not accept the refusal.
* **Click-to-call is not broken.** *"Your phone did not pick that up"* is the documented
  behaviour when the paired handset does not answer, and the desk hand-off it falls back to
  worked — the Log call dialog opened. The real cause is almost certainly the one already
  written down: **every installed copy of the app predates `placeCall`** and will until
  somebody rebuilds and re-installs it, which cannot be done from this container (there is
  a JDK and no Android SDK). The message says that now rather than asking whether the phone
  is switched on, which sends a rep checking a phone that is working perfectly.

### What is actually proved, read off production on 20 September 2026

The owner asked whether the foundation is strong and whether he can stop
opening WhatsMarketing, and said he doubted it. `.github/workflows/whatsapp-audit.yml`
is the answer: read-only, one promise at a time, **and it prints the zeros**,
because a feature that has never once run is invisible from every screen.

What the numbers said:

| promise | evidence |
|---|---|
| a customer's message arrives | inbound rows through to 10:25 that morning |
| a rep replies inside 24 hours | 4 outbound, all `read` |
| the CRM learns what arrived | 4 delivered and 4 read stamps, from the poller |
| a thread finds its contact | 5 of the 6 business threads linked |
| the inbox stays clean | 6 business threads, **0** odd handles |
| a template reaches somebody | **2 attempts, 0 arrived — never once** |
| a photo or document moves | **0 files kept**; nothing has ever gone either way |
| a campaign runs | **0 campaigns have ever existed** |

**The 120 imported personal-WhatsApp threads are correctly invisible.** They
carry group ids (`+120363…`) and malformed handles, and every one of them has
a `wa_account_id`, which is exactly what `listConversations` filters on. Worth
knowing because it looks alarming in the table and is the filter working.

**The ten synced templates genuinely have no blanks** — wording is 119 to 617
characters and not one contains `{{n}}`, so "0 mapped" is correct rather than
unfinished. Checked with `length(body_text)`, since empty wording and wording
with no placeholders both read as zero blanks and mean opposite things.

**Two conversations hold no messages at all.** A send that fails creates the
thread and then throws, so the empty row stays in the team's queue reading
"No messages yet" — the owner saw two of them. Cosmetic, and still a promise
broken: `business/thread.ts` says looking writes nothing.

**Three things still need WhatsMarketing's own dashboard**, so the answer to
*"never open it again"* is **not yet**: a template can only be **read** here,
never written and submitted for Meta's approval; their inbound webhook is
switched off, so replies are polled rather than pushed; and the account itself
— business profile, display name, credit — is theirs.

### Opened in a browser with a provider connected, 20 September 2026

Every line in this file that said *"never opened in a browser"* about WhatsApp
was true until this. A provider **was** connected — Meta Cloud pointed at a
local stub through its own `baseUrl` config, which is why that field being a
setting rather than a constant paid for itself — a customer's message was put
through the real webhook, a reply was sent, receipts came back, templates
synced, and a campaign ran. Six faults came out of it, and **all six were
invisible to 812 unit tests, 661 integration tests and a clean typecheck**,
because every one of them lives past the "no provider is switched on" guard.

* **Every fact in the chat header was invisible.** `HeaderFieldStrip` measured
  with `child.offsetLeft`, which is relative to the nearest *positioned*
  ancestor rather than to the strip. In the split view the two happen to agree;
  in the Chats header the strip sits 390px in, so every field computed as "does
  not fit", all of them went `invisible`, and the header showed a lone `…`. It
  measures from `getBoundingClientRect()` now. **A latent bug the split view
  could never have shown.**
* **The contact's name read "Riya …".** Sharing a row with the assignment box
  and the last-message line, `min-w-0 truncate` made the name give way first —
  three characters of the one thing on that screen that has to be readable. The
  name floors at `9rem`; the last-message line yields instead, and the queue row
  beside it already says the same thing.
* **The strip repeated the two biggest things on the screen.** "Full Name" is
  the heading and "Mobile" is the line under it, and between them they ate the
  whole strip. Both are dropped through metadata — `labelFields` and the phone
  field `useRecordPanes` already finds — never by naming a field.
* **A refused message said "Something went wrong on our end."** The server knew
  exactly why (`whyItFailed` was already writing the reason onto the row); it
  rethrew the raw error, which became an unhandled 500, which the client can
  only render as that sentence. `sendOnBusinessNumber` throws a
  `BadRequestError` carrying the same words now, and the screen refreshes on
  failure so the rep's own message stays in the thread marked NOT delivered with
  the reason under it — which is what WhatsApp does and what the bubble was
  already built to draw. **Before this a failed message vanished off the
  screen entirely.**
* **Two providers implemented template sync and never declared it.** Meta's
  `listTemplates` reads `GET /{waba-id}/message_templates` — the reason the
  setup guide asks for a WABA id — and Gupshup's reads their own list, but
  neither had `templateSync` in its capability set, so the Sync button answered
  *"whatsapp_meta does not hand its template list back"*. It does.
  Pinned in `tests/whatsappProvider.test.ts`.
* **"Reached the phone" counted the customer's own messages.** An inbound row
  is stored `delivered` the moment it arrives, and the Health tile counted every
  status rather than outbound ones — so it read **17 against 8 sent**. A
  delivery receipt is about a message we sent.
* **And the Health page named WhatsMarketing whichever provider was connected.**
  It reads the connected card's own name now.

**The one that would have cost money: a campaign previewed as "Send to 84" with
all 84 rows reading "Will be skipped".** An unmapped blank is unfilled for
*everybody* — WhatsApp refuses a template with a hole in it — and `reachable`
cannot see it, because it counts who has a number. So the approver is shown a
number, approves it, and not one message goes. That is precisely the failure
this whole feature exists to prevent, wearing the feature's own clothes.
`previewCampaign` answers `unmapped` separately now, the dialog says *"Nobody
would get this"* above the sample names rather than below them, and the Send
button is disabled until the blanks are mapped.
`tests/integration/whatsappCampaigns.test.ts` pins both halves — an unmapped
blank is named, a mapped field that is empty on one record is still an ordinary
per-person skip.

**What the walk proved works, first time, end to end:** a customer's message
through the real webhook opens a thread, matches the contact by number, writes
`wa_id` and opens the 24-hour window; a free-text reply reaches the provider and
shows as sent; delivered and read receipts arrive signature-verified and move
the status forward only; a template syncs from the provider and its blanks fill
per recipient; a campaign freezes its audience at approval and sends **exactly
ten a minute** (measured — an earlier "nothing is sending" was the dev server
restarting on every edit and resetting the timer, not a bug); and the messaging
report counts real outbound traffic for the first time.

**The familiarity half, which was the other thing asked for.** The conversation
sits on a tinted canvas so a white incoming bubble reads as a bubble; the date
is one chip down the middle (`dayLabel` in `lib/whatsapp.ts`) instead of a full
date on all forty bubbles from one afternoon, and the bubble keeps the clock
alone. `tests/whatsappDayLabel.test.ts` pins that it compares **calendar days,
not hours elapsed** — 11pm and 1am are different days however close they are.

**How to do this again, because it is the only way these are found.** Point
Meta Cloud's `baseUrl` at a local stub that answers the Cloud API's shapes,
switch the card on, and post to `/api/webhooks/whatsapp/meta`. A guard that
every test trips over is a guard that hides everything behind it; the test has
to supply the configuration, not accept the refusal.

### The Health page was an empty grey box, and the guard is why

**20 September 2026, the owner, against two screenshots** — `/whatsapp/health`
and `/admin/whatsapp`, both showing nothing but a grey rectangle: *"whats wrong
in here dude"*.

Two faults, and the second is the one worth keeping.

* **`whatsAppOverview` counted templates with `body LIKE '%{{%'`.** The column
  on `ipy_whatsapp_template` is **`body_text`**; `body` has never existed. So
  Postgres refused the whole statement (42703), `/overview` answered 500, and
  the screen had nothing to draw. This is rule 8's neighbour — the SQL is a
  string, so typecheck cannot see a wrong column and a unit test with a mocked
  `db.query` accepts any statement at all.
* **A failed request is not a loading one.** The page guarded with
  `if (isLoading || !data)`, and on an error `isLoading` is false while `data`
  stays undefined — so it held its loading skeleton **for ever**. That is why
  the report could only be "what's wrong in here": an empty grey box names
  nothing. It now renders the error, says the rest of WhatsApp is unaffected,
  and prints the reason. **Any screen written as `isLoading || !data` has this
  bug waiting**; the pattern is the finding, not the one page.
  `admin/SharingAdmin.tsx` and `admin/MatchingSetupAdmin.tsx` still carry it —
  left alone because neither has been reported and neither could be checked
  against a failing request from here, but they are the next two to meet it.

`tests/integration/whatsappOverviewLoads.test.ts` runs every query in that
function against a real database and was checked both ways: it fails with
*column "body" does not exist* on the old code and passes on the fix. It
asserts no business meaning on purpose — what broke was whether Postgres would
accept the statement at all.

**And a trap that cost a run on the way in: a SQL comment inside a template
literal may not contain a backtick.** `` -- `body_text` is the column `` ends
the string, and esbuild fails with *Expected ")"* pointing at the next word,
which reads like a broken query rather than a broken quote.

## Campaigns: one template, many people, once each

**19 September 2026, the owner: "now start campaigns"** — the next thing in his own order
after the inbox.

**This feature exists under one rule, and the rule is this repo's own history.** On 13 and
16 September a *daily* workflow whose condition list had emptied itself queued 40,515
WhatsApp messages — 20,209 people holding two each — and nobody received one only because
no provider was connected. Luck, not a safeguard. A campaign is deliberately "message many
people", so "refuse to match everybody" cannot be the protection. These are, and each one
is tested:

* **Nothing sends until a person approves a number they have been shown.** The screen has
  no Send button until the preview has run; the button then *carries that number*, approval
  passes it back, and the server refuses a mismatch — so an audience that moved between
  reading it and approving it stops rather than surprises. `audienceVerdict` is pure and
  exported for exactly that reason (`tests/campaignCeiling.test.ts` walks every threshold).
* **The audience is frozen at approval.** One row per recipient in `ipy_campaign_recipient`,
  written then. A saved view widened afterwards cannot grow a running campaign, because
  nothing re-reads the view. Pinned by `tests/integration/whatsappCampaigns.test.ts`, which
  approves, then adds a matching contact, then checks the campaign is still the size it was.
* **Once each**, by a unique index on `(campaign_id, record_id)` rather than by whoever is
  careful — and **once per number**, not per record: two contacts on one husband-and-wife
  handset are one person. Worth knowing that `createRecord` already refuses a second record
  with the same *mobile*, so the way this really happens is an `alternate_phone` matching
  somebody else's mobile, or an import, which bypasses the duplicate check.
* **A ceiling.** Over 500 needs an explicit second confirmation; over 5,000 is refused
  outright. Twenty thousand has been queued by accident here once already, and splitting a
  genuine large campaign costs an afternoon rather than a reputation.
* **Every refusal is a row somebody can read** — opted out, no number, a blank the template
  needed. The birthday messages were invisible until somebody thought to count the queue.
* **Opt-out and the 24-hour window are not re-implemented.** Every message goes through
  `sendOnBusinessNumber`, the one send path, which already refuses both. A refusal marks
  that recipient and the campaign carries on: one person who opted out must not stop the
  other three hundred. An opt-out or a shut window reads as `skipped` (the customer's
  answer); anything else is `failed` (something to look at).
* **Ten a minute, on its own clock** (`startCampaignSending`). Not a throughput decision: a
  campaign approved by mistake has a minute in which somebody can press Pause and only ten
  people have heard about it.

**A campaign sends an approved template and nothing else.** Outside WhatsApp's 24-hour
window nothing else may go, and a campaign by definition reaches people who are not in an
open conversation. The blanks are filled per recipient by `resolveTemplate`, **read as the
person who approved it** — so a campaign cannot put a value in front of a customer that the
approver was not allowed to see. A template with an unfilled blank is skipped and named,
never sent with a hole in it.

**Deliberately absent: a schedule.** A campaign that fires itself at nine in the morning is
precisely the shape of the rule that caused all this. A person approves it, with the count
in front of them. Building one is `whatsapp.send`; **approving one is
`whatsapp.templates`** — writing a campaign and deciding it goes to nine hundred people are
not the same decision.

Migration `161`. Admin → Campaigns. **Never exercised against a real provider**, like
everything else on this route: what is proved is the ceiling, the freeze, the
once-per-number rule, the skip reasons, and the screen refusing to offer a Send button
before a preview (`e2e/campaigns.spec.ts`). Reports followed on 20 September — see
**Reports** below.

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

**His order for this route is done:** the inbox, templates, media, sharing a unit,
campaigns, and reports.

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


## WhatsApp is one destination now

**20 September 2026, the owner:** *"why don't we get most of its things
(whatsmarketing) … inside our CRM to that max … so maybe never ever in this life
I would be required to open whatsmarketing"* — a mixture of their dashboard and
the WhatsApp Web everybody already knows.

Until then WhatsApp lived in four places and three were inside **Admin**, where a
rep never goes: the inbox at `/chats`, plus health, templates and campaigns each
on their own admin tab. Nobody thinks *"I need the campaigns admin page"*; they
think *"I want to do WhatsApp"*. `/whatsapp` is one destination with four tabs in
the order a day runs — **Chats · Campaigns · Templates · Health**.

**Nothing there is a new screen.** Each tab renders the component that already
existed and every old address still works: `/chats` in particular, because that
is what the WhatsApp icon beside a phone number opens. This moved the door, not
the room — a second copy of the inbox would drift from the first, which is the
mistake this repo keeps finding months later.

Two decisions the owner made when asked, both on the day:

* **Everybody sees Chats**, so that tab carries no capability. The inbox already
  decides *what* each person sees — their own threads and the unassigned queue,
  an admin everything — so gating the tab as well would hide the screen from the
  very people whose conversations it holds. Campaigns is `whatsapp.send`,
  Templates `whatsapp.templates`, Health `admin.integrations`.
* **Chats and the record are both the daily driver**, so neither is demoted.

**`HeaderTab['kind']` gains `'whatsapp'`, and the append line matters more than
the tab does.** Every arrangement saved on production predates this page, so an
arrangement that does not name it has not decided against it — without the line
in `arrangeHeaderTabs` it is the one screen nobody can reach, exactly as Chats
was. It is in the drawer too, because the switcher is `lg:block` and does not
exist below 1024px. `tests/headerTabs.test.ts` pins both.

**WhatsApp is a green button on the bar now, not a line in the switcher.**
20 September 2026: *"bring this module right into the top header where that
dropdown of leads and all is there … give it some tacky color maybe green or
something else to highlight to team that this is whatsapp chat system here."*
So `ModuleSwitcher` returns `[]` for the `whatsapp` kind and `Layout` renders
its own `NavLink` beside it, in WhatsApp's own green. It is deliberately **not**
`lg:` like the switcher: the rule this repo already wrote down is that a
destination living only in the switcher is invisible below 1024px, and this is
the screen a rep lives in.

**Reports is folded into that page, on the same instruction** — *"merge this
reports module into this whatsapp module only"*. It is the same `Reports`
component, still carrying its own Records / Messaging split, and `/reports`
still answers so nothing bookmarked breaks. `reports` is out of `KINDS` in
`arrangeHeaderTabs`, so production's saved arrangement — which names it —
drops it rather than rendering a tab beside a button that goes to the same
place. Worth knowing before moving it back: the Records half counts contacts
and units, which has nothing to do with WhatsApp, so "contacts by source" now
lives under a WhatsApp heading. That is his call, recorded rather than argued
with.

**A rep with only Chats sees no tab strip**: one tab is not a choice, and a row
of one reads as something missing. The fallback route goes to the first tab that
person may open rather than a fixed one, so a rep is never bounced to a page they
cannot see.

## What WhatsMarketing's API can and cannot do — probed, not assumed

**20 September 2026, the owner:** *"do things so as much as possible things be
done/come from whatsmarketing to here CRM and we need very less or never to open
whatsmarketing ever in life."*

`.github/workflows/discover-whatsmarketing.yml` asked their live API which of
twenty-five candidate endpoints exist. **Every guess 404'd except one.** What
their API actually answers, in full:

| endpoint | what it gives |
|---|---|
| `whatsapp/send`, `/send/file`, `/send/template` | sending |
| `whatsapp/upload/media` | a media id |
| `whatsapp/get/template/list` | the approved templates, **read only** |
| `whatsapp/subscriber/list`, `whatsapp/get/conversation` | inbound, which the poller reads |
| `whatsapp/get/message-status` | delivery receipts |
| `user/package/list` | answers *"You do not have any Team Role yet"* — no plan data |
| `users/team-member/list` | exists, answers `[]` |
| `whatsapp/catalog/list` | exists, answers `[]` |

Everything else tried — phone-number lists, bots, campaigns, broadcasts, tags,
attributes, opt-ins, business profile, wallet, balance, flows, analytics,
reports — returns their 404 page.

**The conclusion is that there is nothing left to pull in.** Every endpoint of
theirs that carries data is already read by this CRM, and the three that are
not — package, team members, catalogue — answer with nothing for this account.
So the module is not unfinished for want of effort; it is at the ceiling their
API sets. Anyone asked to "bring more across" should read this table first
rather than start guessing endpoint names again.

**So "never open WhatsMarketing again" has a hard ceiling, and it is worth
stating plainly rather than being discovered later: a template can only be
*read* through their API, never written.** Creating one and submitting it for
Meta's approval happens on their site. The same goes for the account itself and
for switching their inbound webhook on. Everything that is *about a
conversation* can live in the CRM; everything that is *about the account*
cannot.

The probe reads only. No create, update or delete endpoint was tried, on
purpose: one that existed would have written to the business's real account,
which is not a thing to find out by accident. So this is evidence that the
plausible names are absent, **not** proof that no such endpoint exists under a
name nobody guessed — their own documentation is the authority, and the copy
the owner sent has no create-template section.

## Reports

**20 September 2026, the owner: "now start reports"** — the last item in his own
order for this phase, after campaigns.

**A report is a saved `WidgetConfig`, and that is the whole design.** The engine to
answer one already existed: `core/analytics/widgets.ts` runs a config against any
module, through the same permission-scoped SQL every list uses, and that is what a
dashboard tile is. What was missing was somewhere to *keep* a question away from a
dashboard's grid. A second query engine for reporting would have drifted from the
first the day somebody deleted a field.

* **Nothing is cached, deliberately.** `ipy_report` (migration `162`) stores the
  question; running it is a live query **as the person asking**. A shared report
  opened by a manager and by a rep is one question over two different sets of
  records — which is what "shared" has to mean in a CRM with a role hierarchy. A
  stored total would be one number for everybody, which is a permissions leak
  wearing a chart. `tests/integration/reports.test.ts` proves the two answers differ.
* **Sharing is the same decision as sharing a dashboard**, so it is the same
  capability (`dashboards.share`) rather than a new one. A new capability is held
  by nobody until an admin ticks it on every profile, so on the day it shipped the
  feature would read as broken.
* **The export is the answer, not the records behind it.** "Contacts by source"
  exports as five lines. Exporting the records is what the list's own export is
  for, and that is gated on `records.export`; this is not a way round it, because
  a count of records is not the records. Values are prefixed against spreadsheet
  formula injection and the file carries a BOM, or Excel reads a Devanagari name
  as mojibake and the file looks corrupt.
* **The screen is one sentence:** *how many / total of / average of — contacts —
  grouped by — status — this month*, then a shape (bars, pie, over time, table,
  one number). It answers **before** anybody configures it: a report page that
  opens empty asking for four choices is one nobody uses.

**`ChartFrame`, `SeriesSummary` and `formatValue` moved out of `Dashboard.tsx`**
into `components/ChartFrame.tsx`. Copying them would have been quicker and is the
mistake this repo keeps finding months later — the accessibility handling in
`ChartFrame` is subtle (recharts renders unlabelled `<path role="img">` and
re-adds `tabindex` on every resize), and a second copy would drift from it in
silence.

**Reports had to be appended to the header arrangement, and that line is the one
the Chats note predicted.** Production's saved arrangement was written before this
page existed, so without `arrangeHeaderTabs` appending a `reports` entry it would
have been the one screen nobody could reach — invisible in exactly the way Chats
was. It is in the drawer too, because the switcher is `lg:block` and does not exist
below 1024px.

### The WhatsApp half of it

The second tab answers the three questions somebody actually asks of the business
number: how much came in and went out per day, what happened to the messages sent
(delivered, read, failed), and how each campaign ended.

* **Counted from the CRM's own rows, never a vendor dashboard** — the rule this
  whole phase was built on, and why the numbers survive changing provider.
* **Who may count is who may read.** `visibility()` in `business/inbox.ts` is
  exported and reused rather than copied: an admin counts every thread, everybody
  else counts their own and the unassigned queue. A report that counted everything
  would tell a rep exactly how many conversations their colleagues are having,
  which is the thing the shared inbox deliberately does not show. Campaigns are an
  admin-only block for the same reason.
* Rule 8's cousin again: the day window is `($n::text || ' days')::interval`, cast
  at the point of use, because a bare parameter beside `interval` deduces two types
  and Postgres refuses the whole statement.

Proved by `tests/integration/reports.test.ts` (5), `e2e/reports.spec.ts` (4,
including that the page is reachable from the navigation rather than only by URL)
and an a11y scan of both tabs in both themes. **What has never been seen is a
messaging report with real outbound traffic**, because nothing has ever been sent
on the business number — the tab reads from two inbound days on a developer's
database.

## Tags: what they count, where they show, and which module they belong to

**19 September 2026, three reports in one message**, plus two more an hour later.
All of them are about the same thing: a tag is shared vocabulary, and every screen
has to agree about it.

* **The number beside a tag counted links, not records.** A tag whose list says
  `2 of 2 records` read **229**, because `COUNT(ipy_tag_link)` survives both
  things that take a record off a list: a delete only flags the row, and a tag
  offered on both modules carries links to the other one. The count joins
  `ipy_record` now, excludes `is_deleted`, and narrows to the module being asked
  about. Pinned in `tagsBelongToAModule.test.ts` — against the old query it read 3
  where it should read 1.
* **There is no "shared tags" split any more.** Every tag name is unique across
  the CRM and everybody can read every tag, so "mine" only ever meant who typed
  the name first. One flat **Tags** section in the picker. Lists keep their split,
  because a list somebody else built genuinely is a different thing.
* **A record's tags are chips in the header of every view, before the icons.**
  `TagChips` in `components/TagButton.tsx`, on the record page (which is what the
  table and the kanban open) and in the split view's action strip. It replaced two
  different hand-rolled chips that disagreed: the record page capped at three and
  painted a raw hex behind white text, the split view capped at two and painted
  everything brand blue. Colour goes through `Badge`, so an admin's own tag
  colour is what shows and `lib/color.ts` still guarantees AA in both themes.
* **A tag narrowed to one module must not appear on the other — and could.**
  `sale` showed on a contact although the tag is not offered on Contacts.
  Migration `154` narrowed the *picker*; it did not narrow the links already
  written, and `POST /records/:module/:id/tags` never checked. Both ends are
  closed now: the write refuses a tag this module is not offered, and both reads
  (`getRecord` and `listRecords`) filter to `cardinality(modules) = 0 OR modules @> ARRAY[module]`.
  Empty `modules` still means everywhere.

**A dialog sharing a query key with something always on screen reads a stale
list.** The tag dialog used to be the only thing asking for `['tags', module]`,
so it always fetched fresh; the chips ask for it the moment a record opens, so
by the time somebody opens the dialog the answer has been cached for a minute
and **a tag created in the meantime is not offered**, with nothing on screen to
say why. The dialog refetches on open for that reason. `splitViewHeader.spec.ts`
caught it, because it creates a tag through the API and then looks for it.

**The two dropdowns above the list read like fine print, and now do not.**
The stage breakdown (`StatusBreakdown.tsx`) and the list/tag picker
(`ListPicker.tsx`) are one size up, counts sit in chips, and the chosen row is
filled and ringed rather than half-tinted — `CHOSEN`, exported from
`StatusBreakdown.tsx` so the two cannot drift. **The per-stage percentages are
gone on the owner's instruction**: the count is the fact, and a share of an
already-filtered list is a second number to read past.

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

* **The field strip never wraps.** It is one row, and a `…` appears at its end when
  something is out of sight — which is the cue to go and shorten the list in Admin → Split
  View rather than a silent loss. Measured with a `ResizeObserver` on the strip itself: a
  window listener is not enough, because the strip also narrows when the queue's divider is
  dragged and that moves no window.
  **It counts what fits rather than only clipping.** Clipping alone cut the last field
  through the middle of a word — "Budg…" — which reads as a broken screen rather than as a
  full line. The ones that do not fit are made **invisible rather than unmounted**: they keep
  their space, so the measurement that produced the count stays true and the count cannot
  oscillate between two answers on every frame.
  **And it sits below the whole row, not inside the name's column**, so it runs the header's
  full width and uses the space under the action icons. Nested beside them it stopped where
  they began and a third of the line was empty on every record — three fields fitting where
  six do now.
* **The name line stopped wrapping too**, which is where most of the height was going: a long
  name pushed *Updated …* onto a second row, so the header grew by a line for nothing. The
  name gives way first (`truncate`) and everything beside it holds its width.
* **The delete circle is gone.** Delete is in the three-dot menu a few pixels away, and one
  destructive action offered twice, a thumb's width from Call, is one more chance to hit it
  by accident than it is worth.
* **The favourite star saved and did not move**, which is the whole of *"favourite icon does
  not work properly in split view"*. `invalidateRecordQueries` was called without the
  record's id, so the lists refreshed and `['record', module, id]` — which is what this
  header reads — did not. The press looked like it had done nothing.
  **A mutation in this pane passes the id**, always: the header shows the fetched record, not
  the list row.
* **The action circles fill with their own colour on hover** and are grey at rest — his
  instruction, and the right way round: four tinted circles at rest read as four warnings,
  while one filling under the cursor says what it is exactly when that matters.
  `ACTION_BASE` and `ACTION_REST` are separate strings for a reason worth keeping: the
  starred state needs its own background, and `bg-amber-500` written after `bg-slate-50` in
  one class list **does not win** — Tailwind decides between two `bg-*` utilities by where
  they sit in its own stylesheet, not by the order they are typed. That is the same rule that
  made every column header in the CRM scroll away once. A state swaps the string out rather
  than trying to beat it.
* **The open record's row is marked by an element, not a border.** It was `border-l-4
  border-l-brand-600` on a row that also says `border-b border-slate-100`, and which of those
  decides the left edge's colour is the same stylesheet-order lottery as above — so the
  marker could come out slate on slate and the row looked no different from its neighbours.
  A `span` competes with nothing.
* **The header is tighter**: smaller avatar, smaller name, 8px circles, less padding above
  and below the tabs. *"Now it is comfortable, but try compact in split view."*
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

### It had never once worked, and the database said so

**20 September 2026, the owner: "Call Not going."** Read off production rather than
guessed (`.github/workflows/why-the-phone-did-not-ring.yml`, read-only): **130 dial
instructions, 122 expired and 8 still queued, `delivered_at` null on every single row.**
Not one has ever been collected by a phone, by anybody, since the feature landed. Pairing
itself is fine — two handsets uploaded calls the same week.

The cause is one line of design that nothing wrote down: **the instruction reaches the
phone only over the app's own socket, into its webview** (`device:dial` in
`lib/realtime.ts`). There is no endpoint a phone polls for waiting commands. So the app
has to be **open and signed in** for a desk Call to ring it — and even then, every
installed copy predates `placeCall`, the plugin call fails, and nothing closes the
command out.

Two changes, both of which work with the app exactly as it is installed today:

* **The webview hands the number to the phone's own dialler when the plugin cannot.**
  A webview always has one, so an old build now dials with the digits filled in and the
  rep presses the green button. Without this the instruction was simply never collected.
* **The app closes its own command through the session** (`POST /api/telephony/dial/:id/result`),
  because the device-token route needs a credential only the native plugin holds. A
  person may close their own dial instruction and nobody else's. The desk is told
  *which* happened — `via: 'app'` rang on its own, `via: 'dialler'` needs the green
  button — and says so, rather than claiming a call that is still waiting for a tap.

**The failure message names the thing a rep can act on**: open the app on the phone. It
used to say the app needed updating, which is true and is not something a rep can do.

### Is the phone reachable, and has it allowed anything?

Two questions the CRM could not answer about a handset, so "Call not going" had no
diagnosis on either side of it.

**Reachability** (migration `165`, `lib/phoneStatus.ts`, `components/PhoneStatus.tsx`).
`last_sync_at` was the only fact there was and **it is not liveness**: `SyncWorker` wakes
every fifteen minutes and returns *without contacting the CRM* when there are no new
calls, so a perfectly healthy phone on a quiet morning looks identical to one switched
off. `ipy_device` now carries `last_seen_at` (stamped by `authenticateDevice`, so every
device-token request counts) and `app_open_at` (a 60-second heartbeat from
`lib/appPresence.ts` while the app is open and visible). Settings → Phones reads them as
**App open · Idle · Offline · Never**, beside how the last Call ended — `expired` being
the exact failure the owner kept meeting. Only "App open" means pressing Call will ring
it, because the instruction travels over the app's own connection.

**The phone now looks for a waiting call on its own timer** (`lib/dialWatch.ts`, every
five seconds while visible). `/dial/pending` existed and **nothing on a schedule ever
called it** — only the socket event and a reconnect did, so a phone whose socket was
asleep collected nothing, for ever. `takePendingDial` lives in that file and is imported
by `realtime.ts` rather than copied: the socket is the fast path, the timer is the one
that works when there is no socket at all, and two copies of the claim would eventually
disagree about how a command is closed out.

**The claim is one statement** — `FOR UPDATE SKIP LOCKED` inside a CTE that updates in
the same breath — because the socket and the timer both look, and both being handed the
same command rings the customer twice.
`tests/integration/thePhoneIsReachable.test.ts` races two callers at it. **It has to
clear the account's other queued commands first**: another suite dialling from the same
admin leaves a row behind, two callers then each legitimately claim a *different*
command, and the test fails while the thing it is about works perfectly. Same rule as the
dashboard specs — a test that depends on what is already in the database reports the
machine it ran on.

### Android asks for nothing at install time

**20 September 2026, the owner:** *"if APK need any permission please ask before install
app, make the working structure."*

Installing an APK grants it **nothing**. Every permission is asked for later, from inside
the app, by the code that needs it — so a handset can be installed, signed into, and
still unable to ring anybody, with nothing on screen saying which answer is missing. That
is precisely what production was doing.

`lib/phonePermissions.ts` is the checklist as **data** (pure, node-tested) and
`components/PhoneSetup.tsx` draws it: pair, Phone, Call logs, Notifications, and Location
only once somebody has switched location on. It is on the app's **You** tab whenever
something required is outstanding — not only in Settings, because a rep who has just
installed the app has no reason to go hunting for a permission nobody told them about —
and on the browser's download card as *what the phone will ask you to allow*, before
anybody installs it.

Three rules in it:

* **A row is redrawn from the plugin's own answer, never from the fact a button was
  pressed.** After two refusals Android stops showing the dialog at all and answers
  "denied" without one; a tick there is a lie the rep then acts on.
* **"While using the app" is not location granted.** `backgroundLocationGranted` is the
  test, because foreground-only reports nothing once the screen goes off — a map that
  quietly stops moving rather than one that says it is off. Android will not grant "all
  the time" from a pop-up either, so that row asks for what it can and then opens the
  app's own settings page.
* **It lives in the web bundle**, which is the half that updates itself from production.
  So it reaches every installed handset with no APK rebuild — which is just as well,
  since this container has a JDK and no Android SDK.

**Still true and still not buildable here:** `placeCall` itself — the ACTION_CALL path
that needs no tap — is Android code that has never been compiled, because this container
has a JDK and no Android SDK.

What is **not** possible, whatever a CRM claims: hearing a call as it happens. Android
closed third-party call recording in Android 10 and no permission reopens it. What works
is what `RecordingFinder` already does — the OEM recorder's file, read from a folder the
rep grants once, uploaded **after** the call ends and matched on the last ten digits plus
a time window. The player with play/pause is already in the timeline and the Calls tab.

### "Phone call was not confirmed" about a call that rang

**20 September 2026, the owner, against a record showing a one-minute outbound
call he had just finished:** *"cool, the call is landed, but this msg coming
unnecessarily."*

The desk watched `GET /api/telephony/dial/:id` for five seconds and accepted
**only `done`**. But the phone collects the instruction in well under a second
(`delivered`) and closes it out only once the rep has taken the handset out of
their pocket and pressed the green button — which is a minute later, not five
seconds. So the ordinary successful path ended in a red toast telling somebody
to go and install the app, while the call they had just made was already in the
timeline.

`delivered` is now the answer to *"did it reach the phone"*, which is the only
question the desk can honestly ask in those five seconds; `done` still says
*how* when it arrives in time. A red message is kept for the two states that
really are failures — `expired` (nothing ever collected it) and `failed`.
`tests/integration/thePhoneIsReachable.test.ts` pins that a claimed command
reads `delivered` with no `via` yet, which is the state that was being called a
failure.

**The general shape, and it has now cost two reports:** a screen that waits a
fixed few seconds for somebody else's slowest step will call the normal path
broken. Wait for the fact you can actually establish in that time.

## The calling system, and what it still needs

**20 September 2026, the owner sent a twenty-point specification** for a NeoDove-style
Android calling app wired into this CRM. His own §20 says: inspect what exists, reuse it,
do not rebuild working functionality, and build in phases. So the first answer is an
inventory, because **most of the server half already exists** and was built over several
sessions:

| His ask | What is already here |
|---|---|
| §1 dialler, §3 mobile→web sync | `packages/app` + `CallSyncPlugin.kt`: pairing, call-log upload, `POST /api/device/calls` with dedupe |
| §2 click-to-call | `POST /api/telephony/dial` → socket + `/dial/pending` poll → the phone's dialler |
| §4 contact matching | `matchContact.ts`, last ten digits, refuses to choose between two people |
| §6 timeline | calls already merge into `buildTimeline` |
| §7 recording | `POST /api/device/recordings`, signed playback, OEM-recorder file only |
| §8 post-call screen | `CallDispositionProvider` on the web, `/calls/:id/disposition`, follow-up written through `followUp.ts` |
| §10 agents/devices | `ipy_device`, per-user tokens, pairing screen |
| §15 security | JWT + refresh rotation, device tokens, capability gates, signed recording URLs |

**Added 20 September:**

* **`GET /api/telephony/lookup?phone=`** (§4, §9, §17) — the caller card. One question, one
  answer, for both the phone (before it rings) and the CRM (after a call ends). It reads
  the record **as the person asking**, so a rep outside a lead's scope is told the number
  belongs to somebody and *whose* — enough to pass it on, nothing about the customer. It
  never guesses between two people; `matchContact` already refuses, and the screen offers
  the candidates.
* **A Calls page** (§5) — every call with direction, picked-up-or-not, outcome, date range
  and "only mine", the record link, and a recording that loads only when somebody presses
  play. Nothing re-derives a call: it is the same endpoint the record's Calls tab reads.
* **The list's filters and its count.** The count rides in **`X-Total-Count`, not in a
  wrapped body** — this endpoint answers a bare array, an integration test pins that in
  those words, and changing the shape to add one number broke four tests before the header
  was used instead. A response shape with readers is a contract.

**What cannot be built here, and it is not a scheduling problem.** Everything in §1, §11,
§12 and most of §16 — the default dialler, `InCallService`, `ROLE_DIALER`,
`CallScreeningService`, multi-SIM, the Room offline queue, FCM — is Android code, and this
container has a JDK and **no Android SDK**. It cannot be compiled, let alone run on a
handset. The repo already carries the cost of ignoring that: `placeCall` was written here,
never compiled, and every installed copy of the app still cannot place a call — 130 dial
instructions, none ever collected. **Writing more unproven Android code makes that worse,
not better.** That half needs a machine with Android Studio and a real phone.

What *is* worth doing from here, in his order: the server and web halves of each phase —
the lookup and the Calls list (done), then the live-call panel and the call reports, which
need the phone to report state and are therefore only worth building once something can.

## The call side, walked as a paired handset — 20 September 2026

Same method as the WhatsApp walk: a real handset paired against the running
stack, and every route it uses driven for real. **What the installed app can do
today works**, and three faults came out of the parts nobody had exercised.

What was proved end to end, against a live server: pairing and `/ping`; a call
log uploaded, both directions read correctly from Android's `type`, both
matched to a contact on the last ten digits; **a replay of the same
`externalId` deduped** (`created: 0, duplicates: 1`); a recording uploaded from
the phone, stored, and played back with range support; a dial queued, expiring
in ninety seconds, and closed by the handset — and **only** by that handset.

* **A call recording was served without the file security headers.** The route
  set `Content-Type` and `nosniff` and stopped there: no Content-Disposition,
  no CSP, with a mime type that arrived with an upload. This is the same
  omission the public file routes produced once, and the repo already has a
  rule about it. `applyFileSecurityHeaders` is called **before the range
  branch**, because a 206 returns bytes too and the seeking player is the one
  that asks. Pinned in `tests/publicFileHeaders.test.ts`, which now also
  asserts that order.
* **"The desk is told which happened" was not true, and this file said it was.**
  `via: 'app'` versus `via: 'dialler'` is the difference between a phone that
  is ringing and a phone with the number typed in waiting for a green button.
  The session route recorded it; the **device-token route — the native
  plugin's, so the good path — did not**, and `phoneTookIt` on the desk threw
  the field away and returned a boolean. So a rep was told "Ringing from your
  phone" either way. Both ends fixed;
  `tests/integration/dialFromTheCrm.test.ts` pins the plugin path saying
  `app`.
* **`POST /api/device/calls` takes `entries`, not `calls`.** Not a bug — worth
  writing down because the obvious guess answers a validation error and looks
  like a broken endpoint.

**What is still not provable from here, and is the honest limit:** `placeCall`
itself is Android code and this container has a JDK and no Android SDK, so the
native path has never been compiled. Everything above tests the server's half
of it. And the installed copies of the app still predate `placeCall`, so until
somebody rebuilds and re-installs, the dialler fallback is the *only* path a
desk Call can take — which is exactly why the `via` fix matters now rather than
later.

## "The app is not working" — what a phone can and cannot tell you

**20 September 2026, the owner: "please update android app also, app not working."**
No screenshot, and from a phone there was nothing to read. So the first job was
to make the invisible visible rather than to change anything.

**Everything the app asks production for is healthy**, read by
`.github/workflows/what-the-app-sees.yml` (read-only, public endpoints only):
the server answers, **both webview origins are accepted** (`https://localhost`
and `capacitor://localhost` — the CORS trap this file already warns about is
not the cause), a bundle is on offer, and `bundle.zip` really is a zip, 878 KB.
An APK is published and downloads: **2.1.0, built 13:41 UTC that day** by the
other developer's session.

**The published APK was opened and read rather than trusted.** `placeCall` is
in `classes2.dex`, and the binary manifest declares `CALL_PHONE` and
`READ_CALL_LOG`. So installing 2.1.0 is a real fix for the desk-Call path, not
a hope — that had never been checked before. The manifest is **UTF-16 binary
XML**: `grep CALL_PHONE AndroidManifest.xml` answers "not found" on an APK that
declares it, which is how a wrong conclusion gets drawn in one line. Read the
bytes (`perm.encode('utf-16-le') in data`), never a plain grep.

**The app is two halves and they update two different ways.** The **screens**
are the same React bundle the website serves and update themselves on the next
launch (`lib/liveUpdate.ts` + `/api/public/app/bundle`), so they are nearly
always current. The **native half** — the dialler, the call-log reader — is
frozen in the installed APK. Every handset in this business had a build that
predates `placeCall`, and **nothing on the phone said so**: `callSyncStatus()`
has carried `BuildConfig.VERSION_NAME` all along and no screen showed it.

So Settings, *inside the app only*, now says which build this phone is running,
what the latest is, and offers Update when it is behind (`ThisPhonesApp`, with
`lib/appVersion.ts` deciding). **An unreadable version counts as behind**, which
is the case that matters rather than an edge: a build too old to name itself is
by definition older than the one on offer, and answering "up to date" there
would hide exactly the phones that cannot place a call
(`tests/appVersion.test.ts`).

**What remains unknown, and was said plainly rather than guessed:** which of the
several possible faults the owner actually met. A phone with no version on
screen and no error message cannot be diagnosed from here, which is the whole
reason that card now exists.

## The call console

**21 September 2026, the owner, with a design of his own:** *"can you redesign
this UI/UX of click-to-call popup form and next-to-call dialler with fully
functional features, editable key values as per given screenshot."* What it
replaced asked for an outcome, a duration and a date.

`components/CallConsole.tsx` draws it; `lib/callConsole.ts` holds the decisions,
pure, so a `node` test can read them without dragging the store in. The console
renders inside the ordinary `Modal` — which gained an optional `header` and
`bodyClassName` for it, rather than growing a second focus trap, Escape handler
and scroll lock to keep in step.

* **No screen names a field.** The key values in the bar under the header are
  whatever Admin → Split View says this module's header shows, through the same
  `useRecordPanes` the record page and the chat pane read, and they are edited
  where they stand with `EditableField`. So Budget appearing there is an admin's
  decision, made once, and every screen agrees.
* **The outcome cards are the admin's picklist**, through `useCallDispositions`,
  never a list of six written here. `outcomeCard` gives each value an icon, a
  hint and a corner chip, and **reads an outcome nobody has described by its
  words** rather than dropping it — an admin who adds "Site Visit Fixed" gets a
  card, because the alternative is a rep who cannot record what happened.
  `aria-label` is the outcome itself: without it a screen reader announces the
  chip first ("Priority Interested High priority buyer").
* **The chip and the schedule cannot disagree.** "In 2 hours" is printed from
  `followUpInHours` on the same card the save reads, so a card promising two
  hours and a follow-up landing tomorrow is not expressible. It **never
  overwrites a date already in the future** — the header lets a rep book
  Saturday's site visit mid-call, and a card quietly replacing it is the bug
  that would follow.
* **Mute, hold and End are drawn and dead on purpose.** Android only lets the
  handset's **default phone app** touch a call that is already running; iPropy
  hands a number to the dialler and reads the call log afterwards. A red End
  button that ends nothing is the exact failure this repo keeps writing down, so
  they carry the reason in their `title` and light up on their own when
  `mayControlLiveCall` says the app can (it cannot today, and that needs the
  `InCallService`/`ROLE_DIALER` work, which is Android code and needs an SDK).
  The e2e spec asserts they are **disabled**, so nobody quietly enables one.
* **The timer counts what can honestly be counted** — time since Call was
  pressed, not time the two people have been talking, which no browser knows.
* **Hot / Warm / Cold is on the call, not the record.** The obvious home looks
  like `leads.rating` and is the wrong one: that field is read-only because the
  scorer owns it, and when it was editable an edit was accepted, audited, and
  overwritten moments later — the rep saw Hot and the database kept Warm.
  Migration `166` adds `ipy_call.intent`, checked to the three words.
* **The WhatsApp follow-up is offered only when it could actually go**: a
  provider connected, an approved template, and its blanks filling for *this*
  person through the existing `/templates/:id/preview`, which resolves as the
  person asking. A template with a hole in it shows the reason with the switch
  dead. A refused send never loses the call that was just written.
* **Save & dial next** reads `GET /records/:module/:id/neighbours` — the same
  order the list is in — and then *navigates* to that record with `?dial=1`
  rather than swapping the person underneath the console. The provider belongs
  to whichever record is open, which is what makes the queue behave identically
  from the split view, the table and a record's own page. The flag is stripped
  on arrival, so a refresh cannot re-ring somebody already called.
* **The draft is this browser's**, every five seconds, cleared on save. A server
  write per keystroke against a call that does not exist yet is a row per
  keystroke.

`e2e/callOutcome.spec.ts` was rewritten around the cards and still proves the
same four promises (the list is the admin's, a save reaches the Calls tab, there
is no free-text path, an option added in Settings appears), plus the key-value
bar and the disabled End button. An a11y scan covers the console in both themes
and **creates its own lead with a number** — the first row in the list may have
none, and a spec that depends on what is already in the database reports the
machine it ran on.

**One fact worth keeping: `No Answer` is not one of this CRM's outcomes.**
`CALL_DISPOSITIONS` has thirteen and that is not among them, so the first cut of
the cards described an outcome the server refuses — caught by
`tests/integration/callConsoleSaves.test.ts`, which is the only layer that runs
the picklist check. It has a card anyway, for the admin who adds it.

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
