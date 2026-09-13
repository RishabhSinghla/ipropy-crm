# Deploying iPropy

## Live

| | URL |
|---|---|
| CRM | https://crm.ipropy.com (custom domain, attached 4 September 2026; `https://ipropy-crm.onrender.com` still answers and always will) |
| Website | https://ipropy-website.vercel.app |
| Marketing site | https://www.ipropy.com — a Wix site, not this repo |

The CRM's certificate is issued and renewed by Render automatically. The health
monitor's `HEALTH_URL` repository variable points at the custom domain, so the
every-two-hours check now exercises DNS and the certificate as well as the
database. The website's `CRM_API_URL` on Vercel still names the old
`onrender.com` host and works — when it is next changed, point it at
`https://crm.ipropy.com`. Anything that posts webhooks to the CRM (Meta lead
ads, WhatsApp) should carry the new host too.

Both verified: health check green, DB connected, CORS allows the website's
origin, the deployed bundle matches `main`, and the seed admin password is in
effect (the repo's public default is rejected — `curl`-tested, not just "it
loaded").

Goal: both apps live on the internet, with production deploying only after the
repository's required CI checks pass. The committed Render plan is still Free;
move it to an always-on instance before relying on scheduled work.

Everything in this guide needs **your** accounts and your click — I can prepare
the configuration (all of it is already committed) but I can't create accounts,
accept terms or enter payment details on your behalf.

```
  ┌────────────────────┐   git push    ┌──────────────────────────────┐
  │ github.com/…/      │──────────────▶│ Render — CRM                 │
  │ ipropy-crm         │               │ API + React app + scheduler  │
  └────────────────────┘               │ one Docker service           │
                                       └──────────┬───────────────────┘
  ┌────────────────────┐   git push               │ reads/writes
  │ github.com/…/      │──────────────▶┌──────────▼─────────┐  ┌──────────────┐
  │ ipropy-website     │  ┌──────────┐ │ Neon — Postgres    │  │ Cloudflare   │
  └────────────────────┘  │ Vercel   │ └────────────────────┘  │ R2 — media   │
                          │ website  │────── reads /api/public ─────▶ (CRM)
                          └──────────┘
```

Why these four and not one: Render hosts the container but its **free Postgres
is deleted after 30 days**, and free instances have **no persistent disk** — so
the database goes to Neon (free tier that persists) and uploaded photos/videos
go to Cloudflare R2 (free tier, no egress fees). Skip either and you lose data
you will care about.

---

## 1. Database — Neon (5 min)

1. Sign up at **neon.tech** with GitHub.
2. Create a project — name `ipropy`, region **Singapore** (closest to India).
3. Copy the **connection string**. It looks like:
   `postgresql://user:pass@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`

Keep it somewhere for step 3. Treat it like a password.

> Neon's free tier sleeps an idle database and wakes it in a few hundred
> milliseconds. That is fine here. Do **not** use Render's free Postgres
> instead — it is deleted after 30 days, taking your data with it.

---

## 2. Media storage — Cloudflare R2 (10 min, optional but recommended)

Skip this and the CRM writes uploads to the container's local disk, which Render
**wipes on every deploy** — so each push silently deletes every photo and video
your team uploaded. The whole media pipeline (watermarking, title cards) works
either way; only where the files live changes.

1. Sign up at **cloudflare.com** → **R2** in the sidebar. Enabling R2 asks for a
   card, but the free tier (10 GB storage, unlimited egress) does not charge.
2. **Create bucket** → name `ipropy-media`, location **Asia-Pacific**.
3. **Manage R2 API Tokens** → **Create API token** → *Object Read & Write*,
   scoped to that bucket. Copy the **Access Key ID**, **Secret Access Key** and
   the **S3 endpoint** (`https://<account-id>.r2.cloudflarestorage.com`).
4. In the bucket's **Settings → Public access**, enable a public r2.dev URL, or
   attach a custom domain later. The website loads images straight from the CRM,
   so this only matters if you later serve media directly from R2.

The CRM's S3 driver (`core/storage/index.ts`) is plain S3 with a configurable
endpoint, which is exactly what R2 speaks — no code changes.

---

## 3. CRM — Render (10 min)

1. Sign up at **render.com** with GitHub and authorise access to
   `RishabhSinghla/ipropy-crm`.
2. **New → Blueprint**, pick the repo. Render reads [`render.yaml`](render.yaml)
   and proposes one web service, `ipropy-crm`.
3. It will prompt for every var marked `sync: false`. Fill them in:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the Neon string from step 1 |
   | `SEED_ADMIN_EMAIL` | your real email — this becomes the admin login |
   | `SEED_ADMIN_PASSWORD` | **a strong password you choose** (see warning below) |
   | `APP_URL` | leave blank for now, fixed in step 5 |
   | `S3_BUCKET` | `ipropy-media` (blank if you skipped step 2) |
   | `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
   | `S3_ACCESS_KEY_ID` | from step 2 |
   | `S3_SECRET_ACCESS_KEY` | from step 2 |
   | `ANTHROPIC_API_KEY` | optional — without it AI features fall back to rules |

   If you did step 2, also change `STORAGE_DRIVER` from `local` to `s3`.

   `JWT_SECRET` is generated by Render automatically — don't set it by hand.

4. **Apply**. First build takes ~5–8 minutes (it compiles TypeScript and
   installs ffmpeg). On boot the container migrates the schema and seeds
   metadata by itself — see [`scripts/docker-entrypoint.sh`](scripts/docker-entrypoint.sh).
5. Note the URL Render gives you, e.g. `https://ipropy-crm.onrender.com`.

> ⚠️ **Change the seed admin password.** The repo's dev default
> (`admin@ipropy.com` / `Admin@123`) is in public git history. If you leave it,
> anyone who finds your URL owns your CRM. Set `SEED_ADMIN_PASSWORD` *before*
> the first deploy, because the seed only creates the admin once.

### Your CRM will start empty — that's deliberate

`SEED_DEMO_DATA` is `false`, and the server **refuses to boot** in production if
you flip it (`validateProductionConfig()` in `config.ts`). The demo seed creates
about a dozen users who all share one password that is published in this repo —
fine on your laptop, an open door on a public URL.

If you want the sample leads/projects/deals for a demo, load them from your
laptop instead, where that gate doesn't apply:

```bash
DATABASE_URL='<your Neon connection string>' SEED_DEMO_DATA=true npm run db:seed
```

Then, in the CRM, go to **Admin → Users** and deactivate every demo user except
your own — they can otherwise all log in. Better still for a real team review:
add a handful of genuine leads and one real project, which shows your data model
doing its job rather than someone else's fixtures.

### What is reachable without signing in

Three surfaces answer unauthenticated requests, by design. If you ever put an
auth proxy in front of this deployment, these must stay reachable or the
features silently stop working:

| Path | Why it is public |
|---|---|
| `/api/public/*` | The website's catalogue — `Available`, published units only |
| `/api/webhooks/*` | Inbound leads, WhatsApp delivery receipts, portal enquiries |
| `/s/:token` and `/api/public/share/:token` | **Property share links.** One property, one unguessable token, sent to one buyer |

Share links are the one to understand before you go live. A link is created
deliberately by somebody who can already see the record, it is revocable, and it
is independent of whether the unit is published to the website — so it happily
exposes a *draft* property to whoever holds the URL. That is the point of it.
Every failure mode — revoked, expired, mistyped, deleted — returns the same 404,
so the token cannot be probed for.

**Don't put a shared CDN cache in front of shared media.** Those responses are
deliberately sent as `Cache-Control: private` — a link is not secret enough to
sit in a cache other people can reach, and revoking one has to actually take
effect. A public edge cache would keep serving photos from a link you revoked.

---

## 4. Website — Vercel (5 min)

1. Sign up at **vercel.com** with GitHub.
2. **Add New → Project** → import `RishabhSinghla/ipropy-website`. Next.js is
   detected automatically; don't change the build settings.
3. Add environment variables:

   | Variable | Value |
   |---|---|
   | `CRM_API_URL` | your Render URL, e.g. `https://ipropy-crm.onrender.com` |
   | `NEXT_PUBLIC_CRM_MEDIA_URL` | the same Render URL |
   | `NEXT_PUBLIC_SITE_URL` | your Vercel URL, e.g. `https://ipropy.vercel.app` |

   (`NEXT_PUBLIC_SITE_URL` is only known after the first deploy — set it then
   and redeploy. It drives canonical URLs, the sitemap and OG image links.)

4. **Deploy.**

---

## 5. Connect the two (2 min) — don't skip this

Back in Render → `ipropy-crm` → **Environment**, set:

```
APP_URL = https://ipropy-crm.onrender.com,https://ipropy.vercel.app
```

Both URLs, comma-separated, no spaces. In production this string is the **CORS
allowlist** (`app.ts`), so until the Vercel origin is in it the website's images
are blocked by the browser. Save — Render redeploys automatically.

---

## 6. The deploy is gated on CI, not on the branch

- Push to `ipropy-crm` `main` → GitHub runs the dependency audit, typecheck,
  build, unit, integration, browser and production-Docker checks.
- `render.yaml` uses `autoDeployTrigger: checksPass`, so Render deploys only
  after the checks on that `main` commit pass. A failed check leaves the current
  working version live.
- Push to `ipropy-website` `main` → Vercel rebuilds and redeploys.
- The CRM's `main` branch is **not** protected, deliberately: the repository has
  a single owner, and GitHub does not let anyone approve their own pull request,
  so a required review would mean nothing could ever merge. Pushing straight to
  `main` is normal here. The gate that matters is the one above — a red check
  stops the deploy, so a broken commit on `main` never reaches the team.

Vercel also builds a unique preview URL for every pull request — useful for
"what do you think of this change?" without touching the live site.

---

### Backups: nightly to R2, verified

**Changed 2026-08-18.** This repo previously carried a dump job, it was removed,
and the standing decision was to buy Neon's Launch plan instead — on the
reasoning that a backup job you maintain yourself is a backup job that quietly
stops working.

That reasoning is right and is why the job that replaced it does something the
old one did not: **every night it restores the dump it just took into a throwaway
Postgres and counts the tables and records.** A backup nobody has ever restored
is not a backup, and this one is restored every single night before it is kept.

It runs in GitHub Actions (`.github/workflows/backup.yml`), not on the server and
not on a laptop. Render restarts the container whenever it likes, so a job living
inside it has no schedule you can trust, and a Mac is asleep at 1am. GitHub runs
it whether or not the site is up — which is precisely when you want a backup to
have happened.

What you get: last night. What you do not get: point-in-time restore to 4:07pm
yesterday. That is the difference Neon's paid plan sells, and it is a deliberate
trade at this size rather than an oversight.

**Five repository secrets are required** (Settings → Secrets and variables →
Actions): `PROD_DATABASE_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_ENDPOINT`, `R2_BACKUP_BUCKET`. Without them the job fails loudly on its first
run rather than appearing to succeed.

The `pg_dump` client is pinned to PostgreSQL 18 to match Neon. A client older
than the server refuses to read it at all, and Neon upgrades without asking —
that has already broken this once.

## 7. Backups and monitoring (10 min, do this before real client data)

### Backups: use Neon's, don't build your own

Neon's paid **Launch** plan includes scheduled backups (daily/weekly/monthly)
and a 7-day instant-restore window. Turn both on and the problem is solved
properly: nothing is copied anywhere, there is no dump file to leak, no API
token to rotate, and restore is a button rather than a procedure.

1. Neon Console → your project → **Billing** → upgrade to **Launch**.
2. **Settings → Instant restore** → history window **7 days**.
3. **Settings → Backups** → enable a **daily** schedule.

The free plan gives you neither: a history window of at most 6 hours, one
snapshot, and no schedule at all.

An earlier version of this guide shipped a GitHub Action that dumped the
database nightly to R2. It was removed on purpose. Its only real advantage was
holding a copy *outside* your database provider, which matters on the day the
provider itself is the problem — a reasonable thing to want later, and it is in
this repository's git history if you do. It is not worth a nightly copy of every
client's name, phone number and PAN moving between two systems today.

### Monitoring: already committed

**`.github/workflows/health.yml`** calls `/api/health` every 15 minutes, which
answers `ok` only after it has really reached Postgres. Two failures in a row
open a GitHub issue; the next success closes it. Your incident log is the issue
list, with no account to create anywhere and nothing to configure — though you
can set a repository **variable** called `HEALTH_URL` once the CRM has its own
domain, since it defaults to the Render URL.

Two things about GitHub's scheduler: it is best-effort and runs late under load,
and **it disables scheduled workflows in a repository with no commits for 60
days**. If the project goes quiet, check this is still on.

To take a manual dump at any time — before a risky migration, say — `npm run
db:backup` still works, and `npm run db:restore <file>` puts one back. Read
`PROJECT_HANDOVER.md` §9 first: restore replaces the live database.

---

## Sharing with your team

Send them the two URLs. For the CRM, create a real user each rather than sharing
the admin login: **Admin → Users → New User**, pick a role, and they get their
own password and permissions (the CRM's 4-layer permission engine is what makes
per-person accounts worth the two minutes).

### Installing on phones and tablets

Both apps are installable PWAs — no App Store, no Play Store, no developer
account, and updates arrive with your deploys instead of a review queue.

- **Android / Chrome:** open the URL → menu (⋮) → *Add to Home screen* /
  *Install app*.
- **iPhone / iPad (Safari — must be Safari, not Chrome):** open the URL →
  Share (□↑) → *Add to Home Screen*.

It then launches full-screen with its own icon, exactly like a native app. The
CRM's service worker keeps the shell loading instantly and never caches API
responses, so nobody sees a stale lead stage.

---

## Known limits of the free tier

Be upfront with your team about these — they are properties of "free", not bugs:

| Limit | Effect | Fix |
|---|---|---|
> **Plan names are gone.** Render's blueprint spec takes instance type IDs now, so
> the $7 tier is `0.5c-512mb`, not `starter`. The id is printed beside the price in
> the dashboard's Compute tab. Writing the old name gets the blueprint rejected.
>
> The service is **Blueprint managed**, which means `render.yaml` wins: changing the
> plan in the dashboard alone is undone by the next sync. Change it here.

| Render free instances sleep after ~15 min idle | First visit takes **~50 seconds** to wake. Later visits are instant. | `plan: 0.5c-512mb`, $7/mo, always on |
| …and the scheduler sleeps with it | This is the one that costs you money rather than patience. `render.yaml` runs the API, the web app and `ENABLE_SCHEDULER=true` in **one** service, so while it is asleep no follow-up reminder fires, no untouched lead escalates and no birthday message goes out. Nothing errors; the work silently does not happen overnight and at weekends. | `plan: 0.5c-512mb` — same $7/mo |
| 512 MB RAM / 0.1 CPU | Large video transcodes are slow, and a very large upload can OOM the container | `0.5c-512mb` |
| No persistent disk | Uploads vanish on redeploy — **unless you did step 2** | Cloudflare R2 (step 2) |
| Neon free tier | 0.5 GB storage; idle databases sleep briefly | Neon paid tiers |

The cold start is the one your team will notice. If the reaction is "it's
broken", it is almost always just the first request waking the server — reload
after a minute.

---

## Attaching a real domain later

Nothing needs redeploying; both hosts do free HTTPS automatically.

1. Buy a domain (Cloudflare Registrar sells at cost; Namecheap and GoDaddy are
   fine too).
2. **Website** → Vercel → project → **Settings → Domains** → add
   `ipropy.com` + `www`. Vercel shows the exact A/CNAME records to paste at
   your registrar.
3. **CRM** → Render → service → **Settings → Custom Domain** → add
   `app.ipropy.com`. Render shows a CNAME to paste.
4. Update the env vars to the new URLs and redeploy:
   - Render `APP_URL` → `https://app.ipropy.com,https://ipropy.com`
   - Vercel `CRM_API_URL`, `NEXT_PUBLIC_CRM_MEDIA_URL` → `https://app.ipropy.com`
   - Vercel `NEXT_PUBLIC_SITE_URL` → `https://ipropy.com`

---

## If something breaks

| Symptom | Cause | Fix |
|---|---|---|
| CRM URL hangs ~50s then loads | Free instance was asleep | Normal on free. `0.5c-512mb` removes it. |
| Website shows no projects | CRM asleep/unreachable at render time | Reload after the CRM wakes. Listing pages degrade to empty instead of erroring, and ISR self-repairs within 60s. |
| Images broken on the website | `APP_URL` missing the Vercel origin | Step 5 |
| "relation does not exist" | Migrations didn't run | Check the Render deploy log for the `applying database migrations…` line |
| Can't log in after first deploy | Seed ran before you set the admin vars | Reset the password from Neon's SQL editor, or drop the DB and redeploy |
| Uploaded photos gone after a deploy | Local disk storage on a free instance | Do step 2 and set `STORAGE_DRIVER=s3` |

Render's **Logs** tab is the first place to look; the container logs every boot
step and the scheduler logs each queue drain.
