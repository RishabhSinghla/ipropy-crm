# REVIEW — the OpenWA bridge (branch `crm-openwa-bridge`)

Written 24 October 2026. Read this first; the longer picture is in
[`docs/OPENWA.md`](docs/OPENWA.md) and the CRM's own notes in `WHATSAPP.md`.

**State of the branch:** pushed, **not merged, not deployed, no pull request.** Nothing on
`crm.ipropy.com` changes until someone merges it to `main` — and even then the feature is
**off** until an admin switches the OpenWA card on.

## What was built, in plain words

The company WhatsApp number can now be used from inside the CRM, through OpenWA (a separate
program linked to the number the way WhatsApp Web is). The team can read a customer's chat
on the contact, reply, and send one photo or document, while the owner's phone and every other
linked device keep working normally.

1. **A settings card** — Admin → Integrations → WhatsApp → *OpenWA (linked device)*: OpenWA's
   address, session name, API key (encrypted, never shown again), webhook secret (one-click
   generate), and the three send limits. **Test** shows whether the session is *ready*,
   *waiting for the QR code* or *disconnected*, and the linked number with most digits hidden.
2. **Messages coming in** — a signed webhook (`/api/webhooks/whatsapp/openwa`). Bad, missing or
   30-minute-old signatures are refused; the same message arriving twice is stored once;
   delivery ticks (sent / delivered / read / failed) update the message. Messages the owner sends
   *from the phone* are stored too. Photos and files are stored as a name and size only; a
   **Load** button fetches the file from OpenWA when someone wants to see it.
3. **The chat panel** on a contact (the WhatsApp tab): newest at the bottom, date separators,
   ticks, a banner when OpenWA is down or the phone is unlinked, a text box and a paperclip for
   one attachment, working on a phone and with the dark-theme classes.
4. **Safety brakes in code** (all before anything reaches OpenWA): one recipient per request, no
   bulk endpoint, campaigns refuse this connection by name, a message may only go to a number on
   a record the user can open or an existing chat in their inbox, a daily cap per user (60) and per
   customer (15), at least 10 seconds between sends, refuse if the phone is not linked. Each
   CRM-sent message records which CRM user sent it. OpenWA's own rate-limit refusal is shown in plain
   words ("try again in about 30 seconds").
5. **Unmatched numbers** — a filter in the Chats inbox for numbers the CRM doesn't know, each with
   a button, **Create contact from this chat**, that fills the phone and the person's own WhatsApp
   name. It never runs by itself, and links to an existing contact if the number already has one.
6. **When OpenWA is down** — the CRM keeps working; the chat panel shows a banner; a send fails
   visibly (nothing is queued silently). Once a minute the CRM asks OpenWA how the session is,
   logs each change once, and writes it where the existing WhatsApp **Health** page already looks;
   the Health page also gets an OpenWA panel (sent / failed today, refused webhooks, last message).

Also changed, deliberately: switching one WhatsApp provider on now switches the others off
(before, nothing enforced "one at a time" and the CRM silently preferred whichever came first).

## A decision that is the owner's, not mine

`CLAUDE.md` / `WHATSAPP.md` say the official business route is the only WhatsApp road and not to
build the QR one a third time. That line was written about **reps linking their own personal
numbers**. This is different (one company number, linked once, no personal chats, no history
import, no bulk) — but it is still an **unofficial** gateway, so **the ban risk that line was
protecting against is real here too.** I built it because the brief asks for it and kept it off by
default. Please treat merging as the owner saying yes to that trade-off. `WHATSAPP.md` now records
this openly rather than leaving the old line standing unqualified.

## Preview it on your own computer (Rishabh)

Uses a **throw-away database** called `ipropy_openwa` (already made and filled), so your normal local
data is untouched. OpenWA is already running at `http://127.0.0.1:2785`.

