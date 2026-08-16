# The WhatsApp bridge

Lets the CRM send and receive WhatsApp through a phone that is already signed
in, the same way WhatsApp Web works. No Meta account, no approval, no template
submissions, no 24-hour window, nothing per message.

It runs on the always-on Mac, next to the media worker, because a WhatsApp
session has to stay alive and the CRM runs in a container that restarts.

---

## Read this part first

**WhatsApp does not allow this and can ban the number.**

Whether that happens is decided by how the number behaves, not by the fact that
something automated is attached to it. A number that answers people who wrote
first, at a human pace, during waking hours is left alone; a number that wakes
up and fires sixty messages at strangers is not.

The limits are enforced by the CRM rather than left to anyone's judgement:

| Rule | Value |
|---|---|
| Gap between messages | 40 seconds plus up to 80 random |
| Per day, first 3 days | 25 |
| Per day, days 3 to 7 | 50 |
| Per day, days 7 to 14 | 100 |
| Per day, after 14 days | 200 |
| Sending hours | 08:00 to 21:00, in the organisation's timezone |

The CRM hands out one message per number at a time and refuses the next until
the gap has passed. Running the bridge in a loop, or twice, cannot make it go
faster.

**Two things worth doing anyway.** Link one number first and watch it for a
couple of weeks before adding the team, so a bad outcome costs one number rather
than five. And do not start with the number the whole business runs on.

---

## Setting it up

### 1. Switch it on in the CRM

Admin, then Integrations, then **WhatsApp via linked phone**. Turn it on and put
a long random string in `bridgeToken`. Anything will do:

```bash
openssl rand -hex 24
```

That token is the only thing standing between whoever can reach the CRM and your
WhatsApp, so treat it like a password.

### 2. Start the bridge

```bash
cd wa-bridge
npm install
WA_BRIDGE_TOKEN=<the same string> CRM_URL=https://ipropy-crm.onrender.com npm start
```

| Variable | Default | What it does |
|---|---|---|
| `WA_BRIDGE_TOKEN` | *(none)* | required; must match the CRM |
| `CRM_URL` | `http://localhost:4000` | which CRM to serve |
| `WA_SESSION_DIR` | `~/.ipropy-wa-sessions` | where the linked sessions are kept |
| `WA_MIN_POLL_SECONDS` | `5` | a floor; the CRM sets the real pace |
| `WA_DEBUG` | *(unset)* | put Baileys' own logs back |

### 3. Link a phone

In the CRM: **Settings, Phones, Link my WhatsApp**. A code appears within a few
seconds. On the phone: WhatsApp, Settings, Linked devices, Link a device, and
point the camera at the screen.

The code changes every twenty seconds by itself. If the camera misses one, wait
for the next.

---

## What it does, and what it refuses to do

The bridge asks the CRM what to do and does it. It decides nothing about who to
message, what to say, or how fast.

Every exchange is the bridge calling the CRM. The CRM never calls the bridge, so
the machine holding the sessions needs no public address, no tunnel and no open
port.

```
  bridge                          CRM
    |  poll ------------------->   |  which numbers am I holding?
    |                              |  is anything ready to send?
    |  <----------------- answer   |  at most one message per number
    |                              |
    |  ---- send on WhatsApp ---   |
    |  result ----------------->   |  sent, or why not
    |                              |
    |  inbound ---------------->   |  a customer replied
```

An incoming message goes through the same code the Meta webhook uses, so the
24-hour window, opt-out detection, sequence exit on reply, auto-replies, the SLA
clock and the record timeline all work without knowing which door it came
through.

**Media is recorded but not downloaded.** A photo from a buyer appears in the
conversation as an attachment that arrived, with its caption, rather than as the
picture. Visibly incomplete on purpose: dropping the message silently would be
worse, and pulling files off the session is a bigger job than it looks.

---

## Keeping it running

`npm start` in a terminal is fine to begin with. To have it start with the Mac,
a launchd job is the usual answer, the same as the media worker.

The CRM's Settings screen shows **Bridge last seen**. If that goes stale, the
program has stopped or the Mac is asleep. Nothing is lost while it is down:
messages wait in the queue, and anything a stopped bridge had claimed is
released automatically after ten minutes.

Stopping the bridge does not unlink anything. Sessions are on disk in
`WA_SESSION_DIR` and resume on the next start.

---

## When something is wrong

**No code appears.** The bridge is not running, or its token does not match the
CRM's. Its log says which.

**"That number is not connected right now".** The session dropped. The next poll
restarts it; if the phone removed the link, the CRM says so and the rep scans
again.

**Nothing sends and the log says "outside sending hours".** Correct behaviour
between 21:00 and 08:00. The clock used is the organisation's timezone, not the
laptop's.

**Nothing sends and the log says "daily limit reached".** Also correct. Check
the number's age against the warm-up table above.

**A message says "that number is not on WhatsApp".** The lead's mobile is wrong
or they do not use WhatsApp. It is marked failed after two tries and left for a
person.

---

## A note on the library

This uses [Baileys](https://github.com/WhiskeySockets/Baileys), pinned to
`6.7.24`.

**Do not "upgrade" to 6.17.16.** It sorts highest by version number and is a
year older than the 6.7 line, and it carries a message-spoofing vulnerability.
Asking npm for the newest-looking version gets you the wrong one; the
maintainers tag `6.7.24` as `legacy` and `7.0.0-rc*` as `latest`.
