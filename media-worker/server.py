#!/usr/bin/env python3
"""
The small HTTP service n8n talks to.

Standard library only, on purpose. This has to start on a laptop with one
command and no virtualenv, and a dependency you have to remember to install is
a dependency that will be missing at 9pm on a Sunday. Pillow is the single
exception and it is already there.

Two rules it will not bend on:

* **Localhost only.** It reads and writes files. Nothing outside this machine
  has any business calling it, and binding to 0.0.0.0 on a café wifi would hand
  a stranger the filesystem.
* **Inside the root only.** Every path is resolved and checked to be under
  IPROPY_ROOT. Without that, `{"folder": "../../.ssh"}` is a valid request.

    python3 server.py
    IPROPY_ROOT=/path/to/IPROPY-PROPERTIES IPROPY_TOKEN=secret python3 server.py
"""
from __future__ import annotations

import base64
import io
import json
import os
import pathlib
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image

import pipeline

HOST = '127.0.0.1'
PORT = int(os.environ.get('IPROPY_PORT', '8712'))
ROOT = pathlib.Path(os.environ.get(
    'IPROPY_ROOT',
    pathlib.Path.home() / 'Library/CloudStorage/OneDrive-Personal/IPROPY-PROPERTIES',
)).expanduser()
TOKEN = os.environ.get('IPROPY_TOKEN', '')

# Big enough for a model to tell a kitchen from a bathroom, small enough that
# forty of them are not forty megabytes of base64.
PREVIEW_EDGE = 768
PREVIEW_QUALITY = 70


class Refused(Exception):
    """A bad request, as opposed to a bug — answered 400, not 500."""


def resolve(folder: str) -> pathlib.Path:
    """A real folder underneath the root, or an exception."""
    if not folder:
        raise Refused('folder is required')
    candidate = pathlib.Path(folder).expanduser()
    if not candidate.is_absolute():
        candidate = ROOT / folder
    candidate = candidate.resolve()
    root = ROOT.resolve()
    if root != candidate and root not in candidate.parents:
        raise Refused(f'folder must be inside {root}')
    if not candidate.is_dir():
        raise Refused(f'no such folder: {candidate}')
    return candidate


def preview_of(path: pathlib.Path) -> str | None:
    """A master as a small data URI, for the vision model."""
    try:
        im = Image.open(path).convert('RGB')
    except Exception:
        return None
    im.thumbnail((PREVIEW_EDGE, PREVIEW_EDGE), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=PREVIEW_QUALITY)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()


# ---------------------------------------------------------------------------

def do_prepare(body: dict) -> dict:
    """
    Decode, correct and compress everything in `01 Originals`.

    Returns a preview of each master so the caller can decide labels and order
    without downloading full photographs.
    """
    folder = resolve(body.get('folder', ''))
    out = pipeline.prepare(folder)

    previews = []
    master_dir = folder / pipeline.MASTER
    for name in out.masters:
        uri = preview_of(master_dir / name)
        if uri:
            previews.append({'master': name, 'preview': uri})

    return {
        'folder': str(folder),
        'originals': len(out.originals),
        'masters': out.masters,
        'videos': out.videos,
        'skipped': out.skipped,
        'previews': previews,
    }


def do_finish(body: dict) -> dict:
    """Apply the plan, then write whatever text files came with it."""
    folder = resolve(body.get('folder', ''))
    plan = body.get('plan') or []
    if not isinstance(plan, list) or not plan:
        raise Refused('plan must be a non-empty list of {master, label, order}')

    result = pipeline.finish(folder, plan)
    files = body.get('files') or {}
    written = pipeline.write_text_files(folder, files) if isinstance(files, dict) else []

    return {'folder': str(folder), **result, 'wrote': written}


ROUTES = {'/prepare': do_prepare, '/finish': do_finish}


class Handler(BaseHTTPRequestHandler):
    server_version = 'iPropyMedia/1.0'

    def _send(self, code: int, payload: dict) -> None:
        raw = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == '/health':
            self._send(200, {'ok': True, 'root': str(ROOT), 'authRequired': bool(TOKEN)})
        else:
            self._send(404, {'error': 'not found'})

    def do_POST(self) -> None:  # noqa: N802
        handler = ROUTES.get(self.path)
        if not handler:
            self._send(404, {'error': 'not found'})
            return

        if TOKEN and self.headers.get('X-Worker-Token') != TOKEN:
            self._send(401, {'error': 'bad or missing X-Worker-Token'})
            return

        try:
            length = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(length) or b'{}')
        except Exception:
            self._send(400, {'error': 'body must be JSON'})
            return

        try:
            self._send(200, handler(body))
        except Refused as exc:
            self._send(400, {'error': str(exc)})
        except Exception as exc:
            # The whole trace to the console, one line to the caller: n8n's
            # execution list is not the place for a stack trace, and the
            # console is where somebody debugging is already looking.
            traceback.print_exc()
            self._send(500, {'error': f'{type(exc).__name__}: {exc}'})

    def log_message(self, fmt: str, *args) -> None:
        print(f'  {self.address_string()} {fmt % args}')


def main() -> None:
    if not ROOT.exists():
        raise SystemExit(f'IPROPY_ROOT does not exist: {ROOT}')
    if not pipeline.WATERMARK_LIGHT.exists():
        print('  ! no watermark yet — run: python3 make_watermark.py')
    print(f'iPropy media worker on http://{HOST}:{PORT}')
    print(f'  root  {ROOT}')
    print(f'  token {"required" if TOKEN else "NOT SET (fine on a laptop, set IPROPY_TOKEN otherwise)"}')
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == '__main__':
    main()
