# WhatsApp — the whole story

Everything about WhatsApp in this CRM. Read it before touching anything under
`integrations/whatsapp/`, the Chats screen, templates, campaigns or the reports.

The rules that hold everywhere live in [`CLAUDE.md`](CLAUDE.md); this file is the detail.

---

## WhatsApp is gone. Do not rebuild it without being asked.

**Removed on 2026-09-17, on the owner's instruction:** *"whatever whatsapp thing we have
in our codebase and over in crm.ipropy.com just completely rip it off and I will later on
begin working at it after a fresh start some time later."*

All three doors are now shut. What went: the Meta Cloud API provider and service, the
`wa.me` hand-off and its `ipy_device_send` queue, the auto-reply, the broadcast engine,
the new-lead greeting, the WhatsApp Web accounts, the record's WhatsApp Chat tab, the
compose modal's WhatsApp side, the template editor's WhatsApp tab, the `meta_whatsapp`
integration card and guide, the `send_whatsapp` workflow step, the `whatsapp.*` settings
and the `WHATSAPP_*` environment variables. `.github/workflows/remove-whatsapp.yml` is the
production half — seeding is create-only, so the live rows had to be deleted by hand,
and it copies everything to `*_removed` tables before it does.

**What deliberately stayed, and why:**

* **`ipy_conversation` / `ipy_message` rows on channel `whatsapp`.** Real conversations
  with real customers. The Inbox still reads them; it just cannot send on that channel.
  `Channel` in `shared/src/types.ts` therefore still lists `'whatsapp'`.
* **`ipy_channel_optout` rows on channel `whatsapp`.** Somebody asked not to be messaged.
  That request outlives the integration, and `ConsentChannel` keeps the value.
* **The capabilities `whatsapp.send` and `whatsapp.templates`.** They gate SMS, RCS and
  email templates too, and they are stored on live profile rows — renaming the keys would
  mean rewriting those rows to keep the team's access. The *labels* say "Send messages"
  and "Manage message templates" now.
* **The `whatsapp_number` field on leads**, and the "WhatsApp" options in Lead Source and
  Activity Type. Those are a phone number and two business facts, not the integration.
  Deleting a seeded field drops its column; deleting a dropdown option orphans every
  record that chose it.
* **`wa.me` share buttons** — Share Links, the matching tab, the shared-matches page and
  the mobile swipe. Those are a link a *person* taps to send a property from their own
  phone; nothing in the CRM sends anything. Say so before removing them, because that is
  how a unit reaches a buyer today.
* **Every table.** No migration drops anything, so a rebuild later starts from data.

**A door was already removed once before, on 2026-08-18 (migration `060`).** A linked phone,
the WhatsApp Web mechanism, run through a `wa-bridge/` process: the rep's own number, no
approval, no fee, against WhatsApp's terms. It worked, and working is what killed it —
pointed at a real handset it imported 821 chats, which is a person's private life in a
business database. Scoping them per-user (migration `056`) hid them from colleagues, and
holding them was still the wrong thing.

Removed with it: `ipy_wa_link`, `wa_link_id`/`claimed_at`/`priority`/`message_id` on the
queue, `private_to_user_id` on conversations, the bridge endpoints, the WhatsApp sidebar
page and the `whatsapp_linked` provider. The owner asked for a clean slate so it can be
rebuilt deliberately later.

### The QR-code road was built, and then removed

**2026-09-17:** the owner sent a specification for *Agent Linked WhatsApp* — each rep
links their own number by scanning a QR code, sends and receives inside the CRM. It was
built, under `integrations/whatsapp/agent/`, with a Baileys socket per agent, the linked
device's keys in the database, a history policy, and a Chats screen.

**2026-09-19 it was removed, on the owner's instruction:** *"remove that whatsapp agent
base QR code scan connection that is there in settings there is tab just completely rip
that off, and there is chats dropdown ... remove that chats thing too."* The reason it
could never have stayed is the one already written down when the first version went in
2026-08-18: QR-linking a personal account is WhatsApp's linked-device mechanism, it is
against their terms, and it risks the rep's own number. **The official business route
below is the only WhatsApp road now.** Do not build the QR one a third time.

What went: `integrations/whatsapp/agent/` (authState, claim, historyPolicy, service,
session, store), `api/routes/whatsappAgent.ts` and its `/api/whatsapp` prefix, the boot
hooks in `index.ts`, `web/src/components/WhatsAppLink.tsx` and the Settings → WhatsApp
tab it lived on, `web/src/pages/Chats.tsx`, every `api.whatsapp*` client call, and the
`@whiskeysockets/baileys` and `qrcode` dependencies.

**One file survived the deletion and matters: `integrations/whatsapp/matchContact.ts`.**
It was `agent/matchContact.ts`, and `business/thread.ts`, `business/inbound.ts` and
`business/send.ts` all import it — matching a number to a contact by its last ten digits
is the official road's job too. It moved up a directory rather than being deleted with
its neighbours.

**What deliberately stayed:**

* **Every table**, including `ipy_wa_account` and the messages the agent road wrote.
  No migration drops anything. `ipy_message.route` still reads `'agent'` on those rows,
  and the contact's WhatsApp tab still says which phone each one went through.
* **WhatsApp templates** — asked for by name (*"whatsapp template to keep"*). Admin →
  WhatsApp Templates is untouched and belongs to the official route anyway.
* **`/chats`**, which now renders `BusinessChats` — the official number's shared inbox.
  It is no longer a header tab and no longer in the drawer; the WhatsApp icon beside a
  phone number is the way in, and the page says so itself when no provider is connected.

**`HeaderTab['kind']` no longer has `'chats'`, and production's saved arrangement still
names it.** `arrangeHeaderTabs` therefore drops any kind this build does not have, rather
than rendering a tab that goes nowhere — pinned by `tests/headerTabs.test.ts`. Anything
fixed *added* to that header later still needs its own append line, for the opposite
reason: an arrangement saved before a page existed cannot have meant to leave it out.

**Two WhatsApp controls, and they deliberately go to different places** — the owner asked
for this on 17 September. The small **icon beside a number** stays inside the CRM: the
composer over the record where there is one, `/chats?to=…` otherwise, where a manager can
read the thread and the timeline records it. The labelled **button on the record header**
leaves: `https://api.whatsapp.com/send/?phone=…` through `openExternal`, so the rep writes
in WhatsApp itself. Only that button leaves. `openExternal` and not a plain link, because
`window.open` returns null inside the phone app and the tap does nothing at all.

**A destination that lives only in the header's module switcher is invisible on most
screens** — the switcher is `lg:block`, so below 1024px it is not on the screen at all.
Anything a rep needs on a laptop or a phone goes in the drawer too.

---

## The official WhatsApp Business route, through a BSP

**18 September 2026, the owner:** *"The feature of Personal whatsapp Agent wise not use to
me, i need Bussiness API Integration."* So the CRM now has both, and the official one is
what the business will use. The agent-linked route is **not** deleted — his own §13 asks
for the two to stay separate with the route recorded on every message, and `ipy_message.route`
('business' | 'agent', migration `158`) is that record.

**One contract, four adapters, and nothing hard-coded to a vendor**
(`integrations/whatsapp/business/`). `WhatsAppBusinessProvider` extends the same
`WhatsAppProvider` contract in `providers/types.ts`, which outlived the agent route that
first needed it: a provider asked for a capability it lacks throws `NotSupportedError`
rather than returning quietly, because a send that silently does nothing is the failure
mode that let 40,000 birthday messages queue unnoticed.
Moving from AiSensy to Gupshup is an admin switching an integration card; no conversation
moves, because the history was never the vendor's to hold — provider ids sit *beside* the
CRM's own ids, never instead of them.

**What each adapter can do is what its own live documentation says, checked on the day:**

* **Meta Cloud API** — `POST /{phone-number-id}/messages`, text, media, templates, status
  webhooks, mark-read. The graph version and base URL are **settings, not constants**:
  Meta retires versions on a schedule, and a hard-coded one is a dead integration on a date
  nobody has in their calendar. Written from knowledge and **not verified against the live
  reference from here** — `developers.facebook.com` is blocked by this container's egress
  proxy — so the Test Connection button is what proves it against the real account.
