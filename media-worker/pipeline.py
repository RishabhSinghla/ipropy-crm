#!/usr/bin/env python3
"""
Everything that happens to a property's photographs.

Runs on the Mac that already syncs OneDrive, so it reads and writes ordinary
local files. That is not a shortcut — it removes the Microsoft Graph API, the
OAuth dance and the token refresh from the whole design. OneDrive's own client
does the uploading, which it is far better at than we would be.

The order matters and is the same every time:

    01 Originals  ->  02 Master  ->  03/04/05/06

`02 Master` is compressed and corrected **once**. Every crop is then made from
the master in a single step. Compressing twice is the classic way to end up
with mush: each JPEG save throws away a little more, and four derivative sets
means four chances to do it.

What this deliberately does NOT do
----------------------------------
**Straightening.** Getting verticals true needs real line detection, and a
guess that rotates a room two degrees the wrong way is worse than leaving it
alone. Naming a limitation is cheaper than shipping a bad rotation.

**Culling.** Ranking and grouping near-identical shots is the model's job in
n8n. This applies a plan; it does not form one.
"""
from __future__ import annotations

import json
import pathlib
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Iterable

from PIL import Image, ImageEnhance, ImageOps

HERE = pathlib.Path(__file__).parent
WATERMARK_LIGHT = HERE / 'brand' / 'watermark-light.png'

ORIGINALS = '01 Originals'
MASTER = '02 Master'

# Folder -> (aspect ratio or None to keep the master's, watermark?)
# None means "whatever shape the master is", which for a landscape photo is
# what portals and the website want.
DERIVATIVES: dict[str, tuple[tuple[int, int] | None, bool]] = {
    '03 Portals and Website':    (None,   False),  # portals can flag heavy branding
    '04 Google and Marketplace': ((1, 1), True),
    '05 Instagram and Facebook': ((4, 5), True),
    '06 Reels Stories Status':   ((9, 16), True),
}

MASTER_LONG_EDGE = 2400
MASTER_QUALITY = 88
DERIVATIVE_QUALITY = 86

# Watermark geometry, as a fraction of the image it sits on.
WM_WIDTH = 0.16
WM_INSET = 0.035
WM_OPACITY = 0.52
# Instagram and WhatsApp draw their own buttons over the bottom of a 9:16
# frame, so the mark moves up out of that band rather than hiding under a
# "Send message" bar.
WM_TALL_BOTTOM_SAFE = 0.14

IMAGE_SUFFIXES = {'.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp'}
VIDEO_SUFFIXES = {'.mov', '.mp4', '.m4v'}


# ---------------------------------------------------------------------------
# Reading what the phone produced
# ---------------------------------------------------------------------------

def _decode_heic(src: pathlib.Path, dest: pathlib.Path) -> bool:
    """
    HEIC via macOS's own `sips`.

    Pillow cannot open HEIC without pillow-heif, and sharp's libvips ships with
    no HEVC decoder either — the same trap this project has already been caught
    by once. `sips` is part of macOS, needs installing nothing, and reads what
    an iPhone writes.
    """
    r = subprocess.run(
        ['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '95',
         str(src), '--out', str(dest)],
        capture_output=True, text=True,
    )
    return r.returncode == 0 and dest.exists()


def _open_any(path: pathlib.Path, scratch: pathlib.Path) -> Image.Image | None:
    """An image from any of the formats a phone might hand us, or None."""
    if path.suffix.lower() in {'.heic', '.heif'}:
        tmp = scratch / (path.stem + '.jpg')
        if not _decode_heic(path, tmp):
            return None
        path = tmp
    try:
        im = Image.open(path)
        # Phones record orientation in EXIF rather than rotating the pixels.
        # Without this, a photo held normally arrives on its side.
        im = ImageOps.exif_transpose(im)
        return im.convert('RGB')
    except Exception:
        return None


# ---------------------------------------------------------------------------
# The corrections that actually matter for an Indian interior
# ---------------------------------------------------------------------------

