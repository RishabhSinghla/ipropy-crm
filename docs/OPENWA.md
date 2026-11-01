# OpenWA — the company WhatsApp as a linked device

Written 24 October 2026. Plain words first; the technical detail is further down.

## The idea in four sentences

The company has one WhatsApp number. It already lives on the owner's phone, and
WhatsApp lets that number be "linked" to up to four more devices — the way you
open WhatsApp Web on a laptop. **OpenWA** is a small separate program that acts
as one of those linked devices, and the CRM talks to OpenWA over the internet.
So the team can chat with customers inside the CRM, and the owner's phone and
everyone else's linked devices keep working exactly as before.

```
 Customer's phone                      Owner's phone  +  team's linked devices
        │                                         │   (WhatsApp's own "linked devices")
        ▼                                         ▼
  ┌────────────────────────── WhatsApp ───────────────────────────┐
  └──────────────────────────────┬─────────────────────────────────┘
                                 │ (one more linked device)
                          ┌──────▼──────┐        signed webhook  (customer wrote,
                          │   OpenWA    │ ─────────────────────▶   delivery ticks,
                          │ (own server)│                          phone sent one)
                          └──────▲──────┘                        │
                      send / ask │ HTTPS + API key               ▼
                                 │                      ┌─────────────────┐
                                 └──────────────────────│     the CRM     │
                                                        │ (Render, as now)│
                                                        └─────────────────┘
```

* **CRM → OpenWA:** "send this text to that number" and "how is the session?"
  (HTTP, with an API key that never leaves the CRM server).
* **OpenWA → CRM:** a *webhook*: OpenWA posts each event to
  `/api/webhooks/whatsapp/openwa`, signed with a shared secret. The CRM refuses
  anything unsigned, wrongly signed or older than 30 minutes, and ignores a
  message it has already stored.
* OpenWA is **not part of the CRM**. They share no code and no database. If
  OpenWA is switched off the CRM carries on; only WhatsApp chat in the CRM pauses
  (a banner says so, and a send fails visibly — nothing is queued silently).

## How this fits the earlier WhatsApp decisions

`WHATSAPP.md` records two doors that were removed on purpose:
the per-rep "link my own phone" road (QR code per agent, Baileys) and the
"WhatsApp Web" bridge. Both were removed because they copied *reps' personal*
chats into a business database and put each rep's own number at risk. **This is
neither of them, and it does not bring them back**: it is **one company number**,
linked once, by the owner; the CRM never imports old chats (it only stores what
arrives from now on); there are no per-rep accounts; and nothing here sends in
bulk.

