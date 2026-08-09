# Working on iPropy CRM

For anyone joining the repo. Read once, then keep the "Daily loop" section handy.

---

## Day one — get it running locally

You need **Node 20+** and **Docker Desktop** installed and running.

```bash
git clone https://github.com/RishabhSinghla/ipropy-crm.git
cd ipropy-crm
cp .env.example .env      # defaults work as-is for local dev
docker compose up -d db   # starts Postgres on :5432
npm install
npm run setup             # builds shared types, migrates, seeds demo data
npm run dev               # API on :4000, web on :5173
```

Open <http://localhost:5173> and sign in as `admin@ipropy.com` / `Admin@123`.

**Your database is your own.** Docker runs a Postgres on your machine, seeded with
demo data. Nobody else sees it, and it is not connected to production. Break it
freely — `npm run db:reset` rebuilds it from scratch.

You do **not** need any API keys, cloud accounts or production credentials to
develop. AI, WhatsApp, email and telephony all degrade to deterministic
fallbacks when their keys are missing — that is deliberate, not broken.

---

## Daily loop

```bash
git checkout main
git pull                              # always start from the latest main
git checkout -b feat/short-description

# ... make your changes ...

npm run typecheck                     # must be clean
npm test                              # unit tests, no DB needed

git add -A
git commit -m "feat: what changed and why"
git push -u origin feat/short-description
```

Then open a **Pull Request** on GitHub. CI runs typecheck, build, unit and
integration tests, plus browser tests on desktop and mobile. Get it green, get
it reviewed, then merge.

Merging to `main` deploys to production automatically. That is why nobody pushes
straight to `main`.

**Branch names:** `feat/…` for new work, `fix/…` for bugs, `docs/…` for
documentation. Keep branches small and short-lived — a branch open for two weeks
is painful to merge.

---

## Two things that will bite two people working at once

### 1. Migration numbers collide

Database migrations are numbered files (`030_…sql`, `031_…sql`). If you and
someone else both create `031_` on separate branches, both merge, and the
numbering is now broken and ambiguous.

**Before creating a migration:** pull `main`, check the highest number that
exists there, and take the next one. If your PR sits open for a while and
someone else lands a migration first, renumber yours before merging. Say in the
PR that you are adding a migration so the other person knows.

### 2. Seed changes overwrite each other

The data model lives in `db/seed/modules.ts`. Re-running `npm run db:seed`
refreshes system content but leaves user-created content alone. If you and
someone else both edit the seed on separate branches, git will merge both — but
the result may not be what either of you intended. Coordinate before reshaping
modules or fields.

---

## Before you push — the checklist

| Check | Command |
|---|---|
| Types are clean | `npm run typecheck` |
| Unit tests pass | `npm test` |
| Nothing secret is staged | `git status` — is `.env` in there? It must not be |

Two heavier suites you can run when your change warrants it:

```bash
npm run test:integration   # spins up its own throwaway database
npm run test:e2e           # drives a real browser against your local stack
```

CI runs all of these on every PR anyway, so pushing without them is fine — you
will just find out a few minutes later instead of immediately.

---

## Things that will cause real damage

- **Never commit `.env`.** It is gitignored, so this only happens if you force
  it. The repo is public.
- **Never push directly to `main`.** It deploys straight to the live CRM.
- **Never point your local `.env` at the production database.** `DATABASE_URL`
  stays pointed at your local Docker Postgres. The e2e tests create and delete
  records in whatever database they find — against production that is a very bad
  afternoon.
- **`npm run db:reset` is destructive.** Fine locally, catastrophic anywhere
  else. Check what `DATABASE_URL` says before running it.

---

## How this codebase thinks

Read `CLAUDE.md` before your first real change — it is short and it is the list
of rules that keep the design intact. The single most important one:

> Modules, fields, layouts, permissions and workflows are **data, not code**.
> All record reads and writes go through one generic engine
> (`core/entity/recordService.ts`). If you find yourself writing
> `if (module === 'leads')` inside the engine, stop and reconsider.

`README.md` explains the architecture and what each part does.
`PROJECT_HANDOVER.md` has the full context, history and known issues.

---

## Where things live

```
packages/shared    field types and the filter grammar — shared by both sides
packages/server    the API, database, permissions, workflows
packages/web       the React app
e2e/               browser tests
```

Server and web run together with one `npm run dev`.
