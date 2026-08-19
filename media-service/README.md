# The automation machine

Everything that happens after somebody presses **Finish** on a property: the
folder tree, the details sheet, the compressed and watermarked copies, the
social sizes, and pushing the website set back into the CRM.

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
* **The API key and callback secret are not recoverable.** The CRM stores only a
  hash. Losing `.env` means minting new ones.