What it **does** share with the removed road, and must not hide: OpenWA is an
**unofficial** gateway (it speaks WhatsApp's linked-device protocol through
open-source libraries; it is not Meta's Business API). WhatsApp can restrict a
number that behaves like a robot. `CLAUDE.md` says "the official business route
is the only WhatsApp road" — so **switching this on is a decision that
overrides that line, and it is the owner's to make.** It is off until an admin
turns the card on, and the official providers stay available beside it (only one
is live at a time; switching one on switches the other off).

It is built as a fifth provider next to Meta, AiSensy, Gupshup and
whatsmarketing.in, so the inbox, the contact's WhatsApp tab, opt-out handling and
the health page all work unchanged.

## The one thing that must be true: OpenWA runs day and night

OpenWA holds the live WhatsApp connection. If its server is off, the CRM cannot
send or receive WhatsApp. So it needs a small always-on computer that the CRM
(on Render) can reach over the internet. **Your laptop is fine for trying it
out, not for real use** (it sleeps, and `127.0.0.1` is not reachable from Render).

### Recommended: a small VPS + Docker + automatic HTTPS

Why: the simplest thing that stays up. OpenWA ships a `docker-compose.yml`; a
reverse proxy (Caddy) puts HTTPS in front and gets the certificate by itself.

| | |
|---|---|
| Server | 2 GB RAM Linux VPS (OpenWA with the Baileys engine used about 280 MB on the trial, so 1 GB works but is tight once Docker, the OS and the proxy are counted). Singapore or Mumbai, close to Render's Singapore. |
| Rough price | DigitalOcean's own price page (checked 24 Oct 2026): 1 GiB $6, 2 GiB $12 a month; Hetzner's entry plans start around €6 (checked the same day; they have no India site, Singapore is nearest). In rupees that is **about ₹500–600 a month for 1 GB and ₹1,000–1,200 for 2 GB, plus GST** — the rupee figure is an estimate from today's rough exchange rate, not a quote. |
| Other costs | None. Use a sub-address of the existing domain, e.g. `openwa.ipropy.com` (a free DNS record). |

**Steps** (about an hour, once):

1. Create the VPS (Ubuntu 24.04). Add your SSH key. Point `openwa.ipropy.com` at its IP (an `A` record).
2. On the server: install Docker (`curl -fsSL https://get.docker.com | sh`).
3. Get OpenWA: `git clone https://github.com/rmyndharis/OpenWA && cd OpenWA && cp .env.example .env`.
4. Edit `.env`: `ENGINE_TYPE=baileys`, `RESOLVE_LID_TO_PHONE=true` (so people who hide their number still show a number),
   and **turn OpenWA's own send pacing on** (`SEND_PACING_ENABLED=true`) — a second safety net behind the CRM's.
5. `docker compose up -d`. OpenWA listens only on the server itself (`127.0.0.1:2785`), which is what you want.
6. Add Caddy as the front door (replace the domain):
   ```
   openwa.ipropy.com {
     reverse_proxy 127.0.0.1:2785
   }
   ```
   Run it with `docker run -d --restart unless-stopped --network host -v $PWD/Caddyfile:/etc/caddy/Caddyfile -v caddy_data:/data caddy`.
   Caddy fetches the HTTPS certificate itself.
7. Open the firewall for ports 80 and 443 only. Do **not** open 2785.
8. In OpenWA's dashboard create a **session** (for example `company`), scan the QR code from the owner's phone
   (WhatsApp → Settings → Linked devices → Link a device), and create an **API key** limited to that session.
9. In the CRM: **Admin → Integrations → WhatsApp → OpenWA (linked device)**. Enter
   `https://openwa.ipropy.com`, the session name, the API key, and press **Generate** for the webhook secret.
   Press **Test** — it should say the session is ready and show the number with most digits hidden.
10. In OpenWA add a **webhook** for the session: URL `https://crm.ipropy.com/api/webhooks/whatsapp/openwa`,
    the same secret, events `message.received`, `message.sent`, `message.ack`, `message.failed`, `session.status`.
11. Switch the card on. The CRM's WhatsApp Health page now shows an OpenWA panel.

Back up OpenWA's data folder (its `data` volume holds the WhatsApp login). Updating OpenWA is
`git pull && docker compose up -d --build`.

### The other thing that must be true: open WhatsApp on the phone every two weeks

WhatsApp logs linked devices out if the main phone is not used for **over 14
days** (WhatsApp Help Center, "About linked devices", checked 24 Oct 2026). If
that happens the CRM's chat banner and the Health page say the session needs
linking again; scanning the QR once more fixes it. Nothing is lost.

## Running it on your own computer (to try it)

```bash
# 1. OpenWA (already running for you at http://127.0.0.1:2785)
cd ~/Documents/claude-work/openwa-trial/OpenWA && docker compose up -d
#    Let OpenWA call the CRM running on this Mac:
#    add  SSRF_ALLOWED_HOSTS=host.docker.internal  to OpenWA's .env, then: docker compose up -d
```

2. Start the CRM against a throw-away database (so your real local data is untouched):
   see `REVIEW.md` → "Preview it on localhost".
3. In the CRM card use `http://127.0.0.1:2785` and the session name; add the webhook in OpenWA with
   URL `http://host.docker.internal:4000/api/webhooks/whatsapp/openwa`.

## What the CRM adds around OpenWA (the guard-rails)

All in code, all checked **before** anything reaches OpenWA, all visible on the card:

* **One recipient per request.** There is no "send to many" endpoint. Campaigns refuse this connection by name, and the
  workflow template step cannot use it (it has no templates).
* **Only to a number the user may already open:** it must be on a record they can view, or an existing chat in their
  inbox. A typed-in stranger is refused.
* **Daily caps:** per CRM user (default 60) and per customer number (default 15), counted from the CRM's own records.
  Adjustable on the card, clamped so a typo cannot switch them off.
* **Minimum gap** between any two sends from the number (default 10 seconds, never below 3).
* **Refuses when the phone is not linked**, before writing anything.
* **Plain-language errors**, including OpenWA's own rate limit ("try again in about 30 seconds").
* **Attribution:** every CRM-sent message carries the CRM user who sent it.
* **Privacy:** only one-to-one chats are stored (channels and status posts are ignored; groups never become chats and only reach Dealer Groups when an admin switches that group on); photos and files are
  stored as a name and size only and fetched from OpenWA when someone presses **Load**; the API key is encrypted and never
  returned to the browser; a webhook with a bad signature, no signature, or older than 30 minutes is refused.

## Technical notes

* Provider id `whatsapp_openwa`; code in `packages/server/src/integrations/whatsapp/business/openwa*.ts`.
* Capability `linkedDevice` (no 24-hour window, no templates, no campaigns); `replyWindowAlwaysOpen()` tells the screens.
* Message ids are stored in OpenWA's short form (`3EB0…`); the long form the send call returns is shortened, so the copy of
  our own message that OpenWA announces is recognised, not stored twice. A message sent from the phone is recorded after a
  20-second pause for the same reason.
* Webhook replay window: `webhookMaxAgeMinutes` on the card (default 30, max 24 h). OpenWA retries a failed delivery
  with the *same* body, so a CRM outage longer than the window makes OpenWA's later retries refuse; widening it is safe
  because message ids are de-duplicated anyway.
* **Dealer groups:** group messages are not chats. They go to the Dealer Groups feed, only for groups an admin
  switched on (Admin → WhatsApp → Group sync). See `WHATSAPP.md`, *Dealer groups, read live*.
* Tests: `tests/openwa*.test.ts` (pure rules), `tests/integration/openwaBridge.test.ts` (API + database against
  `tests/fakes/fakeOpenWa.ts`), `e2e/openwaChat.spec.ts` (browser against the same fake).

## One number per agent (added 1 November 2026)

Each agent can have their **own** WhatsApp number (their own OpenWA session). Admin → **WhatsApp numbers** is the master:
add a session, Start it, scan its QR with that agent's phone, then pick the agent from the dropdown. One number is flagged
**Company number** (the original `harish-phone`); it is the fallback for leads whose agent has no number.

**Rules (the same ones the code enforces, in `business/waNumbers.ts` and `business/send.ts`):**

* An **agent sends only from their own number.** With no number assigned the send is refused with a plain message — it
  never quietly goes out from somebody else's.
* An **admin** can send from any number. The default is the lead owner's number; if that agent has none the company number
  is used and the screen says so. A **paused** number sends nothing (customers' replies still arrive).
* **Incoming messages** are stamped with the number they arrived on (`ipy_message.number_id`; OpenWA names its session in
  every webhook). A stranger writing to an agent's own number becomes that agent's chat, not the shared queue's.
* **Who sees a chat** is unchanged: the lead's owner (and admins). So **re-assigning a lead keeps the whole history** visible
  to the new owner, each message still showing the number that carried it; **new messages go from the new owner's number**.
  The customer will see them arrive from a different WhatsApp number — that is expected.
* **Limits are per number:** the minimum gap between sends and the daily caps are counted for each number separately.
* **Audit:** every CRM-sent message records who sent it and from which number; the master screen lists the latest.

**Capacity on the Render plan:** the OpenWA server (`ipropy-openwa`, Starter, 512 MB, 1 GB disk at `/app/data`).
Measured 1 Nov 2026 from Render's metrics: with **three** numbers connected it used about **225 MB** of 537 MB, CPU
under 2% of 0.5; earlier with one number and several hours of uptime it sat near 300 MB, so memory creeps up over time.
The CRM refuses to **start** a number beyond the limit saved on the numbers screen ("OpenWA server room", default 3,
setting `whatsapp.capacity`) and says it needs the bigger Render plan. Optionally set a metrics token (below) so the CRM
also refuses when the server's real memory is above 80%. Estimate for 10 numbers: about 0.8–1.2 GB, so the 2 GB plan.

**Setup note:** creating/starting/QR from the master screen needs an OpenWA key allowed to manage sessions. If the card's
key is restricted to one session, add a second key (OpenWA dashboard → API Keys, role ADMIN) as `adminApiKey` on the card.

**Rollback:** `ALTER TABLE ipy_message DROP COLUMN number_id; DROP TABLE ipy_wa_number;` (messages are untouched; the
migration only tags existing OpenWA messages with the company number).


---

# Running many numbers (added 1 November 2026)

## Where the logins live, and why a redeploy keeps them

Everything that makes a phone stay linked is on the Render **persistent disk** `disk` (`dsk-dbes8qjrjlhs738ntla0`, 1 GB,
mounted at `/app/data`): `data/baileys/` (the WhatsApp login keys, one folder per session), `data/main.sqlite` and
`data/openwa.sqlite` (sessions, API keys, webhooks, OpenWA's own message copy) and `data/media/`. A redeploy or restart
replaces the container but not the disk.

**Proof (not assumption):** on 1 Nov 2026 12:11 UTC the service was redeployed. OpenWA's own log shows `harish-phone` and
`yogesh-phone` "Adopted session … from lapsed node" and "Session ready" within 2 and 4 seconds, no QR generated, and the CRM
kept sending from them. (`deepak-phone` generated a QR in that window because it was being paired for the first time.)
A link cannot be proved on a throwaway session without a phone to scan it, so no company number was ever restarted for a test.

Rules that keep it true:
* Never delete the disk, change its mount path (`/app/data`), or move the service to a plan without disks.
* Run **one** instance only. Two instances on one session risk a forced WhatsApp logout.
* Keep `AUTO_START_SESSIONS` set on the OpenWA service so linked sessions start by themselves after a restart.
* Before any risky change take a **disk snapshot** (Render dashboard → ipropy-openwa → Disk → Snapshots).

## Runbook: restart, redeploy, rollback, "agent got logged out"

1. **Restart one number** (the usual fix): Admin → WhatsApp numbers → *Restart*. No QR needed.
2. **Restart the whole OpenWA server:** Render → ipropy-openwa → Manual Deploy → *Restart service*. Wait about 2 minutes; every
   number should return to **Connected** by itself. If one stays "disconnected", press *Restart* on it.
3. **Redeploy a new OpenWA version:** take a disk snapshot first, then Manual Deploy. The service has no zero-downtime deploy
   (it owns a disk), so WhatsApp chat in the CRM pauses for 1–3 minutes; the CRM keeps working.
4. **Rollback:** Render → Deploys → pick the previous deploy → *Rollback*. If sessions misbehave afterwards, restore the snapshot.
5. **"The agent got logged out"** (screen shows *disconnected* / *needs QR* and the watchdog gave up): on the agent's phone open
   WhatsApp → Settings → Linked devices. If the OpenWA device is gone, press *Show QR* on the number and scan again (Linked
   devices → Link a device). Nothing in the CRM is lost. WhatsApp logs a linked device out if the main phone is unused for 14 days.

## What the CRM does by itself now

* **Watchdog** (every minute): a number that was linked and has dropped is restarted after 1, 5, 15, 30, 60 minutes, at most five
  times, one number per minute across the fleet; then it stops and the screen says a person must act. A number an admin stopped or
  unlinked is never restarted. The counter resets when the number is ready again.
* **Room check:** a number is only started if the server has room (see capacity above).
* **Quiet hours:** Admin → Integrations → OpenWA card → "No CRM WhatsApp sends from this hour … until" (organisation timezone).
* **Per number** the screen shows messages sent today, failures today, last active, status since, last error.
* Incoming messages are stored once per provider message id (webhook claim plus a unique check); OpenWA retries are harmless.
* Optional **metrics token:** set `METRICS_TOKEN` on the OpenWA service (Render env) and the same value as "OpenWA metrics token" on
  the card; the screen then shows OpenWA's real memory. Setting it restarts OpenWA once, so do it in a quiet moment.

## Upgrading the OpenWA server (do this only after the owner says yes)

Price (Render pricing page, 1 Nov 2026): Starter 0.5 CPU / 512 MB **$7**/month → Standard 1 CPU / 2 GB **$25**/month; disk
$0.25 per GB per month. Steps, about 10 minutes, at a quiet time:
1. Disk snapshot (Render → Disk → Snapshots).
2. Render → ipropy-openwa → Settings → Instance Type → **Standard (1 CPU, 2 GB)** → Save. The service restarts once.
3. Render → Environment → set `MAX_CONCURRENT_SESSIONS` to `12` → Save (one more restart). Optionally raise the disk to 5 GB.
4. Wait until every number says Connected (no QR should be asked).
5. CRM → Admin → WhatsApp numbers → "OpenWA server room": set *Most numbers connected at once* to `10`, *Server memory* to `2048`, Save.
6. Watch memory in Render → Metrics for a day; it should stay under about 1.2 GB with 10 numbers.
Rollback: Instance Type back to Starter, and set the room limit back to `3`.

## An agent links their own number (Settings → My WhatsApp)

Any signed-in agent with an assigned number opens **Settings → My WhatsApp**, presses *Get QR code*, scans it (WhatsApp → Linked devices →
Link a device) and the page flips to *Connected* by itself. If they are logged out later, the same page's button gets a new code. The page only
ever acts on the number assigned to the person signed in (`/api/whatsapp-numbers/mine/qr` and `/mine/start`); it cannot stop or unlink, and it
obeys the same capacity rule as the admin screen.

## Why a number can show "missing"

"Missing" means the CRM has the number in its list but OpenWA no longer has that session. `shikha-phone` went missing because somebody deleted
the session in OpenWA (OpenWA log, 1 Nov 2026 10:30 UTC: "Session deleted: shikha-phone", an explicit delete request) — not the redeploy and not the
CRM's capacity rule (the CRM has no delete button and the rule came later). Fix: Admin → WhatsApp numbers → type the same name → *Add number*, then
the agent scans from Settings → My WhatsApp.

## Memory token (not set yet)

The CRM can read OpenWA's real memory only if `METRICS_TOKEN` is set on the OpenWA service and the same value is saved as "OpenWA metrics token"
on the OpenWA card. Both are secret-store writes, so they are done by the owner: Render → ipropy-openwa → Environment → add `METRICS_TOKEN`
(any long random string; this restarts OpenWA once, quiet moment, numbers reconnect by themselves), then Admin → Integrations → OpenWA → paste the
same string → Save. Until then the guard only counts connected numbers.