* **AiSensy** — `POST https://backend.aisensy.com/campaign/t1/api/v2`, which sends an
  **approved template and nothing else**. So its adapter declares `templates` and *not*
  `text`, and a rep typing a free reply is told before they press send rather than after.
* **Gupshup** — `POST https://api.gupshup.io/wa/api/v1/msg`, form-encoded, key in an
  `apikey` header: text, media and templates, and a template list to sync.
* **whatsmarketing.in** — **the one the business actually bought**, and it has a real
  adapter now (`business/whatsMarketing.ts`), written from their own API documentation
  v1.0, which the owner sent on 19 September 2026. Until then it was the Cloud-API-shaped
  guess, and **the guess was wrong in four ways**: the token goes in the form body as
  `apiToken` rather than a Bearer header, requests are form-encoded rather than JSON, the
  paths are `/whatsapp/send` and friends rather than `/{version}/{phone-number-id}/messages`,
  and — the expensive one — **a refused message answers HTTP 200** with `{"status":"0"}`.
  An adapter that trusts `res.ok` records every refusal as a send, and a rep watches a tick
  appear for a message the customer never got. `tests/whatsMarketing.test.ts` opens on that
  case for exactly that reason.

  **Their replies are polled, not pushed** (`business/pollInbound.ts`, every
  scheduler tick). This is not a nicety: the CRM works the 24-hour window out
  from its own record of the last inbound message, so with nothing ever
  arriving `window_expires_at` is never set, every conversation reads as
  permanently shut, and **a rep cannot reply to a customer who has just
  written** — the composer offers templates only and `sendOnBusinessNumber`
  refuses the send. That was found the moment the owner connected it and tried.
  The poller reads `/whatsapp/subscriber/list` (ordered by most recent) then
  `/whatsapp/get/conversation`, and hands each message to `receiveInbound` —
  **the same function the webhook calls**, so there is one place that matches a
  contact, opens the window and notifies an agent, and so re-reading a thread
  is free. Two things in it are pinned by `tests/whatsMarketingPoll.test.ts`
  because they fail silently: a row from `sender: 'bot'` must never be replayed
  as something the customer said, and **identity decides what is stored, never
  the clock**.

  That second one cost 20 September 2026 and is the rule to keep. The poller
  remembered when it last looked and skipped anything stamped earlier — correct
  only if a message becomes readable the moment it is stamped, and
  WhatsMarketing's does not. The owner's "hey" was stamped 07:27:30 UTC, was
  still invisible to a visit at 07:45, and first appeared at 07:48. By then the
  watermark was past it, so it was skipped, and would have been skipped for
  ever. **The poller reported success every single minute throughout.**

  Widening the window was tried twice — fifteen minutes, then forty-five — and
  both are the same bug with a longer fuse: any window is a bet on somebody
  else's worst lag, and losing it is silent. So the window is gone. Every visit
  offers everything it can see and `receiveInbound`'s unique insert on the
  provider message id decides what is new. Identity is a fact; a timestamp is a
  guess about another company's clock. Two bounds keep it cheap rather than
  honest-but-expensive: `HISTORY_FLOOR_DAYS` (a *floor*, measured from now and
  a week back, so it can never creep past something unseen — it exists only so
  a vendor returning a year of history does not import a year) and a `seen`
  set seeded once per process from `ipy_wa_webhook_event`, which makes both the
  repeat visit and the restart free. `seen` is an optimisation and never the
  guarantee.

  **Store everything, announce what is fresh.** `ANNOUNCE_WITHIN_MS` in
  `business/inbound.ts` is six hours: a message older than that is written to
  the inbox, the record and the timeline, and rings nobody. Without it the
  first visit after a vendor is connected — or after its lag catches up — buzzes
  the team's phones about conversations from Tuesday, and a team that switches
  notifications off is how the useful ones get lost.

  **What a customer actually sends, read from their live API on 20 September
  2026 rather than from anybody's documentation:** WhatsMarketing store the
  *entire Meta webhook envelope* against an inbound row —
  `{object:'whatsapp_business_account', entry:[{changes:[{value:{messages:[…]}}]}]}`
  — and a small `{messaging_product, to, text}` against an outbound one. A
  customer's row says `sender: "user"`; ours says `sender: "bot"` with the
  agent id in `agent_name`. Their PDF says none of this, which is why six of
  the owner's messages read as unreadable while the poller reported success
  every minute. The envelope goes to `metaCloudProvider.parseWebhook`, the
  parser the CRM already has for exactly that shape — **one parser, so the
  webhook door and the polling door learn a new message type together.** A
  copy would drift, and the way it drifts is that one of them quietly stops
  understanding a customer.

  **`handle` is a matching key and must never be a destination.** Every
  free-text reply this CRM ever attempted failed on that, and the error said
  something else entirely. `ipy_conversation.handle` is the last ten digits on
  purpose — it is what matches a contact whose mobile might be stored as
  `9891222206`, `+919891222206` or `0 9891 222206` — and `sendOnBusinessNumber`
  was handing it to the provider as the number to send to. WhatsApp read ten
  digits as a different person from the `919891222206` who had just written in,
  found no session for them, and refused with *"Sending message outside 24 hour
  window is not allowed. You can only send template message to this user."*
  Which reads exactly like a window bug and is not one: read off production on
  20 September 2026, `window_expires_at` was the following morning and the send
  was refused anyway.
  Migration `163` adds `ipy_conversation.wa_id`, WhatsApp's own id, written from
  every inbound message so threads that predate it heal themselves the first
  time their customer writes again. `dialableNumber` in `business/send.ts`
  prefers it, then a number the caller already gave in full, then the record's
  `country_code` + `mobile` through `toInternational` — and **refuses rather
  than assuming +91**, because a silent Indian default sends an NRI buyer's
  message to a stranger and cannot be taken back.
  The two sends that did work, on 18 September, went to handles that happened
  to be longer than ten digits. That is the whole reason this looked
  intermittent.

  **The same rows carry delivery receipts for what *we* sent**, also
  undocumented: `message_status`, `delivery_status_updated_at`, `read_time`
  and `failed_reason` on a `sender: "bot"` row. `readOutboundStatus` hands
  them to `applyStatus` — the webhook's own function, which only moves a
  status forward and claims each one once, so re-reading a thread every minute
  is free. Without this the CRM knows only that it handed a message over, and
  **a campaign report could count attempts and never arrivals** — "sent 900"
  meaning nothing at all.

  **Their template listing contains a live Meta access token**, in
  `template_json` and `raw_data`, and on 20 September it reached a GitHub
  Actions run log before anybody noticed. That log was deleted and the token
  must be treated as exposed. `test-whatsmarketing.yml` now pipes every
  response through a `redact` filter — the credential-bearing fields by name,
  plus Meta's `EAA…` prefix generically. **A vendor's response is not ours to
  trust with a log**, and this is the second time a third party's payload has
  carried something it should not; assume the next one does too.

  **The diagnosis came from the poller's own report, not from the vendor.**
  `whatsapp.last_poll` carries the handle the newest visible message came from,
  how many were already held, and what was dropped, by cause. Before that,
  "stored 0" covered five different failures. The raw-thread probe was tried
  first and cannot work: it needs a repository secret that is not set, and the
  live key exists only encrypted inside the CRM — printing a credential to
  fetch a diagnosis is the wrong trade.

  **A template row carries two ids and their documentation names neither as
  the one to send with.** `template_id` is Meta's long id
  (`1574812586925817`); `id` is their own row (`340813`). The adapter sent
  Meta's, on the strength of the send parameter sharing its name, and on
  20 September their API answered *"Message template not found."* about a
  template that had synced from them minutes earlier — a red bubble in front
  of the owner. Both are kept now (`otherId`), and `sendTemplate` retries with
  the other one **once, only on that exact refusal**: a blanket retry would
  double every real failure, and this one is narrow enough that the worst case
  is a second refusal nobody sees. When it works the log says which id did it
  — `whatsmarketing accepted the other template id` — and **that is the line
  to come back and write down here**, because it is the only way this stops
  being a guess.

  **`org.country_code` (migration `164`) is the other half of the dialling
  rule.** Refusing a number with no country code is right — `toE164` assumes
  India, and an unseen Indian default sends an NRI buyer's message to a
  stranger — but on 20 September the owner met the other end of it: most of
  the 22,988 contacts were imported with a ten-digit mobile and no
  `country_code`, so **every one of them was unreachable**, refused before the
  provider was called. What the warning is about is a default *nobody can
  see*. This is a row with a label in Admin → Settings, seeded `91`, and a
  contact carrying its own code still wins over it.

  **And the refusal after that one is not ours, which is the point of writing
  it down.** The owner sent the same template twice on 20 September: 10:52 UTC
  answered *"Message template not found."*, and 11:00 UTC reached Meta and came
  back *"(Error Code : 131049 )In order to maintain a healthy ecosystem
  engagement, the message failed to be delivered."* — read off production, not
  from the screen. **131049 is Meta limiting how many marketing messages one
  person may receive**, and nothing on this side lifts it: the customer writing
  in first (which opens the 24-hour window) or a utility-category template are
  the only two ways past it. What changed between the two attempts is **not
  established** — either the template-id retry reaching production or a sync
  refreshing the minute-long `templateCache` would produce it, and both are
  possible in that gap.

  `business/whyItFailed.ts` puts a plain sentence in front of the codes we
  recognise and **keeps the provider's own words after it**, because the
  original is what a support conversation with the vendor is about and an
  unrecognised code must stay readable. An unknown code is passed through
  untouched rather than guessed at (`tests/whyWhatsAppRefused.test.ts`).

  **Their `category` is useless for this and it looks useful.** All ten synced
  templates read `general` — WhatsMarketing's own word, from `check_wp_type` —
  so the CRM cannot tell a marketing template from a utility one, which is
  exactly the fact 131049 turns on. Do not read that column as Meta's category.

  Two more things worth knowing before touching it. Their templates are addressed by a
  numeric `template_id` from their dashboard, so a name is resolved through their list
  endpoint first and a miss is refused *naming the template* rather than posting a blank id.
  And **their documentation has no inbound webhook section at all** — §17 says delivery
  webhooks need their support team. So `parseWebhook` reads the two shapes it can recognise
  without inventing one, and **logs the body** of anything else rather than dropping it:
  an unrecognised delivery has to become a fact somebody can read, not a customer's message
  that quietly never arrived. Until they enable a callback, replies do not reach the CRM.

  `cloudCompatibleProvider` stays in `resellers.ts` — it is still the right answer for the
  next reseller that genuinely does proxy the Cloud API.

