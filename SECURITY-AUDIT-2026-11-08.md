# Security check of the iPropy CRM — 8 November 2026

First small run of Cloudflare's `security-audit` skill. **Read-only.** No fixes made, nothing pushed or deployed, no live database, Render, Neon or production key touched.

## How big this run was

Small on purpose. It is **not** the full six-phase audit (that sends many agents through the whole codebase). I looked at the doors facing the internet:

- login and its rate limits
- every webhook in `api/routes/webhooks.ts`
- the server setup in `app.ts` (CORS, helmet, rate limits)
- the secret and config checks
- a scan of git for committed secrets
- `npm audit` on production dependencies (this sends only the package list to the npm registry)

Not looked at: `records.ts`, `public.ts`, file serving, the admin routes, the phone-app routes, the MCP door, and the permission engine. Those are the next slice if you want one.

## Overall

The basics are done well. Nothing here is an emergency, and I found **no confirmed way in for an outsider**.

Already good, so you know it was checked:

- Facebook leads verify Meta's signature on the raw body, and Zapier, portal, Google and n8n doors all use a secret compared in constant time.
- The generic web form refuses to run on its published default key.
- The server refuses to start in production with a known-bad `JWT_SECRET`.
- Logins are rate-limited per account and per address (IPv6 handled).
- CORS is locked to a list of allowed sites in production.
- Git holds **no real secrets**. Only `.env.example` files are tracked and the connection strings in docs and tests are placeholders.

## Findings, most serious first

| # | Severity | Real or noise | What | Where |
|---|---|---|---|---|
| 1 | Medium | Real, needs a check | **Demo admin login.** Project notes say the demo admin is `admin@ipropy.com` with a password written in `CLAUDE.md`. I cannot look at production from here, so I could not tell whether that account still exists there with that password. | seed data; check in the live Admin → Users |
| 2 | Medium | Real | **Library with a known flaw: zod** (reported as "high"). A huge crafted request can eat server memory. Fix is a version bump. Mostly relevant on the public doors, where strangers can post data. | `npm audit` |
| 3 | Low | Real | **Portal secret can travel in the web address** (`?secret=`). Addresses get written to logs and history, headers do not. Header form already works. | `webhooks.ts:282` |
| 4 | Low | Real | **Voice-agent (Sarvam) secret lives inside the URL path**, so it lands in logs. Safe compare is used. | `webhooks.ts:40,63,72` |
| 5 | Low | Real | **Generic lead form compares its key with `!==`**, not the constant-time check every other door uses. Tiny timing leak; exploiting it over the internet is unrealistic. | `webhooks.ts:~436` |
| 6 | Low | Real | **Facebook setup handshake compares its token with `===`.** Same reason, same low risk. | `webhooks.ts:183` |
| 7 | Low | Real | **Other flagged libraries** (uuid, exceljs, archiver, minimatch, readdir-glob), all "moderate". Only matter if the CRM feeds them untrusted input. Fixes exist. | `npm audit` |
| 8 | Info | Noise | **Dev-mode CORS allows any site** (`origin: true`). Only when not in production, so no effect on `crm.ipropy.com`. | `app.ts:158` |
| 9 | Info | Noise | The skill's own scan flagged 13 items. All were prose in its documents and its test files. See the install note below. | skillspector report |

## Suggested fixes (waiting for your yes — none done)

1. Open the live Admin → Users and confirm the demo admin is gone or has a strong, changed password. **If it still has the documented password, change it today.** (Only you can check; I did not log in anywhere.)
2. Update `zod` (and the other flagged libraries) to the fixed versions, then run typecheck and all tests before pushing. A zod major version change can break code, so it needs real testing.
3. Make the portal and Sarvam doors accept the secret from a header only. This needs the portals and the voice agent re-pointed, so it is more work than it looks.
4. Swap the two plain comparisons (#5, #6) for the existing `safeEqual` helper. Two small edits.
5. Run the next slice: records, public listings, file serving, admin and MCP routes.

## Secrets

No real secret exposed in the repo, so nothing needs rotating from this run. The WhatsMarketing token that appeared in a log earlier (already noted in `CLAUDE.md`) should still be treated as exposed if it was not rotated.

## About the skill itself

- Source: github.com/cloudflare/security-audit-skill, commit `c1c8a8c`, MIT licence.
- Its only code is two small checker scripts and their tests. They use only Node's built-in `fs`, `path` and `util`: **no network calls, no credential or cookie access, no installs.** The rest is instruction text.
- It writes nothing unless asked for a full audit, and then writes to a new folder outside the project (`~/security-audit-skill/...`).
- Its own rules say: no probing of live endpoints, only dummy secrets in tests, run target code only in a sandbox.
- Installed by copying the folder into `.claude/skills/security-audit/` for this project only (I did not use `npx`, which would have fetched more code). The folder is not git-ignored, so it will be committed with the repo whenever you next commit.
