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
    # Every shape a broker posts, from one horizontal photo. Crops where the
    # target is close to the source and fits onto a blurred backdrop where it is
    # not, because a 9:16 crop of a landscape room keeps 31% of it.
    "shapes": "make_all_shapes.sh",
    "video": "make_video_shapes.sh",
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
            self._reply(200, {"ok": True, "root": str(MEDIA_ROOT), "jobs": sorted(JOBS)})
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
