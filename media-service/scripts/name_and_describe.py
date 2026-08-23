#!/usr/bin/env python3
"""Look at a property's photos, name them, order them, and write the copy.

This is the step that turns a folder of IMG_4377.jpg into something a person can
work with. A model looks at every photo and says what room it is, how good the
shot is, and what it would say about it. The photos are then renamed and put in
the order somebody would show them, and the property's DESCRIPTIONS.txt is
rewritten with a title, a description, a caption and hashtags that came from the
actual rooms rather than from the price alone.

Three decisions worth knowing:

* **Renaming happens here, before anything else.** Every later step keys off the
  filename, and the CRM, the portals and the social folders all end up carrying
  it. Renaming after the shapes are cut would leave five folders disagreeing
  about what a photo is called.

* **Nothing is invented.** The model is told, in the prompt, that it is
  describing photographs of a real flat somebody will walk into, and that it
  must not mention furniture, fittings, views or finishes it cannot see. An
  empty builder floor is described as an empty builder floor.

* **Failure is ordinary.** No model, no key, a timeout: the photos keep their
  camera names and the descriptions file keeps the version the CRM wrote from
  the facts. Nothing is lost and the run still succeeds.

  name_and_describe.py <property-root> [unit] [facts-json]
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import crm  # noqa: E402

PHOTO_SUFFIXES = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}
BATCH = 8
# Wide enough for a model to read a room, small enough that 25 of them are a
# few megabytes rather than a hundred. Photos go to the API at this size only;
# the originals are never touched.
PREVIEW_EDGE = 1024

ROLE = "You are a senior real-estate photographer and listing writer in Faridabad, India."

# Kept in step with `PORTALS` in `core/storage/propertyDetails.ts`, which writes
# the headings this replaces. The key is the JSON key asked of the model; the
# heading is what the section is called in the file.
PORTALS = [
    {"key": "99acres", "heading": "99ACRES",
     "brief": "Dense and factual, 800-1200 characters, specification-led. Lead with configuration, "
              "area and possession. No lifestyle language."},
    {"key": "housing", "heading": "HOUSING.COM",
     "brief": "Locality-led, 700-1000 characters, warmer. Open with the neighbourhood and what is "
              "around it, then the flat. Only name landmarks given in the facts."},
    {"key": "magicbricks", "heading": "MAGICBRICKS",
     "brief": "A two-line opener, then six to eight short bullet points. Scanned on a phone."},
]


def unit_of(folder: Path) -> str:
    return (folder.name.split("-")[0] or "PROPERTY").upper()


def slug(text: str, limit: int = 28) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return (cleaned[:limit].rstrip("-")) or "photo"


def preview(source: Path) -> bytes | None:
    """A small JPEG of one photo, whatever it started as.

    GraphicsMagick rather than Pillow because this has to read HEIC, which is
    what an iPhone actually writes and what Pillow cannot open without a plugin
    that has already cost this project a week. The container carries libde265
    for exactly this.
    """
    handle, name = tempfile.mkstemp(suffix=".jpg")
    os.close(handle)
    target = Path(name)
    try:
        completed = subprocess.run(
            ["gm", "convert", str(source), "-auto-orient",
             "-resize", f"{PREVIEW_EDGE}x{PREVIEW_EDGE}>", "-quality", "82", str(target)],
            capture_output=True, text=True, errors="replace", check=False, timeout=120,
        )
        if completed.returncode != 0 or not target.is_file() or target.stat().st_size == 0:
            print(f"  could not read {source.name}: {completed.stderr.strip()[:120]}", flush=True)
            return None
        return target.read_bytes()
    finally:
        target.unlink(missing_ok=True)


def look_at_photos(photos: list[Path], facts: dict) -> list[dict] | None:
    """One entry per photo: what it is, how good it is, what to say about it."""
    fact_lines = "\n".join(f"{k}: {v}" for k, v in facts.items()) or "None supplied."
    seen: list[dict] = []

    for start in range(0, len(photos), BATCH):
        chunk = photos[start:start + BATCH]
        previews = [preview(p) for p in chunk]
        pairs = [(p, b) for p, b in zip(chunk, previews) if b]
        if not pairs:
            continue

        listing = "\n".join(
            f"{i + 1}. {path.name}" for i, (path, _) in enumerate(pairs)
        )
        prompt = (
            f"These are photographs of one property.\n\nWHAT THE OWNER RECORDS ABOUT IT:\n{fact_lines}\n\n"
            f"THE PHOTOGRAPHS, in the order attached:\n{listing}\n\n"
            "For each photograph, in the same order, return an object with:\n"
            '  "file"    the filename exactly as listed above\n'
            '  "room"    what the photograph shows, two or three words, e.g. "living room", '
            '"master bedroom", "kitchen", "balcony", "front elevation", "staircase", "bathroom", '
            '"terrace", "parking", "floor plan"\n'
            '  "quality" 1 to 10, how well this photograph sells the property: lighting, framing, '
            "how much of the room is visible, whether it is sharp\n"
            '  "hero"    true for at most one photograph, the single best one to lead with\n'
            '  "note"    one short sentence about what is actually visible, for a listing\n\n'
            "Return a JSON array and nothing else."
        )
        answer = crm.parse_json(crm.vision(prompt, [b for _, b in pairs], system=crm.system_prompt(ROLE), max_tokens=3000))
        if not isinstance(answer, list):
            print(f"  vision returned nothing usable for photos {start + 1}-{start + len(chunk)}", flush=True)
            continue

        by_name = {path.name: path for path, _ in pairs}
        for index, item in enumerate(answer):
            if not isinstance(item, dict):
                continue
            named = by_name.get(str(item.get("file", "")))
            if named is None and index < len(pairs):
                # A model that renumbered rather than echoing the name is still
                # useful: position in the batch is the fallback, and it is right
                # far more often than dropping the entry would be.
                named = pairs[index][0]
            if named is None:
                continue
            seen.append({
                "path": named,
                "room": str(item.get("room") or "photo").strip(),
                "quality": float(item.get("quality") or 5),
                "hero": bool(item.get("hero")),
                "note": str(item.get("note") or "").strip(),
            })
    return seen or None


# The order somebody walks a buyer through a property, which is not the order a
# camera happens to record it in. Anything unrecognised sorts after these, by
# quality, so a new room type never disappears off the end.
TOUR_ORDER = [
    "elevation", "front", "entrance", "lobby", "living", "drawing", "dining", "kitchen",
    "master", "bedroom", "bathroom", "washroom", "balcony", "terrace", "study", "pooja",
    "utility", "store", "stair", "parking", "corridor", "plan", "map",
]


def tour_rank(room: str) -> int:
    lowered = room.lower()
    for index, word in enumerate(TOUR_ORDER):
        if word in lowered:
            return index
    return len(TOUR_ORDER)


def rename_in_order(entries: list[dict], unit: str) -> list[dict]:
    """Rename every photo to `UNIT-NN-room`, hero first, then the tour order.

    Two-digit numbering so twenty photos sort the way a person expects, and the
    room in the name so somebody scrolling a folder on a phone can find the
    kitchen without opening anything.
    """
    ordered = sorted(
        entries,
        key=lambda e: (0 if e["hero"] else 1, tour_rank(e["room"]), -e["quality"], e["path"].name),
    )

    # Rename through a temporary name first. Going straight to the final name
    # can collide with a photo that has not moved yet, and a collision here
    # silently overwrites somebody's photograph.
    staged: list[tuple[Path, dict]] = []
    for entry in ordered:
        holding = entry["path"].with_name(f".staging-{entry['path'].name}")
        entry["path"].rename(holding)
        staged.append((holding, entry))

    used: set[str] = set()
    for position, (holding, entry) in enumerate(staged, start=1):
        stem = f"{unit}-{position:02d}-{slug(entry['room'])}"
        candidate = f"{stem}{holding.suffix.lower()}"
        suffix = 2
        while candidate.lower() in used:
            candidate = f"{stem}-{suffix}{holding.suffix.lower()}"
            suffix += 1
        used.add(candidate.lower())
        final = holding.with_name(candidate)
        holding.rename(final)
        entry["path"] = final
        entry["name"] = final.name
        entry["position"] = position
    return ordered


def cull(entries: list[dict], root: Path, unit: str) -> int:
    """Move the weak photographs out of the way, and say which and why.

    The scoring already happened — the naming pass asked how well each shot
    sells the property and got a number back. Nothing acted on it, so a blurred
    frame and a photograph of the floor were cut into five shapes each and
    published alongside the good ones.

    Held rather than deleted. They move to a HELD-BACK folder inside the raw
    uploads, which is the one place in this pipeline nothing else reads, so the
    originals are still there and putting one back is a drag in Finder.

    The floor is a setting. Zero publishes everything, which is the right answer
    for somebody who trusts their own eye more than a model's.
    """
    config = crm.style()
    if not config.get("features", {}).get("photoCulling", True):
        return 0
    floor = float(config.get("photoScoreFloor") or 0)
    if floor <= 0:
        return 0

    weak = [e for e in entries if e["quality"] < floor]
    # Never hold back everything. A model having a bad day, or a floor set too
    # high, should not produce a property with no photographs at all.
    if not weak or len(weak) >= len(entries) - 2:
        return 0

    holding = root / f"{unit}-RAW-UPLOADS" / "HELD-BACK"
    holding.mkdir(parents=True, exist_ok=True)
    moved = 0
    for entry in weak:
        try:
            entry["path"].rename(holding / entry["path"].name)
        except OSError as err:
            print(f"  could not hold back {entry['path'].name}: {err}", flush=True)
            continue
        entry["held"] = True
        entry["path"] = holding / entry["path"].name
        moved += 1

    if moved:
        reasons = "\n".join(
            f"  {e['name']}  {e['quality']:.0f}/10  {e['note'] or e['room']}"
            for e in weak if e.get("held")
        )
        (holding / "WHY THESE ARE HERE.txt").write_text(
            "These photographs were held back automatically.\n\n"
            "Nothing has been deleted. They are the originals, and they were kept out of the\n"
            "shapes, the watermarked set, the videos and the CRM because they scored below the\n"
            f"floor set in Admin, Settings, AI features (currently {floor:.0f} out of 10).\n\n"
            f"{reasons}\n\n"
            "To publish one anyway, move it back up into PHOTOS and press Finish again.\n"
            "To stop this happening at all, set the floor to 0.\n",
            encoding="utf-8",
        )
    return moved


def write_copy(root: Path, unit: str, facts: dict, entries: list[dict]) -> bool:
    """Rewrite the descriptions file with what the photographs actually show.

    Six pieces of writing rather than one. The title and description do the same
    job on a portal that a caption does on Instagram, and pretending otherwise
    produces text that is wrong in both places. Each portal then gets its own
    version, because 99acres rewards density and Housing rewards locality, and
    pasting one paragraph into three sites is how a listing ends up middling
    everywhere.

    Tone, language and the sign-off all come from the house style in Admin. This
    prompt carries the task; the CRM carries the voice.
    """
    rules = crm.style()["style"]
    fact_lines = "\n".join(f"{k}: {v}" for k, v in facts.items()) or "None supplied."
    rooms = "\n".join(
        f"{e['position']:02d}. {e['room']} — {e['note']}" for e in entries if e.get("note")
    )
    portal_briefs = "\n".join(f'  "{p["key"]}" — {p["brief"]}' for p in PORTALS)

    prompt = (
        f"WHAT THE OWNER RECORDS ABOUT THIS PROPERTY:\n{fact_lines}\n\n"
        f"WHAT THE PHOTOGRAPHS SHOW:\n{rooms}\n\n"
        "Write the listing copy for buyers in Faridabad. Use only the facts above. "
        f"Every piece should end by pointing them at: {rules['signOff']}\n\n"
        "Return JSON with exactly these keys:\n"
        '  "title"       one line, under 70 characters, for a portal listing and a YouTube title\n'
        '  "description" three or four short paragraphs for your own website, plain text\n'
        f'  "caption"     for Instagram, Facebook and WhatsApp. {rules["captionTone"]}\n'
        '  "hashtags"    eight to twelve hashtags on one line, Faridabad and property relevant\n'
        '  "portals"     an object, one key per portal below, each a full listing description:\n'
        f"{portal_briefs}\n"
        '  "hindi"       an object with "caption" and "description", the same thing in Hindi for '
        "WhatsApp forwards. Devanagari script here, this one is meant to be read rather than spoken.\n"
    )
    answer = crm.parse_json(crm.text(prompt, system=crm.system_prompt(ROLE), max_tokens=4000))
    if not isinstance(answer, dict) or not answer.get("title"):
        print("  copy: model returned nothing usable; leaving the existing file alone", flush=True)
        return False

    path = root / f"{unit}-DESCRIPTIONS.txt"
    if not path.is_file():
        print(f"  copy: {path.name} does not exist yet; leaving it to the CRM", flush=True)
        return False

    original = path.read_text(encoding="utf-8", errors="replace")
    updated = _replace_sections(original, answer)
    if updated == original:
        print("  copy: nothing to replace in the descriptions file", flush=True)
        return False
    path.write_text(updated, encoding="utf-8")
    print(f"  copy: rewrote {path.name} from what the photographs show", flush=True)
    return True


# What a section heading looks like in the descriptions file. Digits and dots
# are in there because two of the portals are called 99acres and Housing.com,
# and a pattern that only allowed letters silently matched neither — which reads
# as the model not answering rather than as a regular expression being wrong.
HEADING = r"[A-Z0-9][A-Z0-9 .&/-]*"


def _replace_sections(text: str, answer: dict) -> str:
    """Swap the written blocks, leaving the folder map and the facts alone.

    Rewriting the whole file here would mean this script owning the layout as
    well, and then two places would decide what the file looks like. The CRM
    writes the structure; this replaces the words inside it.
    """
    def block(name: str, value: str) -> None:
        nonlocal text
        pattern = re.compile(
            rf"(^{re.escape(name)}\n-{{10,}}\n(?:.*\n)*?\n)"
            rf"((?:  .*\n|\n)*?)"
            rf"(?=^{HEADING}\n-{{10,}}|^{HEADING}\n={{10,}})",
            re.MULTILINE,
        )
        body = "".join(f"  {line}\n" if line.strip() else "\n" for line in value.split("\n"))
        replaced, count = pattern.subn(lambda m: m.group(1) + body + "\n", text, count=1)
        if count:
            text = replaced
        else:
            print(f"  copy: no {name} section to replace", flush=True)

    block("TITLE", str(answer.get("title", "")))
    block("DESCRIPTION", str(answer.get("description", "")))
    block("CAPTION", str(answer.get("caption", "")))
    block("HASHTAGS", str(answer.get("hashtags", "")))

    portals = answer.get("portals")
    if isinstance(portals, dict):
        for portal in PORTALS:
            body = portals.get(portal["key"])
            if isinstance(body, str) and body.strip():
                block(portal["heading"], body.strip())

    hindi = answer.get("hindi")
    if isinstance(hindi, dict):
        both = "\n\n".join(
            str(hindi[k]).strip() for k in ("caption", "description")
            if isinstance(hindi.get(k), str) and hindi[k].strip()
        )
        if both:
            block("HINDI", both)
    return text


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: name_and_describe.py <property-root> [unit] [facts-json]", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    unit = (sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else unit_of(root)).upper()
    facts = {}
    if len(sys.argv) > 3 and sys.argv[3]:
        try:
            facts = json.loads(sys.argv[3])
        except json.JSONDecodeError:
            print("  facts were not valid JSON; carrying on without them", flush=True)

    photos_dir = root / f"{unit}-RAW-UPLOADS" / "PHOTOS"
    if not photos_dir.is_dir():
        print(f"no photo folder at {photos_dir}", flush=True)
        return 0

    index_path = root / f"{unit}-PHOTO-INDEX.json"
    photos = sorted(p for p in photos_dir.iterdir()
                    if p.is_file() and p.suffix.lower() in PHOTO_SUFFIXES
                    and not p.name.startswith("."))
    if not photos:
        print("no photos to look at", flush=True)
        return 0

    # Already named means already done. The index is the record, and its absence
    # is what makes a rerun do the work again.
    already = {p.name for p in photos if re.match(rf"^{re.escape(unit)}-\d\d-", p.name)}
    if index_path.is_file() and len(already) == len(photos):
        print(f"{len(photos)} photos already named; nothing to do", flush=True)
        return 0

    if not crm.configured():
        print("CRM_URL or CRM_N8N_SECRET is not set; photos keep their camera names", flush=True)
        return 0

    print(f"looking at {len(photos)} photo(s)", flush=True)
    entries = look_at_photos(photos, facts)
    if not entries:
        print("no usable answer from the model; photos keep their camera names", flush=True)
        return 0

    ordered = rename_in_order(entries, unit)
    held = cull(ordered, root, unit)
    for entry in ordered:
        mark = "  held back" if entry.get("held") else ""
        print(f"  {entry['position']:02d} {entry['name']}  ({entry['room']}, {entry['quality']:.0f}/10){mark}", flush=True)
    if held:
        print(f"  {held} photo(s) held back; they are still in {unit}-RAW-UPLOADS", flush=True)

    index_path.write_text(json.dumps([
        {k: (str(v) if k == "path" else v) for k, v in e.items()} for e in ordered
    ], indent=2) + "\n", encoding="utf-8")

    write_copy(root, unit, facts, [e for e in ordered if not e.get("held")])
    print(f"named {len(ordered)} photo(s)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
