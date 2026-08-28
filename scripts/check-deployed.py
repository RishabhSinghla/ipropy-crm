#!/usr/bin/env python3
"""Is what is running the same as what is in this repo?

Twice now the answer has been no, and both times everything looked fine:

  * The media worker container was months behind. It reported `ok: true` on
    every run with four of its seven steps silently missing.
  * The n8n media workflow was days behind, and pointed at a folder called
    `07_WEBSITE` that no longer exists. Every run made the pictures correctly
    and then failed on the last step, so nothing reached the CRM at all.

Neither showed up in a test, because tests run the repo and the bug was in the
gap between the repo and the machine. Nothing was watching that gap. This does.

Run it after any deploy, and before believing a green test run:

    python3 scripts/check-deployed.py

Exit code is 0 when everything matches and 1 when it does not, so it can go in
CI or a cron. It reads and compares; it changes nothing.
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
N8N_CONTAINER = "n8n"
MEDIA_CONTAINER = "ipropy-media"

# Workflow id in n8n -> the file in this repo it should equal.
WORKFLOWS = {
    "ipropyPropertyMediaSrv": "n8n/ipropy-property-media-server.json",
    "ipropyPropertyFolders1": "n8n/ipropy-property-folders.json",
}

# Where the media service's files live in the repo, and in its container.
MEDIA_SOURCE = ROOT / "media-service"
MEDIA_CONTAINER_ROOT = "/app"

problems: list[str] = []
notes: list[str] = []


def run(args: list[str]) -> str | None:
    """A command's stdout, or None if it could not be run at all."""
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout if out.returncode == 0 else None


def container_running(name: str) -> bool:
    out = run(["docker", "ps", "--filter", f"name=^{name}$", "--format", "{{.Names}}"])
    return bool(out and name in out.split())


# --- 1. The n8n workflows ---------------------------------------------------
#
# Read straight out of n8n's own database rather than through its API, so this
# needs no login and cannot be fooled by a cached copy. Node positions and ids
# are ignored: dragging a node on the canvas is not a change to what it does.

READ_WORKFLOWS_JS = r"""
const sqlite3 = require('/usr/local/lib/node_modules/n8n/node_modules/sqlite3');
const db = new sqlite3.Database('/home/node/.n8n/database.sqlite', sqlite3.OPEN_READONLY);
db.all("SELECT id, name, active, nodes, connections FROM workflow_entity", (e, rows) => {
  if (e) { console.error(String(e)); process.exit(1); }
  const out = {};
  for (const r of rows) {
    out[r.id] = {
      name: r.name,
      active: !!r.active,
      nodes: typeof r.nodes === 'string' ? JSON.parse(r.nodes) : r.nodes,
      connections: typeof r.connections === 'string' ? JSON.parse(r.connections) : r.connections,
    };
  }
  console.log(JSON.stringify(out));
  db.close();
});
"""


def comparable(nodes: list[dict]) -> dict:
    """A workflow's nodes, minus what only affects where they sit on screen."""
    return {
        n["name"]: {k: v for k, v in n.items() if k not in ("position", "id")}
        for n in nodes
    }


