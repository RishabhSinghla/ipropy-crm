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

# Five numbers, one checker (added 5 November 2026)

**What was already there (not rebuilt):** one number per agent with the admin assignment screen (Admin → WhatsApp numbers), server-side
enforcement in `business/send.ts` (an agent can only send from their own number; admin can use any), the minute watchdog, admin alerts
when a number drops, and the persistent disk. Render facts checked 5 Nov 2026: `ipropy-openwa` is a paid Starter web service (never
sleeps), one instance, a 1 GB disk at `/app/data` holding every login, health check `/api/health/ready`. So **Render is not the cause of
drops**. Real causes are WhatsApp itself: the phone unlinked the device, the phone was off/unused for 14 days, or OpenWA restarted and
was slow to adopt the sessions. WhatsApp can always log a phone out; no setting makes that impossible.

**New:**
* **The name/photo checker shares its work across every linked number.** Each number runs its own loop (own random 8–20 s pause, own
  daily cap, default 150, counted from `ipy_wa_lookup.number_id`), so five numbers do ~5× the work per day while no single number goes
  faster than before. A number that is not `ready`, is paused, or errors is left out; the rest carry on. Contacts are claimed in
  memory so two numbers never take the same one. Restarting the job resumes where it stopped (a contact with a result is skipped).
* **Slow retry:** after the five quick restarts fail the watchdog now tries again every 6 hours while the number stays down (a long
  OpenWA outage heals by itself); the red alert stays up meanwhile. A number that WhatsApp unlinked still needs a QR.
* **Room default is 5 numbers** (was 3). If the card already saved a different value, change it on Admin → WhatsApp numbers.
  Memory on the 512 MB plan with 5 numbers is not yet measured (3 numbers ≈ 225 MB; the service sits ~310–350 MB today). Set the
  metrics token (see above) so the CRM refuses to start a number when memory passes 80%; upgrade to Standard ($25/mo) only if Render's
  memory graph stays above ~450 MB.

# Housekeeping on the numbers screen (7 November 2026)

* **Remove number** (Admin → WhatsApp numbers): deletes a leftover or test session from the list and from OpenWA. Refused for the
  company number, for a connected number, and for any number that ever carried a message (those keep their history; unassign the agent).
* **Needs-QR banner:** a number whose phone was logged out (`qr_ready` / `disconnected`) is listed in red at the top with the agent's
  name. Restarting cannot fix it. The down alert now says so, and the agent gets their own bell notice pointing to Settings → My WhatsApp.
* A card whose status is `qr_ready` opens its QR code by itself.


# The slow drip: one promotional message over many weeks (7 November 2026)

**Read the risk first.** The CRM has no bulk button on the linked phones, on purpose: many messages to many strangers is exactly the
pattern WhatsApp restricts numbers for. The owner has decided to accept that risk for one promotional message to the CRM's contacts,
sent very slowly. This section is that exception. It does **not** remove the other guard-rails (above), and it is not a safe
route — it is a *less risky* one. The safe route for bulk is still the official WhatsApp API with approved templates (WhatsMarketing).

* Even at this pace a linked phone can be **limited or banned**. These are real people's numbers (Harish's is the company number).
  If WhatsApp limits one, stop using it for promotions and do not try to get round it.
* **India's rules still apply.** Promotional messages fall under TRAI's rules, and personal data under the DPDP Act. In plain words:
  message only people who have a real reason to expect it (they enquired, they are in your trade), always give a way to stop, and
  honour every STOP, everywhere. The drip does the second and third parts for you; the first is your judgement.
* At this speed **50,000 contacts is a year or more, not weeks**: 4 phones × 20 a day = 80 a day to start, 160 a day at the very most
  (40 per phone). Start with your best saved lists, not the whole database.

## What it does, in plain words

Admin → **WhatsApp drip** (admins only; API keys are refused). You make a *queue*:

1. **Pick a saved list** of contacts (a saved filter). "Everybody" is not an option; the list must be named.
2. **Write the message** (it starts with the IPROPY wording, four slightly different versions). Each person gets one version,
   chosen by their record, plus their **first name when it is a real name** (`{name}`; with none, "Hello," only). Every message ends
   with **"Reply STOP to stop"**. Links are refused in the wording (a link in a cold message is the quickest way to be reported).
3. **Tick the phones** to send from (only connected, un-paused ones are offered).
4. **Press "Who would get this?"** — it shows how many people, who is left out and why, and three sample messages. Nothing is sent.
5. **Start for N.** The people are copied into the queue *at that moment*, with the count you were shown; if the list has changed
   since, Start refuses. Editing the saved list later changes nothing for a running queue.

Then the CRM's clock sends **one message at a time**:

