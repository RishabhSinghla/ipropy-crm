"""The editing bench: what every property video is built out of.

Two videos come out of one property. One is cut from photographs, one is cut
from the walkthrough somebody actually shot. They want the same things — a
frame that moves, cuts that land on the music, a room named in the corner, a
voice over the top — so those live here once rather than twice.

The rule the whole file is built around: **nothing is invented.** No frame is
generated, no room is furnished, no view is added. Every pixel came off his
camera. What this does is choose, move, time and finish, which is what an editor
does and is where the difference between a slideshow and a reel actually lives.
"""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

REEL_W, REEL_H, FPS = 1080, 1920, 30

# drawtext does not fall back to a system default; with no font file it fails
# the render outright.
#
# DejaVu before the prettier Liberation Sans for one reason: **the rupee sign.**
# Liberation Sans has no glyph for U+20B9 and draws an empty box instead, so
# every price on every title card came out as "☐ 1.45 Cr". Worth knowing that
# Pillow reports the font as having the glyph — `getmask("₹").getbbox()` returns
# a box because .notdef *is* a box — so the only test that means anything is
# rendering it and looking.
FONT = next(
    (p for p in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    ) if Path(p).is_file()),
    "",
)
FONT_LIGHT = next(
    (p for p in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ) if Path(p).is_file()),
    FONT,
)

LOGO = next(
    (p for p in ("/app/iPropy-Logo-1.jpeg",) if Path(p).is_file()),
    "",
)


def run(args: list[str], timeout: int = 1800) -> subprocess.CompletedProcess[str]:
    # `errors="replace"` because ffprobe echoes the file's own metadata, and a
    # video off a phone carries tags in whatever encoding the phone felt like.
    # One stray byte in a title tag otherwise raises UnicodeDecodeError out of
    # subprocess itself, which reads as "the editor crashed" rather than as
    # "the camera wrote Latin-1".
    return subprocess.run(
        args, capture_output=True, text=True, errors="replace", check=False, timeout=timeout,
    )


def ffmpeg(args: list[str], timeout: int = 1800) -> bool:
    completed = run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args], timeout)
    if completed.returncode != 0:
        print(f"    ffmpeg: {completed.stderr.strip().splitlines()[-1][:200] if completed.stderr.strip() else 'failed'}", flush=True)
        return False
    return True


@dataclass
class Media:
    width: int
    height: int
    duration: float
    fps: float

    @property
    def landscape(self) -> bool:
        return self.width > self.height * 1.15


def probe(path: Path) -> Media | None:
    """Dimensions as they will *display*, which is not what the stream says.

    A phone writes a rotation tag rather than rotating the pixels. Reading
    width and height straight off the stream gets a vertical walkthrough
    backwards, and everything downstream then letterboxes a video that was
    already the right shape.
    """
    completed = run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries",
        "stream=width,height,r_frame_rate:stream_side_data=rotation:format=duration",
        "-of", "json", str(path),
    ], timeout=120)
    if completed.returncode != 0:
        return None
    try:
        data = json.loads(completed.stdout)
        stream = data["streams"][0]
    except (json.JSONDecodeError, KeyError, IndexError):
        return None

    width, height = int(stream.get("width") or 0), int(stream.get("height") or 0)
    rotation = 0
    for side in stream.get("side_data_list", []) or []:
        if "rotation" in side:
            rotation = int(side["rotation"])
    if abs(rotation) % 180 == 90:
        width, height = height, width

    rate = str(stream.get("r_frame_rate") or "0/1")
    try:
        num, _, den = rate.partition("/")
        fps = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        fps = 30.0
    duration = float((data.get("format") or {}).get("duration") or 0)
    return Media(width or 1, height or 1, duration, fps or 30.0)


# ---------------------------------------------------------------------------
# Where the beats are
# ---------------------------------------------------------------------------

