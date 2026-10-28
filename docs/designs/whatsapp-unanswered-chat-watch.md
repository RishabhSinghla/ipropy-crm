# Design: Waiting-for-reply alerts for WhatsApp chats

Status: Draft v5 (after 4 review stages; the two open questions below do not block implementation)
Date: 2026-10-27
Author: Rishabh Singhla (drafted with Claude)
Code name in files: `waitWatch`; notification kind `whatsapp_wait`.

## The problem

A customer writes to the company WhatsApp number. The chat lands in the CRM inbox
and on the contact's WhatsApp tab, and nothing tells anybody the customer is still
waiting. We assume a buyer who waits an hour for an answer may call another
broker; this has not been measured. Today a rep only finds out by opening the
inbox and noticing the unread badge.

## Goals

1. When a customer's WhatsApp message has had no reply for a set time, tell the
   person who holds the chat. The holder is the record's owner (`HOLDER` in
   `business/inbox.ts`). If nobody holds it (an unlinked or unassigned chat) the
   admins are told instead.
2. If it is still unanswered after a second, longer time, tell the admins.
3. Admins control the times and the on/off switch. Reps cannot change them.
4. Admins see how many chats are waiting now and the longest wait, on the
   WhatsApp admin page.

Success looks like: with the feature on, a chat unanswered for the first time
limit produces exactly one alert to the holder, and one to admins at the second
limit, however many times the job runs.

## Non-goals

* Nothing is sent to a customer: no auto-reply, no template. The feature has no
  send path. (Background: a daily workflow once queued 40,515 WhatsApp messages
  by accident; see `WHATSAPP.md`, *Campaigns*.)
* No per-rep league table in this version.
* No change to how messages are received, stored, or sent.
* No filtering of "ok" / "thanks" / stickers: any customer message restarts the
  wait. Accepted noise for version 1.

## Proposed architecture

A standalone job ticks once a minute. It is started in `index.ts` beside
`startCampaignSending`; it is not a workflow-scheduler job. Each tick finds
waiting chats, claims them, then notifies.

```
customer message -> receiveInbound -> ipy_conversation.last_inbound_at
every minute: waitWatch tick
   1. SQL: candidate chats (waiting rules, not yet nudged, recent)
   2. code: waitedMinutes() per chat against the working-hours window
   3. SQL claim: stamp wait_nudge_N_at for the exact message read
   4. notify() the holder (level 1) or notifyMany() the admins (level 2)
```

It reads only `ipy_conversation` and `ipy_message`, so it behaves the same for the
OpenWA company number and the official providers.

### Settings

Three rows in `ipy_setting`, category `whatsapp`, inserted by the migration with a
label and description (`ON CONFLICT DO NOTHING`; without a category a new key lands
in `general` and the admin screen never shows it):

| key | default | meaning |
|---|---|---|
| `whatsapp.wait_watch.enabled` | `false` | master switch |
| `whatsapp.wait_watch.first_minutes` | `15` | working minutes before the holder is told |
| `whatsapp.wait_watch.second_minutes` | `60` | working minutes before admins are told |

Admins edit them in the existing Admin Settings screen (`PUT /api/admin/settings`,
already admin-only). The tick reads them from the database each time (no cache, so
no invalidation hook). One pure function `readWatchSettings(raw)` validates:
enabled only if exactly `true`; minutes clamped to 5-240; `second` raised to
`first + 5` if not larger. Invalid values are clamped, not rejected.

### Which chats count as waiting

All of these must hold:

1. `channel = 'whatsapp'` and `wa_account_id IS NULL` (same scope as the inbox, so
   the imported personal threads never alert anyone).
2. Status is `open` or `pending`; or status is `snoozed` and `snoozed_until` is
   before now (nothing flips the status back when a snooze ends). A `snoozed` chat
   with `snoozed_until IS NULL` is skipped. `resolved` is skipped.
3. Not opted out (`OPTED_OUT` in `inbox.ts`).
4. No reply since the customer's last message. A reply is an `ipy_message` in the
   same conversation with `direction = 'outbound'`, status not `failed`, and
   inserted after the customer's message. Both sides are compared on the
   database's own insert time, never on the provider's `sentAt` (a provider clock
   ahead of ours would make a real reply sort before the message it answers).
   This needs one new column, `ipy_message.received_at timestamptz DEFAULT now()`
   (set by the database on insert, never by the provider; the migration backfills
   it from `created_at`), and the conversation gets `last_inbound_seen_at
   timestamptz`, set to `now()` in the same UPDATE in `inbound.ts` that sets
   `last_inbound_at`. Queued, sent, AI-written and phone-typed rows all count; a
   failed send does not.
