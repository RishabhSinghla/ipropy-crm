# SMS and RCS through MSG91

Read this before touching `packages/server/src/integrations/msg91/`, the
`/api/bulk-messages` routes, or Admin → **SMS & RCS campaigns**.

Added 7 November 2026, on the owner's instruction: *bulk promotional messages from iPropy to
all records in the CRM at once.* The rules that hold everywhere live in [`CLAUDE.md`](CLAUDE.md).

## What exists

| Piece | Where |
|---|---|
| MSG91 calls (send SMS, send RCS, test the key) | `integrations/msg91/client.ts` |
| The campaign engine: audience, approval, freezing, sending | `integrations/msg91/bulk.ts` |
| Routes | `api/routes/bulkMessages.ts` → `/api/bulk-messages` |
| Settings card | Admin → Integrations → **MSG91 — SMS and RCS** |
| Screen | Admin → **SMS & RCS campaigns** (`web/src/pages/admin/BulkMessagesAdmin.tsx`) |
| Tables | `ipy_bulk_message`, `ipy_bulk_message_recipient` (migration `236`) |
| Tests | `tests/msg91Bulk.test.ts` |

One **Auth Key** carries both channels. It is saved on the card as a credential (encrypted
like every other), sent in a header, never put in an address, never logged.

## The rules (copied from WhatsApp campaigns on purpose)

It is the same engine shape as `integrations/whatsapp/business/campaigns.ts`, for the same
reason — read the top of that file for the 40,515-message story. In short:

1. Nothing sends until a person approves a number they were shown; a changed count refuses.
2. The audience **and each person's wording** are frozen at approval.
3. Once each — unique `(bulk_id, record_id)`, and one message per phone number.
4. Over 500 people needs a second confirmation. Over **50,000** is refused (WhatsApp's is 5,000;
   this one is higher because the owner asked to reach every record at once — change
   `MOST_WE_WILL_SEND` in `bulk.ts` on purpose if it ever binds).
5. Every person left out is a row with a reason (no mobile, not an Indian mobile, empty field,
   duplicate number, asked not to be messaged).
6. **"Everyone" must be said out loud** (`audience.everyone = true`). An empty audience is
   refused, never read as everybody.
7. Opt-out is checked at approval **and again just before each batch leaves**, in
   `ipy_channel_optout` under channels `sms` and `rcs`. (`ConsentChannel` now lists them.)
8. API keys are blocked from these routes entirely.

Different from WhatsApp, on purpose:

* **Faster:** up to 200 people a minute (MSG91 takes a batch in one call), not ten. Pause stops
  it within a minute.
* **Promotional hours:** only 9 am – 9 pm India time (TRAI). Outside that a running campaign
  waits; nothing is dropped.
* Nothing is scheduled. A person approves, with the count in front of them.

## What a message is

* **SMS** — India only sends **DLT-approved templates**. A campaign names the MSG91 template id
  and says what fills each blank (`name = {{first_name}}`; `{{label}}` is the record's name).
  The sender id and the wording live in the template at MSG91. A record whose field is empty is
  **skipped**, never sent a hole.
* **RCS** — free text with `{{field}}` tokens, sent as an RCS text to the agent's project.
  It is **not** silently turned into an SMS when the phone cannot receive RCS.

Only Indian mobiles (`+91`, starting 6–9) are messaged. Other countries have their own rules and
are skipped with the reason "not an Indian mobile number".

## What was deliberately NOT done

* **Workflows and sequences do not send SMS yet** (`send_sms` task and the sequence `sms` step
  still only log). Automated sends are exactly the shape of the rule behind the 40,515-message
  incident; they need their own decision.
* **No inbound STOP handling for SMS/RCS.** Replies need an MSG91 inbound number/webhook. Until
  then, opt-outs are recorded by hand or import (`recordConsent`, channel `sms`/`rcs`), and
  every promotional template must carry the DLT opt-out wording MSG91 requires.
* **No delivery reports yet.** "Handed to MSG91" is what the CRM knows. Delivered/read lives in
  MSG91 → SMS → Logs and → RCS → Logs.

## Going live (the part only the account owner can do)

1. MSG91 → complete **KYC**.
2. Register on **DLT** (Jio/Airtel/Vi portals), get a **header (sender id)** and a
   **promotional content template** approved; add it in MSG91 → SMS → Templates and copy its id.
3. For RCS: create the agent in MSG91 → RCS, wait for approval, copy the **project id**.
4. Add funds.
5. Admin → Integrations → MSG91: paste the Auth Key, the SMS template id and the RCS project id,
   save, switch on, **Test connection**.
6. Send one campaign to a list of yourself first (a saved list of 1–3 records), then the rest.

"Test connection" asks MSG91 for the RCS wallet balance — read-only, sends nothing, costs
nothing. It proves the key is accepted; it cannot prove a template is approved.

## Checks that were run and what they could not cover

Unit tests cover every rule above that has no database (audience verdicts, "everyone" guard,
promotional hours, number shapes, wording, MSG91's error shapes). **No live message was sent**
and the screen has not been driven against a real MSG91 key, because the account has no
approved template, sender id or RCS agent yet — so the exact request shapes are checked against
MSG91's published API docs, not against its servers.