def beat_grid(audio: Path, fallback_seconds: float = 2.4) -> list[float]:
    """The times to cut on, in seconds from the start of the track.

    Onset strength, then a period, then a phase. Spectral flux — how much the
    sound changed between one short window and the next — spikes on a drum hit,
    a chord change or a note attack, so its autocorrelation peaks at the beat
    period whether or not there are drums. The phase is whichever offset within
    that period the spikes actually land on.

    A regular grid rather than the raw onsets on purpose: cutting on every
    detected onset produces a stutter, and a listener hears the pulse the grid
    implies, not the individual hits.

    Falls back to a fixed spacing when numpy is missing or the track is too
    quiet to read. A reel cut on a stopwatch is worse than one cut on the beat
    and much better than no reel.
    """
    def fixed(total: float) -> list[float]:
        count = max(2, int(total / fallback_seconds) + 1)
        return [round(i * fallback_seconds, 3) for i in range(count)]

    info = probe(audio)
    total = info.duration if info else 0.0

    try:
        import numpy as np
    except ImportError:
        print("    numpy missing; cutting on a fixed rhythm", flush=True)
        return fixed(total or 60.0)

    sample_rate = 22050
    decoded = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(audio), "-ac", "1",
         "-ar", str(sample_rate), "-f", "f32le", "-"],
        capture_output=True, check=False, timeout=300,
    )
    if decoded.returncode != 0 or len(decoded.stdout) < sample_rate * 4:
        return fixed(total or 60.0)
    samples = np.frombuffer(decoded.stdout, dtype=np.float32)

    hop, window = 512, 1024
    count = 1 + (samples.size - window) // hop
    if count < 8:
        return fixed(total or 60.0)

    frames = np.lib.stride_tricks.as_strided(
        samples, shape=(count, window), strides=(samples.strides[0] * hop, samples.strides[0]),
    ) * np.hanning(window).astype(np.float32)
    spectra = np.abs(np.fft.rfft(frames, axis=1))
    flux = np.maximum(0.0, np.diff(spectra, axis=0)).sum(axis=1)
    # Take the local average off before correlating, or the loudest section of
    # the track dominates and the period comes out of nowhere.
    flux = flux - np.convolve(flux, np.ones(16) / 16, mode="same")
    flux = np.maximum(0.0, flux)
    if not np.any(flux):
        return fixed(total or 60.0)

    per_second = sample_rate / hop
    lag_low, lag_high = int(per_second * 60 / 180), int(per_second * 60 / 60)
    correlation = np.correlate(flux, flux, mode="full")[flux.size - 1:]
    band = correlation[lag_low:lag_high]
    if band.size == 0:
        return fixed(total or 60.0)
    period = int(np.argmax(band)) + lag_low

    phase = max(range(period), key=lambda offset: float(flux[offset::period].sum()))
    seconds_per_beat = period / per_second
    duration = total or (samples.size / sample_rate)
    start = phase / per_second
    grid = []
    time = start
    while time < duration:
        grid.append(round(time, 3))
        time += seconds_per_beat
    print(f"    beat: {60 / seconds_per_beat:.0f} BPM, {len(grid)} beats", flush=True)
    return grid if len(grid) > 4 else fixed(duration)


def shot_times(grid: list[float], target_seconds: float, count: int) -> list[float]:
    """Cut points for `count` shots, each about `target_seconds`, on the beat.

    Every shot lands on a beat and the durations differ slightly because the
    beats do. That unevenness is the point: identical shot lengths are what make
    a slideshow read as a slideshow.
    """
    if len(grid) < 4:
        return [target_seconds] * count
    step = max(1, round(target_seconds / max(0.05, grid[1] - grid[0])))
    out: list[float] = []
    index = 0
    for _ in range(count):
        nxt = min(index + step, len(grid) - 1)
        span = grid[nxt] - grid[index]
        if span < 0.8:  # ran off the end of the track
            out.append(target_seconds)
        else:
            out.append(round(span, 3))
        index = nxt
        if index >= len(grid) - 1:
            index = 0  # loop the grid rather than stop cutting
    return out


# ---------------------------------------------------------------------------
# Text on screen, without a quoting disaster
# ---------------------------------------------------------------------------

_text_files: list[Path] = []


def text_file(text: str) -> str:
    """drawtext reads the words from a file, so nothing has to be escaped.

    Colons, apostrophes, commas and percent signs all mean something inside a
    filter string, and a property called "Sector 21, Faridabad" breaks the
    render in a way that reads as an ffmpeg bug.
    """
    handle, name = tempfile.mkstemp(suffix=".txt")
    with os.fdopen(handle, "w", encoding="utf-8") as file:
        file.write(text)
    path = Path(name)
    _text_files.append(path)
    return str(path)


