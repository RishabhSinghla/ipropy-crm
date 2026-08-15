# The content factory — n8n

`ipropy-content-factory.json` is an importable n8n workflow. The CRM tells it a
shoot is finished; it asks the media worker what is there, decides how the
photos should be labelled and ordered, writes the words, and has the worker
publish them. Then it tells the CRM.

Nothing in here runs inside the CRM. That is the point: the CRM keeps answering
requests while this does the slow work, and either one can be down without
taking the other with it.

---

## How the whole thing fits together

```
  iPhone                OneDrive              CRM              n8n         worker
    |                      |                   |                |            |
 photograph  --auto-->  01 Originals           |                |            |
    |                      |                   |                |            |
 tap Finish ----------------------------->  session closed      |            |
                                               |--- webhook --->|            |
                                               |                |-- prepare->|
                                               |                |<- previews-|
                                               |                | (label each)
                                               |                | (order, words)
                                               |                |-- publish->|
                                               |                |            | writes 02-06
                                               |<-- content-ready ---|        | + the 3 files
                                            notification                      |
```

You touch two things: the camera, and the Finish button.

## The folder plan

```
IPROPY-PROPERTIES/properties/<property>/
    captions.md       every channel's words, in one file
    listing.md        portal title, description, photo order
    _status.json      what ran, and what it refused to publish

    01 Originals               as shot — never touched, never renamed
    02 Master                  compressed once, corrected, camera-named
    03 Portals and Website     landscape, no watermark
    04 Google and Marketplace  1:1, small logo
    05 Instagram and Facebook  4:5, small logo
    06 Reels Stories Status    9:16, small logo
```

Five folders feed fifteen places. The same photo in four shapes, not four
different sets of photos.

The CRM creates only `01 Originals`. The worker creates the rest as it
publishes — an absent folder says "not run yet" without ambiguity, where five
empty ones say nothing at all.

## The upload problem, and why it mostly already solved itself

Having you find the right folder among thirty, on a phone, at the moment you
are hot and walking to the next building, is the step that gets skipped on
property 22 of 30. Tapping Finish is fine. Choosing a folder is the poison.

The CRM already has the machinery, from `CLAUDE.md`:

> A photo finds its property by the clock, never by GPS.

A shoot session binds a property to a *window of time*, and
`matchOrphansForSession()` already claims files that fall inside it. So:

1. Turn on **Camera Upload** in the OneDrive iOS app. Once, forever.
2. Photograph the property. Touch nothing.
3. Tap **Finish** in the CRM.

Personal photos taken outside a shoot window are never claimed, so it is safe
to leave switched on. You navigate to a folder exactly never.

**Shoot landscape.** Every photo. Rooms look bigger, portals want it, and a
landscape frame crops down to 4:5 and 1:1 — where a portrait one cannot be
turned back into a good landscape, the sides are simply gone. Then shoot one
vertical video for the Reel and the Status. Photos sideways, video upright.

## Setting it up

### 1. Start the media worker

See `media-worker/README.md`. One command, no dependencies to install.

### 2. Three credentials in n8n

| Name it exactly | Type | Value |
|---|---|---|
| `OpenRouter API key` | Header Auth | Name `Authorization`, Value `Bearer sk-or-...` |
| `iPropy CRM API key` | Header Auth | Name `X-API-Key`, from **Settings → Connected apps** |
| `iPropy CRM callback secret` | Header Auth | Name `X-N8N-Secret`, matching `N8N_CALLBACK_SECRET` |
| `iPropy media worker token` | Header Auth | Name `X-Worker-Token`, matching `IPROPY_TOKEN` |

The names matter — the workflow references them. **No Microsoft credential is
needed anywhere**: n8n never touches OneDrive.

### 3. Import and fire it by hand

n8n → Workflows → Import from File → `ipropy-content-factory.json`. Then, before
wiring the CRM up, run one property yourself and watch it:

```bash
curl -X POST http://localhost:5678/webhook-test/ipropy-shoot-finished \
  -H 'Content-Type: application/json' \
  -d '{"propertyId":"<a real property id>","folder":"properties/<the folder>","crmBaseUrl":"http://localhost:4000"}'
```

### 4. Then wire the CRM

Both sides exist. Set two things in the CRM's integration settings (or as env
vars):

| Setting | Env var | What it is |
|---|---|---|
| `n8n` → config → `webhookUrl` | `N8N_WEBHOOK_URL` | the workflow's production webhook URL |
| `n8n` → credentials → `callbackSecret` | `N8N_CALLBACK_SECRET` | any long random string |

* `POST /api/capture/sessions/finish` posts to n8n **without waiting**. A dead
  n8n cannot stop a rep closing a site visit.
* `POST /api/webhooks/n8n/content-ready` notifies the property owner and
  whoever walked the site. It writes nothing to the record.

An unset secret **refuses every callback** rather than accepting them, and
there is a test that fails if anyone ever "fixes" that.

## What it does, node by node

```
Shoot finished (webhook)
  -> Read the request        normalise; refuse a request with no propertyId
  -> Get property from CRM   the facts the copy must not contradict
  -> Worker: prepare         HEIC decoded, corrected, compressed; previews back
  -> Split previews          one item per photo
  -> Each photo ─────────┐
       Look at the photo │   which room? is it genuinely unpublishable?
       Collect label ────┘   junk answer costs one label, never the run
  -> Put them in order       order, do not cull
  -> Write the words         every channel's copy, from the real facts
  -> Build the files         captions.md, listing.md, _status.json
  -> Worker: publish         crops, watermarks, renames, writes
  -> Tell the CRM
```

### Choices worth knowing about

**`qwen/qwen3.7-flash`.** $0.03 in / $0.13 out per million, 1M context, and it
reads images — checked against OpenRouter's live API, not a blog post. The
model most people would reach for here, DeepSeek V4 Flash, is roughly 4.5x more
expensive on input *and* cannot see a photograph at all, which makes it the
wrong tool for a business built on pictures. Judging 40 photos costs a few
paise.

**Order, do not cull.** The photos are taken carefully, so nothing is dropped
for being merely ordinary. The only things dropped are what the model calls
genuinely unpublishable — a shot of a shoe, a screenshot — and even those are
written into `_status.json` with the reason.

What it does decide is sequence, and that matters more: the photo at position
one on a 99acres listing is what decides whether anybody clicks. One of each
room first, in the order a buyer walks a property, then the remaining angles
behind them.

**Nothing disappears silently.** A photo that vanished without explanation is
what makes people stop trusting the whole pipeline.

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

**What is not verified, and cannot be from here:** the four credentials, the
real OneDrive paths, and the model's actual judgement — whether it calls that
room a drawing room, and whether the caption is one you would post. Those need
one real property. Everything else is covered, including the worker: run
`python3 media-worker/end_to_end.py` for the pixel half.

Edit `build-workflow.py` rather than the JSON, then re-run it — the JSON is
generated, and hand-escaping JavaScript inside JSON is how you get a workflow
that imports but does not run.
