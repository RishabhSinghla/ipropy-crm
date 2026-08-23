#!/usr/bin/env python3
"""Apply a restrained professional real-estate finish to photos.

This script is fully local and deterministic. It does not use AI, call a model,
upload media, add or remove scene content, or replace original files.

The automatic finish is intentionally conservative:

* correct camera roll only when architectural lines give a reliable reading
* make a partial neutral white-balance correction without removing warm lighting
* balance exposure, shadows, highlights, and contrast within narrow limits
* add mild colour and luminance detail without an artificial HDR appearance
* preserve photo EXIF and ICC colour data

Examples:
  python3 scripts/professional_photo_finish.py B12-Greenfield-Colony/IMG_4377.jpg
  python3 scripts/professional_photo_finish.py B12-Greenfield-Colony B12-finished
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

from PIL import (
    Image,
    ImageChops,
    ImageEnhance,
    ImageFilter,
    ImageOps,
    ImageStat,
    UnidentifiedImageError,
)

ROOT = Path(__file__).resolve().parents[1]
ORIENTATION_TAG = 274
# No default photo in the container. On the owner's Mac this pointed at a sample
# in the work folder; here that path does not exist, and a default that names a
# missing file turns "you forgot an argument" into "the file is gone".
DEFAULT_SOURCE = None
PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}
OUTPUT_MARKER = "-professionally-finished"

EXIF_PIXEL_WIDTH = 40962
EXIF_PIXEL_HEIGHT = 40963


@dataclass
class ToneStats:
    p02: float
    p10: float
    median: float
    p90: float
    p98: float
    mean_saturation: float
    neutral_red: float
    neutral_green: float
    neutral_blue: float
    neutral_coverage: float


@dataclass
class TonePlan:
    red_gain: float
    green_gain: float
    blue_gain: float
    exposure: float
    shadow_lift: float
    highlight_control: float
    contrast: float
    saturation: float
    detail_percent: int


@dataclass
class StraightenPlan:
    angle: float
    confidence: float
    score_improvement: float
    crop_percent: float = 0.0


@dataclass
class FinishReport:
    source: str
    output: str
    straighten_degrees: float
    straighten_confidence: float
    straighten_crop_percent: float
    red_gain: float
    green_gain: float
    blue_gain: float
    exposure: float
    shadow_lift: float
    highlight_control: float
    contrast: float
    saturation: float
    detail_percent: int
    original_dimensions: str
    output_dimensions: str
    note: str


def project_path(value: str | Path) -> Path:
    """Resolve relative paths from the iPropy-work-items folder."""
    path = Path(value).expanduser()
    return path if path.is_absolute() else ROOT / path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create subtly corrected professional copies of photos. "
            "The process is local, deterministic, non-AI, and never changes originals."
        )
    )
    parser.add_argument(
        "source",
        nargs="?" if DEFAULT_SOURCE else None,
        **({"default": str(DEFAULT_SOURCE)} if DEFAULT_SOURCE else {}),
        help="Photo or folder to finish",
    )
    parser.add_argument(
        "output",
        nargs="?",
        help="Output file or folder. A safe separate name is used by default.",
    )
    parser.add_argument(
        "--strength",
        type=int,
        default=100,
        metavar="PERCENT",
        help="Finishing strength from 50 to 125 (default: 100)",
    )
    parser.add_argument(
        "--straighten",
        choices=("auto", "off"),
        default="auto",
        help="Conservative architectural roll correction (default: auto)",
    )
    parser.add_argument(
        "--max-straighten",
        type=float,
        default=2.5,
        metavar="DEGREES",
        help="Maximum automatic roll correction from 0.5 to 5 degrees (default: 2.5)",
    )
    parser.add_argument(
        "--quality",
        type=int,
        default=95,
        help="Finished JPEG/WebP quality from 80 to 100 (default: 95)",
    )
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="Also process photos inside subfolders",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace existing finished copies, never source photos",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show which files would be processed without creating outputs",
    )
    args = parser.parse_args()

    if not 50 <= args.strength <= 125:
        parser.error("--strength must be between 50 and 125")
    if not 0.5 <= args.max_straighten <= 5:
        parser.error("--max-straighten must be between 0.5 and 5")
    if not 80 <= args.quality <= 100:
        parser.error("--quality must be between 80 and 100")
    return args


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def run(command: list[str]) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def command_path(name: str) -> str | None:
    return shutil.which(name)


def percentile(histogram: list[int], percentage: float) -> int:
    target = sum(histogram) * percentage
    count = 0
    for value, amount in enumerate(histogram):
        count += amount
        if count >= target:
            return value
    return 255


def preview_copy(image: Image.Image, maximum_size: int = 1200) -> Image.Image:
    preview = image.copy()
    preview.thumbnail((maximum_size, maximum_size), Image.Resampling.LANCZOS)
    return preview


def neutral_measurements(image: Image.Image) -> tuple[float, float, float, float]:
    preview = preview_copy(image.convert("RGB"), 900)
    hsv = preview.convert("HSV")
    saturation = hsv.getchannel("S")
    brightness = hsv.getchannel("V")
    low_saturation = saturation.point(lambda value: 255 if value <= 45 else 0)
    useful_brightness = brightness.point(lambda value: 255 if 88 <= value <= 242 else 0)
    neutral_mask = ImageChops.multiply(low_saturation, useful_brightness)
    selected = sum(neutral_mask.histogram()[1:])
    coverage = selected / max(1, preview.width * preview.height)

    if coverage < 0.006:
        return 1.0, 1.0, 1.0, coverage

    means = ImageStat.Stat(preview, mask=neutral_mask).mean[:3]
    neutral_level = sum(means) / 3
    gains = tuple(neutral_level / max(channel, 1) for channel in means)
    return gains[0], gains[1], gains[2], coverage


def analyse_tones(image: Image.Image) -> ToneStats:
    preview = preview_copy(image.convert("RGB"), 1000)
    histogram = ImageOps.grayscale(preview).histogram()
    saturation = ImageStat.Stat(preview.convert("HSV").getchannel("S")).mean[0]
    red, green, blue, coverage = neutral_measurements(preview)
    return ToneStats(
        p02=float(percentile(histogram, 0.02)),
        p10=float(percentile(histogram, 0.10)),
        median=float(percentile(histogram, 0.50)),
        p90=float(percentile(histogram, 0.90)),
        p98=float(percentile(histogram, 0.98)),
        mean_saturation=float(saturation),
        neutral_red=red,
        neutral_green=green,
        neutral_blue=blue,
        neutral_coverage=coverage,
    )


def plan_tone(stats: ToneStats, strength_percent: int) -> TonePlan:
    strength = strength_percent / 100
    white_balance_weight = 0.48 * strength if stats.neutral_coverage >= 0.006 else 0.0
    red_gain = clamp(1 + ((stats.neutral_red - 1) * white_balance_weight), 0.965, 1.035)
    green_gain = clamp(1 + ((stats.neutral_green - 1) * white_balance_weight), 0.975, 1.025)
    blue_gain = clamp(1 + ((stats.neutral_blue - 1) * white_balance_weight), 0.960, 1.040)
    exposure = clamp((130 / max(stats.median, 1)) ** (0.20 * strength), 0.955, 1.065)
    shadow_lift = 0.085 * clamp((52 - stats.p10) / 44, 0.0, 1.0) * strength
    highlight_control = 0.075 * clamp((stats.p98 - 232) / 20, 0.0, 1.0) * strength
    tonal_range = stats.p90 - stats.p10
    contrast_need = clamp((168 - tonal_range) / 420, 0.0, 0.030)
    contrast = 1 + max(0.007, contrast_need) * strength
    colour_need = clamp((80 - stats.mean_saturation) / 900, 0.0, 0.025)
    saturation = 1 + max(0.006, colour_need) * strength
    detail_percent = round(clamp(34 * strength, 20, 46))
    return TonePlan(
        red_gain,
        green_gain,
        blue_gain,
        exposure,
        shadow_lift,
        highlight_control,
        contrast,
        saturation,
        detail_percent,
    )


def projection_variance(values: list[int]) -> float:
    if not values:
        return 0.0
    mean = sum(values) / len(values)
    if mean <= 0.001:
        return 0.0
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    return variance / (mean * mean)


def alignment_edges(image: Image.Image, maximum_size: int = 650) -> Image.Image:
    preview = preview_copy(image.convert("RGB"), maximum_size)
    edges = ImageOps.grayscale(preview).filter(ImageFilter.FIND_EDGES)
    edges = ImageOps.autocontrast(edges, cutoff=2)
    threshold = percentile(edges.histogram(), 0.78)
    return edges.point(lambda value: value if value >= threshold else 0)


def alignment_score(edges: Image.Image, angle: float) -> float:
    rotated = edges.rotate(angle, Image.Resampling.BICUBIC, False, fillcolor=0)
    margin = max(4, round(min(rotated.size) * 0.055))
    if rotated.width > 2 * margin and rotated.height > 2 * margin:
        rotated = rotated.crop((margin, margin, rotated.width - margin, rotated.height - margin))
    rows = list(rotated.resize((1, rotated.height), Image.Resampling.BOX).get_flattened_data())
    columns = list(
        rotated.resize((rotated.width, 1), Image.Resampling.BOX).get_flattened_data()
    )
    return projection_variance(rows) + projection_variance(columns)


def angle_range(low: float, high: float, step: float) -> list[float]:
    count = max(0, math.floor((high - low) / step))
    return [round(low + (index * step), 4) for index in range(count + 1)]


def estimate_straighten(image: Image.Image, maximum_angle: float, preview_size: int = 650) -> StraightenPlan:
    edges = alignment_edges(image, preview_size)
    baseline = alignment_score(edges, 0.0)
    if baseline <= 0:
        return StraightenPlan(0.0, 0.0, 0.0)
    candidates = angle_range(-maximum_angle, maximum_angle, 0.30)
    if 0.0 not in candidates:
        candidates.append(0.0)
    coarse_angle, _ = max(
        ((angle, alignment_score(edges, angle)) for angle in candidates),
        key=lambda item: item[1],
    )
    refined = angle_range(
        max(-maximum_angle, coarse_angle - 0.30),
        min(maximum_angle, coarse_angle + 0.30),
        0.05,
    )
    best_angle, best_score = max(
        ((angle, alignment_score(edges, angle)) for angle in refined),
        key=lambda item: item[1],
    )
    improvement = max(0.0, (best_score / baseline) - 1)
    confidence = clamp((improvement - 0.012) / 0.075, 0.0, 1.0)
    if abs(best_angle) < 0.12 or improvement < 0.018 or confidence < 0.08:
        return StraightenPlan(0.0, confidence, improvement)
    return StraightenPlan(round(best_angle, 2), confidence, improvement)


def largest_inner_rectangle(width: int, height: int, angle_degrees: float) -> tuple[int, int]:
    angle = abs(math.radians(angle_degrees))
    if angle < 1e-9:
        return width, height
    sin_angle = abs(math.sin(angle))
    cos_angle = abs(math.cos(angle))
    longer = max(width, height)
    shorter = min(width, height)
    if shorter <= 2 * sin_angle * cos_angle * longer:
        half_short = 0.5 * shorter
        if width >= height:
            crop_width = half_short / max(sin_angle, 1e-9)
            crop_height = half_short / max(cos_angle, 1e-9)
        else:
            crop_width = half_short / max(cos_angle, 1e-9)
            crop_height = half_short / max(sin_angle, 1e-9)
    else:
        cos_double = (cos_angle * cos_angle) - (sin_angle * sin_angle)
        crop_width = ((width * cos_angle) - (height * sin_angle)) / cos_double
        crop_height = ((height * cos_angle) - (width * sin_angle)) / cos_double
    return max(2, math.floor(crop_width)), max(2, math.floor(crop_height))


def crop_center(image: Image.Image, width: int, height: int) -> Image.Image:
    left = max(0, (image.width - width) // 2)
    top = max(0, (image.height - height) // 2)
    return image.crop((left, top, left + width, top + height))


def apply_straighten(image: Image.Image, plan: StraightenPlan) -> tuple[Image.Image, StraightenPlan]:
    if abs(plan.angle) < 0.01:
        return image, plan
    rotated = image.rotate(plan.angle, Image.Resampling.BICUBIC, False, fillcolor=(0, 0, 0))
    crop_width, crop_height = largest_inner_rectangle(image.width, image.height, plan.angle)
    corrected = crop_center(rotated, min(image.width, crop_width), min(image.height, crop_height))
    crop_percent = 100 * (1 - ((corrected.width * corrected.height) / (image.width * image.height)))
    return corrected, StraightenPlan(plan.angle, plan.confidence, plan.score_improvement, crop_percent)


def apply_white_balance(image: Image.Image, plan: TonePlan) -> Image.Image:
    adjusted = [
        channel.point([min(255, max(0, round(value * gain))) for value in range(256)])
        for channel, gain in zip(image.convert("RGB").split(), (plan.red_gain, plan.green_gain, plan.blue_gain))
    ]
    return Image.merge("RGB", adjusted)


def balance_luminance(image: Image.Image, plan: TonePlan) -> Image.Image:
    luminance, blue_difference, red_difference = image.convert("YCbCr").split()
    luminance = ImageEnhance.Brightness(luminance).enhance(plan.exposure)
    original_luminance = luminance.copy()
    if plan.shadow_lift > 0.002:
        lifted = ImageEnhance.Brightness(luminance).enhance(1 + plan.shadow_lift)
        mask = original_luminance.point(
            lambda value: round(255 * (max(0.0, (136 - value) / 136) ** 1.7))
        )
        luminance = Image.composite(lifted, luminance, mask)
    if plan.highlight_control > 0.002:
        controlled = ImageEnhance.Brightness(luminance).enhance(1 - plan.highlight_control)
        mask = original_luminance.point(
            lambda value: round(255 * (max(0.0, (value - 170) / 85) ** 1.55))
        )
        luminance = Image.composite(controlled, luminance, mask)
    luminance = ImageEnhance.Contrast(luminance).enhance(plan.contrast)
    return Image.merge("YCbCr", (luminance, blue_difference, red_difference)).convert("RGB")


def finish_colour_and_detail(image: Image.Image, plan: TonePlan) -> Image.Image:
    image = ImageEnhance.Color(image).enhance(plan.saturation)
    luminance, blue_difference, red_difference = image.convert("YCbCr").split()
    radius = clamp(min(image.size) / 2100, 0.9, 2.4)
    luminance = luminance.filter(
        ImageFilter.UnsharpMask(radius=radius, percent=plan.detail_percent, threshold=4)
    )
    return Image.merge("YCbCr", (luminance, blue_difference, red_difference)).convert("RGB")


def professional_finish_photo(
    image: Image.Image,
    strength_percent: int,
    straighten: bool,
    maximum_angle: float,
) -> tuple[Image.Image, TonePlan, StraightenPlan]:
    image = image.convert("RGB")
    straighten_plan = (
        estimate_straighten(image, maximum_angle)
        if straighten
        else StraightenPlan(0.0, 0.0, 0.0)
    )
    image, straighten_plan = apply_straighten(image, straighten_plan)
    tone_plan = plan_tone(analyse_tones(image), strength_percent)
    image = apply_white_balance(image, tone_plan)
    image = balance_luminance(image, tone_plan)
    return finish_colour_and_detail(image, tone_plan), tone_plan, straighten_plan


def load_photo(source_path: Path) -> tuple[Image.Image, Image.Exif, bytes | None]:
    temporary_file: Path | None = None
    try:
        try:
            opened = Image.open(source_path)
            opened.load()
        except (UnidentifiedImageError, OSError):
            # `sips` is macOS only and does not exist on a server. GraphicsMagick
            # with libde265 reads the same formats, so whichever is present wins.
            # In the normal pipeline `prepare_photos.sh` has already converted
            # the file and this never runs — but "almost never" is not never.
            converter = command_path("sips") or command_path("gm")
            if source_path.suffix.lower() not in {".heic", ".heif"} or not converter:
                raise
            handle, temporary_name = tempfile.mkstemp(suffix=".jpg")
            os.close(handle)
            temporary_file = Path(temporary_name)
            completed = run(
                [converter, "-s", "format", "jpeg", str(source_path), "--out", str(temporary_file)]
                if converter.endswith("sips")
                else [converter, "convert", str(source_path), "-auto-orient", "-quality", "96", str(temporary_file)]
            )
            if completed.returncode != 0:
                detail = completed.stderr.decode(errors="replace").strip()
                raise RuntimeError(detail or "could not read this HEIC photo")
            opened = Image.open(temporary_file)
            opened.load()
        with opened:
            exif = opened.getexif()
            icc_profile = opened.info.get("icc_profile")
            image = ImageOps.exif_transpose(opened).convert("RGB")
        if exif:
            exif[ORIENTATION_TAG] = 1
        return image, exif, icc_profile
    finally:
        if temporary_file:
            temporary_file.unlink(missing_ok=True)


def save_photo(
    image: Image.Image,
    output_path: Path,
    exif: Image.Exif,
    icc_profile: bytes | None,
    quality: int,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    options: dict[str, object] = {}
    if exif:
        exif[ORIENTATION_TAG] = 1
        exif[EXIF_PIXEL_WIDTH] = image.width
        exif[EXIF_PIXEL_HEIGHT] = image.height
        options["exif"] = exif.tobytes()
    if icc_profile:
        options["icc_profile"] = icc_profile
    extension = output_path.suffix.lower()
    if extension in {".jpg", ".jpeg"}:
        image.convert("RGB").save(
            output_path,
            quality=quality,
            subsampling=0,
            optimize=True,
            progressive=True,
            **options,
        )
    elif extension == ".webp":
        image.convert("RGB").save(output_path, quality=quality, method=6, **options)
    elif extension == ".png":
        image.save(output_path, optimize=True, **options)
    else:
        raise ValueError(f"Unsupported output photo type: {extension or '(none)'}")


def output_suffix(source: Path) -> str:
    return ".jpg" if source.suffix.lower() in {".heic", ".heif"} else source.suffix


def default_output(source: Path) -> Path:
    if source.is_dir():
        return source.with_name(f"{source.name}{OUTPUT_MARKER}")
    return source.with_name(f"{source.stem}{OUTPUT_MARKER}{output_suffix(source)}")


def find_photos(folder: Path, recursive: bool) -> list[Path]:
    candidates = folder.rglob("*") if recursive else folder.iterdir()
    return sorted(
        path
        for path in candidates
        if path.is_file()
        and path.suffix.lower() in PHOTO_EXTENSIONS
        and OUTPUT_MARKER not in path.stem.lower()
    )


def build_jobs(
    source: Path,
    requested_output: str | None,
    recursive: bool,
) -> list[tuple[Path, Path]]:
    output = project_path(requested_output) if requested_output else default_output(source)
    if source.is_file():
        if source.suffix.lower() not in PHOTO_EXTENSIONS:
            raise ValueError(f"Unsupported photo type: {source.suffix or '(none)'}")
        if output.exists() and output.is_dir():
            output = output / f"{source.stem}{output_suffix(source)}"
        return [(source, output)]
    if not source.is_dir():
        raise FileNotFoundError(f"Photo or folder not found: {source}")
    if output.resolve().is_relative_to(source.resolve()):
        raise ValueError("Put the output beside the source folder, not inside it")
    files = find_photos(source, recursive)
    jobs = [
        (media, (output / media.relative_to(source)).with_suffix(output_suffix(media)))
        for media in files
    ]
    if not jobs:
        raise ValueError(f"No supported photos found in: {source}")
    return jobs


def process_photo(
    source: Path,
    destination: Path,
    args: argparse.Namespace,
) -> FinishReport:
    image, exif, icc_profile = load_photo(source)
    original_dimensions = image.size
    finished, tone_plan, straighten_plan = professional_finish_photo(
        image, args.strength, args.straighten == "auto", args.max_straighten
    )
    save_photo(finished, destination, exif, icc_profile, args.quality)
    shutil.copystat(source, destination)
    return FinishReport(
        str(source), str(destination),
        straighten_plan.angle, straighten_plan.confidence, straighten_plan.crop_percent,
        tone_plan.red_gain, tone_plan.green_gain, tone_plan.blue_gain,
        tone_plan.exposure, tone_plan.shadow_lift, tone_plan.highlight_control,
        tone_plan.contrast, tone_plan.saturation, tone_plan.detail_percent,
        f"{original_dimensions[0]}x{original_dimensions[1]}",
        f"{finished.width}x{finished.height}",
        "EXIF and ICC metadata retained",
    )


def print_report(report: FinishReport) -> None:
    print(f"Created: {report.output}")
    if abs(report.straighten_degrees) >= 0.01:
        print(
            f"  Straighten {report.straighten_degrees:+.2f} degrees "
            f"(confidence {report.straighten_confidence:.2f}, crop {report.straighten_crop_percent:.1f}%)"
        )
    else:
        print("  Straighten skipped; no reliable correction was needed")
    print(
        "  Finish: "
        f"colour {report.red_gain:.3f}/{report.green_gain:.3f}/{report.blue_gain:.3f}, "
        f"exposure {report.exposure:.3f}, shadows {report.shadow_lift:.3f}, "
        f"highlights {report.highlight_control:.3f}, contrast {report.contrast:.3f}, "
        f"colour intensity {report.saturation:.3f}"
    )
    print(
        f"  Media: {report.original_dimensions} to {report.output_dimensions}; {report.note}"
    )


def write_batch_report(output_root: Path, reports: list[FinishReport]) -> Path:
    report_path = (
        output_root.with_name(f"{output_root.stem}-report.json")
        if output_root.suffix
        else output_root / "professional-finish-report.json"
    )
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps([asdict(report) for report in reports], indent=2) + "\n",
        encoding="utf-8",
    )
    return report_path


def main() -> int:
    args = parse_args()
    source = project_path(args.source)
    output_root = project_path(args.output) if args.output else default_output(source)
    try:
        jobs = build_jobs(source, args.output, args.recursive)
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    print("Professional real-estate finish")
    print("Method: local deterministic adjustments; no AI and no uploads")
    print(f"Source: {source}")
    print(f"Files: {len(jobs)}\n")
    reports: list[FinishReport] = []
    skipped = 0
    failures = 0
    for source_path, output_path in jobs:
        if source_path.resolve() == output_path.resolve():
            print(f"Failed: output cannot replace original: {source_path}")
            failures += 1
            continue
        if output_path.exists() and not args.overwrite:
            print(f"Skipped existing copy: {output_path}")
            skipped += 1
            continue
        if args.dry_run:
            print(f"Would create: {output_path}")
            continue
        try:
            report = process_photo(source_path, output_path, args)
            reports.append(report)
            print_report(report)
        except Exception as error:
            print(f"Failed: {source_path}: {error}", file=sys.stderr)
            failures += 1
    if reports:
        print(f"\nAdjustment report: {write_batch_report(output_root, reports)}")
    print(
        f"Done. Created {len(reports)} finished file(s); skipped {skipped}; "
        f"failed {failures}. Originals were not changed."
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