def cleanup() -> None:
    for path in _text_files:
        path.unlink(missing_ok=True)
    _text_files.clear()


def wrap(text: str, size: int, width: int = REEL_W - 120) -> list[str]:
    """Break a line so it fits the frame.

    Measured against an average glyph width rather than the real one, because
    the alternative is loading the font and shaping the string here to save a
    few pixels. Erring narrow costs a line break; erring wide runs the locality
    off both edges of the phone, which is what "4 BHK · Builder Floor ·
    Greenfield Colony · Faridabad" did on the first render.
    """
    budget = max(8, int(width / (size * 0.52)))
    if len(text) <= budget:
        return [text]
    lines: list[str] = []
    current = ""
    # Split on the separator first when there is one, so a break lands between
    # two facts rather than in the middle of "Faridabad".
    pieces = text.split(" · ") if " · " in text else text.split(" ")
    joiner = " · " if " · " in text else " "
    for piece in pieces:
        candidate = f"{current}{joiner}{piece}" if current else piece
        if len(candidate) <= budget:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = piece
    if current:
        lines.append(current)
    return lines


def drawtext(text: str, *, size: int, y: str, x: str = "(w-tw)/2",
             colour: str = "white", font: str = "", start: float | None = None,
             end: float | None = None, box: bool = False, alpha: str | None = None) -> str:
    parts = [
        f"textfile='{text_file(text)}'",
        f"fontfile='{font or FONT}'",
        f"fontsize={size}",
        f"fontcolor={colour}",
        f"x={x}", f"y={y}",
        "shadowcolor=black@0.45", "shadowx=2", "shadowy=2",
    ]
    if box:
        parts += ["box=1", "boxcolor=black@0.42", "boxborderw=24"]
    if alpha:
        parts.append(f"alpha='{alpha}'")
    if start is not None and end is not None:
        parts.append(f"enable='between(t,{start},{end})'")
    return "drawtext=" + ":".join(parts)


# ---------------------------------------------------------------------------
# One shot
# ---------------------------------------------------------------------------

