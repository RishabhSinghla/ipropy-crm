---
name: whatsapp-bridge
description: >-
  Diagnose and work on iPropy's linked-phone WhatsApp: the wa-bridge process,
  QR/pairing, the ipy_device_send queue, inbound and outbound message flow,
  media, and history sync. Use when a QR will not appear, a message will not
  send or is slow, chats or history are missing, the bridge logs 401/428/440/515,
  or when changing anything under wa-bridge/ or integrations/whatsapp/.
---

# The linked-phone WhatsApp

Everything here was paid for in a single long night of debugging. Each item is a
failure that presented as something else entirely. Read the symptom table first.

## Symptom → cause

| What you see | What it actually is |
|---|---|
| `disconnected (428)` repeatedly, no QR ever | Baileys too old for a `syncFullHistory: true` handshake. Must be on the `latest` dist-tag, not `legacy`. |
| `401 Invalid bridge token` | The token in the bridge's env no longer matches `ipy_integration.whatsapp_linked`. Regenerate in Admin → Integrations and restart the bridge. |
| `disconnected (440)` | Session replaced. Another bridge process is running. `pgrep -fl wa-bridge`. |
| `disconnected (515)` | Normal once, immediately after a scan. It reconnects on its own. |
| Message sits with a clock, never sends | Status is `opened`, not `pending`. Opening Outreach marks it opened, and the claim query must accept both. |
| Message sends, but minutes late | The bridge is inside a long poll back-off. Outside 08:00–21:00 the idle back-off must stay short, or typed replies (exempt from hours) wait out a nap. |
| History arrives but the CRM 400s | Something in `resolveHandle`. Check the server log for the real Postgres error, not the API's mapped message. |
| Button "does nothing" | The screen is showing a stale `logged_out` link. Links accumulate; pick connected → pending → newest, never `.find()`. |
| Chats missing / only a handful | Chat scope. History is filtered by `resolveHandle`; a filter matching three leads empties an 821-chat phone. |

## Things that are true and non-obvious

**History arrives exactly once, during the handshake after a scan.** There is no
way to request it again. Restarting the bridge does nothing. To re-import, the
user must unlink and re-scan. Any change to history handling therefore needs a
real unlink/relink to test — nothing else exercises it.

**`messaging-history.set` must be logged even when empty.** "The phone sent
nothing" and "the event never fired" are different problems with identical
symptoms. The log line carries chats, contacts, messages, syncType and progress.

**Pacing lives in the CRM, never in the bridge.** The bridge is a laptop script
that gets restarted and run twice by accident; anything it remembers about
timing is forgotten at the worst moment. `claimOutbox()` hands out one message
per number and refuses the next until the gap passes.

**Human replies are exempt from pacing, automation is not.**
`priority = 'immediate'` (set when `sentBy` is present with no workflow and no
broadcast) skips the 40–80s gap, the daily cap and the sending-hours window. It
does not skip consent, and a 120/hour ceiling per number remains as a
runaway-loop stop. An exemption is worthless if the poll interval is long — the
consumer has to be awake to collect it.

**Meta's 24-hour window does not apply to a linked phone.** That is a Cloud API
billing rule. Through a linked phone this is the ordinary app. The endpoint
reports `canSendFreely`; the UI must read that, not `windowOpen`.

**Never replay history through `handleInbound`.** It bumps unread, re-opens the
window, starts the SLA clock, notifies the owner, exits sequences, records
consent keywords and fires the auto-reply. Replaying a year of chats through it
messages every customer about something they said months ago.

**Messages the rep sends from their own handset must sync too**, or the CRM holds
one half of every dialogue. They go in via the history path, not inbound, for
the reason above.

## Checks worth running before believing anything

```bash
pgrep -fl wa-bridge                  # more than one is a 440 waiting to happen
docker exec ipropy-db psql -U ipropy -d ipropy -c \
  "SELECT status, priority, attempts FROM ipy_device_send ORDER BY created_at DESC LIMIT 5;"
docker exec ipropy-db psql -U ipropy -d ipropy -c \
  "SELECT id, status, handle FROM ipy_wa_link;"
```

The server log holds the real database error; the API maps `42703` to a generic
"Unknown field referenced in the request" that names nothing.

## The habit this file exists to enforce

Every bug here passed the full test suite. Unit, integration, typecheck, docker
build, all green, three times over, while the feature was broken in the user's
hands. Verify a change by making a real message move end to end, not by watching
tests pass. A path nothing exercises is not a working path.
