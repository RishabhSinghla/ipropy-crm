#!/usr/bin/env python3
"""Cut the walkthrough he actually shot into the version he wishes he had shot.

This is the half of the job that does not need a video model at all. The footage
exists and it is real. What it needs is an editor: somebody to watch it, throw
away the thirty seconds of pointing at the floor while walking between rooms,
keep the ten seconds where the living room reads properly, steady the handheld
wobble, lift the shadows a builder floor always has, and put a name on each room.

So a vision model watches it — frame by frame, with timestamps — and writes the
shot list. ffmpeg executes the shot list. Nothing is generated, nothing is
invented, and the result is his footage with the dead air taken out.

Order stays chronological on purpose. A walkthrough is a walk, and reordering it
so the best room comes first breaks the one thing a walkthrough has that a
photo reel does not: you can tell how the flat connects together.

  edit_walkthrough.py <property-root> [unit] [facts-json] [seconds]
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import crm  # noqa: E402
import reelkit as kit  # noqa: E402

VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".avi", ".mkv"}
DEFAULT_SECONDS = 55
# One frame every three seconds is enough to tell a room from a corridor and
# cheap enough that a three minute walkthrough is sixty pictures.
SAMPLE_EVERY = 3.0
BATCH = 8
MIN_SEGMENT, MAX_SEGMENT = 2.2, 6.0

MUSIC_BRIEF = (
    "Calm, elegant, understated instrumental for a luxury property walkthrough. "
    "Warm piano or soft strings, light steady pulse, no drop and nothing dramatic. "
    "It should sit under a speaking voice."
)

SYSTEM = (
    "You are a senior real-estate video editor. You are watching frames from a "
    "walkthrough of a real flat that buyers will physically visit. Judge only what is "
    "visible. Never describe furniture, fittings, views or finishes that are not in the "
    "frame. Reply with JSON only."
)


def unit_of(folder: Path) -> str:
    return (folder.name.split("-")[0] or "PROPERTY").upper()


def find_walkthrough(root: Path, unit: str) -> Path | None:
    """The longest video in the raw folder, which is the walkthrough.

    Longest rather than newest: people shoot a couple of five second clips of a
    switchboard and one two minute walk, and only the walk is the walkthrough.
    """
    folder = root / f"{unit}-RAW-UPLOADS" / "VIDEOS"
    if not folder.is_dir():
        return None
    best, best_duration = None, 0.0
    for path in sorted(folder.iterdir()):
        if not path.is_file() or path.suffix.lower() not in VIDEO_SUFFIXES:
            continue
        info = kit.probe(path)
        if info and info.duration > best_duration:
            best, best_duration = path, info.duration
    return best


def sample_frames(video: Path, duration: float, work: Path) -> list[tuple[float, Path]]:
    """One small JPEG every few seconds, with the time it came from."""
    frames: list[tuple[float, Path]] = []
    at = 1.0
    index = 0
    while at < duration - 0.5:
        target = work / f"frame-{index:04d}.jpg"
        ok = kit.ffmpeg([
            "-ss", f"{at:.2f}", "-i", str(video), "-frames:v", "1",
            "-vf", "scale=1024:-2:flags=lanczos", "-q:v", "4", str(target),
        ], timeout=120)
        if ok and target.is_file():
            frames.append((round(at, 2), target))
        at += SAMPLE_EVERY
        index += 1
    return frames


def watch(frames: list[tuple[float, Path]], facts: dict) -> list[dict]:
    """Ask what each moment shows and whether it is worth keeping."""
    fact_lines = "\n".join(f"{k}: {v}" for k, v in facts.items()) or "None supplied."
    judged: list[dict] = []

    for start in range(0, len(frames), BATCH):
        chunk = frames[start:start + BATCH]
        listing = "\n".join(f"{i + 1}. at {t:.1f} seconds" for i, (t, _) in enumerate(chunk))
        prompt = (
            f"WHAT THE OWNER RECORDS ABOUT THIS PROPERTY:\n{fact_lines}\n\n"
            f"These are frames from one continuous walkthrough video, in order:\n{listing}\n\n"
            "For each frame, in the same order, return an object with:\n"
            '  "at"      the timestamp given above, as a number\n'
            '  "room"    what is on screen in two or three words, e.g. "living room", '
            '"kitchen", "master bedroom", "balcony", "corridor", "staircase", "entrance"\n'
            '  "keep"    1 to 10. 10 means a steady, well lit, well framed view of a room a '
            "buyer wants to see. 1 means the camera is pointing at the floor, at a blank wall, "
            "is badly blurred, is mid-turn, or shows nothing about the property.\n"
            '  "note"    one short sentence about what is actually visible\n\n'
            "Return a JSON array and nothing else."
        )
        answer = crm.parse_json(crm.vision(
            prompt, [path.read_bytes() for _, path in chunk], system=SYSTEM, max_tokens=3000,
        ))
        if not isinstance(answer, list):
            continue
        for index, item in enumerate(answer):
            if not isinstance(item, dict):
                continue
            at = item.get("at")
            if not isinstance(at, (int, float)) and index < len(chunk):
                at = chunk[index][0]
            judged.append({
                "at": float(at or 0),
                "room": str(item.get("room") or "").strip(),
                "keep": float(item.get("keep") or 5),
                "note": str(item.get("note") or "").strip(),
            })
    return sorted(judged, key=lambda j: j["at"])


def build_segments(judged: list[dict], duration: float, target: float) -> list[dict]:
    """Turn per-frame scores into the runs of footage worth keeping.

    Consecutive frames showing the same room are one shot, not several. A shot
    is then worth keeping on its best moment rather than its average: a room
    that reads well for three seconds inside eight seconds of wandering is
    still a good three seconds.
    """
    if not judged:
        return []

    runs: list[dict] = []
    for frame in judged:
        room = frame["room"].lower()
        if runs and runs[-1]["room"].lower() == room and frame["at"] - runs[-1]["end"] <= SAMPLE_EVERY * 1.6:
            runs[-1]["end"] = frame["at"]
            runs[-1]["best"] = max(runs[-1]["best"], frame["keep"])
            if frame["keep"] >= runs[-1]["best"]:
                runs[-1]["peak"] = frame["at"]
                runs[-1]["note"] = frame["note"] or runs[-1]["note"]
        else:
            runs.append({
                "room": frame["room"], "start": frame["at"], "end": frame["at"],
                "best": frame["keep"], "peak": frame["at"], "note": frame["note"],
            })

    # A corridor is not a room anybody drove across town to see. Kept only when
    # there is nothing else, which the score already handles.
    keepers = [r for r in runs if r["best"] >= 5.0] or runs
    keepers.sort(key=lambda r: -r["best"])

    chosen: list[dict] = []
    running = 0.0
    for run in keepers:
        if running >= target:
            break
        # Centre the clip on the best moment rather than starting where the run
        # started: the first second of a room is usually the camera arriving.
        span = min(MAX_SEGMENT, max(MIN_SEGMENT, (run["end"] - run["start"]) or MIN_SEGMENT))
        start = max(0.0, min(run["peak"] - span * 0.35, duration - span))
        chosen.append({**run, "clip_start": round(start, 2), "clip_seconds": round(span, 2)})
        running += span

    chosen.sort(key=lambda r: r["clip_start"])
    return chosen


def has_vidstab() -> bool:
    result = kit.run(["ffmpeg", "-hide_banner", "-filters"], timeout=60)
    return "vidstabtransform" in result.stdout


def cut_segment(video: Path, out: Path, start: float, seconds: float,
                label: str, stabilise: bool, work: Path, index: int) -> bool:
    """One piece of the walkthrough, steadied, graded, and framed vertically."""
    filters: list[str] = []

    if stabilise:
        # Two passes: find the shake, then take it out. The transforms file is
        # per-segment because the analysis is only valid for the frames it saw.
        transforms = work / f"stab-{index:02d}.trf"
        analysed = kit.ffmpeg([
            "-ss", f"{start:.2f}", "-t", f"{seconds:.2f}", "-i", str(video),
            "-vf", f"vidstabdetect=shakiness=6:accuracy=12:result={transforms}",
            "-f", "null", "-",
        ], timeout=600)
        if analysed and transforms.is_file():
            filters.append(
                f"vidstabtransform=input={transforms}:zoom=1:smoothing=24:optzoom=1,unsharp=5:5:0.6"
            )
    if not filters:
        filters.append("deshake=rx=24:ry=24")

    filters += [
        # Restrained on purpose. A builder floor is grey concrete and warm tube
        # light; the job is to make that look like the room it is, not to grade
        # it into somewhere else.
        "eq=contrast=1.07:saturation=1.09:gamma=1.03:brightness=0.015",
        f"scale={kit.REEL_W}:{kit.REEL_H}:force_original_aspect_ratio=increase:flags=lanczos",
        f"crop={kit.REEL_W}:{kit.REEL_H}",
        f"fps={kit.FPS}",
    ]

    if label:
        filters.append(
            f"drawbox=x=64:y={kit.REEL_H - 300}:w=90:h=5:color=white@0.9:t=fill:"
            f"enable='between(t,0.4,{max(0.5, seconds - 0.4)})'"
        )
        filters.append(kit.drawtext(
            label.upper(), size=46, x="64", y=str(kit.REEL_H - 262),
            colour="white", start=0.4, end=max(0.5, seconds - 0.4),
        ))
    filters.append("format=yuv420p")

    return kit.ffmpeg([
        "-ss", f"{start:.2f}", "-t", f"{seconds:.2f}", "-i", str(video),
        "-vf", ",".join(filters),
        "-r", str(kit.FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "19",
        "-pix_fmt", "yuv420p", "-an", str(out),
    ], timeout=900)


def script_for(facts: dict, segments: list[dict], seconds: float) -> str | None:
    fact_lines = "\n".join(f"{k}: {v}" for k, v in facts.items()) or "None supplied."
    rooms = "\n".join(f"- {s['room']}: {s['note']}" for s in segments if s.get("note")) or "Not described."
    words = int(seconds * 2.3)
    prompt = (
        f"WHAT THE OWNER RECORDS ABOUT THIS PROPERTY:\n{fact_lines}\n\n"
        f"WHAT THE WALKTHROUGH SHOWS, in order:\n{rooms}\n\n"
        f"Write the voiceover for a {seconds:.0f} second property walkthrough for buyers in Faridabad.\n\n"
        "Rules:\n"
        "- Hinglish. Natural spoken Hindi-English mixing, the way a Delhi NCR property "
        "consultant actually talks to a client. Latin script, not Devanagari.\n"
        f"- About {words} words, so it fits in {seconds:.0f} seconds at a calm pace.\n"
        "- Walk the viewer through in the order above.\n"
        "- Only the facts given. Do not invent an area, a floor, a direction, an amenity, "
        "a landmark or a price.\n"
        "- Close by asking them to message for a visit.\n"
        "- No emoji, no hashtags, no stage directions, no speaker labels.\n\n"
        'Return JSON: {"script": "..."}'
    )
    answer = crm.parse_json(crm.text(prompt, system=SYSTEM, max_tokens=1200))
    if isinstance(answer, dict) and answer.get("script"):
        return str(answer["script"]).strip()
    return None


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: edit_walkthrough.py <property-root> [unit] [facts-json] [seconds]", file=sys.stderr)
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

    source = find_walkthrough(root, unit)
    if not source:
        print("no walkthrough video to edit", flush=True)
        return 0
    info = kit.probe(source)
    if not info or info.duration < 6:
        print(f"{source.name} is too short to cut", flush=True)
        return 0

    out_dir = root / f"{unit}-VIDEO"
    out_dir.mkdir(parents=True, exist_ok=True)
    final = out_dir / f"{unit}-walkthrough-9x16.mp4"
    if final.is_file() and final.stat().st_mtime >= source.stat().st_mtime:
        print(f"{final.name} is already up to date", flush=True)
        return 0

    print(f"editing {source.name} — {info.duration:.0f}s of footage into about {target:.0f}s", flush=True)
    work = Path(tempfile.mkdtemp(prefix="walk-"))
    try:
        segments: list[dict] = []
        if crm.configured():
            frames = sample_frames(source, info.duration, work)
            print(f"  watching {len(frames)} moment(s)", flush=True)
            segments = build_segments(watch(frames, facts), info.duration, target)

        if not segments:
            # No model, or it said nothing useful. An even sample across the
            # footage is a poor edit and still far better than a raw two minute
            # handheld clip nobody watches past ten seconds.
            print("  no shot list; taking an even sample instead", flush=True)
            count = max(4, int(target // 3.5))
            step = info.duration / count
            segments = [{
                "room": "", "note": "",
                "clip_start": round(i * step, 2),
                "clip_seconds": round(min(3.5, step), 2),
            } for i in range(count)]

        stabilise = has_vidstab()
        print(f"  {len(segments)} shot(s), stabilising with {'vidstab' if stabilise else 'deshake'}", flush=True)

        clips: list[Path] = []
        for index, segment in enumerate(segments):
            clip = work / f"seg-{index:02d}.mp4"
            if cut_segment(source, clip, segment["clip_start"], segment["clip_seconds"],
                           segment.get("room", ""), stabilise, work, index):
                clips.append(clip)
                print(f"  {index + 1:02d} {segment['clip_start']:6.1f}s +{segment['clip_seconds']:.1f}s"
                      f"{'  ' + segment['room'] if segment.get('room') else ''}", flush=True)

        if not clips:
            print("nothing rendered", flush=True)
            return 1

        body = sum(s["clip_seconds"] for s in segments)
        end = work / "end.mp4"
        if kit.card(end, 2.0, [
            ("iPropy", 92),
            ("Message us for the floor plan", 42),
            ("and a site visit", 42),
        ]):
            clips.append(end)

        voice_path = None
        script = script_for(facts, segments, body)
        if script:
            audio = crm.speech(script, speed=0.96)
            if audio:
                voice_path = work / "voice.mp3"
                voice_path.write_bytes(audio)

        music_path = None
        bed = crm.music(MUSIC_BRIEF, seconds=int(min(120, max(20, body + 4))))
        if bed:
            music_path = work / "music.mp3"
            music_path.write_bytes(bed)

        silent = work / "silent.mp4"
        if not kit.crossfade(clips, silent, fade=0.25):
            return 1
        if not kit.add_sound(silent, final, voice_path, music_path):
            return 1

        kit.cover_frame(final, out_dir / f"{unit}-walkthrough-cover.jpg")
        done = kit.probe(final)
        print(f"created {final.name} — {done.duration:.1f}s" if done else f"created {final.name}", flush=True)
        return 0
    finally:
        kit.cleanup()
        for path in sorted(work.rglob("*"), reverse=True):
            path.unlink(missing_ok=True) if path.is_file() else path.rmdir()
        work.rmdir()


if __name__ == "__main__":
    raise SystemExit(main())
