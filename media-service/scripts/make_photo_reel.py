#!/usr/bin/env python3
"""A vertical reel cut from the property's own photographs.

No frame here is generated. Every pixel came off his camera. What the reel adds
is movement, order, timing and a voice — the four things a photograph cannot do
and a video editor charges for.

How it decides:

* **Which photographs.** The vision pass scored every shot out of ten and named
  the room. This takes the best of each room rather than the best overall, so a
  reel never opens with three angles of the same balcony while the kitchen never
  appears.
* **How long each one holds.** Long enough to read the room, short enough to
  keep moving, and always landing on a beat in the music.
* **Which way it moves.** A wide photograph travels across, because he shoots
  rooms horizontally and a 9:16 crop of a horizontal room is a strip of wall. A
  tall one pushes in.

Everything degrades. No music, no beat grid, cut on a stopwatch. No voice, the
music carries it. No vision index, the photographs run in filename order with no
room labels. A property with photos always gets a reel.

  make_photo_reel.py <property-root> [unit] [facts-json] [seconds]
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import crm  # noqa: E402
import reelkit as kit  # noqa: E402

DEFAULT_SECONDS = 32
# Under this a reel is a teaser and nobody learns anything; over it the drop-off
# on a phone is brutal. Twelve rooms at about two and a half seconds each.
MIN_SHOTS, MAX_SHOTS = 4, 14

ROLE = "You are a senior real-estate listing writer in Faridabad, India."


def unit_of(folder: Path) -> str:
    return (folder.name.split("-")[0] or "PROPERTY").upper()


def photo_index(root: Path, unit: str) -> list[dict]:
    """What the vision pass found, or a plain filename ordering if it never ran."""
    index = root / f"{unit}-PHOTO-INDEX.json"
    photos_dir = root / f"{unit}-SHAPES" / "4x3"
    if not photos_dir.is_dir():
        photos_dir = root / f"{unit}-RAW-UPLOADS" / "PHOTOS"

    if index.is_file():
        try:
            entries = json.loads(index.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            entries = []
        out = []
        for entry in entries:
            stem = Path(str(entry.get("name") or entry.get("path") or "")).stem
            match = next((p for p in photos_dir.glob(f"{stem}.*")), None)
            if match:
                out.append({"path": match, "room": entry.get("room", ""),
                            "quality": float(entry.get("quality") or 5),
                            "hero": bool(entry.get("hero")),
                            "note": entry.get("note", "")})
        if out:
            return out

    return [{"path": p, "room": "", "quality": 5.0, "hero": False, "note": ""}
            for p in sorted(photos_dir.glob("*.jpg"))]


def choose(entries: list[dict], wanted: int) -> list[dict]:
    """The best shot of each room first, then the next best, and so on.

    A straight top-N by score gives four photographs of whichever room happened
    to photograph well and none of the rest of the flat. Going round the rooms
    in turn is what makes it read as a tour.
    """
    by_room: dict[str, list[dict]] = {}
    for entry in entries:
        by_room.setdefault(entry["room"].lower() or "other", []).append(entry)
    for shots in by_room.values():
        shots.sort(key=lambda e: -e["quality"])

    hero = next((e for e in entries if e["hero"]), None)
    chosen: list[dict] = [hero] if hero else []
    rounds = 0
    while len(chosen) < wanted and rounds < 6:
        for room in sorted(by_room, key=lambda r: -max(e["quality"] for e in by_room[r])):
            if len(chosen) >= wanted:
                break
            for shot in by_room[room]:
                if shot not in chosen:
                    chosen.append(shot)
                    break
        rounds += 1
    return chosen[:wanted]


def script_for(facts: dict, entries: list[dict]) -> str | None:
    """The voiceover, in whatever language the house style asks for."""
    rules = crm.style()["style"]
    fact_lines = "\n".join(f"{k}: {v}" for k, v in facts.items()) or "None supplied."
    rooms = "\n".join(f"- {e['room']}: {e['note']}" for e in entries if e.get("note")) or "Not described."
    prompt = (
        f"WHAT THE OWNER RECORDS ABOUT THIS PROPERTY:\n{fact_lines}\n\n"
        f"WHAT THE VIDEO SHOWS, in order:\n{rooms}\n\n"
        "Write the voiceover for a 30 second property reel for buyers in Faridabad.\n\n"
        "Rules:\n"
        f"- {rules['voiceLanguage']}\n"
        "- 60 to 75 words. It has to fit in 30 seconds at a calm pace.\n"
        "- Only the facts above. Do not invent an area, a floor, a direction, an amenity, "
        "a landmark or a price.\n"
        "- Open with what the property is.\n"
        f"- Close with: {rules['signOff']}\n"
        "- No emoji, no hashtags, no stage directions, no speaker labels.\n\n"
        'Return JSON: {"script": "..."}'
    )
    answer = crm.parse_json(crm.text(prompt, max_tokens=800))
    if isinstance(answer, dict) and answer.get("script"):
        return str(answer["script"]).strip()
    return None


def headline(facts: dict, unit: str) -> list[tuple[str, int]]:
    bits = [facts.get(k, "") for k in ("Configuration", "Type", "Locality", "City")]
    line = " · ".join(b for b in bits if b) or unit
    price = facts.get("Price") or facts.get("Base Price") or ""
    lines = [(facts.get("Unit") or unit, 96), (line, 46)]
    if price:
        lines.append((price, 58))
    return lines


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: make_photo_reel.py <property-root> [unit] [facts-json] [seconds]", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    unit = (sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else unit_of(root)).upper()
    facts: dict = {}
    if len(sys.argv) > 3 and sys.argv[3]:
        try:
            facts = json.loads(sys.argv[3])
        except json.JSONDecodeError:
            pass
    target = float(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else DEFAULT_SECONDS

    entries = photo_index(root, unit)
    if len(entries) < MIN_SHOTS:
        print(f"only {len(entries)} photo(s); not enough for a reel", flush=True)
        return 0

    out_dir = root / f"{unit}-VIDEO"
    out_dir.mkdir(parents=True, exist_ok=True)
    final = out_dir / f"{unit}-reel-9x16.mp4"

    # The photographs are the record. If the reel is newer than all of them,
    # nothing has changed and rebuilding it is thirty seconds of nothing.
    if final.is_file() and all(final.stat().st_mtime >= e["path"].stat().st_mtime for e in entries):
        print(f"{final.name} is already up to date", flush=True)
        return 0

    wanted = max(MIN_SHOTS, min(MAX_SHOTS, int(target // 2.5)))
    chosen = choose(entries, wanted)
    print(f"building a {target:.0f}s reel from {len(chosen)} of {len(entries)} photo(s)", flush=True)

    work = Path(tempfile.mkdtemp(prefix="reel-"))
    try:
        # Voice first: the music has to be at least as long as the speech, and
        # the speech length is not known until it exists.
        voice_path = None
        script = script_for(facts, chosen)
        if script:
            print(f"  voiceover: {script[:90]}...", flush=True)
            audio = crm.speech(script, speed=0.96)
            if audio:
                voice_path = work / "voice.mp3"
                voice_path.write_bytes(audio)
                spoken = kit.probe(voice_path)
                if spoken and spoken.duration > target:
                    # A voice that runs long is not trimmed, the reel grows. A
                    # sentence cut off mid-word is worse than four extra seconds.
                    target = spoken.duration + 2.5
                    print(f"  voice runs {spoken.duration:.1f}s; reel extended to {target:.0f}s", flush=True)

        music_path = None
        bed = crm.music(crm.style()["style"]["musicBrief"], seconds=int(min(120, max(20, target))))
        if bed:
            music_path = work / "music.mp3"
            music_path.write_bytes(bed)

        grid = kit.beat_grid(music_path) if music_path else []
        title_seconds = 2.2
        end_seconds = 2.0
        body = max(6.0, target - title_seconds - end_seconds)
        per_shot = body / len(chosen)
        durations = kit.shot_times(grid, per_shot, len(chosen)) if grid else [per_shot] * len(chosen)

        clips: list[Path] = []
        title = work / "00-title.mp4"
        if kit.card(title, title_seconds, headline(facts, unit),
                    background=chosen[0]["path"]):
            clips.append(title)

        for position, (entry, seconds) in enumerate(zip(chosen, durations)):
            clip = work / f"{position + 1:02d}.mp4"
            if kit.photo_shot(entry["path"], clip, seconds, position, entry["room"]):
                clips.append(clip)
                print(f"  {position + 1:02d} {entry['path'].name} {seconds:.1f}s"
                      f"{' · ' + entry['room'] if entry['room'] else ''}", flush=True)

        end = work / "99-end.mp4"
        # The closing line comes from the house style, so changing how the
        # business signs off changes it on the videos too rather than only in
        # the captions.
        sign_off = crm.style()["style"]["signOff"]
        if kit.card(end, end_seconds, [("iPropy", 92), (sign_off, 42)]):
            clips.append(end)

        if len(clips) < 2:
            print("nothing rendered", flush=True)
            return 1

        silent = work / "silent.mp4"
        if not kit.crossfade(clips, silent):
            return 1
        if not kit.add_sound(silent, final, voice_path, music_path):
            return 1

        # Taken from the title card once it has stopped animating, not from the
        # first second. This frame is the thumbnail WhatsApp and Instagram show
        # before anyone presses play, and at 0.8s it caught the price still
        # fading up — the one line that most needs to be readable there.
        kit.cover_frame(final, out_dir / f"{unit}-reel-cover.jpg", at=kit.settled(title_seconds))
        info = kit.probe(final)
        print(f"created {final.name} — {info.duration:.1f}s" if info else f"created {final.name}", flush=True)
        return 0
    finally:
        kit.cleanup()
        for path in work.glob("*"):
            path.unlink(missing_ok=True)
        work.rmdir()


if __name__ == "__main__":
    raise SystemExit(main())
