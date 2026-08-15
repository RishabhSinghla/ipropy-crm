# The media worker

Does every pixel of work on a property's photographs, and every byte of file
handling. n8n decides *what* should happen; this makes it happen.

It runs on the Mac that already syncs OneDrive, so it reads and writes ordinary
local files. That removes the Microsoft Graph API, the OAuth dance and the
token refresh from the whole design — OneDrive's own client does the uploading,
which it is far better at than we would be.

---

## Start it

```bash
cd media-worker
python3 make_watermark.py     # once, or whenever the logo changes
IPROPY_TOKEN=pick-a-long-random-string python3 server.py
```

Pillow is the only dependency and it is already installed. Nothing else to set
up — no virtualenv, no pip, no Docker.

| Variable | Default | What it does |
|---|---|---|
| `IPROPY_ROOT` | `~/Library/CloudStorage/OneDrive-Personal/IPROPY-PROPERTIES` | the only folder it will touch |
| `IPROPY_TOKEN` | *(empty)* | required in `X-Worker-Token` when set |
| `IPROPY_PORT` | `8712` | |

It binds to `127.0.0.1` only, and refuses any path outside `IPROPY_ROOT`.
Both matter: it reads and writes files, so a request saying
`{"folder": "../../.ssh"}` has to be refused, and a laptop on café wifi should
not be serving the filesystem.

---

## What it does to a photograph

```
01 Originals          what the phone wrote — never touched, never renamed
      |
      |   decode HEIC, fix orientation, white balance, lift shadows,
      |   gentle contrast, resize to 2400px, save once
      v
02 Master             ~400 KB, corrected, still camera-named
      |
      |   crop, watermark, rename to the published order
      v
03 Portals and Website      landscape   no watermark
04 Google and Marketplace   1:1         small logo
05 Instagram and Facebook   4:5         small logo
06 Reels Stories Status     9:16        small logo, lifted clear of the buttons
```

**Compressed once, cropped once.** Every derivative comes from the master in a
single step. Compressing twice is the classic way to get mush — each JPEG save
throws a little more away, and four derivative sets means four chances.

**Originals keep their camera names.** `IMG_4471.HEIC` stays `IMG_4471.HEIC`.
The friendly names go on the copies. If the labelling gets a room wrong you
have renamed a copy, not your master, and the EXIF trail is intact.

### The corrections

Four things, all gentle:

* **White balance** — grey-world, capped at 12% per channel. Tube lights turn a
  white wall yellow-green. The cap is there because an uncapped correction on a
  room with one big red sofa drains the sofa.
* **Shadow lift** — a curve that opens the darks and leaves the highlights
  alone, so a bright window stays bright instead of going grey.
* **Contrast +4%, saturation +3%** — barely perceptible, applied after the
  shadow lift so it does not simply undo it.

No HDR, no cranked saturation, no fake blue sky. Buyers spot it instantly and
trust you less for it.

### What it deliberately does not do

**Straightening.** Getting verticals true needs real line detection, and a
guess that rotates a room two degrees the wrong way is worse than leaving it
alone. This is the single biggest remaining improvement, and it wants a proper
computer-vision library rather than a heuristic.

**Culling.** Ordering and grouping is n8n's job. This applies a plan; it does
not form one.

### The watermark

Generated from `brand/logo-source.jpg` by `make_watermark.py`, which crops away
the border and the white field, turns the ink into an alpha mask and re-colours
it to one flat tone.

One colour, not the gold-and-navy original: a two-colour logo at 50% opacity
over a beige wall goes muddy, while a single tone reads as an intentional mark.
The key is much lighter than the wordmark, so the mask is stretched to stop the
key fading out next to the letters.

Bottom-**left**, 16% of the width, 52% opacity, with a soft shadow so it
survives a pale wall. Left rather than right because portals and Instagram both
put their own furniture bottom-right. On a 9:16 frame it lifts to 14% off the
bottom, clear of where Instagram and WhatsApp draw their buttons.

**Portals get no watermark at all.** 99acres and MagicBricks have rules about
branding on images, and it is your own website — there is nobody to prove
ownership to.

---

## The two calls n8n makes

### `POST /prepare`

```json
{ "folder": "properties/b12-4bhk-250sqyd-0001" }
```

Decodes, corrects and compresses everything in `01 Originals` into `02 Master`,
then answers with a small preview of each one so the model can label them
without anybody downloading a 4 MB photograph.

```json
{ "originals": 31, "masters": ["IMG_4471.jpg", "..."],
  "videos": ["IMG_4480.MOV"], "skipped": [],
  "previews": [{ "master": "IMG_4471.jpg", "preview": "data:image/jpeg;base64,..." }] }
```

### `POST /finish`

```json
{ "folder": "properties/b12-4bhk-250sqyd-0001",
  "plan": [{ "master": "IMG_4471.jpg", "label": "drawing room", "order": 1 }],
  "files": { "captions.md": "...", "listing.md": "...", "_status.json": "..." } }
```

Crops, watermarks, renames to `01-drawing-room.jpg` and writes the text files.
Anything the plan omits is simply not published.

---

## Checking it

```bash
python3 end_to_end.py
```

Builds a fake property with the problems real ones have — 4032×3024 frames,
HEIC files, tube-light yellow, black corners, a `notes.txt` that is not a
photograph — starts the server, and runs the whole thing over real HTTP against
real files. 20 checks: shapes, watermark presence and position, naming,
originals untouched, and the total size.

Only the model is stubbed, because its answers are a matter of taste and this
is checking the machinery.

Two things worth knowing about how those checks are written. The watermark is
verified by the **bounding box of what changed** — is there a change, is it
bottom-left, is it small — rather than by an average brightness, because a
small translucent mark barely moves the average of a large patch and any
threshold you pick for that is a threshold you tuned until it passed. And there
is deliberately no absolute number for how much the watermark should shift the
pixels: how much it shifts depends on what is behind it.

`make_test_property.py` writes the fixture on its own if you want to look at
real output:

```bash
python3 make_test_property.py /tmp/look
python3 -c "import pathlib,pipeline; pipeline.prepare(pathlib.Path('/tmp/look'))"
open /tmp/look
```