1. In a terminal:
   ```bash
   cd ~/Documents/claude-work/iPropy-Projects/iPropy-crm/.claude/worktrees/crm-openwa-bridge-7c0b9b
   ```
   ```bash
   DATABASE_URL=postgres://ipropy:ipropy@localhost:5432/ipropy_openwa npm run dev
   ```
2. Open http://localhost:5173 and sign in: `admin@ipropy.com` / `Admin@123`.
3. **Admin → Integrations → WhatsApp → OpenWA.** Address `http://127.0.0.1:2785`; session name: the
   name shown in OpenWA's dashboard. For the API key, run `pbcopy < ~/Documents/claude-work/openwa-trial/.api-key`
   in another terminal (it goes to your clipboard without being shown) and paste it. Press **Generate**
   for the webhook secret, **Save**, then **Test** — you should see *ready* and the number with digits hidden.
4. To see **customer messages arrive**, tell OpenWA where to post: in OpenWA's `.env` add
   `SSRF_ALLOWED_HOSTS=host.docker.internal`, `docker compose up -d`, and add a webhook for your session with URL
   `http://host.docker.internal:4000/api/webhooks/whatsapp/openwa`, the same secret, and events
   `message.received message.sent message.ack message.failed session.status`.
5. Open any contact → **WhatsApp** tab; **Admin → WhatsApp → Health** shows the OpenWA panel.
6. **Careful:** pressing Send in step 5 sends a *real* WhatsApp message. Try it only on a contact whose
   number is your own second phone. Nothing I did sent or read any real message.

To stop: `Ctrl-C`. To start over: `docker exec ipropy-db psql -U ipropy -d postgres -c "DROP DATABASE ipropy_openwa"`.

## Running the checks

```bash
npm run typecheck && npm test                                   # all unit tests (1,076 server + 448 web + 8 mcp)
npm run test:integration -w @ipropy/server -- openwaBridge      # the API tests against the pretend OpenWA
DATABASE_URL=postgres://ipropy:ipropy@localhost:5432/ipropy_openwa npx playwright test e2e/openwaChat.spec.ts --project=chromium
```
(The browser spec needs `npm run db:migrate && npm run db:seed` once on that database so the OpenWA card exists.)

## Hosting recommendation (so it runs day and night)

OpenWA must be on an always-on server the CRM (on Render) can reach. Simplest: **a small VPS with
Docker and Caddy for automatic HTTPS**, in Singapore or Mumbai, with `openwa.ipropy.com` pointing at it.
Exact steps are in `docs/OPENWA.md` (about an hour, once).

**Cost:** about **₹500–600 a month** for a 1 GB server and **₹1,000–1,200 for 2 GB** (recommended;
OpenWA used about 280 MB here, so 1 GB is workable but tight), plus GST. Source: DigitalOcean's price page
($6 and $12) and Hetzner's (entry plans from about €6), both checked 24 Oct 2026; the rupee amounts are my
rough conversion, not a quote. No other running cost.

## Risks, plainly

* **WhatsApp ban risk.** OpenWA is unofficial and reverse-engineered (its own README says so). The CRM's
  brakes make the pattern as human as possible (one-to-one, slow, capped, only to people already in the CRM)
  but cannot make it zero. Keep OpenWA's own send pacing switched on as a second net.
* **The 14-day rule.** WhatsApp logs linked devices out if the owner's phone is unused for over 14 days
  (WhatsApp Help Center, checked 24 Oct 2026). The banner and Health page say when it happens; re-scan the QR.
* **One server is a single point of failure.** If it is off, WhatsApp chat in the CRM pauses (nothing else
  does). Back up OpenWA's data folder — it holds the WhatsApp login.
* **A long CRM outage and webhooks.** OpenWA retries with the *same* signed body; after the replay window
  (30 minutes by default) those retries are refused. Widening the window on the card is safe because messages
  are de-duplicated; missed ones can be re-driven from OpenWA.
