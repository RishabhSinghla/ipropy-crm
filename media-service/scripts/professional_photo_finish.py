#!/usr/bin/env python3
"""Give iPropy property photos a restrained professional finish.

This is a basic automated finishing pass, not a replacement for manual retouching.
It corrects neutral colour, balances the main tones, adds gentle detail, and then
applies the official iPropy watermark. Original photos are never changed.

Examples:
  python3 scripts/professional_photo_finish.py B12-Greenfield-Colony/IMG_4377.jpg
  python3 scripts/professional_photo_finish.py B12-Greenfield-Colony B12-finished
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageChops, ImageEnhance, ImageFilter, ImageOps, ImageStat

from render_ipropy_watermark import (
    DEFAULT_LOGO,
    ORIENTATION_TAG,
    ROOT,
    SUPPORTED_EXTENSIONS,
    add_watermark,
    extract_official_logo,
    project_path,
)


DEFAULT_SOURCE = ROOT / "B12-Greenfield-Colony" / "IMG_4377.jpg"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create naturally edited, iPropy-watermarked copies of one photo "
            "or a folder of photos. Originals are left untouched."
        )
    )
    parser.add_argument(
        "source",
        nargs="?",
        default=str(DEFAULT_SOURCE),
        help="Original photo or folder to finish",
    )
    parser.add_argument(
        "output",
        nargs="?",
        help=(
            "Output photo or folder. The default name ends with "
            "'-ipropy-finished-watermarked'."
        ),
    )
    parser.add_argument(
        "--logo",
        default=str(DEFAULT_LOGO),
        help="Logo image to use (default: iPropy-Logo-1.jpeg)",
    )
    parser.add_argument(
        "--strength",
        type=int,
        default=100,
        metavar="PERCENT",
        help="Editing strength from 50 to 125 (default: 100)",
    )
    parser.add_argument(
        "--logo-size",
        type=float,
        metavar="PERCENT",
        help="Logo width as a percentage of the photo width (default: automatic)",
    )
    parser.add_argument(
        "--logo-opacity",
        type=int,
        default=94,
        metavar="PERCENT",
        help="Logo opacity from 20 to 100 (default: 94)",
    )
    parser.add_argument(
        "--quality",
        type=int,
        default=95,
        help="JPEG/WebP quality from 70 to 100 (default: 95)",
    )
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="Also process photos inside subfolders",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace existing finished copies, never the original photos",
    )
    args = parser.parse_args()

    if not 50 <= args.strength <= 125:
        parser.error("--strength must be between 50 and 125")
    if args.logo_size is not None and not 8 <= args.logo_size <= 35:
        parser.error("--logo-size must be between 8 and 35")
    if not 20 <= args.logo_opacity <= 100:
        parser.error("--logo-opacity must be between 20 and 100")
    if not 70 <= args.quality <= 100:
        parser.error("--quality must be between 70 and 100")
    return args


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


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


def neutral_white_balance(image: Image.Image, strength: float) -> tuple[Image.Image, tuple[float, float, float]]:
    """Correct obvious colour cast while retaining warm interior lighting."""
    preview = preview_copy(image, 1000)
    saturation = preview.convert("HSV").getchannel("S")
    brightness = preview.convert("HSV").getchannel("V")
    low_saturation = saturation.point(lambda value: 255 if value <= 48 else 0)
    useful_brightness = brightness.point(lambda value: 255 if 96 <= value <= 242 else 0)
    neutral_mask = ImageChops.multiply(low_saturation, useful_brightness)
    selected_pixels = sum(neutral_mask.histogram()[1:])

    if selected_pixels < max(200, round(preview.width * preview.height * 0.008)):
        return image, (1.0, 1.0, 1.0)

    means = ImageStat.Stat(preview, mask=neutral_mask).mean[:3]
    neutral_level = sum(means) / 3
    raw_gains = [neutral_level / max(channel, 1) for channel in means]

    # A partial correction is deliberate. Full grey-world correction often
    # removes the warm character that makes residential interiors feel natural.
    correction = 0.58 * strength
    gains = tuple(
        clamp(1 + ((gain - 1) * correction), 0.955, 1.045)
        for gain in raw_gains
    )
    channels = image.split()
    adjusted_channels = [
        channel.point(
            [min(255, max(0, round(value * gain))) for value in range(256)]
        )
        for channel, gain in zip(channels, gains)
    ]
    return Image.merge("RGB", adjusted_channels), gains


def tonal_percentiles(image: Image.Image) -> tuple[int, int, int, int, int]:
    histogram = ImageOps.grayscale(preview_copy(image)).histogram()
    return (
        percentile(histogram, 0.02),
        percentile(histogram, 0.10),
        percentile(histogram, 0.50),
        percentile(histogram, 0.90),
        percentile(histogram, 0.98),
    )


def balance_tones(image: Image.Image, strength: float) -> tuple[Image.Image, dict[str, float]]:
    p02, p10, median, p90, p98 = tonal_percentiles(image)

    # Move the middle of the image gently. The small exponent prevents the
    # aggressive exposure swings common in one-click HDR filters.
    exposure = clamp((132 / max(median, 1)) ** (0.28 * strength), 0.94, 1.08)
    image = ImageEnhance.Brightness(image).enhance(exposure)
    grayscale = ImageOps.grayscale(image)

    shadow_need = clamp((52 - p10) / 42, 0.0, 1.0)
    shadow_amount = 0.13 * shadow_need * strength
    if shadow_amount > 0.002:
        lifted = ImageEnhance.Brightness(image).enhance(1 + shadow_amount)
        shadow_mask = grayscale.point(
            lambda value: round(255 * (max(0.0, (132 - value) / 132) ** 1.65))
        )
        image = Image.composite(lifted, image, shadow_mask)

    highlight_need = clamp((p98 - 232) / 20, 0.0, 1.0)
    highlight_amount = 0.10 * highlight_need * strength
    if highlight_amount > 0.002:
        controlled = ImageEnhance.Brightness(image).enhance(1 - highlight_amount)
        highlight_mask = grayscale.point(
            lambda value: round(255 * (max(0.0, (value - 172) / 83) ** 1.55))
        )
        image = Image.composite(controlled, image, highlight_mask)

    tonal_range = p90 - p10
    contrast = 1 + (clamp((176 - tonal_range) / 900, 0.012, 0.035) * strength)
    image = ImageEnhance.Contrast(image).enhance(contrast)

    return image, {
        "exposure": exposure,
        "shadow_lift": shadow_amount,
        "highlight_control": highlight_amount,
        "contrast": contrast,
        "black_point": float(p02),
        "white_point": float(p98),
    }


def finish_detail_and_colour(image: Image.Image, strength: float) -> Image.Image:
    colour = 1 + (0.025 * strength)
    image = ImageEnhance.Color(image).enhance(colour)

    short_side = min(image.size)
    radius = clamp(short_side / 1850, 1.0, 2.8)
    sharpness = round(42 * strength)
    return image.filter(
        ImageFilter.UnsharpMask(
            radius=radius,
            percent=sharpness,
            threshold=3,
        )
    )


def professional_finish(image: Image.Image, strength_percent: int) -> tuple[Image.Image, dict[str, object]]:
    strength = strength_percent / 100
    image = image.convert("RGB")
    image, white_balance = neutral_white_balance(image, strength)
    image, tone_report = balance_tones(image, strength)
    image = finish_detail_and_colour(image, strength)
    return image, {"white_balance": white_balance, **tone_report}


def find_photos(folder: Path, recursive: bool) -> list[Path]:
    candidates = folder.rglob("*") if recursive else folder.iterdir()
    excluded_names = ("-ipropy-watermarked", "-ipropy-finished-watermarked")
    return sorted(
        path
        for path in candidates
        if path.is_file()
        and path.suffix.lower() in SUPPORTED_EXTENSIONS
        and not any(marker in path.stem.lower() for marker in excluded_names)
    )


def build_jobs(
    source: Path,
    requested_output: str | None,
    recursive: bool,
) -> list[tuple[Path, Path]]:
    if source.is_file():
        if source.suffix.lower() not in SUPPORTED_EXTENSIONS:
            raise ValueError(f"Unsupported photo type: {source.suffix or '(none)'}")
        output = (
            project_path(requested_output)
            if requested_output
            else source.with_name(
                f"{source.stem}-ipropy-finished-watermarked{source.suffix}"
            )
        )
        if output.is_dir():
            output = output / source.name
        return [(source, output)]

    if not source.is_dir():
        raise FileNotFoundError(f"Photo or folder not found: {source}")

    output_folder = (
        project_path(requested_output)
        if requested_output
        else source.with_name(f"{source.name}-finished-watermarked")
    )
    jobs = [
        (photo, output_folder / photo.relative_to(source))
        for photo in find_photos(source, recursive)
    ]
    if not jobs:
        raise ValueError(f"No supported photos found in: {source}")
    return jobs


def save_result(
    image: Image.Image,
    output_path: Path,
    exif: Image.Exif,
    icc_profile: bytes | None,
    quality: int,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    options: dict[str, object] = {}
    if exif:
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
            **options,
        )
    elif extension == ".webp":
        image.convert("RGB").save(
            output_path,
            quality=quality,
            method=6,
            **options,
        )
    elif extension == ".png":
        image.save(output_path, optimize=True, **options)
    else:
        raise ValueError(f"Unsupported output type: {extension or '(none)'}")


def process_photo(
    source_path: Path,
    output_path: Path,
    logo: Image.Image,
    args: argparse.Namespace,
) -> dict[str, object]:
    with Image.open(source_path) as opened:
        icc_profile = opened.info.get("icc_profile")
        photo = ImageOps.exif_transpose(opened).convert("RGB")
        exif = photo.getexif()

    if ORIENTATION_TAG in exif:
        exif[ORIENTATION_TAG] = 1

    finished, report = professional_finish(photo, args.strength)
    watermarked = add_watermark(
        finished,
        logo,
        args.logo_size,
        args.logo_opacity,
    )
    save_result(watermarked, output_path, exif, icc_profile, args.quality)
    return report


def print_report(report: dict[str, object]) -> None:
    red, green, blue = report["white_balance"]
    print(
        "  Finish: "
        f"colour {red:.3f}/{green:.3f}/{blue:.3f}, "
        f"light {report['exposure']:.3f}, "
        f"shadows {report['shadow_lift']:.3f}, "
        f"highlights {report['highlight_control']:.3f}"
    )


def main() -> None:
    args = parse_args()
    source = project_path(args.source)
    logo = extract_official_logo(project_path(args.logo))
    jobs = build_jobs(source, args.output, args.recursive)

    created = 0
    skipped = 0
    for source_path, output_path in jobs:
        if source_path.resolve() == output_path.resolve():
            raise ValueError(f"Output cannot replace the original photo: {source_path}")
        if output_path.exists() and not args.overwrite:
            print(f"Skipped existing copy: {output_path}")
            skipped += 1
            continue

        report = process_photo(source_path, output_path, logo, args)
        print(f"Created: {output_path}")
        print_report(report)
        created += 1

    print(f"Done. Created {created} finished photo(s); skipped {skipped}.")


if __name__ == "__main__":
    main()
