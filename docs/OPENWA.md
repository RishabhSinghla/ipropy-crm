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
* **Privacy:** only one-to-one chats are stored (groups, channels and status posts are ignored); photos and files are
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
* Tests: `tests/openwa*.test.ts` (pure rules), `tests/integration/openwaBridge.test.ts` (API + database against
  `tests/fakes/fakeOpenWa.ts`), `e2e/openwaChat.spec.ts` (browser against the same fake).