def _white_balance(im: Image.Image) -> Image.Image:
    """
    Neutralise the colour cast, gently.

    Tube lights and warm LEDs turn a white wall yellow-green, and every phone
    leaves some of that in. This measures the average of each channel and pulls
    them towards each other — the "grey world" assumption, which holds well for
    a room and badly for, say, a photo that is mostly sky.

    Capped at 12% correction per channel. An uncapped grey-world on a room with
    one big red sofa will drain the sofa, and a slightly warm photo is far less
    damaging than a visibly wrong one.
    """
    # Measured on a thumbnail: the average colour of a room does not change
    # with resolution, and this runs on every photo.
    small = im.resize((64, 64), Image.BILINEAR)
    means = [max(1.0, sum(ch.getdata()) / (64 * 64)) for ch in small.split()]
    target = sum(means) / 3

    out = []
    for ch, mean in zip(im.split(), means):
        factor = max(0.88, min(1.12, target / mean))
        out.append(ch.point(lambda v, f=factor: min(255, int(v * f))))
    return Image.merge('RGB', out)


def _lift_shadows(im: Image.Image) -> Image.Image:
    """
    Open up the dark corners without flattening the picture.

    Indian interiors are lit from one side and the far corners go to black.
    This is a curve that lifts the bottom third and leaves the highlights
    alone, so a bright window stays bright instead of going grey.
    """
    lut = []
    for v in range(256):
        x = v / 255
        lifted = x ** 0.82          # gamma < 1 opens the shadows
        blend = max(0.0, 1 - x * 1.8)  # only in the darks
        y = x * (1 - blend) + lifted * blend
        lut.append(min(255, int(y * 255)))
    return im.point(lut * 3)


def correct(im: Image.Image) -> Image.Image:
    """The whole light touch, in the order that behaves best."""
    im = _white_balance(im)
    im = _lift_shadows(im)
    # A little contrast last, after the shadows have been opened, or the lift
    # just gets undone.
    im = ImageEnhance.Contrast(im).enhance(1.04)
    im = ImageEnhance.Color(im).enhance(1.03)
    return im


# ---------------------------------------------------------------------------
# Shaping
# ---------------------------------------------------------------------------

def _crop_to(im: Image.Image, ratio: tuple[int, int]) -> Image.Image:
    """
    Centre crop to a ratio.

    Centre rather than clever: a room is photographed from the doorway with the
    subject in the middle, and an automatic "interesting area" crop is exactly
    the sort of thing that decides the interesting part of a bedroom is the
    plug socket.
    """
    want = ratio[0] / ratio[1]
    have = im.width / im.height
    if abs(want - have) < 0.01:
        return im.copy()
    if have > want:
        new_w = round(im.height * want)
        left = (im.width - new_w) // 2
        return im.crop((left, 0, left + new_w, im.height))
    new_h = round(im.width / want)
    top = (im.height - new_h) // 2
    return im.crop((0, top, im.width, top + new_h))


def _fit_long_edge(im: Image.Image, long_edge: int) -> Image.Image:
    if max(im.size) <= long_edge:
        return im.copy()
    scale = long_edge / max(im.size)
    return im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)


def watermark(im: Image.Image, tall: bool = False) -> Image.Image:
    """
    The mark, bottom-left, small and quiet.

    Bottom-**left** because portals and Instagram both like to put their own
    furniture bottom-right. Semi-transparent white with a soft shadow so it
    survives a pale wall without ever becoming the thing you look at.
    """
    if not WATERMARK_LIGHT.exists():
        return im
    mark = Image.open(WATERMARK_LIGHT).convert('RGBA')

    target_w = max(90, round(im.width * WM_WIDTH))
    mark = mark.resize((target_w, round(mark.height * target_w / mark.width)), Image.LANCZOS)

    alpha = mark.getchannel('A').point(lambda v: int(v * WM_OPACITY))
    mark.putalpha(alpha)

    inset = round(im.width * WM_INSET)
    bottom_gap = round(im.height * WM_TALL_BOTTOM_SAFE) if tall else inset
    pos = (inset, im.height - mark.height - bottom_gap)

    canvas = im.convert('RGBA')
    canvas.alpha_composite(mark, pos)
    return canvas.convert('RGB')