| Rule | Value |
|---|---|
| Per phone per day | **20** for the first 3 days it really sends, then +5 every 3 days, never above **40** (the code's ceiling; a typed higher number is cut down). A hand-typed chat is still limited to 60 per person per day, separately. |
| Gap between any two messages | random **60 to 120 seconds** (never under 60, even if set lower) |
| Hours | **10:00–18:00** in the organisation timezone by default (never before 06:00 or after 21:00) |
| Which phone | takes turns, the one that sent least recently; a phone that is not ready, paused, restricted or at its cap is skipped for that turn |
| Each person | **once, ever** — across every queue (a database rule, not carefulness) |
| Only one queue runs at a time | so the pace cannot double |

## Who is left out (and the screen says how many, per reason)

* no mobile number, or not a valid Indian mobile (ten digits starting 6–9);
* the same number twice in the list (the second record is left out);
* **asked not to be messaged** — anyone who replied STOP (see below) or was marked do-not-message by hand; this is checked at Start
  *and again just before each message*, because somebody can reply STOP in between;
* a number the queue has already messaged;
* **not on WhatsApp** — the CRM's number checker result is used if it has one; otherwise it asks WhatsApp once (one lookup, then
  waits 8–20 seconds before the next action) and remembers the answer;
* a record that was deleted or archived since Start.

## It stops itself, and never starts itself

The whole queue **pauses** and every admin gets a notice (bell, push, and email if email is connected) when:

* any phone on the queue **drops** (disconnected, logged out, removed) — the message names the phone;
* WhatsApp reports a **restriction** on a phone (the session's `restriction`, e.g. `reachout_timelock`);
* **three sends fail** within a day;
* OpenWA cannot be reached for the phone about to send, or the admin who started it is no longer an active admin.

A paused queue stays paused until a person presses **Resume**. At Resume you can untick a phone that is still down and carry on with
the rest. **Stop** is final (people not yet messaged are simply never messaged). If the server restarts in the middle of a send, that
one person is marked *failed – interrupted* and **not retried**: a missed message is better than a double one.
A phone paused by hand on the WhatsApp numbers screen is simply left out of the turns; it does not pause the queue (unless every phone is paused).

## STOP

Every message ends "Reply STOP to stop". When a customer replies **STOP** (also `unsubscribe`, `stop all`, `opt out`), the existing
inbound path writes them to the do-not-message list (with an audit row naming the record), and every send on every route — chats,
campaigns, this queue — refuses them from then on. Only the *whole* reply counts ("don't stop calling me" does not). Other angry
replies ("remove my number", "who are you?") are **not** auto-detected: read the replies, and use the contact's WhatsApp opt-out
control by hand. The queue's card counts "N replied STOP".

## Audit trail

* The queue card → **What happened**: every create / start / pause / resume / stop / auto-pause with *who*, *which phone* (for a
  phone-specific pause) and *when*, the people left out by reason, and the latest sends and failures.
* **Admin → WhatsApp numbers → Who sent what, from which number**: every drip message appears there too, marked "drip: <queue name>",
  with the admin who started the queue, the phone and the time. Messages also sit in the contact's chat like any other.

## How to try it (do these in order)

1. Make sure **you** are a contact in the CRM (a lead with your own mobile). The CRM only messages people it has a record for.
2. Admin → WhatsApp drip → **New queue**. Type your mobile in **"Send me a test"** and press it. Read it on your phone: the wording,
   the greeting, "Reply STOP to stop". Reply **STOP** from your phone and check you are now left out (the contact shows opted out).
3. Make a small saved list (5 contacts you know), a new queue with **"Stop after" = 5**, press "Who would get this?", read the sample,
   then Start. Watch them go out over ten minutes or so. It will say "waiting for daytime" outside 10:00–18:00.
4. Only then use a bigger list. Keep an eye on the card for the first few days: failures, STOP replies, anything odd.
5. **To stop right now:** Pause (reversible) or Stop (final) on the queue's card. To stop a single phone: pause that number on
   the WhatsApp numbers screen.

## Technical notes

* Tables `ipy_wa_drip` (queue + speed settings + state), `ipy_wa_drip_item` (one row per person, frozen at Start; unique on
  `(drip_id, record_id)` and on `handle` where status is `sending`/`sent`), `ipy_wa_drip_event` (audit). Migration `237_wa_drip.sql`.
* Code: `integrations/whatsapp/business/dripRules.ts` (pure rules, unit-tested), `drip.ts` (queue, clock, pause logic),
  `api/routes/whatsappDrip.ts` (admin-only routes — none of them sends a list), UI `WhatsAppDripAdmin.tsx`.
* Every message goes through `sendOnBusinessNumber` — the one send path. The only change to it is an optional `fromQueue` flag that makes
  the *per-user daily cap* (about hand-typing) not apply to the queue (which has its own, stricter, per-phone cap) and not count
  queue messages against the admin's own allowance. Spacing, quiet hours, per-customer cap, opt-out, paused/not-ready number and
  "must be a record we have" all still apply, and a refusal by one of those brakes just delays the queue (it is not counted as a failure).
* The clock ticks every 15 seconds and sends at most one message per tick; `next_send_at` lives in the database so a restart loses nothing.
* Not built, on purpose: sending to "everyone", a faster mode, retrying an interrupted send, auto-resume, and auto-detecting replies
  that are not the STOP words.
