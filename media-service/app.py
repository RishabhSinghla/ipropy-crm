"""The media worker, as a service rather than a laptop.

Everything here used to happen on somebody's Mac: the watermark script, the
compressor and the finishing pass all shell out to Pillow, ffmpeg and — on a
Mac — sips. That was fine for proving the idea and is not a thing a team can
depend on, because it stops the moment a lid closes.

So the scripts move into a container that can run anywhere, and n8n asks this
service to do the work instead of trying to do it itself. n8n's own image is a
hardened one with no package manager, so adding Python to it is not an option
and would be the wrong shape anyway: orchestration and image processing have
different dependencies and very different failure modes.

Deliberately small. It takes a folder, runs one named job over it, and reports
what happened. It holds no state, has no database, and knows nothing about
properties or the CRM — n8n already knows all of that, and a worker that also
knew it would be a second place for that knowledge to go stale.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json

SCRIPTS = Path(__file__).resolve().parent / "scripts"
MEDIA_ROOT = Path(os.environ.get("MEDIA_ROOT", "/data/properties"))
LOGO = Path(os.environ.get("IPROPY_LOGO", str(Path(__file__).resolve().parent / "iPropy-Logo-1.jpeg")))
TOKEN = os.environ.get("MEDIA_SERVICE_TOKEN", "")

# One entry per thing the pipeline can ask for. A name that is not in here is
# refused, so a caller can never nominate an arbitrary command to run.
JOBS = {
    "watermark": "render_ipropy_watermark.py",
    "finish": "professional_photo_finish.py",
    "compress": "compress_iphone_media.py",
    "walkthrough": "create_ipropy_walkthrough.py",
    # HEIC to JPEG, then the professional finish, into EDITED/FINISHED. Runs
    # before the shapes so all five come off a corrected photograph.
    "prepare": "prepare_photos.sh",
    # A model looks at every photo, names it, orders it, and rewrites the
    # listing copy from what is actually in the rooms.
    "name": "name_and_describe.py",
    # Every shape a broker posts, from one horizontal photo. Crops where the
    # target is close to the source and fits onto a blurred backdrop where it is
    # not, because a 9:16 crop of a landscape room keeps 31% of it.
    "shapes": "make_all_shapes.sh",
    "video": "make_video_shapes.sh",
    # The two that make a video worth watching. Neither generates a frame.
    "reel": "make_photo_reel.py",
    "edit": "edit_walkthrough.py",
}

# Everything one property needs, in one call.
#
# Split across three n8n steps this could not report honestly: a step that
# fails hands on an error object rather than a result, so the run had no
# reliable way to see what went wrong and told the CRM everything was fine.
# A property with no photos and a green tick is worse than a red one.
#
# Doing it here instead means one call, one answer, and a reason in plain
# words. Each part still runs even if an earlier one failed, because a bad
# video should not cost you the photos.
# What each named step actually runs, and nothing about the order.
#
# The order used to live here, as a tuple, which meant "skip the watermark for
# this builder" was a code change and a deploy. It is n8n's job now: n8n sends
# the list, this runs what it is told, in the order it is given. Reordering the
# pipeline is editing one line on a canvas.
#
# What stays here is the *one call*, and that is deliberate. Split across seven
# separate n8n nodes this could not report honestly — a step that fails hands on
# an error object rather than a result, so a run with no photos told the CRM
# everything was fine. A property with a green tick and an empty folder is worse
# than a red one. So: n8n decides what runs, this decides what to say about it.
PROPERTY_STEPS = {
    # renames the originals; everything downstream keys off the filename
    "name": ("name", "", ["{u}", "{facts}"]),
    # HEIC to JPEG, then the professional finish
    "prepare": ("prepare", "", ["{u}"]),
    # the five shapes, cut from the finished copies
    "photos": ("shapes", "", []),
    # the logo, on the 4:3 only — after the crop, or the crop eats it
    "watermark": ("watermark", "/{u}-SHAPES/4x3", ["{root}/{u}-EDITED/WATERMARKED"]),
    # a vertical reel from the photographs
    "reel": ("reel", "", ["{u}", "{facts}"]),
    # the walkthrough he shot, cut down
    "walkthrough": ("edit", "", ["{u}", "{facts}"]),
    # the plain 9:16 conversion, as a floor under `walkthrough`
    "video": ("video", "/{u}-RAW-UPLOADS/VIDEOS", ["{root}/{u}-VIDEO", "{prefix}"]),
}

# What runs when n8n does not say. Every deployment starts here and diverges by
# editing a node rather than this file.
DEFAULT_STEPS = ("name", "prepare", "photos", "watermark", "reel", "walkthrough", "video")


def unit_of(folder: str) -> str:
    """`A1818-4bhk-250sqyd` -> `A1818`, matching how the CRM names the folders."""
    last = [p for p in folder.split("/") if p][-1] if folder.strip("/") else ""
    return (last.split("-")[0] or "PROPERTY").upper()


# The folders this pipeline fills and refills. Everything in them is a copy of
# something in RAW-UPLOADS, which is why they are safe to sweep and RAW-UPLOADS
# never is.
DERIVATIVE_FOLDERS = (
    "{u}-SHAPES/4x5", "{u}-SHAPES/9x16", "{u}-SHAPES/1x1",
    "{u}-SHAPES/4x3", "{u}-SHAPES/16x9",
    "{u}-EDITED/WATERMARKED", "{u}-EDITED/THUMBNAILS",
)

# What this pipeline's own output looks like: a name, then a two or three digit
# number. Nothing else is touched, so a photograph somebody dropped in by hand
# stays where they put it.
OUR_OUTPUT = re.compile(r"^(?P<stem>.+)-\d{2,3}\.(jpe?g|png|webp)$", re.IGNORECASE)


def sweep_stale(root: str, unit: str, prefix: str) -> int:
    """Move copies made under an older name into the archive folder.

    A property's filenames are built from its record — unit, project, locality,
    configuration, area. Edit any of those and the next run writes a whole new
    set beside the old one, because the names no longer collide. B12 went from
    twelve photographs to twenty-four that way, after somebody added the
    locality to the record: every shape folder held both
    `b12-greenfield-colony-*` and `b12-greenfield-colony-sector-15-*`, and the
    website would have shown every room twice.

    Moved rather than deleted, into the archive folder that already exists for
    this. These are the team's files in the team's OneDrive; being wrong about
    which ones are stale should cost somebody a drag-and-drop, not a photograph.
    """
    if not prefix:
        return 0
    archive = Path(root, f"{unit}-ARCHIVE")
    moved = 0
    for template in DERIVATIVE_FOLDERS:
        folder = Path(root, template.format(u=unit))
        if not folder.is_dir():
            continue
        for item in folder.iterdir():
            if not item.is_file():
                continue
            match = OUR_OUTPUT.match(item.name)
            if not match or match.group("stem") == prefix:
                continue
            try:
                target = archive / folder.name / item.name
                target.parent.mkdir(parents=True, exist_ok=True)
                item.replace(target)
                moved += 1
            except OSError:
                # A file the drive has locked is not a reason to stop; the worst
                # case is the duplicate this was meant to prevent.
                continue
    return moved


def run_property(
    folder: str,
    prefix: str = "",
    facts: dict | None = None,
    steps: list[str] | None = None,
) -> dict:
    """Everything one property needs, in one call, in the order n8n asked for.

    Each part still runs even if an earlier one failed, because a bad video
    should not cost you the photos. An unknown step name is reported rather than
    ignored: a typo in an n8n node that silently skipped the watermark would be
    invisible until somebody noticed the logo missing weeks later.
    """
    root = str(safe_target(folder))
    unit = unit_of(folder)
    facts_json = json.dumps(facts or {})
    index_path = Path(root, f"{unit}-PHOTO-INDEX.json")
    wanted = [s for s in (steps or DEFAULT_STEPS) if isinstance(s, str)] or list(DEFAULT_STEPS)

    done, failed, log = [], [], []
    for label in wanted:
        recipe = PROPERTY_STEPS.get(label)
        if recipe is None:
            failed.append(label)
            log.append(f"{label}: not a step this worker knows. Known: {', '.join(PROPERTY_STEPS)}")
            continue
        job, suffix, args = recipe
        try:
            extra = [a.format(root=root, u=unit, prefix=prefix or unit, facts=facts_json) for a in args]
            if label == "photos":
                # The shape maker takes the name to use, then the unit whose
                # folders it writes into. An empty name means "keep the one the
                # file already has".
                #
                # Checked here rather than at the top of the run, because the
                # naming step is what creates the index. Read too early and
                # every photo it just named is renamed back to A1818-01, and
                # the room is thrown away.
                extra.extend(["" if index_path.is_file() else prefix, unit])
            r = run_job(job, folder + suffix.format(u=unit), extra)
        except FileNotFoundError:
            # No video folder, or no photos yet. Ordinary, not broken.
            log.append(f"{label}: nothing to do")
            done.append(label)
            continue
        except Exception as err:  # noqa: BLE001
            failed.append(label)
            log.append(f"{label}: {err}")
            continue
        (done if r["ok"] else failed).append(label)
        log.append(f"{label}: {'ok' if r['ok'] else (r['error'] or '').strip()[-200:]}")

    # After the steps, never before. Sweeping first would archive the only good
    # copies the property has and then, if the run failed, leave it with none.
    moved = sweep_stale(root, unit, prefix)
    if moved:
        log.append(f"archived {moved} file(s) named for an older version of this property")

    return {
        "ok": not failed,
        "done": done,
        "failed": failed,
        "steps": wanted,
        "summary": ("Photos are named and finished, every social size is cut, "
                    "and both videos are ready."
                    if not failed else
                    f"These did not finish: {', '.join(failed)}. "
                    "Your originals are safe. Press Finish again once fixed."),
        "output": "\n".join(log),
    }


def safe_target(raw: str) -> Path:
    """Resolve a caller-supplied path and refuse anything outside the media root.

    The caller is n8n, which is trusted, but this service listens on a port and
    the cost of being wrong is arbitrary filesystem access. `resolve()` collapses
    any `..` before the check, so the comparison is on the real path rather than
    the one that was typed.
    """
    target = (MEDIA_ROOT / raw.lstrip("/")).resolve()
    if target != MEDIA_ROOT and MEDIA_ROOT not in target.parents:
        raise ValueError("path is outside the media root")
    return target


def run_job(job: str, folder: str, extra: list[str]) -> dict:
    script = JOBS.get(job)
    if script is None:
        raise ValueError(f"unknown job: {job}")

    target = safe_target(folder)
    if not target.exists():
        raise FileNotFoundError(f"{folder} does not exist")

    # Shell scripts need a shell; the Python ones need the interpreter. Keyed
    # off the extension so adding a script never means editing this line.
    runner = ["sh"] if script.endswith(".sh") else [sys.executable]
    argv = [*runner, str(SCRIPTS / script), str(target), *extra]
    if job in {"watermark", "finish"}:
        argv += ["--logo", str(LOGO)]

    completed = subprocess.run(argv, capture_output=True, text=True, check=False, timeout=1800)
    return {
        "job": job,
        "folder": folder,
        "ok": completed.returncode == 0,
        # Trimmed rather than dropped: when this fails, the reason is the only
        # thing anybody wants, and n8n has nowhere else to look for it.
        "output": completed.stdout[-4000:],
        "error": completed.stderr[-4000:],
    }


class Handler(BaseHTTPRequestHandler):
    def _reply(self, code: int, body: dict) -> None:
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._reply(200, {
                "ok": True, "root": str(MEDIA_ROOT),
                "jobs": sorted([*JOBS, "property"]),
                # So n8n can be written against what this worker actually knows
                # rather than against a list somebody remembered.
                "steps": list(PROPERTY_STEPS),
                "defaultSteps": list(DEFAULT_STEPS),
            })
        else:
            self._reply(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if TOKEN and self.headers.get("x-media-token") != TOKEN:
            self._reply(401, {"error": "unauthorized"})
            return
        if self.path != "/run":
            self._reply(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            if body["job"] == "property":
                result = run_property(
                    body["folder"], body.get("prefix", ""), body.get("facts"), body.get("steps"),
                )
            else:
                result = run_job(body["job"], body["folder"], body.get("args", []))
            self._reply(200 if result["ok"] else 500, result)
        except Exception as err:  # noqa: BLE001
            self._reply(400, {"ok": False, "error": str(err)})

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(f"{self.address_string()} {fmt % args}\n")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    print(f"media service on :{port}, root {MEDIA_ROOT}, jobs {sorted(JOBS)}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