def check_workflows() -> None:
    if not container_running(N8N_CONTAINER):
        notes.append(f"n8n: container '{N8N_CONTAINER}' is not running, nothing to compare")
        return

    script = "/tmp/_check_deployed_read.js"
    write = subprocess.run(
        ["docker", "exec", "-i", N8N_CONTAINER, "sh", "-c", f"cat > {script}"],
        input=READ_WORKFLOWS_JS, text=True, capture_output=True,
    )
    if write.returncode != 0:
        problems.append(f"n8n: could not write the reader into the container: {write.stderr.strip()}")
        return

    raw = run(["docker", "exec", N8N_CONTAINER, "node", script])
    subprocess.run(["docker", "exec", N8N_CONTAINER, "rm", "-f", script], capture_output=True)
    if raw is None:
        problems.append("n8n: could not read the workflow database")
        return

    live = json.loads(raw)
    for wf_id, rel in WORKFLOWS.items():
        path = ROOT / rel
        if not path.exists():
            problems.append(f"n8n: {rel} is missing from the repo")
            continue
        if wf_id not in live:
            problems.append(f"n8n: workflow '{wf_id}' ({rel}) is not in n8n at all")
            continue

        want = json.loads(path.read_text())
        got = live[wf_id]

        if not got["active"]:
            # Importing a workflow deactivates it. Forgetting to switch it back
            # on is silent: no error anywhere, the automation simply stops.
            problems.append(f"n8n: '{got['name']}' is switched OFF")

        want_nodes, got_nodes = comparable(want["nodes"]), comparable(got["nodes"])
        missing = sorted(set(want_nodes) - set(got_nodes))
        extra = sorted(set(got_nodes) - set(want_nodes))
        if missing:
            problems.append(f"n8n: '{got['name']}' is missing node(s): {', '.join(missing)}")
        if extra:
            problems.append(f"n8n: '{got['name']}' has node(s) the repo does not: {', '.join(extra)}")

        for name in sorted(set(want_nodes) & set(got_nodes)):
            a = json.dumps(want_nodes[name], sort_keys=True)
            b = json.dumps(got_nodes[name], sort_keys=True)
            if a != b:
                problems.append(f"n8n: '{got['name']}' node \"{name}\" differs from the repo")

        if json.dumps(want["connections"], sort_keys=True) != json.dumps(got["connections"], sort_keys=True):
            problems.append(f"n8n: '{got['name']}' is wired differently from the repo")


# --- 2. The media worker ----------------------------------------------------
#
# File by file, by hash. The failure this catches is a container built from an
# older checkout: same filenames, same entrypoint, different contents, and a
# health check that passes either way.

def check_media_worker() -> None:
    if not container_running(MEDIA_CONTAINER):
        notes.append(f"media: container '{MEDIA_CONTAINER}' is not running, nothing to compare")
        return
    if not MEDIA_SOURCE.exists():
        problems.append(f"media: {MEDIA_SOURCE} is missing from the repo")
        return

    # What the image actually contains, taken from the Dockerfile rather than
    # guessed. `provision.sh` sets up a bare server and is deliberately not in
    # the image; a check that assumed "every script in the folder" reported it
    # missing and cried wolf on a first run, which is how a checker gets
    # ignored.
    wanted = [MEDIA_SOURCE / "app.py"]
    wanted += [p for p in sorted((MEDIA_SOURCE / "scripts").rglob("*"))
               if p.is_file() and "__pycache__" not in p.parts]
    wanted = [p for p in wanted if p.exists()]
    if not wanted:
        problems.append("media: found no scripts in the repo to compare")
        return

    for path in wanted:
        rel = path.relative_to(MEDIA_SOURCE).as_posix()
        want = hashlib.sha256(path.read_bytes()).hexdigest()
        got = run(["docker", "exec", MEDIA_CONTAINER, "sha256sum", f"{MEDIA_CONTAINER_ROOT}/{rel}"])
        if got is None:
            problems.append(f"media: {rel} is not in the running container")
            continue
        if got.split()[0] != want:
            problems.append(f"media: {rel} in the container differs from the repo")


def main() -> int:
    check_workflows()
    check_media_worker()

    for note in notes:
        print(f"  skipped  {note}")

    if problems:
        print(f"\n{len(problems)} thing(s) running are not what this repo says:\n")
        for p in problems:
            print(f"  - {p}")
        print(
            "\nTo put n8n back in step:"
            "\n  docker cp n8n/<file>.json n8n:/tmp/wf.json"
            "\n  docker exec n8n sh -c 'cd /home/node && n8n import:workflow --input=/tmp/wf.json'"
            "\n  docker exec n8n sh -c 'cd /home/node && n8n update:workflow --id=<id> --active=true'"
            "\n  docker restart n8n"
            "\n\nImporting switches a workflow off, so the update line is not optional."
            "\n\nTo put the media worker back in step, rebuild and recreate its image."
        )
        return 1

    print("\nEverything running matches this repo.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