**The webhook is `/api/webhooks/whatsapp/:slug`, one door per provider**, and every delivery
is verified by the adapter that owns it — Meta's `hub.challenge` handshake and an app-secret
signature over the **raw** body (re-serialising the parsed JSON changes the bytes and reads
exactly like a wrong secret), a constant-time shared token for the resellers. It answers 200
first and works second, because every provider retries anything it does not hear a prompt
200 for.

**Three rules the inbound path is built on**, all pinned by
`tests/integration/whatsappBusinessWebhook.test.ts`:

* **Seen once.** `ipy_wa_webhook_event` claims a delivery by unique insert — the insert *is*
  the check, because a SELECT-then-INSERT lets two racing deliveries both through. Meta
  retries for days; without this the agent is notified twice for one sentence.
* **Never a silent duplicate contact.** An unknown number opens a thread with no record
  attached and waits for create / link / ignore.
* **A status only moves forward.** Providers deliver them out of order, and a late "sent"
  would otherwise un-read a message the customer has plainly read.

**One trap this cost a test run to find, and it is rule 8's cousin:** a parameter used both
as a timestamp and as the left side of `+ interval` deduces two types and Postgres refuses
the whole statement — *"inconsistent types deduced for parameter $2"*, at runtime, with a
customer's message in hand. Every position is `$2::timestamptz` now.

**Built so far:** the provider layer, the four adapters, the webhook (verify, dedupe,
inbound, status), sending text and templates with the 24-hour window and opt-out enforced
*before* the provider is called, the four integration cards with their secrets encrypted,
and `GET /api/whatsapp-business/status` so a screen can ask what the live provider can
actually do before offering a control.

**A seeded integration card with no `PROVIDER_FIELDS` entry is a card nobody can fill
in.** The four rows in `db/seed/automation.ts` existed for a day while
`admin/IntegrationsAdmin.tsx` had no fields and no guide for them, so the Integrations tab
showed four WhatsApp cards with nothing to type into — which reads exactly like the
feature not being there, and is how the owner reported it. Both halves are in now, and
every key named is one the adapter actually reads (`metaCloud.ts`, `resellers.ts`): a
field the server never asks for is worse than a missing one, because somebody fills it in,
presses Test, and the failure says nothing about why.

**The Chats screen and the contact tab are on this route now** (`pages/BusinessChats.tsx`).
Three columns: the queue, the conversation, and the CRM contact **linked rather than
copied** — a lead's budget repeated on this screen is a second copy to keep in step, and the
first time the two disagree nobody knows which is true. `/chats` **is** the business inbox now — the per-agent
screen it used to fall back to was removed on 19 September 2026. It is no longer a header
tab; the WhatsApp icon beside a phone number is the way in.

**It wears the split view's clothes, and that was an instruction.** 20 September 2026,
against a screenshot of the leads page: *"you've got this page and the beauty of this page
right, similar beauty and type I want for my whatsapp module page also"*. So the queue row
**is** the split view's row rather than something like it — the open one marked by a `span`
and not a `border-l` (two `border-*` utilities on one row let Tailwind's stylesheet order
pick the colour, and the marker came out slate on slate once), a bold name, the last
message under it, and the time above one chip on the right. Two lines each side; two chips
on two lines with two different right edges is what makes a queue look ragged.

The conversation header is the record header: avatar, one name line that truncates rather
than wraps, a fact strip under it that never wraps, and the actions as the same grey
circles that fill with their own colour on hover. It was five bordered buttons and two
dropdowns wrapping onto a second row, which is what he was looking at when he asked.
`ACTION_BASE` / `ACTION_REST` / `ACTION_CIRCLE` moved out of `IpropyWorkspace.tsx` into
**`lib/actionCircle.ts`** for the reason this repo keeps re-learning: a second copy of
three class strings is a second thing to keep in step, and the first time they disagree
the same button looks different depending on which page you arrived from. The `*_REST`
string stays separate from the shape because a button that is *on* needs its own
background, and a later `bg-*` in the same class list does not win.

**The whole contact sits beside the conversation now, and one set of
components draws it everywhere.** 20 September 2026, the owner: *"I don't
need it there instead all those details … I do not want to switch screen
during whatsapp chat and then and there I want all info of that record
everything in the right pane."* The pane used to hold two summary cards and a
link, so answering "what is their budget" meant leaving the chat and coming
back to two new messages.

Three pieces came out of `IpropyWorkspace.tsx` rather than being copied, which
is the whole point:

* **`lib/recordPanes.ts` — `useRecordPanes(module)`** decides which fields a
  record's header strip and field cards show: Admin → Split View first, the
  Layout Designer second, the module's own flags last. **No screen names a
  field.** A copy of this reasoning would drift, and the way it drifts is that
  one screen learns about a new Split View setting and the other does not, so
  the same record reads differently depending on where you came from.
* **`components/RecordBlocks.tsx` — `FieldBlock`, `NotesPanel`,
  `HeaderFieldStrip`.** The strip owns its own `ResizeObserver` and the
  count-what-fits rule (invisible rather than unmounted, or the measurement
  that produced the count stops being true). `data-testid="header-fields"` is
  still on it, so `e2e/splitViewHeader.spec.ts` measures the same element.
* **`components/ChatRecordPane.tsx`** puts those cards in the Chats right
  column, on **the same query keys** the record page and the split view use —
  so an edit made in the chat invalidates the record page, and opening one
  warms the other.

The chat header carries the same strip (`ChatHeaderFields`), which is a
component of its own only because `useRecordPanes` is a hook and the header
renders inside a conditional.

**Unproven in a browser**, like everything else on this screen: the Chats
pane only renders when a provider is connected and none is on a developer's
database. What is proved is that the split view is unchanged — typecheck,
967 unit tests and the full build are green, and its specs still find the
strip they measure.