5. Working-minutes wait is more than `first_minutes` and at most
   `WAIT_FLOOR_MINUTES` (360). The floor stops the first switch-on, or a job
   outage, from alerting about old chats (same idea as `ANNOUNCE_WITHIN_MS` in
   `inbound.ts`). Wall-clock time is used only as a SQL prefilter
   (`last_inbound_at` within 7 days).

### The clock

`waitedMinutes(since: Date, now: Date, hours): number` returns the whole minutes
(floored) between the two instants that fall inside the open windows of the
existing `business_hours` setting (`start`, `end` as HH:MM; `days` as stored there,
0 = Sunday; `timezone` from that setting, with `organisationTimezone()` only as a
fallback). A 22:00 message starts counting at opening time, so at 09:30 it has
waited 30 minutes and is still under the floor. If `business_hours` is missing or
malformed the business counts as always open, with one warning logged per process.
Chats waiting longer than the floor are not alerted; see Risks. Rules: `end` is exclusive; `end <= start`, an empty `days`, or an unknown timezone counts as malformed (always open, one warning). DST is handled by converting through the timezone with `Intl`, not by adding 24 hours.

### The tick

1. Query candidates: rules 1-4 above, `last_inbound_at` within 7 days, and for
   each level not yet claimed for this message (`wait_nudge_N_at IS NULL OR
   wait_nudge_N_at < last_inbound_seen_at`), newest first, 200 rows. Newest first and the
   stamp filter in SQL stop old unanswered chats from filling the slice and hiding
   fresh ones.
2. In code, compute `waitedMinutes` and keep chats between the limits above. Take
   at most 50 per tick; log how many were left over.
3. Claim each with one statement: `UPDATE ... SET wait_nudge_N_at =
   now() WHERE id = $1 AND last_inbound_seen_at = $read_value::timestamptz
   AND (wait_nudge_N_at IS NULL OR wait_nudge_N_at < last_inbound_seen_at) AND NOT
   EXISTS (outbound reply with received_at > last_inbound_seen_at) RETURNING id`.
   Both sides of every comparison are database time, so provider clock skew and
   late or out-of-order deliveries cannot re-alert every minute or skip a
   re-arm. `$read_value` is read and passed back as text, never through a JS
   `Date` (it would drop microseconds and the claim would never match). Pinning
   `last_inbound_seen_at` and re-checking for a reply
   means a message or reply that lands between the read and the claim is not
   overwritten. Only a chat that returns a row is notified.
4. Level windows: level 1 when the wait is more than `first_minutes` and at most
   `second_minutes`; level 2 when it is more than `second_minutes` and at most the
   floor. Levels are independent: a chat already past `second_minutes` at first
   switch-on gets level 2 only. For an unheld chat, level 1 goes to the admins and
   level 2 goes to the same admins again as a second reminder (no de-duplication
   across levels). A holder who is inactive or deleted counts as no holder. With no
   active admins the alert is skipped and logged.

Failure behaviour: a notify that throws is caught and logged per chat; the claim
stands and that alert is not retried. We accept losing one alert so that nobody
is ever told twice.

### The alert

`notify()` / `notifyMany()` only, kind `whatsapp_wait`. Title `<name> is waiting for
a reply`; body `Waiting N working min`; name falls back from `contact_name` to the number.
`recordId` is set when linked; the link follows the `tellSomebody` rule in
`inbound.ts` (record page if linked, else `/chats`). No message text is included.
(New-message alerts today do include up to 140 characters; unchanged.) Recipients
are active users; level 2 goes to active admins. `notify` also sends a phone push.

### Lifecycle

`startWaitWatch()` / `stopWaitWatch()` mirror the campaign sender's. A "tick still
running" flag skips overlapping ticks in one process; the claim statement is what
protects against several server instances. The tick is wrapped in try/catch.
Rollout: ships off. Kill switch: set `enabled` to false; the next tick stops.

### Health tile

