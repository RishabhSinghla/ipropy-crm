#!/usr/bin/env python3
"""Add the official iPropy logo to one photo or a folder of photos.

The original files are never changed. New copies are created with a small,
subtle logo card in the bottom-left corner.

Examples:
  python3 scripts/render_ipropy_watermark.py B12-Greenfield-Colony/IMG_4383.jpg
  python3 scripts/render_ipropy_watermark.py B12-Greenfield-Colony B12-watermarked
  python3 scripts/render_ipropy_watermark.py B12-Greenfield-Colony --recursive
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LOGO = ROOT / "iPropy-Logo-1.jpeg"
DEFAULT_SOURCE = ROOT / "B12-Greenfield-Colony" / "IMG_4377.jpg"
SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
ORIENTATION_TAG = 274


def project_path(value: str | Path) -> Path:
    """Resolve relative paths from the iPropy-work-items folder."""
    path = Path(value).expanduser()
    return path if path.is_absolute() else ROOT / path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create watermarked copies using the official iPropy logo. "
            "Original photos are left untouched."
        )
    )
    parser.add_argument(
        "source",
        nargs="?",
        default=str(DEFAULT_SOURCE),
        help="Photo or folder to process (default: the included sample photo)",
    )
    parser.add_argument(
        "output",
        nargs="?",
        help=(
            "Output photo or folder. By default, a photo gets an "
            "'-ipropy-watermarked' copy and a folder gets a '-watermarked' folder."
        ),
    )
    parser.add_argument(
        "--logo",
        default=str(DEFAULT_LOGO),
        help="Logo image to use (default: iPropy-Logo-1.jpeg)",
    )
    parser.add_argument(
        "--size",
        type=float,
        metavar="PERCENT",
        help="Logo width as a percentage of the photo width (default: automatic)",
    )
    parser.add_argument(
        "--opacity",
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
        help="Replace existing watermarked copies, never the original photos",
    )
    args = parser.parse_args()

    if args.size is not None and not 8 <= args.size <= 35:
        parser.error("--size must be between 8 and 35")
    if not 20 <= args.opacity <= 100:
        parser.error("--opacity must be between 20 and 100")
    if not 70 <= args.quality <= 100:
        parser.error("--quality must be between 70 and 100")
    return args


def extract_official_logo(logo_path: Path) -> Image.Image:
    """Remove the white canvas while keeping the logo's original colours."""
    if not logo_path.is_file():
        raise FileNotFoundError(f"Logo not found: {logo_path}")

    with Image.open(logo_path) as opened:
        source = ImageOps.exif_transpose(opened).convert("RGB")

    # Logo 1 has a thin frame at the edge. Ignore that frame, then detect the
    # navy-and-gold artwork against its nearly white JPEG background.
    edge = max(2, round(min(source.size) * 0.04))
    source = source.crop((edge, edge, source.width - edge, source.height - edge))
    white = Image.new("RGB", source.size, "white")
    difference = ImageChops.difference(source, white).convert("L")

    def alpha_for(value: int) -> int:
        if value <= 8:
            return 0
        if value >= 38:
            return 255
        return round((value - 8) * 255 / 30)

    alpha = difference.point(alpha_for)
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError(f"No visible artwork found in logo: {logo_path}")

    pad = max(4, round(min(source.size) * 0.012))
    left = max(0, bounds[0] - pad)
    top = max(0, bounds[1] - pad)
    right = min(source.width, bounds[2] + pad)
    bottom = min(source.height, bounds[3] + pad)

    source = source.crop((left, top, right, bottom)).convert("RGBA")
    source.putalpha(alpha.crop((left, top, right, bottom)))
    return source


def logo_width_ratio(width: int, height: int, requested_size: float | None) -> float:
    if requested_size is not None:
        return requested_size / 100
    # Portrait property photos need a touch more width for the small tagline.
    return 0.18 if height >= width else 0.14


