#!/usr/bin/env python3
"""Create smaller, safe copies of iPhone photos and videos.

There are two deliberately separate modes:

* compact: visually high-quality delivery copies, normally much smaller.
* lossless: no image or sound quality is removed, so savings may be tiny.

Original files are never changed.

Examples:
  python3 scripts/compress_iphone_media.py B12-Greenfield-Colony
  python3 scripts/compress_iphone_media.py B12-Greenfield-Colony --mode lossless
  python3 scripts/compress_iphone_media.py IMG_4392.MOV --saving 85
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import uuid
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError


ROOT = Path(__file__).resolve().parents[1]
PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".heic", ".heif", ".png", ".webp"}
VIDEO_EXTENSIONS = {".mov", ".mp4", ".m4v"}
MEDIA_EXTENSIONS = PHOTO_EXTENSIONS | VIDEO_EXTENSIONS
ORIENTATION_TAG = 274


@dataclass
class Result:
    source: Path
    output: Path | None
    source_bytes: int
    output_bytes: int
    status: str
    note: str = ""

    @property
    def saving_percent(self) -> float:
        if self.source_bytes <= 0:
            return 0.0
        return 100 * (1 - (self.output_bytes / self.source_bytes))


@dataclass
class VideoInfo:
    duration: float
    size: int
    bitrate: int
    width: int
    height: int
    fps: float
    codec: str
    pixel_format: str
    color_space: str
    color_transfer: str
    color_primaries: str
    rotation: int

    @property
    def is_hdr(self) -> bool:
        return (
            "10" in self.pixel_format
            or self.color_transfer in {"arib-std-b67", "smpte2084"}
            or self.color_primaries == "bt2020"
        )

    @property
    def display_dimensions(self) -> tuple[int, int]:
        if abs(self.rotation) % 180 == 90:
            return self.height, self.width
        return self.width, self.height


def project_path(value: str | Path) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else ROOT / path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Make smaller copies of iPhone photos and videos without touching "
            "the originals. Compact mode is high quality but not lossless."
        )
    )
    parser.add_argument("source", help="Photo, video, or folder to process")
    parser.add_argument(
        "output",
        nargs="?",
        help="Output file or folder. A safe new name is used by default.",
    )
    parser.add_argument(
        "--mode",
        choices=("compact", "lossless"),
        default="compact",
        help=(
            "compact makes much smaller high-quality copies; lossless keeps "
            "all visual and audio information (default: compact)"
        ),
    )
    parser.add_argument(
        "--saving",
        type=int,
        default=85,
        metavar="PERCENT",
        help="Target video saving in compact mode, from 50 to 92 (default: 85)",
    )
    parser.add_argument(
        "--photo-quality",
        type=int,
        default=85,
        metavar="QUALITY",
        help="Compact JPEG quality from 75 to 95 (default: 85)",
    )
    parser.add_argument(
        "--photo-max-edge",
        type=int,
        default=3000,
        metavar="PIXELS",
        help="Maximum long edge for compact photos (default: 3000)",
    )
    parser.add_argument(
        "--video-max-edge",
        type=int,
        default=1920,
        metavar="PIXELS",
        help="Maximum long edge for compact videos (default: 1920)",
    )
    parser.add_argument(
        "--video-fps",
        type=int,
        default=30,
        metavar="FPS",
        help="Maximum compact video frame rate (default: 30)",
    )
    parser.add_argument(
        "--video-preset",
        choices=("fast", "medium", "slow"),
        default="medium",
        help="Video encoding effort: slow is smaller but takes longer (default: medium)",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace existing copies, never the originals",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be processed without creating files",
    )
    args = parser.parse_args()

    if not 50 <= args.saving <= 92:
        parser.error("--saving must be between 50 and 92")
    if not 75 <= args.photo_quality <= 95:
        parser.error("--photo-quality must be between 75 and 95")
    if not 1200 <= args.photo_max_edge <= 8064:
        parser.error("--photo-max-edge must be between 1200 and 8064")
    if not 720 <= args.video_max_edge <= 3840:
        parser.error("--video-max-edge must be between 720 and 3840")
    if not 24 <= args.video_fps <= 60:
        parser.error("--video-fps must be between 24 and 60")
    return args


def human_size(byte_count: int) -> str:
    size = float(byte_count)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            digits = 0 if unit == "B" else 1
            return f"{size:.{digits}f} {unit}"
        size /= 1024
    return f"{byte_count} B"


def temporary_path(destination: Path) -> Path:
    token = uuid.uuid4().hex[:10]
    return destination.parent / f".{destination.stem}-{token}.tmp{destination.suffix}"


def command_path(name: str) -> str | None:
    return shutil.which(name)


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def ensure_tools(mode: str, has_videos: bool) -> None:
    if not has_videos:
        return
    missing = [name for name in ("ffmpeg", "ffprobe") if command_path(name) is None]
    if missing:
        raise RuntimeError(
            "Video processing needs ffmpeg and ffprobe. Missing: " + ", ".join(missing)
        )
    if mode == "compact":
        encoders = run(["ffmpeg", "-hide_banner", "-encoders"])
        if "libx265" not in encoders.stdout:
            raise RuntimeError("This ffmpeg installation does not include the HEVC encoder libx265.")


def media_files(source: Path) -> list[Path]:
    if source.is_file():
        if source.suffix.lower() not in MEDIA_EXTENSIONS:
            raise ValueError(f"Unsupported media file: {source.name}")
        return [source]
    if not source.is_dir():
        raise FileNotFoundError(f"Source not found: {source}")
    return sorted(
        path
        for path in source.rglob("*")
        if path.is_file() and path.suffix.lower() in MEDIA_EXTENSIONS
    )


def default_output(source: Path, mode: str) -> Path:
    label = "compact" if mode == "compact" else "lossless"
    if source.is_dir():
        return source.with_name(f"{source.name}-{label}")
    suffix = compact_suffix(source) if mode == "compact" else source.suffix
    return source.with_name(f"{source.stem}-{label}{suffix}")


def compact_suffix(source: Path) -> str:
    if source.suffix.lower() in PHOTO_EXTENSIONS:
        return ".jpg"
    return ".mp4"


def output_for(
    source_root: Path,
    output_root: Path,
    media: Path,
    mode: str,
) -> Path:
    if source_root.is_file():
        if output_root.exists() and output_root.is_dir():
            suffix = compact_suffix(media) if mode == "compact" else media.suffix
            return output_root / f"{media.stem}{suffix}"
        return output_root

    relative = media.relative_to(source_root)
    destination = output_root / relative
    if mode == "compact":
        destination = destination.with_suffix(compact_suffix(media))
    return destination


def ensure_safe_paths(source: Path, output: Path) -> None:
    resolved_source = source.resolve()
    resolved_output = output.resolve()
    if resolved_source == resolved_output:
        raise ValueError("The output cannot be the original file or folder.")
    if source.is_dir() and resolved_output.is_relative_to(resolved_source):
        raise ValueError("Put the output beside the source folder, not inside it.")


def prepare_destination(destination: Path, overwrite: bool) -> bool:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and not overwrite:
        return False
    return True


def choose_smaller_or_original(source: Path, candidate: Path, destination: Path) -> str:
    if candidate.exists() and candidate.stat().st_size < source.stat().st_size:
        os.replace(candidate, destination)
        shutil.copystat(source, destination)
        return "optimised without quality loss"
    candidate.unlink(missing_ok=True)
    shutil.copy2(source, destination)
    return "already efficient; copied unchanged"


def lossless_photo(source: Path, destination: Path) -> str:
    candidate = temporary_path(destination)
    jpegtran = command_path("jpegtran")
    try:
        if source.suffix.lower() in {".jpg", ".jpeg"} and jpegtran:
            completed = run(
                [
                    jpegtran,
                    "-copy",
                    "all",
                    "-optimize",
                    "-progressive",
                    "-outfile",
                    str(candidate),
                    str(source),
                ]
            )
            if completed.returncode != 0:
                raise RuntimeError(completed.stderr.strip() or "jpegtran failed")
            return choose_smaller_or_original(source, candidate, destination)

        shutil.copy2(source, destination)
        return "copied unchanged; no safe lossless saving available"
    finally:
        candidate.unlink(missing_ok=True)


def image_save_options(image: Image.Image, quality: int) -> dict[str, object]:
    options: dict[str, object] = {
        "format": "JPEG",
        "quality": quality,
        "optimize": True,
        "progressive": True,
        "subsampling": "4:2:0",
    }
    exif = image.getexif()
    if exif:
        exif[ORIENTATION_TAG] = 1
        options["exif"] = exif.tobytes()
    icc_profile = image.info.get("icc_profile")
    if icc_profile:
        options["icc_profile"] = icc_profile
    return options


def flatten_to_rgb(image: Image.Image) -> Image.Image:
    if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
        rgba = image.convert("RGBA")
        white = Image.new("RGBA", rgba.size, "white")
        return Image.alpha_composite(white, rgba).convert("RGB")
    return image.convert("RGB")


def compact_photo_with_pillow(
    source: Path,
    candidate: Path,
    quality: int,
    max_edge: int,
) -> str:
    with Image.open(source) as opened:
        options = image_save_options(opened, quality)
        image = ImageOps.exif_transpose(opened)
        original_dimensions = image.size
        image = flatten_to_rgb(image)
        image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
        image.save(candidate, **options)
        return f"{original_dimensions[0]}x{original_dimensions[1]} to {image.width}x{image.height}"


def compact_photo_with_graphicsmagick(
    source: Path,
    destination: Path,
    quality: int,
    max_edge: int,
) -> str:
    """The Linux stand-in for sips, used for HEIC and anything Pillow refuses.

    `-resize WxH>` only shrinks, so a photo already under the limit keeps its
    own size rather than being enlarged into a bigger, softer file.
    """
    gm = command_path("gm")
    if gm is None:
        raise RuntimeError(
            f"Cannot read {source.suffix}: neither sips nor GraphicsMagick is available."
        )
    completed = subprocess.run(
        [
            gm, "convert", str(source),
            "-auto-orient",
            "-resize", f"{max_edge}x{max_edge}>",
            "-quality", str(quality),
            str(destination),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "GraphicsMagick could not convert this photo")

    identify = subprocess.run(
        [gm, "identify", "-format", "%wx%h", str(destination)],
        capture_output=True, text=True, check=False,
    )
    return identify.stdout.strip() or "unknown"


def compact_photo_with_sips(
    source: Path,
    candidate: Path,
    quality: int,
    max_edge: int,
) -> str:
    sips = command_path("sips")
    if sips is None:
        # Off a Mac there is no sips, and this is the HEIC path — every iPhone
        # photo lands here. GraphicsMagick reads HEIC through libde265, so the
        # server build uses that instead and the script stays portable.
        return compact_photo_with_graphicsmagick(source, destination, quality, max_edge)
    completed = run(
        [
            sips,
            "-Z",
            str(max_edge),
            "-s",
            "format",
            "jpeg",
            "-s",
            "formatOptions",
            str(quality),
            str(source),
            "--out",
            str(candidate),
        ]
    )
    if completed.returncode != 0 or not candidate.is_file():
        raise RuntimeError(completed.stderr.strip() or "sips could not convert this photo")
    with Image.open(candidate) as image:
        return f"converted to {image.width}x{image.height} JPEG"


def compact_photo(
    source: Path,
    destination: Path,
    quality: int,
    max_edge: int,
) -> str:
    candidate = temporary_path(destination)
    try:
        try:
            dimensions = compact_photo_with_pillow(
                source, candidate, quality, max_edge
            )
        except (UnidentifiedImageError, OSError):
            candidate.unlink(missing_ok=True)
            dimensions = compact_photo_with_sips(
                source, candidate, quality, max_edge
            )

        if not candidate.is_file() or candidate.stat().st_size == 0:
            raise RuntimeError("No compact photo was created")
        os.replace(candidate, destination)
        shutil.copystat(source, destination)
        return dimensions
    finally:
        candidate.unlink(missing_ok=True)


def parse_fraction(value: str | None) -> float:
    if not value or value in {"0/0", "N/A"}:
        return 0.0
    try:
        return float(Fraction(value))
    except (ValueError, ZeroDivisionError):
        return 0.0


def probe_video(source: Path) -> VideoInfo:
    completed = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            (
                "stream=codec_name,width,height,r_frame_rate,pix_fmt,color_space,"
                "color_transfer,color_primaries:stream_side_data=rotation:"
                "format=duration,size,bit_rate"
            ),
            "-of",
            "json",
            str(source),
        ]
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "ffprobe could not read the video")
    data = json.loads(completed.stdout)
    streams = data.get("streams", [])
    if not streams:
        raise RuntimeError("No video track found")
    stream = streams[0]
    container = data.get("format", {})
    side_data = stream.get("side_data_list", [])
    rotation = next(
        (int(item["rotation"]) for item in side_data if "rotation" in item),
        0,
    )
    duration = float(container.get("duration") or 0)
    size = int(container.get("size") or source.stat().st_size)
    bitrate = int(container.get("bit_rate") or 0)
    if bitrate <= 0 and duration > 0:
        bitrate = round((size * 8) / duration)
    return VideoInfo(
        duration=duration,
        size=size,
        bitrate=bitrate,
        width=int(stream.get("width") or 0),
        height=int(stream.get("height") or 0),
        fps=parse_fraction(stream.get("r_frame_rate")),
        codec=str(stream.get("codec_name") or "unknown"),
        pixel_format=str(stream.get("pix_fmt") or "unknown"),
        color_space=str(stream.get("color_space") or "unknown"),
        color_transfer=str(stream.get("color_transfer") or "unknown"),
        color_primaries=str(stream.get("color_primaries") or "unknown"),
        rotation=rotation,
    )


def even(value: float) -> int:
    rounded = max(2, round(value))
    return rounded if rounded % 2 == 0 else rounded - 1


def delivery_dimensions(width: int, height: int, max_edge: int) -> tuple[int, int]:
    longest = max(width, height)
    if longest <= max_edge:
        return even(width), even(height)
    scale = max_edge / longest
    return even(width * scale), even(height * scale)


def video_bitrate(
    info: VideoInfo,
    width: int,
    height: int,
    fps: float,
    saving: int,
) -> int:
    desired_total = info.bitrate * (1 - (saving / 100))
    audio_allowance = 128_000
    pixel_factor = (width * height) / (1920 * 1080)
    frame_factor = max(0.8, fps / 30) ** 0.65

    # Below this floor, property details and movement can become visibly soft.
    quality_floor = 2_800_000 * pixel_factor * frame_factor
    quality_floor = max(1_200_000, quality_floor)
    sensible_ceiling = max(3_000_000, 8_000_000 * pixel_factor * frame_factor)
    desired_video = desired_total - audio_allowance
    return round(max(quality_floor, min(sensible_ceiling, desired_video)))


def compact_video(
    source: Path,
    destination: Path,
    saving: int,
    max_edge: int,
    maximum_fps: int,
    preset: str,
) -> str:
    info = probe_video(source)
    if info.duration <= 0 or info.width <= 0 or info.height <= 0:
        raise RuntimeError("The video duration or dimensions could not be read")

    display_width, display_height = info.display_dimensions
    width, height = delivery_dimensions(display_width, display_height, max_edge)
    fps = min(info.fps or maximum_fps, maximum_fps)
    bitrate = video_bitrate(info, width, height, fps, saving)
    candidate = temporary_path(destination)
    pixel_format = "yuv420p10le" if info.is_hdr else "yuv420p"
    filters = f"scale={width}:{height}:flags=lanczos,fps={fps:g},format={pixel_format}"

    command = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-map_metadata",
        "0",
        "-map_chapters",
        "0",
        "-sn",
        "-dn",
        "-vf",
        filters,
        "-c:v",
        "libx265",
        "-preset",
        preset,
        "-b:v",
        str(bitrate),
        "-maxrate",
        str(round(bitrate * 1.35)),
        "-bufsize",
        str(bitrate * 2),
        "-tag:v",
        "hvc1",
        "-metadata:s:v:0",
        "rotate=0",
    ]

    if info.is_hdr:
        command.extend(["-x265-params", "hdr-opt=1:repeat-headers=1"])
        if info.color_primaries != "unknown":
            command.extend(["-color_primaries", info.color_primaries])
        if info.color_transfer != "unknown":
            command.extend(["-color_trc", info.color_transfer])
        if info.color_space != "unknown":
            command.extend(["-colorspace", info.color_space])

    command.extend(
        [
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart+use_metadata_tags",
            str(candidate),
        ]
    )

    try:
        completed = run(command)
        if completed.returncode != 0:
            detail = completed.stderr.strip().splitlines()
            useful_detail = " | ".join(detail[-4:])
            raise RuntimeError(useful_detail or "ffmpeg compression failed")
        if not candidate.is_file() or candidate.stat().st_size == 0:
            raise RuntimeError("No compact video was created")

        result_info = probe_video(candidate)
        duration_difference = abs(result_info.duration - info.duration)
        if duration_difference > max(1.0, info.duration * 0.01):
            raise RuntimeError("The compact video did not retain the full duration")
        if result_info.display_dimensions != (width, height):
            raise RuntimeError("The compact video orientation or dimensions are incorrect")
        if info.is_hdr and not result_info.is_hdr:
            raise RuntimeError("The compact video did not retain HDR colour")

        os.replace(candidate, destination)
        shutil.copystat(source, destination)
        hdr_label = ", HDR retained" if info.is_hdr else ""
        return (
            f"{display_width}x{display_height} {info.fps:.2f} fps to "
            f"{width}x{height} {fps:.2f} fps{hdr_label}"
        )
    finally:
        candidate.unlink(missing_ok=True)


def lossless_video(source: Path, destination: Path) -> str:
    candidate = temporary_path(destination)
    command = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-map",
        "0",
        "-c",
        "copy",
        "-map_metadata",
        "0",
        "-movflags",
        "+faststart+use_metadata_tags",
        str(candidate),
    ]
    try:
        completed = run(command)
        if completed.returncode == 0 and candidate.is_file():
            return choose_smaller_or_original(source, candidate, destination)
        shutil.copy2(source, destination)
        return "container could not be safely optimised; copied unchanged"
    finally:
        candidate.unlink(missing_ok=True)


def process_one(
    source: Path,
    destination: Path,
    args: argparse.Namespace,
) -> Result:
    source_bytes = source.stat().st_size
    if destination.exists() and not args.overwrite:
        return Result(source, destination, source_bytes, destination.stat().st_size, "skipped", "already exists")
    if args.dry_run:
        return Result(source, destination, source_bytes, source_bytes, "planned")

    prepare_destination(destination, args.overwrite)
    try:
        if source.suffix.lower() in PHOTO_EXTENSIONS:
            if args.mode == "lossless":
                note = lossless_photo(source, destination)
            else:
                note = compact_photo(
                    source,
                    destination,
                    args.photo_quality,
                    args.photo_max_edge,
                )
        else:
            if args.mode == "lossless":
                note = lossless_video(source, destination)
            else:
                note = compact_video(
                    source,
                    destination,
                    args.saving,
                    args.video_max_edge,
                    args.video_fps,
                    args.video_preset,
                )
        return Result(
            source,
            destination,
            source_bytes,
            destination.stat().st_size,
            "created",
            note,
        )
    except Exception as error:
        return Result(source, None, source_bytes, 0, "failed", str(error))


def print_result(result: Result) -> None:
    if result.status == "created":
        print(
            f"OK  {result.source.name}: {human_size(result.source_bytes)} to "
            f"{human_size(result.output_bytes)} ({result.saving_percent:.1f}% smaller)"
        )
        if result.note:
            print(f"    {result.note}")
    elif result.status == "planned":
        print(f"PLAN {result.source.name}: {human_size(result.source_bytes)}")
    elif result.status == "skipped":
        print(f"SKIP {result.source.name}: {result.note}")
    else:
        print(f"FAIL {result.source.name}: {result.note}")


def main() -> int:
    args = parse_args()
    source = project_path(args.source)
    output = project_path(args.output) if args.output else default_output(source, args.mode)

    try:
        ensure_safe_paths(source, output)
        files = media_files(source)
        if not files:
            raise ValueError(f"No supported photos or videos found in: {source}")
        ensure_tools(
            args.mode,
            any(path.suffix.lower() in VIDEO_EXTENSIONS for path in files),
        )
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2

    print(f"Mode: {args.mode}")
    if args.mode == "compact":
        print(
            "Compact mode is visually high quality, but it is not mathematically lossless."
        )
    else:
        print("Lossless mode may save very little because iPhone media is already compressed.")
    print(f"Source: {source}")
    print(f"Output: {output}")
    print(f"Files: {len(files)}\n")

    destinations: set[Path] = set()
    results: list[Result] = []
    for media in files:
        destination = output_for(source, output, media, args.mode)
        if destination in destinations:
            suffix = media.suffix.lower().lstrip(".") or "media"
            destination = destination.with_name(
                f"{destination.stem}-from-{suffix}{destination.suffix}"
            )
        destinations.add(destination)
        result = process_one(media, destination, args)
        results.append(result)
        print_result(result)

    created = [result for result in results if result.status == "created"]
    failed = [result for result in results if result.status == "failed"]
    if created:
        original_total = sum(result.source_bytes for result in created)
        output_total = sum(result.output_bytes for result in created)
        saving = 100 * (1 - (output_total / original_total))
        print("\nSummary")
        print(f"Created: {len(created)}")
        print(f"Original size: {human_size(original_total)}")
        print(f"New size: {human_size(output_total)}")
        print(f"Space saved: {human_size(original_total - output_total)} ({saving:.1f}%)")
        print("Original files were not changed.")
    if failed:
        print(f"\nFailed: {len(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