# ---------------------------------------------------------------------------
# The two jobs n8n asks for
# ---------------------------------------------------------------------------

@dataclass
class Prepared:
    originals: list[str] = field(default_factory=list)
    masters: list[str] = field(default_factory=list)
    videos: list[str] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)


def slugify(text: str) -> str:
    s = re.sub(r'[^a-z0-9]+', '-', (text or '').lower()).strip('-')
    return s or 'photo'


def prepare(folder: pathlib.Path) -> Prepared:
    """
    `01 Originals` -> `02 Master`.

    Decode, correct, resize, save once. Master filenames keep the original stem
    so a master can always be traced back to the file the phone wrote — the
    friendly names come later, and only on the copies.
    """
    src = folder / ORIGINALS
    dest = folder / MASTER
    dest.mkdir(parents=True, exist_ok=True)
    scratch = dest / '.scratch'
    scratch.mkdir(exist_ok=True)

    out = Prepared()
    try:
        for path in sorted(src.iterdir()):
            if path.name.startswith('.'):
                continue
            suffix = path.suffix.lower()

            if suffix in VIDEO_SUFFIXES:
                out.videos.append(path.name)
                continue
            if suffix not in IMAGE_SUFFIXES:
                continue

            out.originals.append(path.name)
            im = _open_any(path, scratch)
            if im is None:
                out.skipped.append({'file': path.name, 'why': 'could not be decoded'})
                continue

            im = correct(_fit_long_edge(im, MASTER_LONG_EDGE))
            target = dest / f'{path.stem}.jpg'
            im.save(target, 'JPEG', quality=MASTER_QUALITY, optimize=True, progressive=True)
            out.masters.append(target.name)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    return out


def finish(folder: pathlib.Path, plan: Iterable[dict]) -> dict:
    """
    Masters -> the four delivery folders, named and ordered.

    `plan` is a list of {master, label, order}. Anything the plan omits simply
    is not published — which is how "do not cull, just order" is expressed:
    n8n sends every photo, in the order it chose.
    """
    master_dir = folder / MASTER
    made: dict[str, list[str]] = {name: [] for name in DERIVATIVES}
    used: list[dict] = []

    ordered = sorted(plan, key=lambda p: p.get('order', 9999))
    for index, item in enumerate(ordered, start=1):
        src = master_dir / str(item.get('master', ''))
        if not src.exists():
            continue
        try:
            base = Image.open(src).convert('RGB')
        except Exception:
            continue

        name = f'{index:02d}-{slugify(item.get("label"))}.jpg'
        used.append({'master': src.name, 'published_as': name,
                     'label': item.get('label'), 'position': index})

        for folder_name, (ratio, mark) in DERIVATIVES.items():
            target_dir = folder / folder_name
            target_dir.mkdir(parents=True, exist_ok=True)

            im = _crop_to(base, ratio) if ratio else base.copy()
            tall = bool(ratio and ratio[0] / ratio[1] < 0.8)
            if mark:
                im = watermark(im, tall=tall)
            im.save(target_dir / name, 'JPEG', quality=DERIVATIVE_QUALITY,
                    optimize=True, progressive=True)
            made[folder_name].append(name)

    return {'published': used, 'folders': {k: len(v) for k, v in made.items()}}


def write_text_files(folder: pathlib.Path, files: dict[str, str]) -> list[str]:
    """captions.md, listing.md, _status.json — whatever n8n hands over."""
    written = []
    for name, body in files.items():
        # Never let a caller write outside the property folder.
        safe = pathlib.Path(name).name
        if not safe or safe.startswith('.') and safe != '_status.json':
            continue
        (folder / safe).write_text(body if isinstance(body, str) else json.dumps(body, indent=2))
        written.append(safe)
    return written
