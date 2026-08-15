# The content factory — n8n

`ipropy-content-factory.json` is an importable n8n workflow. The CRM tells it a
shoot is finished; it reads the photos out of OneDrive, decides which ones are
worth showing, writes the captions and the portal listing beside them, and tells
the CRM when it is done.

Nothing in here runs inside the CRM. That is the point: the CRM keeps answering
requests while this does the slow work, and either one can be down without
taking the other with it.

---

## The folder plan

**Use the eight folders the CRM already creates.** Not the 136-folder demo tree.

```
IPROPY-PROPERTIES/<AREA>/<PROPERTY>/
  01 Originals                              <- everything you shot, untouched
  02 Compressed
  03 Watermarked
  04 Social Media/Instagram Feed
  04 Social Media/Instagram Story and Reels
  04 Social Media/Facebook
  04 Social Media/WhatsApp
  05 CRM Website

  _status.json      <- what this workflow did, and what it refused
  captions.md       <- Instagram, Facebook, WhatsApp, in one file
  listing.md        <- portal title, description, photo order
  shortlist.json    <- the chosen photos, with scores
```

Twelve things to look at instead of a hundred and thirty-six.

**The argument against the big tree is not disk space.** 673 MB per property at
30 a month is about 20 GB a month — a 1 TB OneDrive survives that for four
years. The problem is that 136 folders, nine of them permanently empty, is a
filing cabinet nobody opens. You cannot tell what is current, what was posted,
or what is safe to delete. A structure people stop trusting is worse than a
flat folder.

**Do not store one crop per platform.** A 4:5 Instagram crop is a 200 ms
operation on a photo you already have. Storing it forever, syncing it to every
device, and then wondering whether it is the current version costs more than
regenerating it. Keep originals, keep what you actually published, regenerate
the rest.

**Add a folder the day you need it, not before.** `08_BLOG` and `09_AEO_GEO` in
the demo are real ambitions, but an empty folder teaches the team that the
system is aspirational, and then they stop believing any of it.

---

## The upload problem, and why it mostly already solved itself

The design as described has you, per property: leave the CRM, open OneDrive,
find the right folder among thirty, upload, come back, tap Finish. That is five
steps at the exact moment you are hot, tired, and walking to the next building.
On property 22 of 30 you will skip it, and the folder will sit empty.

**Tapping Finish is fine. Choosing the folder is the poison.** Remove that.

The CRM already has the machinery, from `CLAUDE.md`:

> A photo finds its property by the clock, never by GPS.

A shoot session binds a property to a *window of time*. A photo taken inside
that window belongs to that property — `matchOrphansForSession()` in
`core/capture` already does this, and `POST /api/capture/sessions/finish`
already calls it. Nothing needs inventing.

So:

1. Turn on **Camera Upload** in the OneDrive iOS app, once, forever.
2. Photograph the property. Touch nothing.
3. Tap **Finish** in the CRM.

Photos land in OneDrive by themselves. The CRM knows which window they fall in.
Personal photos taken outside a shoot window are never claimed, so it is safe to
leave switched on. You navigate to a folder exactly never.

The only real cost is that HEIC arrives instead of JPEG — which the CRM already
transcodes at ingest, because that trap was found and fixed earlier.

---

## Setting it up

### 1. Three credentials in n8n

| Name it exactly | Type | Value |
|---|---|---|
| `OneDrive` | Microsoft OneDrive OAuth2 API | sign in with the account that owns IPROPY-PROPERTIES |
| `OpenRouter API key` | Header Auth | Name `Authorization`, Value `Bearer sk-or-...` |
| `iPropy CRM API key` | Header Auth | Name `X-API-Key`, Value from **Settings → Connected apps** |

The names matter — the workflow references them.

### 2. Import

n8n → Workflows → Import from File → `ipropy-content-factory.json`.

### 3. Fire it by hand first

Do not wire the CRM up until you have watched it work once. Copy the webhook URL
off the first node, then:

```bash
curl -X POST http://localhost:5678/webhook-test/ipropy-shoot-finished \
  -H 'Content-Type: application/json' \
  -d '{"propertyId":"<a real property id>","folder":"IPROPY-PROPERTIES/GREENFIELD/B12-4BHK","crmBaseUrl":"http://localhost:4000"}'
```