def add_watermark(
    photo: Image.Image,
    logo_source: Image.Image,
    requested_size: float | None,
    opacity: int,
) -> Image.Image:
    photo = photo.convert("RGBA")
    width, height = photo.size
    short_side = min(width, height)
    margin = max(14, round(short_side * 0.025))

    target_width = round(width * logo_width_ratio(width, height, requested_size))
    target_width = min(target_width, width - (2 * margin))
    target_height = max(1, round(logo_source.height * target_width / logo_source.width))
    logo = logo_source.resize((target_width, target_height), Image.Resampling.LANCZOS)

    if opacity < 100:
        alpha = logo.getchannel("A").point(lambda value: round(value * opacity / 100))
        logo.putalpha(alpha)

    horizontal_padding = max(12, round(target_width * 0.065))
    vertical_padding = max(10, round(target_width * 0.038))
    card_width = target_width + (2 * horizontal_padding)
    card_height = target_height + (2 * vertical_padding)
    radius = max(8, round(card_height * 0.075))

    blur = max(7, round(short_side * 0.004))
    shadow_space = blur * 3
    shadow_offset = max(2, round(short_side * 0.0015))
    layer_size = (
        card_width + (2 * shadow_space),
        card_height + (2 * shadow_space) + shadow_offset,
    )

    shadow = Image.new("RGBA", layer_size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_box = (
        shadow_space,
        shadow_space + shadow_offset,
        shadow_space + card_width,
        shadow_space + shadow_offset + card_height,
    )
    shadow_draw.rounded_rectangle(shadow_box, radius=radius, fill=(5, 10, 20, 58))
    shadow = shadow.filter(ImageFilter.GaussianBlur(blur))

    card = Image.new("RGBA", layer_size, (0, 0, 0, 0))
    card_draw = ImageDraw.Draw(card)
    card_box = (
        shadow_space,
        shadow_space,
        shadow_space + card_width,
        shadow_space + card_height,
    )
    card_draw.rounded_rectangle(
        card_box,
        radius=radius,
        fill=(255, 253, 248, 205),
        outline=(255, 255, 255, 135),
        width=max(1, round(short_side * 0.0005)),
    )
    layer = Image.alpha_composite(shadow, card)
    layer.alpha_composite(
        logo,
        (
            shadow_space + horizontal_padding,
            shadow_space + vertical_padding,
        ),
    )

    destination = (
        margin - shadow_space,
        height - margin - card_height - shadow_space,
    )
    photo.alpha_composite(layer, destination)
    return photo


def output_for_file(source: Path, requested_output: str | None) -> Path:
    if requested_output:
        output = project_path(requested_output)
        if output.is_dir():
            return output / source.name
        return output
    return source.with_name(f"{source.stem}-ipropy-watermarked{source.suffix}")


def find_photos(folder: Path, recursive: bool) -> list[Path]:
    candidates = folder.rglob("*") if recursive else folder.iterdir()
    return sorted(
        path
        for path in candidates
        if path.is_file()
        and path.suffix.lower() in SUPPORTED_EXTENSIONS
        and "-ipropy-watermarked" not in path.stem.lower()
    )


def build_jobs(
    source: Path,
    requested_output: str | None,
    recursive: bool,
) -> list[tuple[Path, Path]]:
    if source.is_file():
        if source.suffix.lower() not in SUPPORTED_EXTENSIONS:
            raise ValueError(f"Unsupported photo type: {source.suffix or '(none)'}")
        return [(source, output_for_file(source, requested_output))]

    if not source.is_dir():
        raise FileNotFoundError(f"Photo or folder not found: {source}")

    output_folder = (
        project_path(requested_output)
        if requested_output
        else source.with_name(f"{source.name}-watermarked")
    )
    jobs = [
        (photo, output_folder / photo.relative_to(source))
        for photo in find_photos(source, recursive)
    ]
    if not jobs:
        raise ValueError(f"No supported photos found in: {source}")
    return jobs


def save_photo(
    source_path: Path,
    output_path: Path,
    logo: Image.Image,
    requested_size: float | None,
    opacity: int,
    quality: int,
) -> None:
    with Image.open(source_path) as opened:
        icc_profile = opened.info.get("icc_profile")
        photo = ImageOps.exif_transpose(opened)
        exif = photo.getexif()

    # The pixels now have their final orientation. Do not ask another viewer to
    # rotate the exported copy a second time.
    if ORIENTATION_TAG in exif:
        exif[ORIENTATION_TAG] = 1

    result = add_watermark(photo, logo, requested_size, opacity)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    extension = output_path.suffix.lower()
    common_options: dict[str, object] = {}
    if exif:
        common_options["exif"] = exif.tobytes()
    if icc_profile:
        common_options["icc_profile"] = icc_profile

    if extension in {".jpg", ".jpeg"}:
        result.convert("RGB").save(
            output_path,
            quality=quality,
            subsampling=0,
            optimize=True,
            **common_options,
        )
    elif extension == ".webp":
        result.convert("RGB").save(
            output_path,
            quality=quality,
            method=6,
            **common_options,
        )
    elif extension == ".png":
        result.save(output_path, optimize=True, **common_options)
    else:
        raise ValueError(f"Unsupported output type: {extension or '(none)'}")


def main() -> None:
    args = parse_args()
    source = project_path(args.source)
    logo_path = project_path(args.logo)
    logo = extract_official_logo(logo_path)
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
        save_photo(
            source_path,
            output_path,
            logo,
            args.size,
            args.opacity,
            args.quality,
        )
        print(f"Created: {output_path}")
        created += 1

    print(f"Done. Created {created} watermarked photo(s); skipped {skipped}.")


if __name__ == "__main__":
    main()