def photo_shot(photo: Path, out: Path, seconds: float, index: int,
               label: str = "") -> bool:
    """One photograph, moving, for `seconds`.

    Which move depends on the shape of the photograph, and that choice is the
    whole trick:

    * **A wide photo travels across it.** Rooms shot horizontally into a
      vertical frame lose more than two thirds of themselves to a 9:16 crop, and
      the third that survives is usually wall. Filling the height and moving
      sideways shows the entire room over three seconds, which is more of it
      than one framed photograph ever shows.

    * **A tall photo pushes in.** Nothing is lost either way, so the move is
      there for life rather than for coverage.

    Direction alternates so consecutive shots do not feel mechanical.

    **Not `zoompan`, deliberately.** It is the filter everybody reaches for and
    it rescales the full frame from the source on every single frame: measured
    here at 342 seconds for one two-and-a-half second shot, which is over an
    hour for one reel. `scale` with `eval=frame` does the same move by resizing
    an already-prepared frame, and takes eleven seconds. It also looks better,
    because the frame it grows is a sharp intermediate rather than the output
    resolution.
    """
    info = probe(photo)
    if not info:
        return False

    if info.landscape:
        # Fill the height, then travel. Capped at a calm speed rather than
        # crossing the whole photograph however wide it is: a fast pan reads as
        # a mistake, and a very wide shot would otherwise whip past.
        scaled_w = max(REEL_W + 2, int(round(REEL_H * info.width / info.height)))
        available = scaled_w - REEL_W
        travel = min(available, int(seconds * 240))
        origin = max(0, (available - travel) // 2)
        moving = (f"{origin}+{travel}*t/{max(0.01, seconds):.3f}" if index % 2 == 0
                  else f"{origin + travel}-{travel}*t/{max(0.01, seconds):.3f}")
        chain = (
            f"scale=-2:{REEL_H}:flags=lanczos,"
            f"crop={REEL_W}:{REEL_H}:x='min(max({moving},0),{max(0, available)})':y=0"
        )
    else:
        # Prepare one sharp frame 16% larger than the output, then grow or
        # shrink *that*. Every pixel the crop takes comes from at least output
        # resolution throughout the move, so there is no softening at either end.
        base_w = int(REEL_W * 1.16) // 2 * 2
        base_h = int(REEL_H * 1.16) // 2 * 2
        grow = (f"(1+0.14*t/{max(0.01, seconds):.3f})" if index % 2 == 0
                else f"(1.14-0.14*t/{max(0.01, seconds):.3f})")
        chain = (
            f"scale={base_w}:{base_h}:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop={base_w}:{base_h},"
            f"scale=w='ceil({base_w}*{grow}/2)*2':h='ceil({base_h}*{grow}/2)*2'"
            f":eval=frame:flags=bicubic,"
            f"crop={REEL_W}:{REEL_H}"
        )

    filters = [chain, f"fps={FPS}", "format=yuv420p"]
    if label:
        # A thin rule under the room name rather than a filled box: a box on a
        # photograph reads as a caption bar, a rule reads as design.
        filters.append(
            f"drawbox=x=64:y={REEL_H - 300}:w=90:h=5:color=white@0.9:t=fill:"
            f"enable='between(t,0.35,{max(0.4, seconds - 0.3)})'"
        )
        filters.append(drawtext(
            label.upper(), size=46, x="64", y=str(REEL_H - 262), colour="white",
            start=0.35, end=max(0.4, seconds - 0.3),
        ))

    return ffmpeg([
        "-loop", "1", "-t", f"{seconds:.3f}", "-i", str(photo),
        "-vf", ",".join(filters),
        # `fast` on the pieces: every one of them is decoded and re-encoded by
        # the crossfade anyway, so effort spent here is thrown away twice.
        "-r", str(FPS), "-c:v", "libx264", "-preset", "fast", "-crf", "17",
        "-pix_fmt", "yuv420p", "-an", str(out),
    ])


def card(out: Path, seconds: float, lines: list[tuple[str, int]],
         background: Path | None = None) -> bool:
    """A title or end card, over a darkened photograph or over black."""
    filters: list[str] = []
    if background and background.is_file():
        filters.append(
            f"scale={REEL_W}:{REEL_H}:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop={REEL_W}:{REEL_H},eq=brightness=-0.22:saturation=0.85,"
            f"boxblur=6:1"
        )
        source = ["-loop", "1", "-t", f"{seconds:.3f}", "-i", str(background)]
    else:
        source = ["-f", "lavfi", "-t", f"{seconds:.3f}",
                  "-i", f"color=c=0x0B1220:s={REEL_W}x{REEL_H}:r={FPS}"]

    # Wrap before measuring: the height of the block depends on how many lines
    # each entry turned into, and centring on the unwrapped count puts a
    # three-line card off the bottom of the frame.
    laid_out: list[tuple[str, int, int]] = []
    for position, (text, size) in enumerate(lines):
        for piece in wrap(text, size):
            laid_out.append((piece, size, position))

    top = REEL_H // 2 - sum(size + 22 for _, size, _ in laid_out) // 2
    for line_index, (text, size, position) in enumerate(laid_out):
        # Each line fades up a beat after the one above it.
        appear = 0.15 + line_index * 0.18
        filters.append(drawtext(
            text, size=size, y=str(top),
            colour="white" if position == 0 else "white@0.86",
            font=FONT if position == 0 else FONT_LIGHT,
            alpha=f"if(lt(t,{appear}),0,min((t-{appear})/0.45,1))",
        ))
        top += size + 22

    filters.append("format=yuv420p")
    return ffmpeg([
        *source, "-vf", ",".join(filters),
        "-r", str(FPS), "-c:v", "libx264", "-preset", "fast", "-crf", "17",
        "-pix_fmt", "yuv420p", "-an", str(out),
    ])


# ---------------------------------------------------------------------------
# Putting the shots together
# ---------------------------------------------------------------------------

def crossfade(clips: list[Path], out: Path, fade: float = 0.3) -> bool:
    """Join the shots, dissolving between them.

    A chain rather than one filter with every input, because xfade takes exactly
    two streams. Offsets accumulate: each dissolve eats `fade` seconds, so the
    next one starts that much earlier than the raw running time suggests. Getting
    that wrong is how a reel ends up with a frozen frame in the middle.
    """
    if not clips:
        return False
    if len(clips) == 1:
        shutil.copy2(clips[0], out)
        return True

    durations = []
    for clip in clips:
        info = probe(clip)
        durations.append(info.duration if info else 2.5)

    inputs: list[str] = []
    for clip in clips:
        inputs += ["-i", str(clip)]

    steps: list[str] = []
    label = "0:v"
    offset = durations[0] - fade
    for index in range(1, len(clips)):
        target = f"x{index}"
        steps.append(
            f"[{label}][{index}:v]xfade=transition=fade:duration={fade}:offset={max(0.0, offset):.3f}[{target}]"
        )
        label = target
        offset += durations[index] - fade

    return ffmpeg([
        *inputs, "-filter_complex", ";".join(steps),
        "-map", f"[{label}]",
        "-r", str(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "19",
        "-pix_fmt", "yuv420p", "-an", str(out),
    ])


def add_sound(video: Path, out: Path, voice: Path | None, music: Path | None) -> bool:
    """Lay the voice over the music, with the music stepping back underneath it.

    Sidechain compression rather than a fixed volume: a bed quiet enough to
    speak over is too quiet everywhere else, and a bed at a good level buries
    the voice. Ducking gives both.
    """
    info = probe(video)
    duration = info.duration if info else 30.0

    if not voice and not music:
        return ffmpeg(["-i", str(video), "-c", "copy", "-an", str(out)])

    inputs = ["-i", str(video)]
    graph: list[str] = []
    index = 1
    voice_label = music_label = None

    if voice:
        inputs += ["-i", str(voice)]
        graph.append(f"[{index}:a]aresample=48000,apad,atrim=0:{duration:.3f},asetpts=N/SR/TB[vo]")
        voice_label = "vo"
        index += 1
    if music:
        inputs += ["-stream_loop", "-1", "-i", str(music)]
        graph.append(
            f"[{index}:a]aresample=48000,atrim=0:{duration:.3f},asetpts=N/SR/TB,"
            f"volume=0.42,afade=t=in:st=0:d=1.2,"
            f"afade=t=out:st={max(0.0, duration - 1.6):.3f}:d=1.6[bed]"
        )
        music_label = "bed"

    if voice_label and music_label:
        graph.append(
            "[bed][vo]sidechaincompress=threshold=0.05:ratio=8:attack=12:release=320[ducked]"
        )
        graph.append("[ducked][vo]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[mix]")
    elif voice_label:
        graph.append("[vo]alimiter=limit=0.95[mix]")
    else:
        graph.append(f"[{music_label}]alimiter=limit=0.95[mix]")

    return ffmpeg([
        *inputs, "-filter_complex", ";".join(graph),
        "-map", "0:v", "-map", "[mix]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", "-shortest", str(out),
    ])


def cover_frame(video: Path, out: Path, at: float = 0.8) -> bool:
    """One frame, to stand in for the video wherever it cannot play.

    Pass `at` late enough that the title card has finished animating. The lines
    fade up one after another — see `card` — and the last of four does not reach
    full opacity until about 1.14s. Grabbing at 0.8s produced a cover with the
    price half faded out, which is the frame WhatsApp and Instagram show as the
    thumbnail: the one place the price most needs to be readable.
    """
    return ffmpeg(["-ss", f"{at:.2f}", "-i", str(video), "-frames:v", "1", "-q:v", "2", str(out)])


def settled(seconds: float) -> float:
    """When a title card of `seconds` is done moving, as a moment to grab a cover.

    Late in the card rather than a fixed number of seconds in, because the card
    is built so its animation finishes inside its own length. Anything that fits
    the card is therefore settled by the time this lands, however many lines the
    wrapping produced.

    The 0.5 is the `crossfade` default of 0.3 plus a margin: land after that and
    the "cover" is really the first photograph dissolving in over the words.
    """
    return max(0.1, seconds - 0.5)