Watch it in the n8n editor. When it finishes, open the property folder in
OneDrive: `captions.md`, `listing.md`, `shortlist.json` and `_status.json`
should be sitting there.

### 4. Then wire the CRM

Both sides exist now. Set two things in the CRM's integration settings (or as
env vars) and the loop closes:

| Setting | Env var | What it is |
|---|---|---|
| `n8n` → config → `webhookUrl` | `N8N_WEBHOOK_URL` | the workflow's production webhook URL |
| `n8n` → credentials → `callbackSecret` | `N8N_CALLBACK_SECRET` | any long random string |

Put the same secret in n8n as a header credential named **`iPropy CRM API key`**
sending `X-N8N-Secret`.

Then:

* `POST /api/capture/sessions/finish` posts `{propertyId, sessionId, folder,
  crmBaseUrl}` to n8n — **without waiting**. A dead n8n cannot stop a rep
  closing a site visit; it logs a warning and the session sits `ready` with no
  content beside it.
* `POST /api/webhooks/n8n/content-ready` takes the report and notifies the
  property owner and whoever walked the site. It writes nothing to the record —
  a model's opinion about which photographs are good has no business editing
  inventory unasked.

An unset secret **refuses every callback** rather than accepting them. That
endpoint sits on the router mounted ahead of `requireAuth`, so an open one is a
stranger able to push notifications at your whole team. There is a test that
fails if anyone ever "fixes" that.

---

## What it does, node by node

```
Shoot finished (webhook)
  -> Read the request            normalise, and refuse a request with no propertyId
  -> Get property from CRM       the facts the copy must not contradict
  -> List originals              OneDrive, "01 Originals"
  -> Pick photos to judge        images only, junk and thumbnails dropped, capped
  -> Each photo ─────────────┐
       Download photo        │   one at a time, so one failure costs one photo
       Photo to data URI     │
       Rate photo            │   vision model: keep? score? which room?
       Collect rating ───────┘
  -> Rank and shortlist          one photo per room first, then the best of the rest
  -> Write the words             captions + portal listing, from the real facts
  -> Build the files
  -> captions.md, listing.md, shortlist.json, _status.json
  -> Tell the CRM
```

### Choices worth knowing about

**`qwen/qwen3.7-flash`.** $0.03 in / $0.13 out per million, 1M context, and it
reads images — checked against OpenRouter's live API, not a blog post. The
model most people would reach for here, DeepSeek V4 Flash, is roughly 4.5x more
expensive on input *and* cannot see a photograph at all, which makes it the
wrong tool for a business built on pictures. Judging 40 photos costs a few
paise.

**One photo per room before the second of anything.** Eight angles of the same
drawing room reads as a thin property even when it is not.

**Rejected photos are written to `_status.json` with the reason.** A selection
you can argue with is worth far more than a selection you have to trust, and
the first week you will disagree with it.

**A model that answers with junk costs one photo, never the run.** That branch
is tested.

---

## What has actually been verified

Run both of these yourself; they need no credentials:

```bash
python3 n8n/check-workflow.py   # structure
node n8n/dry-run.mjs            # logic
```

`check-workflow.py` confirms every connection points at a real node, nothing is
orphaned, every `$('Node')` reference resolves, and every Code node is valid
JavaScript. **n8n will happily import a workflow that fails all four**, and you
find out halfway through a property.

`dry-run.mjs` executes the Code nodes against invented data and asserts on what
comes out — including a junk model answer, an empty folder, a shoot where
everything was rejected, and a property whose copy came back as prose instead of
JSON. 22 checks.

**What is not verified, and cannot be from here:** the OneDrive paths, the three
credentials, the model's actual judgement, and the CRM callback endpoint that
does not exist yet. Those need one real property. Everything above is why the
first run should be the manual `curl`, watched, on a property you do not mind
seeing rewritten.

Edit `build-workflow.py` rather than the JSON, then re-run it — the JSON is
generated, and hand-escaping JavaScript inside JSON is how you get a workflow
that imports but does not run.