**The inbox is shared, and who sees what is the rule that matters.** An admin sees every
thread; everybody else sees their own and the unassigned queue, and **not** one another rep
is working — two people answering one customer is what a shared inbox exists to prevent.
A manager who needs to read it uses the contact's WhatsApp tab, where the CRM's ordinary
record permissions decide, as everywhere else. Take / assign / transfer / mark unread /
open / pending / resolved are all there, a hand-over tells the person losing the thread, and
the header shows who else is looking (in memory, 45 seconds, because it is true for half a
minute and nobody wants to read it tomorrow).

**Rule 8 again, the fifth time, and an integration test caught it rather than production.**
The inbox list bound the user id even for an admin, whose visibility clause is `TRUE` and
names no parameter — Postgres refuses the whole statement with *"could not determine data
type of parameter $1"*, which on screen is an empty inbox for admins only. The clause and
its parameters travel together now (`visibility()` in `business/inbox.ts`).

**The record's WhatsApp tab finds its thread by number, not only by link.**
`matchContact` attaches a conversation to a record when a message arrives,
which is the right moment to *try* and the wrong moment to depend on: the
contact may not exist yet, two records may share the number, or it may sit in
a field the matcher does not read (it reads `uitype = 'phone'` **and**
`storage = 'column'`, so an admin-created phone field — always `json` — is
invisible to it). On production, 20 September 2026, a thread from 9811533633
sat unlinked beside a contact holding that exact number, and the tab showed
nothing, which reads as WhatsApp being broken. The route now matches
`c.record_id = $1 OR c.handle = ANY($2)`, the handles coming off the record
`getRecord` has already authorised — so nobody reads a thread whose contact
they cannot open, and linking becomes tidiness for the shared inbox rather
than the thing the tab depends on. The empty-array guard matters: an unguarded
`= ANY('{}')` is not an error, it simply matches nothing, and the day somebody
inverts that condition it would match everything.
**And sending from a record takes the link** (`conversationFor` in
`business/send.ts`): a person pressing Send is the one moment all three
failure cases are settled, and `COALESCE` means it never steals a thread that
already belongs to another record.

**The contact's WhatsApp tab shows both roads in one column**, with a line saying which
number each message went through: one customer had one conversation even if it reached them
two ways.

**Approved templates and what fills their blanks** (`business/templates.ts`, Admin →
WhatsApp Templates). Meta approves the wording and freezes it, so the only CRM decision is
what goes in each `{{n}}` — and that is **metadata, not code**: a mapping names a field
through the same Field Manager every screen reads, checked against the module when it is
saved rather than when a customer is waiting. The other three sources are the agent
sending it, the business name (`org.name`, the one the header reads) and a literal.

Three rules, pinned by `tests/integration/whatsappTemplateMapping.test.ts`:

* **A sync never touches a mapping.** The provider owns the wording, status and category;
  the CRM owns the blanks. `ON CONFLICT DO UPDATE` deliberately omits `variable_map`,
  because syncing to pick up one new template must not empty the other twelve.
* **A picklist fills with its label**, never its stored value — those two have drifted on
  this database before, and the customer would read the wrong one.
* **An empty blank is named, not sent.** WhatsApp refuses the message anyway, and "failed"
  sends a rep hunting; `{{2}} field:email is empty on this record` is fixable in ten
  seconds. The composer previews the filled text before it goes, because a positional
  template is unreadable in the abstract.

**The nine templates seeded before the removal are still in the database**, and they map in
the *old* vocabulary (`contact.first_name`). `resolveTemplate` reports those as "needs
setting again" rather than slicing the prefix off blindly — which would have produced
nonsense, looked up nothing and sent a blank. Their wording is still useful, so they are
listed for re-mapping rather than deleted.

Parameters are filled **server-side** through `recordService`: a screen that posted them
back could send a customer a budget its user is not allowed to read.

**The icon beside a number is a composer now** (`components/WhatsAppComposer.tsx`). The
Chats screen is the right place to *work* an inbox and the wrong place to answer one
question about the person already on screen, so with a record in view the icon opens a
small dialog over it: the last few lines of the thread, a box, Send. Provided by
`WhatsAppComposerProvider` beside `CallDispositionProvider` on the record page and the
split view, so it knows which record the number belongs to.

Four rules it holds to:

* **Nothing is offered that WhatsApp would refuse.** `composerMode()` in `lib/whatsapp.ts`
  needs both halves — inside the 24-hour window *and* a provider that can send free text.
  AiSensy can never, window or no window, so there the box is replaced by the template
  list with the finished wording shown first.
* **Looking writes nothing** (`business/thread.ts`, `GET /threads/by-number`). A
  conversation created on a glance would put an empty thread in the team's shared queue
  for every number anybody hovered over. `sendOnBusinessNumber` creates it, on the first
  message that actually goes.
* **The record is the gate, not the thread.** Messages come back only when the caller
  names a record and `recordService.getRecord` allows it — the same rule as the contact's
  WhatsApp tab. Without one the answer still carries the window state: enough to choose a
  control, nothing to read.
* **With no provider switched on, nothing changes.** `WhatsAppComposerProvider` supplies
  no context until `status.connected`, so the icon stays the link to Chats it is today
  rather than opening a dialog that can only apologise. `e2e/whatsappComposer.spec.ts`
  pins that fallback, because it is what production is running right now and it is easy to
  lose while adding the thing that replaces it.

**The composer itself has never been opened in a browser** — no provider is connected
anywhere this can be tested, so what is proved is the thread lookup
(`tests/integration/whatsappComposerThread.test.ts`), the mode decision
(`tests/whatsappComposer.test.ts`) and the fallback.

`waDigits` moved from `components/WhatsAppButton.tsx` to `lib/whatsapp.ts` for a reason
worth repeating: a component that imports the app's store cannot be loaded by a `node`
test at all, because the store reads `localStorage` as it is constructed. Importing one
helper out of a component pulled the whole store in and broke an unrelated suite.

### Three bugs the owner found in an hour, 20 September

All three were live, and two of them had never run at all.

* **Moving a record between the modules had never once worked.** *"Bug in Move to Lead"* —
  the dialog answered "Lead Status is required" and the record stayed where it was.
  `moveRecord` deliberately drops both modules' stage values (*"Available" is not a thing a
  person can be*) and left the destination to "apply its own mandatory default".
  **Neither module's stage field has a default**: both are mandatory with an empty
  `default_value`, so every move in both directions failed validation, silently, since the
  day it was written. It now sets the destination's **first dropdown option**, read off the
  picklist rather than the word "New" written into the file — a hardcoded value is a move
  that breaks the day somebody edits a dropdown. The stage field is also found by name *or
  column* now, the same `lead_status`/`status` drift as everywhere else.
  `tests/integration/moveBetweenModules.test.ts` moves one each way.
* **Every WhatsApp send died on the opt-out check.** *"Unknown field referenced in the
  request"* is the error handler's wording for Postgres 42703, and the cause was
  `SELECT id FROM ipy_channel_optout` — a table keyed on `(handle, channel)` that **has no
  `id` column and never has**. It is `SELECT 1` now.
  **Why it survived is the part worth keeping:** nothing had ever run it. The composer has
  never been opened against a live provider, and every test that calls
  `sendOnBusinessNumber` expects it to refuse *earlier*, at "no provider is switched on" —
  so the first thing to reach that line was a customer waiting for a message.
  `tests/integration/whatsappSendReachesTheProvider.test.ts` switches a provider on for
  exactly that reason: it is the only way to make those queries execute.
  **The lesson generalises.** A guard that every test trips over is a guard that hides
  everything behind it. Where a path is gated on configuration this CRM does not have in a
  test database, the test has to supply the configuration, not accept the refusal.
* **Click-to-call is not broken.** *"Your phone did not pick that up"* is the documented
  behaviour when the paired handset does not answer, and the desk hand-off it falls back to
  worked — the Log call dialog opened. The real cause is almost certainly the one already
  written down: **every installed copy of the app predates `placeCall`** and will until
  somebody rebuilds and re-installs it, which cannot be done from this container (there is
  a JDK and no Android SDK). The message says that now rather than asking whether the phone
  is switched on, which sends a rep checking a phone that is working perfectly.