* **Privacy-hidden senders.** Some people appear to WhatsApp as an ID without a number. Set
  `RESOLVE_LID_TO_PHONE=true` in OpenWA; any that still can't be resolved are counted on the Health page, not stored.

## What I could not verify

* **Any real WhatsApp message, either way.** By instruction nothing was sent or read. The fake proves the CRM's
  behaviour; it cannot prove OpenWA's. In particular unverified: the exact shape of a message the owner sends *from
  the phone* (I follow OpenWA's documented `fromMe` / `message.sent`), and that OpenWA's `message.sent` id equals the
  short id inside the send response (I shorten both, from the docs).
* **The signature scheme against a live delivery.** Confirmed by reading OpenWA's source (HMAC-SHA256 of the raw body,
  `sha256=<hex>` in `X-OpenWA-Signature`, ISO `timestamp` inside the body) and by tests built to that format — but I did
  not create a webhook on the real OpenWA, because that is a write, not a read.
* **Live read-only check (done):** real OpenWA at `http://127.0.0.1:2785`, session listed, status *ready*, the CRM's
  Test / Health / Status endpoints all answered correctly with the number masked and the API key absent from every response.
  I then wiped the key from the throw-away database.
* Weeks of behaviour on a real number; the hosting steps on a real VPS; the full `crm.ipropy.com` build via Docker
  (not run — only typecheck, unit, integration and browser suites).
* Pre-existing lint errors elsewhere (e.g. an unused `normalizeFacebook` import in `webhooks.ts`, an unused `Badge`
  import in `WhatsAppAdmin.tsx`) were already on `main`; I left them.

## Tests added

* 31 unit tests: phone normalisation, E.164, message-id shortening, HMAC (right/wrong/missing/malformed), replay window,
  webhook parsing (inbound, from-phone, groups skipped, media as metadata, hidden senders, receipts), plain-language
  refusals, every send brake and the one-at-a-time send lock.
* 21 API tests with a pretend OpenWA and a real database: connect and masking, key never returned, wrong key,
  one-provider-at-a-time, rejected / stale / replayed webhooks, matching to the right contact, unmatched chats,
  sent-from-phone, media metadata, on-demand file, receipts moving forward only, send reaches OpenWA once as the right user,
  attachment bytes intact, spacing, per-number cap, wrong-number and stranger refused, templates refused, phone-not-linked
  refused before writing, OpenWA rate limit shown plainly, create-contact-from-chat, OpenWA down.
* 8 browser tests (Playwright) on the contact's chat panel and the unmatched inbox, including a phone-sized screen.
* Existing unit suite, the WhatsApp integration tests, and the existing WhatsApp / campaign browser specs still pass.
* **Whole integration suite: 961 of 969 pass; the 8 that did not are not from this change.** Two
  (`marketDealMatches`, `semanticSearchThroughTheIndex`) fail identically on a clean `main`; two list-order
  tests passed when re-run alone (they share a database with other sessions); and `companionApk` / `fileCrud`
  fail only because this working copy sits inside a hidden `.claude` folder, which the file-serving library
  refuses (they pass on a clean `main` checked out elsewhere).

## Six lines for the manager

1. Branch `crm-openwa-bridge` is pushed (not merged, not deployed); OpenWA works as a fifth, **off-by-default** WhatsApp provider.
2. Settings card + Test (session state, masked number), signed webhook with replay protection, both sides of the chat stored, media on demand.
3. Chat panel on the contact (ticks, dates, banner, text + one attachment), unmatched-numbers inbox with one-click create contact.
4. Guard-rails in code: one recipient, no bulk, no campaigns, only known numbers, per-user/per-number caps, 10-second spacing, refuse when unlinked.
5. 31 unit + 21 API + 8 browser tests green against a pretend OpenWA; a live read-only check against the real OpenWA passed; no real message sent or read.
6. Needs the owner's yes (it overrides CLAUDE.md's "official route only" for an unofficial gateway), an always-on server (~₹500–1,200/month), and the phone opened every 14 days.
