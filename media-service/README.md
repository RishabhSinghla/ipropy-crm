# The automation machine

Everything that happens after somebody presses **Finish** on a property: the
folder tree, the details sheet, naming the photographs, the finish and the
watermark, every social size, two videos, and pushing the website set back into
the CRM.

It used to run on the owner's Mac. A closed lid stopped all of it silently,
which is not something a team can be given, so it moved here.

## Shape

    CRM (Render)  <—— asks ——  n8n  ——> media worker
                                 \
                                  \—> OneDrive (rclone mount)

**The arrow only points one way.** The CRM is on the public internet and this
machine is not, so the CRM can never open a connection to it. n8n asks the CRM
what needs doing every two minutes instead. Nothing here is exposed: no port
forwarding, no public dashboard, no inbound anything except SSH.

**Two containers, not one.** n8n's published image is hardened and has no
package manager, so Python cannot be installed into it. That forced the split
and the split is right anyway — orchestration and image processing have
different dependencies and very different failure modes.

## What one Finish does, in order

    name       a model looks at every photograph, says which room it is and how
               good the shot is, renames the file, and rewrites the listing copy
               from what is actually in the rooms
    prepare    HEIC becomes JPEG, then the professional finish: straighten,
               white balance, exposure, shadows, a little detail
    photos     five shapes cut from the finished copies
    watermark  the logo, on the 4:3 only — after the crop, or the crop eats it
    reel       a vertical reel from the photographs
    walkthrough  the walkthrough he shot, cut down to its good parts
    video      the plain 9:16 conversion, as a floor under the edit above

**Order is not arbitrary.** The naming pass runs first because everything
downstream keys off the filename — the shapes, the watermark, the CRM and the
portals all end up carrying it, and renaming later would leave five folders
disagreeing about what a photograph is called.

**Nothing is generated.** No frame is invented, no room is furnished, no view is
added. Every pixel came off his camera; the work is choosing, moving, timing and
finishing. The prompts say so explicitly, because a model asked to describe an
empty builder floor will happily furnish it.

## The model key lives in the CRM, not here

The worker has no OpenRouter key. `CRM_URL` and `CRM_N8N_SECRET` point it at a
small relay on the CRM, which does the vision, the voice and the music using
whatever provider **Admin → Integrations** is set to.

That is deliberate. A key in this container would be a second copy of a setting
that is already editable in the admin panel, and the two would drift. Rotate it
in the CRM and this follows without anybody opening a terminal.

Everything degrades. No key, no relay, no answer: the photographs keep their
camera names, the descriptions file keeps the version the CRM wrote from the
facts, and the videos come out without a voice. A property with photographs
always gets its shapes, its watermark and a reel.

## Setting it up

    ./provision.sh          # Docker, rclone, the mount unit
    # then follow what it prints — OneDrive needs a browser, once
    docker compose up -d

Copy `.env.example` to `.env` first and fill it in.

## Importing the workflows

    docker compose exec n8n n8n import:workflow --input=/data/ipropy-property-folders.json
    docker compose exec n8n n8n import:workflow --input=/data/ipropy-property-media.json
    docker compose restart n8n

## Things that will bite

* **A container seeing an empty folder that is obviously full from the shell**
  is the fuse `allow_other` line. provision.sh writes it; if the mount was made
  by hand, it will not be there.
* **n8n 2.0 refuses every filesystem path** unless `N8N_RESTRICT_FILE_ACCESS_TO`
  names one, and it disables the Execute Command node outright. Neither is a
  problem here because the media worker does that work instead.
* **OneDrive "online only" files read as zero bytes** to anything that is not a
  native client — a size that lies. rclone hydrates on read so this machine is
  fine, but the Mac needs "Always keep on this device".
* **`zoompan` is unusable for this.** It is the filter every Ken Burns tutorial
  reaches for and it rescales the whole frame from source on every frame:
  measured at 342 seconds for one two-and-a-half second shot, which is over an
  hour for one reel. `scale` with `eval=frame` does the same move in eleven
  seconds and looks better.
* **Liberation Sans has no rupee sign.** Every price on every title card
  rendered as an empty box until the fonts were reordered to put DejaVu first.
  Pillow reports the glyph as present, because `.notdef` is itself a box, so the
  only test worth running is rendering it and looking at it.
* **ffprobe echoes the file's own metadata**, and a phone writes tags in
  whatever encoding it likes. Decoding subprocess output strictly raises
  `UnicodeDecodeError` on one stray byte, which reads as the editor crashing
  rather than as the camera writing Latin-1.
* **The API key and callback secret are not recoverable.** The CRM stores only a
  hash. Losing `.env` means minting new ones.