### What is actually proved, read off production on 20 September 2026

The owner asked whether the foundation is strong and whether he can stop
opening WhatsMarketing, and said he doubted it. `.github/workflows/whatsapp-audit.yml`
is the answer: read-only, one promise at a time, **and it prints the zeros**,
because a feature that has never once run is invisible from every screen.

What the numbers said:

| promise | evidence |
|---|---|
| a customer's message arrives | inbound rows through to 10:25 that morning |
| a rep replies inside 24 hours | 4 outbound, all `read` |
| the CRM learns what arrived | 4 delivered and 4 read stamps, from the poller |
| a thread finds its contact | 5 of the 6 business threads linked |
| the inbox stays clean | 6 business threads, **0** odd handles |
| a template reaches somebody | **2 attempts, 0 arrived — never once** |
| a photo or document moves | **0 files kept**; nothing has ever gone either way |
| a campaign runs | **0 campaigns have ever existed** |

**The 120 imported personal-WhatsApp threads are correctly invisible.** They
carry group ids (`+120363…`) and malformed handles, and every one of them has
a `wa_account_id`, which is exactly what `listConversations` filters on. Worth
knowing because it looks alarming in the table and is the filter working.

**The ten synced templates genuinely have no blanks** — wording is 119 to 617
characters and not one contains `{{n}}`, so "0 mapped" is correct rather than
unfinished. Checked with `length(body_text)`, since empty wording and wording
with no placeholders both read as zero blanks and mean opposite things.

**Two conversations hold no messages at all.** A send that fails creates the
thread and then throws, so the empty row stays in the team's queue reading
"No messages yet" — the owner saw two of them. Cosmetic, and still a promise
broken: `business/thread.ts` says looking writes nothing.

**Three things still need WhatsMarketing's own dashboard**, so the answer to
*"never open it again"* is **not yet**: a template can only be **read** here,
never written and submitted for Meta's approval; their inbound webhook is
switched off, so replies are polled rather than pushed; and the account itself
— business profile, display name, credit — is theirs.

### Opened in a browser with a provider connected, 20 September 2026

Every line in this file that said *"never opened in a browser"* about WhatsApp
was true until this. A provider **was** connected — Meta Cloud pointed at a
local stub through its own `baseUrl` config, which is why that field being a
setting rather than a constant paid for itself — a customer's message was put
through the real webhook, a reply was sent, receipts came back, templates
synced, and a campaign ran. Six faults came out of it, and **all six were
invisible to 812 unit tests, 661 integration tests and a clean typecheck**,
because every one of them lives past the "no provider is switched on" guard.

* **Every fact in the chat header was invisible.** `HeaderFieldStrip` measured
  with `child.offsetLeft`, which is relative to the nearest *positioned*
  ancestor rather than to the strip. In the split view the two happen to agree;
  in the Chats header the strip sits 390px in, so every field computed as "does
  not fit", all of them went `invisible`, and the header showed a lone `…`. It
  measures from `getBoundingClientRect()` now. **A latent bug the split view
  could never have shown.**
* **The contact's name read "Riya …".** Sharing a row with the assignment box
  and the last-message line, `min-w-0 truncate` made the name give way first —
  three characters of the one thing on that screen that has to be readable. The
  name floors at `9rem`; the last-message line yields instead, and the queue row
  beside it already says the same thing.
* **The strip repeated the two biggest things on the screen.** "Full Name" is
  the heading and "Mobile" is the line under it, and between them they ate the
  whole strip. Both are dropped through metadata — `labelFields` and the phone
  field `useRecordPanes` already finds — never by naming a field.
* **A refused message said "Something went wrong on our end."** The server knew
  exactly why (`whyItFailed` was already writing the reason onto the row); it
  rethrew the raw error, which became an unhandled 500, which the client can
  only render as that sentence. `sendOnBusinessNumber` throws a
  `BadRequestError` carrying the same words now, and the screen refreshes on
  failure so the rep's own message stays in the thread marked NOT delivered with
  the reason under it — which is what WhatsApp does and what the bubble was
  already built to draw. **Before this a failed message vanished off the
  screen entirely.**
* **Two providers implemented template sync and never declared it.** Meta's
  `listTemplates` reads `GET /{waba-id}/message_templates` — the reason the
  setup guide asks for a WABA id — and Gupshup's reads their own list, but
  neither had `templateSync` in its capability set, so the Sync button answered
  *"whatsapp_meta does not hand its template list back"*. It does.
  Pinned in `tests/whatsappProvider.test.ts`.
* **"Reached the phone" counted the customer's own messages.** An inbound row
  is stored `delivered` the moment it arrives, and the Health tile counted every
  status rather than outbound ones — so it read **17 against 8 sent**. A
  delivery receipt is about a message we sent.
* **And the Health page named WhatsMarketing whichever provider was connected.**
  It reads the connected card's own name now.

**The one that would have cost money: a campaign previewed as "Send to 84" with
all 84 rows reading "Will be skipped".** An unmapped blank is unfilled for
*everybody* — WhatsApp refuses a template with a hole in it — and `reachable`
cannot see it, because it counts who has a number. So the approver is shown a
number, approves it, and not one message goes. That is precisely the failure
this whole feature exists to prevent, wearing the feature's own clothes.
`previewCampaign` answers `unmapped` separately now, the dialog says *"Nobody
would get this"* above the sample names rather than below them, and the Send
button is disabled until the blanks are mapped.
`tests/integration/whatsappCampaigns.test.ts` pins both halves — an unmapped
blank is named, a mapped field that is empty on one record is still an ordinary
per-person skip.

**What the walk proved works, first time, end to end:** a customer's message
through the real webhook opens a thread, matches the contact by number, writes
`wa_id` and opens the 24-hour window; a free-text reply reaches the provider and
shows as sent; delivered and read receipts arrive signature-verified and move
the status forward only; a template syncs from the provider and its blanks fill
per recipient; a campaign freezes its audience at approval and sends **exactly
ten a minute** (measured — an earlier "nothing is sending" was the dev server
restarting on every edit and resetting the timer, not a bug); and the messaging
report counts real outbound traffic for the first time.

**The familiarity half, which was the other thing asked for.** The conversation
sits on a tinted canvas so a white incoming bubble reads as a bubble; the date
is one chip down the middle (`dayLabel` in `lib/whatsapp.ts`) instead of a full
date on all forty bubbles from one afternoon, and the bubble keeps the clock
alone. `tests/whatsappDayLabel.test.ts` pins that it compares **calendar days,
not hours elapsed** — 11pm and 1am are different days however close they are.

**How to do this again, because it is the only way these are found.** Point
Meta Cloud's `baseUrl` at a local stub that answers the Cloud API's shapes,
switch the card on, and post to `/api/webhooks/whatsapp/meta`. A guard that
every test trips over is a guard that hides everything behind it; the test has
to supply the configuration, not accept the refusal.

### The Health page was an empty grey box, and the guard is why

**20 September 2026, the owner, against two screenshots** — `/whatsapp/health`
and `/admin/whatsapp`, both showing nothing but a grey rectangle: *"whats wrong
in here dude"*.

Two faults, and the second is the one worth keeping.

* **`whatsAppOverview` counted templates with `body LIKE '%{{%'`.** The column
  on `ipy_whatsapp_template` is **`body_text`**; `body` has never existed. So
  Postgres refused the whole statement (42703), `/overview` answered 500, and
  the screen had nothing to draw. This is rule 8's neighbour — the SQL is a
  string, so typecheck cannot see a wrong column and a unit test with a mocked
  `db.query` accepts any statement at all.
* **A failed request is not a loading one.** The page guarded with
  `if (isLoading || !data)`, and on an error `isLoading` is false while `data`
  stays undefined — so it held its loading skeleton **for ever**. That is why
  the report could only be "what's wrong in here": an empty grey box names
  nothing. It now renders the error, says the rest of WhatsApp is unaffected,
  and prints the reason. **Any screen written as `isLoading || !data` has this
  bug waiting**; the pattern is the finding, not the one page.
  `admin/SharingAdmin.tsx` and `admin/MatchingSetupAdmin.tsx` still carry it —
  left alone because neither has been reported and neither could be checked
  against a failing request from here, but they are the next two to meet it.