One exported function `findWaitingChats({ includeNudged, limit })` returns `{ conversationId, name, waitedMinutes }[]`; the tick and the tile both use it, the tile with no limit. Added to the overview section of `WhatsAppAdmin.tsx` (there is no separate Health
tab). It shows chats past `first_minutes` (same query, `waitedMinutes` and floor,
ignoring nudge stamps and `enabled`, so admins can see it before switching on) as
`waitingCount` and `longestWaitMinutes`, added to the overview response and its
web type. With nothing waiting it shows "Nobody is waiting".

## Risks and mitigations

| risk | mitigation |
|---|---|
| Alert fatigue (every "ok" restarts the wait) | Ships off; limits adjustable; non-questions not filtered, accepted for v1 |
| First switch-on floods | 360-minute floor, 50 per tick, level independence |
| Duplicate alerts (overlap, restart, clock skew, race) | One guarded claim statement with `GREATEST` and exact-message pin |
| Chat waits past the floor and is never alerted | Neither alerted nor on the tile (both exclude past-floor chats); a digest is an open question |
| Job down longer than the floor | Same as above; alerts for that gap are lost, not delayed |
| A failed notify is not retried | Accepted trade-off against duplicates |
| Privacy of lock-screen pushes | Name and wait time only, no message text |
| Who can change it | Existing admin-only settings route |
| Volume | At most 50 chats per tick, each one or two notifications |

## Alternatives considered

1. **Auto-reply "we'll get back to you".** Rejected: it sends from an unofficial
   linked number, raising the ban risk the owner accepted only for human-typed
   replies.
2. **A workflow rule "no reply in 15 minutes".** Rejected: the scheduler walks a
   capped slice ordered by last update, so the oldest, most neglected records fall
   out first (the "Scale" section of `CLAUDE.md` records this bug five times).
3. **A database trigger or SQL-only job.** Rejected: working-hours maths lives in
   TypeScript with the organisation timezone; duplicating it in SQL gives two rules
   that drift.
4. **A delayed job per inbound message.** Rejected: needs a queue the CRM does not
   have, and a restart would lose pending timers. The poll over `last_inbound_at`
   is restart-safe.
5. **Browser-only red badge on the inbox.** Rejected: a rep not looking at the
   screen learns nothing.

## Open questions

* Should a final "still unanswered" digest go to admins for chats past the floor?
* Should one-word replies ("ok", "thanks") be excluded in a later version?

## Detailed implementation

1. `packages/server/src/db/migrations/222_wa_wait_watch.sql` (new): add
   `wait_nudge_1_at`, `wait_nudge_2_at` (timestamptz, null) to `ipy_conversation`;
   insert the three settings rows (category `whatsapp`, label, description,
   `ON CONFLICT DO NOTHING`); partial index on `ipy_conversation(last_inbound_at)`
   where status in ('open','pending','snoozed'), plain `CREATE INDEX` (the table is
   small). Add `ipy_message.received_at` and `ipy_conversation.last_inbound_seen_at`
   as described under "Which chats count". Settings are inserted as JSON `false`,
   `15`, `60`. Rollback: drop the added columns, the index and the three rows.
2. `packages/server/src/integrations/whatsapp/business/inbound.ts` (edit): set `last_inbound_seen_at = now()` where `last_inbound_at` is set (line ~298).
   `waitWatch.ts` (new, in the same folder):
   `readWatchSettings`, `waitedMinutes`, candidate query, claim, tick,
   `startWaitWatch`, `stopWaitWatch`, `WAIT_FLOOR_MINUTES`.
3. `packages/server/src/index.ts` (edit): start the tick next to
   `startCampaignSending`; stop it at shutdown next to `stopCampaignSending`.
4. `packages/server/src/integrations/whatsapp/business/overview.ts` (edit): add
   `waitingCount`, `longestWaitMinutes` using the shared query.
5. `packages/web/src/pages/admin/WhatsAppAdmin.tsx` (edit): the tile and a link to
   Admin Settings; extend the overview type in the web API client.
6. `packages/server/tests/waitWatch.test.ts` (new, pure): `waitedMinutes` across a
   night, a Sunday, a timezone, missing hours; `readWatchSettings` clamping.
7. `packages/server/tests/integration/waitWatch.test.ts` (new, real database):
   fires once; a new customer message re-arms; opted-out, resolved, expired-snooze,
   imported-personal, unlinked (admins told), 7-hour-old and just-replied chats
   behave as specified; a phone-typed reply stops it; a failed reply does not; two
   overlapping ticks notify once; provider timestamp ahead of server does not
   re-alert.
8. `WHATSAPP.md` (edit): a section on the feature, its settings and its floor.