`tests/integration/whatsappOverviewLoads.test.ts` runs every query in that
function against a real database and was checked both ways: it fails with
*column "body" does not exist* on the old code and passes on the fix. It
asserts no business meaning on purpose — what broke was whether Postgres would
accept the statement at all.

**And a trap that cost a run on the way in: a SQL comment inside a template
literal may not contain a backtick.** `` -- `body_text` is the column `` ends
the string, and esbuild fails with *Expected ")"* pointing at the next word,
which reads like a broken query rather than a broken quote.

---

## Campaigns: one template, many people, once each

**19 September 2026, the owner: "now start campaigns"** — the next thing in his own order
after the inbox.

**This feature exists under one rule, and the rule is this repo's own history.** On 13 and
16 September a *daily* workflow whose condition list had emptied itself queued 40,515
WhatsApp messages — 20,209 people holding two each — and nobody received one only because
no provider was connected. Luck, not a safeguard. A campaign is deliberately "message many
people", so "refuse to match everybody" cannot be the protection. These are, and each one
is tested:

* **Nothing sends until a person approves a number they have been shown.** The screen has
  no Send button until the preview has run; the button then *carries that number*, approval
  passes it back, and the server refuses a mismatch — so an audience that moved between
  reading it and approving it stops rather than surprises. `audienceVerdict` is pure and
  exported for exactly that reason (`tests/campaignCeiling.test.ts` walks every threshold).
* **The audience is frozen at approval.** One row per recipient in `ipy_campaign_recipient`,
  written then. A saved view widened afterwards cannot grow a running campaign, because
  nothing re-reads the view. Pinned by `tests/integration/whatsappCampaigns.test.ts`, which
  approves, then adds a matching contact, then checks the campaign is still the size it was.
* **Once each**, by a unique index on `(campaign_id, record_id)` rather than by whoever is
  careful — and **once per number**, not per record: two contacts on one husband-and-wife
  handset are one person. Worth knowing that `createRecord` already refuses a second record
  with the same *mobile*, so the way this really happens is an `alternate_phone` matching
  somebody else's mobile, or an import, which bypasses the duplicate check.
* **A ceiling.** Over 500 needs an explicit second confirmation; over 5,000 is refused
  outright. Twenty thousand has been queued by accident here once already, and splitting a
  genuine large campaign costs an afternoon rather than a reputation.
* **Every refusal is a row somebody can read** — opted out, no number, a blank the template
  needed. The birthday messages were invisible until somebody thought to count the queue.
* **Opt-out and the 24-hour window are not re-implemented.** Every message goes through
  `sendOnBusinessNumber`, the one send path, which already refuses both. A refusal marks
  that recipient and the campaign carries on: one person who opted out must not stop the
  other three hundred. An opt-out or a shut window reads as `skipped` (the customer's
  answer); anything else is `failed` (something to look at).
* **Ten a minute, on its own clock** (`startCampaignSending`). Not a throughput decision: a
  campaign approved by mistake has a minute in which somebody can press Pause and only ten
  people have heard about it.

**A campaign sends an approved template and nothing else.** Outside WhatsApp's 24-hour
window nothing else may go, and a campaign by definition reaches people who are not in an
open conversation. The blanks are filled per recipient by `resolveTemplate`, **read as the
person who approved it** — so a campaign cannot put a value in front of a customer that the
approver was not allowed to see. A template with an unfilled blank is skipped and named,
never sent with a hole in it.

**Deliberately absent: a schedule.** A campaign that fires itself at nine in the morning is
precisely the shape of the rule that caused all this. A person approves it, with the count
in front of them. Building one is `whatsapp.send`; **approving one is
`whatsapp.templates`** — writing a campaign and deciding it goes to nine hundred people are
not the same decision.

Migration `161`. Admin → Campaigns. **Never exercised against a real provider**, like
everything else on this route: what is proved is the ceiling, the freeze, the
once-per-number rule, the skip reasons, and the screen refusing to offer a Send button
before a preview (`e2e/campaigns.spec.ts`). Reports followed on 20 September — see
**Reports** below.

---

## Photos, documents and voice notes

**The rule this phase exists for is one line of his specification: the CRM's history must
never depend on the provider's dashboard.** A webhook hands over a media id that expires,
or a URL that needs the account's own token. A CRM that stores either has a photo album
that empties itself — the picture a customer sent is gone the day the business changes
vendor, silently, with nothing that looks like an error until somebody opens an old chat
and finds a broken square.

So an inbound file is fetched **once, now**, and stored as an ordinary `ipy_attachment`
with `category = 'whatsapp'` — the same row a file dragged onto the record gets. It
appears on the contact's Files tab, it gets the image pipeline's derivatives, and it
survives every vendor decision made afterwards. The provider's own id stays *beside* the
CRM's in `ipy_message.media`, never instead of it: it is what a support conversation with
the vendor is about, and it costs one key.

`keepInboundMedia` runs **after** the message row is committed and never throws
(`business/media.ts`). Collecting a 15MB video is a round trip to the vendor, and a
provider that does not hear a prompt 200 sends the whole delivery again — so a fetch that
fails leaves the message and its caption standing rather than losing both and earning a
retry that delivers the conversation twice. Pinned by
`tests/integration/whatsappMedia.test.ts`.

**Going out, the two halves of the world disagree and neither is a choice:**

* **Meta takes an upload.** `uploadMedia` posts the bytes as multipart, Meta answers with
  its own id, and `sendMediaById` sends that. Nothing of the customer's is published. Two
  traps: the part must be a real `Blob` with a name (a bare Buffer is sent as a plain
  field and answered 400), and the lookaside URL Meta hands back for a *download* still
  needs the Authorization header — fetching it without one answers 401, which reads
  exactly like a wrong access token rather than a missing header.
* **Every reseller fetches a link** and none of them offers an upload. So the CRM has to
  publish the file where they can reach it: `GET /api/public/whatsapp-media/:id`, signed
  with an HMAC over the id **and** the expiry so neither can be edited, valid fifteen
  minutes, `Cache-Control: private, no-store`, and through `applyFileSecurityHeaders` like
  every other byte-serving route. Not a row in a table — there is nothing to look up later
  and nothing to revoke that expiry does not already cover. It is a real exposure for that
  window, it is the vendors' design rather than this one's, and it is the strongest
  argument for Meta direct of the four.

**A file is named by attachment id, never by URL.** `POST /send` takes `attachmentId`;
a caller who could name any link could make the CRM fetch and republish whatever it can
reach. The sender must also be able to *view* the record the file hangs on
(`assertMaySendFile`), which is what stops a rep forwarding a document off a lead they
cannot see.

**WhatsApp's ceilings are lower than people expect** and are checked before the provider
is called: 5MB an image, 16MB audio or video, 100MB a document. A file over them is
refused with its real size named — "will not carry a video over 16MB, and this one is
90MB" — rather than failing two minutes later as a vendor error code. The limits are from
knowledge, not from Meta's page (blocked by this container's proxy), and being slightly
low is the cheap direction to be wrong in.

**One renderer for all three screens** (`components/WhatsAppMedia.tsx`): the Chats inbox,
the contact's WhatsApp tab and the composer. Three copies drift, and the way they drift is
that one keeps rendering the vendor's expiring URL while the others moved to the CRM's
copy — a photo that shows on one screen and is broken on another, months later, for
reasons nobody can reconstruct. `readMessageMedia` (in `lib/whatsapp.ts`, so a `node` test
can reach it without the store) returns null without an `attachmentId` for the same
reason: a row carrying only the vendor's id renders as nothing rather than as a link that
works today.

**Never built and worth knowing:** nothing here has been exercised against a real
provider, because none is connected. What is proved is the storing, the signing, the size
refusal and both transports against a stub
(`tests/integration/whatsappMedia.test.ts`, 8 tests).

---

## Sending a unit from the chat, and chasing them about it

**Both halves already existed and neither is reimplemented** (`business/share.ts`). A share
link is `core/sharing/shareLinks.ts`, which mints a fresh token every time on purpose so a
view count means something and revoking one buyer's link does not revoke another's. A
follow-up is `core/workflow/followUp.ts`, the one definition of "chase them on `<date>`" —
the date on the record, a note in the timeline, a notification to whoever owns the lead. A
chat is not a reason to grow a second of either.

What is new is the join, and the rules in it:

* **The message is composed on the server, never in the browser.** The facts come off the
  property through `recordService`, so a rep who cannot open a unit cannot send it and a
  screen cannot post a link to a floor its user was never shown. `shareMessage` is
  exported and tested because the wording *is* the product here: the rep's own line, the
  unit, then only the facts somebody decides on — configuration, locality, size, price,
  status — and the link **last and alone**, because WhatsApp previews a link it can see
  the end of and nobody taps one buried mid-sentence. It also has to still say something
  when a property has almost nothing filled in, which is what both live properties look
  like today.
* **A send that fails revokes the link it minted.** This is the ordinary path, not a rare
  one: outside WhatsApp's 24-hour window a free-text message cannot go at all, so without
  the cleanup every refused attempt would leave a working link to this morning's draft
  floor behind it. `tests/integration/whatsappShareProperty.test.ts` is mostly about this.
* **The link is labelled with who it went to** (`WhatsApp · <contact>`). The label never
  reaches the visitor; it is what makes the property's Share tab readable a month later,
  because eleven links with view counts and no names is a list nobody can act on.
* **A follow-up needs a record.** A number nobody has claimed has nothing to put a date
  on, and the route says so rather than quietly doing nothing. It also needs *edit*, not
  view: a follow-up writes to the record.

**The picker offers this contact's own matches first** (`components/SharePropertyDialog.tsx`),
through the matching that already exists, with search for the unit somebody has in mind
anyway. The control is a plain date input in the conversation header rather than a dialog —
deciding to chase somebody on Tuesday has to take one tap, and anything longer gets skipped
mid-conversation, which is how follow-ups stop happening.

**Never opened in a browser**, for the same reason as the composer: the business Chats
screen only renders when a provider is connected, and none is. Proved instead against a
real database — the wording, the label, the revoke-on-failure, the permission refusal and
both follow-up guards (7 tests).

**His order for this route is done:** the inbox, templates, media, sharing a unit,
campaigns, and reports.

**The avatar on the row stayed, and a percentage chip that replaced it was rolled back the
same day** (18 September). The owner asked for the chip, saw it on production, and asked for
it back the way it was — so the row leads with the face and its ring again, and the number
rides in the ring's corner. `StrengthChip` was removed with it rather than left behind
unused. Worth knowing before proposing it again: the request and the reversal are both his,
hours apart, and the second is the one that stands.

**The list's pinned quick-actions column is gone** (17 September, owner's instruction), and
with it `e2e/quickActions.spec.ts`. It was one hover-only Call button in a column pinned to
the right of every row. The name column is pinned to the *left* instead — a wide grid
scrolled right left every row anonymous, because the column saying who this is scrolled
away with the rest. `.list-stick-select` / `.list-stick-first` in `styles.css`, pinned by
`e2e/stickyName.spec.ts`.

**The pinned name column was never broken, and the spec that said so was
measuring a different scroller.** 21 September 2026: `stickyName.spec.ts`
walked up from the table until it found *any* ancestor with something to
scroll. The table is `table-fixed w-full`, so with the shipped column widths
the columns shrink to fit and its own container has nothing to scroll — the
walk sailed past it, landed on an unrelated scroller, scrolled that, and the
whole table moved with the pinned cell inside it. Read as a live bug for a
day, including here.
Two halves to the fix, and the second is the rule: it takes the table's **own**
horizontal scroller (nearest ancestor whose `overflow-x` is auto or scroll),
and it **makes the grid wide** by writing column widths into
`ipropy.colwidths.leads` before the page loads, rather than hoping this
browser's saved layout overflows. A skipped assertion proves nothing, and
whether a grid scrolls sideways is a fact about the machine it ran on — the
same rule as the unique markers, applied to a saved layout. Before concluding
a browser is at fault, note that a sticky `<td>` in a `border-collapse` table
was checked directly in this container's Chromium and works.

**And the trap that was hiding in plain sight: `.list-head` says `sticky top-0`, and the
header cell also carried Tailwind's `relative`.** A utility wins on source order, so every
column heading in the CRM was `position: relative` and the whole header row scrolled away
with its rows — reported as "the menu bar is movable". `relative` is gone from the cell (a
sticky cell is a positioned cell, so the resize handle still anchors), and the two pinned
header cells state `position: sticky` themselves under two class names. Both halves are
pinned by two specs: `e2e/listHeaderStaysPut.spec.ts` walks **every** header cell on both
modules — measuring `.first()` was how the bug hid, since the checkbox column was the one
column still pinned — and `e2e/stickyName.spec.ts` covers the two columns frozen to the
left. Both assert the computed style *and* measure that nothing moves; a class that is
present while the cell still slides is exactly the bug.

**If it is rebuilt, the things that cost a night to learn:** history arrives exactly once
during the handshake after a scan and cannot be re-requested; Baileys must be on the
`latest` dist-tag, since a year-old client is refused the moment it asks for a full sync
(presenting as an endless 428 with no QR); history must never be replayed through
`handleInbound`, which would auto-reply to every customer about something they said months
ago; and pacing belongs in the CRM, never in a laptop script that forgets on restart. It
must also decide, up front, that a business CRM has no business storing a rep's personal
chats.

---

## WhatsApp is one destination now

**20 September 2026, the owner:** *"why don't we get most of its things
(whatsmarketing) … inside our CRM to that max … so maybe never ever in this life
I would be required to open whatsmarketing"* — a mixture of their dashboard and
the WhatsApp Web everybody already knows.

Until then WhatsApp lived in four places and three were inside **Admin**, where a
rep never goes: the inbox at `/chats`, plus health, templates and campaigns each
on their own admin tab. Nobody thinks *"I need the campaigns admin page"*; they
think *"I want to do WhatsApp"*. `/whatsapp` is one destination with four tabs in
the order a day runs — **Chats · Campaigns · Templates · Health**.

**Nothing there is a new screen.** Each tab renders the component that already
existed and every old address still works: `/chats` in particular, because that
is what the WhatsApp icon beside a phone number opens. This moved the door, not
the room — a second copy of the inbox would drift from the first, which is the
mistake this repo keeps finding months later.

Two decisions the owner made when asked, both on the day:

* **Everybody sees Chats**, so that tab carries no capability. The inbox already
  decides *what* each person sees — their own threads and the unassigned queue,
  an admin everything — so gating the tab as well would hide the screen from the
  very people whose conversations it holds. Campaigns is `whatsapp.send`,
  Templates `whatsapp.templates`, Health `admin.integrations`.
* **Chats and the record are both the daily driver**, so neither is demoted.

**`HeaderTab['kind']` gains `'whatsapp'`, and the append line matters more than
the tab does.** Every arrangement saved on production predates this page, so an
arrangement that does not name it has not decided against it — without the line
in `arrangeHeaderTabs` it is the one screen nobody can reach, exactly as Chats
was. It is in the drawer too, because the switcher is `lg:block` and does not
exist below 1024px. `tests/headerTabs.test.ts` pins both.

**WhatsApp is a green button on the bar now, not a line in the switcher.**
20 September 2026: *"bring this module right into the top header where that
dropdown of leads and all is there … give it some tacky color maybe green or
something else to highlight to team that this is whatsapp chat system here."*
So `ModuleSwitcher` returns `[]` for the `whatsapp` kind and `Layout` renders
its own `NavLink` beside it, in WhatsApp's own green. It is deliberately **not**
`lg:` like the switcher: the rule this repo already wrote down is that a
destination living only in the switcher is invisible below 1024px, and this is
the screen a rep lives in.

**Reports is folded into that page, on the same instruction** — *"merge this
reports module into this whatsapp module only"*. It is the same `Reports`
component, still carrying its own Records / Messaging split, and `/reports`
still answers so nothing bookmarked breaks. `reports` is out of `KINDS` in
`arrangeHeaderTabs`, so production's saved arrangement — which names it —
drops it rather than rendering a tab beside a button that goes to the same
place. Worth knowing before moving it back: the Records half counts contacts
and units, which has nothing to do with WhatsApp, so "contacts by source" now
lives under a WhatsApp heading. That is his call, recorded rather than argued
with.

**A rep with only Chats sees no tab strip**: one tab is not a choice, and a row
of one reads as something missing. The fallback route goes to the first tab that
person may open rather than a fixed one, so a rep is never bounced to a page they
cannot see.

---

## What WhatsMarketing's API can and cannot do — probed, not assumed

**20 September 2026, the owner:** *"do things so as much as possible things be
done/come from whatsmarketing to here CRM and we need very less or never to open
whatsmarketing ever in life."*

`.github/workflows/discover-whatsmarketing.yml` asked their live API which of
twenty-five candidate endpoints exist. **Every guess 404'd except one.** What
their API actually answers, in full:

| endpoint | what it gives |
|---|---|
| `whatsapp/send`, `/send/file`, `/send/template` | sending |
| `whatsapp/upload/media` | a media id |
| `whatsapp/get/template/list` | the approved templates, **read only** |
| `whatsapp/subscriber/list`, `whatsapp/get/conversation` | inbound, which the poller reads |
| `whatsapp/get/message-status` | delivery receipts |
| `user/package/list` | answers *"You do not have any Team Role yet"* — no plan data |
| `users/team-member/list` | exists, answers `[]` |
| `whatsapp/catalog/list` | exists, answers `[]` |

Everything else tried — phone-number lists, bots, campaigns, broadcasts, tags,
attributes, opt-ins, business profile, wallet, balance, flows, analytics,
reports — returns their 404 page.

**The conclusion is that there is nothing left to pull in.** Every endpoint of
theirs that carries data is already read by this CRM, and the three that are
not — package, team members, catalogue — answer with nothing for this account.
So the module is not unfinished for want of effort; it is at the ceiling their
API sets. Anyone asked to "bring more across" should read this table first
rather than start guessing endpoint names again.

**So "never open WhatsMarketing again" has a hard ceiling, and it is worth
stating plainly rather than being discovered later: a template can only be
*read* through their API, never written.** Creating one and submitting it for
Meta's approval happens on their site. The same goes for the account itself and
for switching their inbound webhook on. Everything that is *about a
conversation* can live in the CRM; everything that is *about the account*
cannot.

The probe reads only. No create, update or delete endpoint was tried, on
purpose: one that existed would have written to the business's real account,
which is not a thing to find out by accident. So this is evidence that the
plausible names are absent, **not** proof that no such endpoint exists under a
name nobody guessed — their own documentation is the authority, and the copy
the owner sent has no create-template section.

---

## Reports

**20 September 2026, the owner: "now start reports"** — the last item in his own
order for this phase, after campaigns.

**A report is a saved `WidgetConfig`, and that is the whole design.** The engine to
answer one already existed: `core/analytics/widgets.ts` runs a config against any
module, through the same permission-scoped SQL every list uses, and that is what a
dashboard tile is. What was missing was somewhere to *keep* a question away from a
dashboard's grid. A second query engine for reporting would have drifted from the
first the day somebody deleted a field.

* **Nothing is cached, deliberately.** `ipy_report` (migration `162`) stores the
  question; running it is a live query **as the person asking**. A shared report
  opened by a manager and by a rep is one question over two different sets of
  records — which is what "shared" has to mean in a CRM with a role hierarchy. A
  stored total would be one number for everybody, which is a permissions leak
  wearing a chart. `tests/integration/reports.test.ts` proves the two answers differ.
* **Sharing is the same decision as sharing a dashboard**, so it is the same
  capability (`dashboards.share`) rather than a new one. A new capability is held
  by nobody until an admin ticks it on every profile, so on the day it shipped the
  feature would read as broken.
* **The export is the answer, not the records behind it.** "Contacts by source"
  exports as five lines. Exporting the records is what the list's own export is
  for, and that is gated on `records.export`; this is not a way round it, because
  a count of records is not the records. Values are prefixed against spreadsheet
  formula injection and the file carries a BOM, or Excel reads a Devanagari name
  as mojibake and the file looks corrupt.
* **The screen is one sentence:** *how many / total of / average of — contacts —
  grouped by — status — this month*, then a shape (bars, pie, over time, table,
  one number). It answers **before** anybody configures it: a report page that
  opens empty asking for four choices is one nobody uses.

**`ChartFrame`, `SeriesSummary` and `formatValue` moved out of `Dashboard.tsx`**
into `components/ChartFrame.tsx`. Copying them would have been quicker and is the
mistake this repo keeps finding months later — the accessibility handling in
`ChartFrame` is subtle (recharts renders unlabelled `<path role="img">` and
re-adds `tabindex` on every resize), and a second copy would drift from it in
silence.

**Reports had to be appended to the header arrangement, and that line is the one
the Chats note predicted.** Production's saved arrangement was written before this
page existed, so without `arrangeHeaderTabs` appending a `reports` entry it would
have been the one screen nobody could reach — invisible in exactly the way Chats
was. It is in the drawer too, because the switcher is `lg:block` and does not exist
below 1024px.

### The WhatsApp half of it

The second tab answers the three questions somebody actually asks of the business
number: how much came in and went out per day, what happened to the messages sent
(delivered, read, failed), and how each campaign ended.

* **Counted from the CRM's own rows, never a vendor dashboard** — the rule this
  whole phase was built on, and why the numbers survive changing provider.
* **Who may count is who may read.** `visibility()` in `business/inbox.ts` is
  exported and reused rather than copied: an admin counts every thread, everybody
  else counts their own and the unassigned queue. A report that counted everything
  would tell a rep exactly how many conversations their colleagues are having,
  which is the thing the shared inbox deliberately does not show. Campaigns are an
  admin-only block for the same reason.
* Rule 8's cousin again: the day window is `($n::text || ' days')::interval`, cast
  at the point of use, because a bare parameter beside `interval` deduces two types
  and Postgres refuses the whole statement.

Proved by `tests/integration/reports.test.ts` (5), `e2e/reports.spec.ts` (4,
including that the page is reachable from the navigation rather than only by URL)
and an a11y scan of both tabs in both themes. **What has never been seen is a
messaging report with real outbound traffic**, because nothing has ever been sent
on the business number — the tab reads from two inbound days on a developer's
database.

---

## Five things the owner asked for on 24 September

* **The queue filters by module.** "Contacts chats" and "Inventories chats" sit
  under the seven status filters in the same dropdown, prefixed `module:` so a
  module name can never be mistaken for a status. The entries come from the
  CRM's own metadata — there are two modules today and an admin may add a third
  with no deploy, so **no module is named in the screen or in the route**; the
  server takes a module name and filters `c.record_module`.
  **A thread nobody has linked to a record has no module and is in neither**,
  which is the half worth pinning — one appearing under both would be invisible
  until somebody counted. `tests/integration/whatsappBusinessInbox.test.ts`.

* **Every row wears a sticker saying which it is.** The module's own
  `singularLabel` in the admin's own module colour, through `badgeVars` so the
  text clears WCAG AA on its own tint in both themes rather than landing at
  2–3:1 — the pattern this repo's conventions already name. The name truncates
  before the sticker does: which module a chat belongs to is one word, and
  losing it is the whole point of having it.

* **"Assigned To" reads like the record page.** It was a permanently open
  select box on the line whose job is to say who the conversation is *with*;
  it is the label, a small face and the name now, and becomes a dropdown when
  somebody clicks it. `Select` gained optional `autoFocus` and `onBlur` for
  that rather than the screen growing a second kind of dropdown.

* **The record's WhatsApp tab caught up with the Chats screen.** Same tinted
  canvas (a white bubble on a white page does not read as a bubble), the date
  once down the middle instead of on all forty bubbles from one afternoon, the
  clock alone on each bubble, and `outboundTone`/`wentOut` rather than a second
  ladder of statuses written in that file — two copies would eventually
  disagree about what a *refused* message looks like, which is the exact bug
  that put six failures in front of the owner in green on 20 September.
  **And the template path is there now.** A shut 24-hour window used to leave
  that tab with a dead box and nothing else, so a rep on a record could not
  reach the customer at all without going and finding the Chats screen. Same
  controls, same server call, blanks filled as the person asking.

* **Which list views exist is now an admin decision** — see
  [`SCREENS.md`](SCREENS.md).
