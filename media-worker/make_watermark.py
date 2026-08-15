#!/usr/bin/env python3
"""
Turns the iPropy logo into a watermark that can sit on a photograph.

The brand file is a square JPEG: navy hairline border, white field, gold key,
navy wordmark. None of that can go straight onto a photograph — a white box in
the corner of a drawing room is exactly the ugly thing we are trying to avoid.

So this does three things:

1. **Crops away the border and the surrounding white.** What is left is the key
   and the words, tight.
2. **Turns white into transparency**, keeping the key's gold and the wordmark's
   shape as an alpha mask rather than as colour.
3. **Re-colours it to a single flat tone** and writes two versions — white for
   normal and dark photographs, navy for bright ones like a sunlit terrace.

A single flat colour is deliberate. A gold-and-navy logo composited at 50%
opacity over a beige wall turns muddy; one colour at a low opacity reads as an
intentional mark instead of a sticker somebody pasted on.

    python3 make_watermark.py
"""
import pathlib
from PIL import Image, ImageChops, ImageFilter, ImageOps

HERE = pathlib.Path(__file__).parent
BRAND = HERE / 'brand'
SOURCE = BRAND / 'logo-source.jpg'

# Anything at least this bright counts as background.
WHITE_CUTOFF = 238
# The hairline border is a few pixels in; start inside it before measuring.
BORDER_INSET = 14


def trimmed_logo() -> Image.Image:
    """The key and the wordmark, with everything around them removed."""
    im = Image.open(SOURCE).convert('RGB')
    w, h = im.size
    im = im.crop((BORDER_INSET, BORDER_INSET, w - BORDER_INSET, h - BORDER_INSET))

    # Bounding box of everything darker than the background.
    grey = im.convert('L')
    mask = grey.point(lambda v: 255 if v < WHITE_CUTOFF else 0)
    box = mask.getbbox()
    if box is None:
        raise SystemExit('the logo appears to be blank — check brand/logo-source.jpg')
    return im.crop(box)


def to_alpha(logo: Image.Image) -> Image.Image:
    """
    Ink becomes opacity.

    White -> fully transparent, black -> fully opaque, and the gold key lands in
    between in proportion to how dark it is. That keeps the key's fine bits
    (the three rings, the teeth) instead of hard-cutting them to a blob.
    """
    grey = logo.convert('L')
    alpha = ImageChops.invert(grey)

    # The gold key and the navy wordmark are nowhere near the same darkness —
    # the key reads about 175 in greyscale against the wordmark's 40, so a
    # straight inversion leaves the key at a third of the text's opacity and it
    # vanishes on a busy photo. Stretch the ink range so the lightest real ink
    # still lands high, then a gentle gamma to keep the antialiased edges soft
    # rather than crunching them to a hard cut-out.
    alpha = ImageOps.autocontrast(alpha, cutoff=(0.5, 0))
    alpha = alpha.point(lambda v: 0 if v < 26 else min(255, int(150 + (v / 255) ** 0.55 * 105)))
    return alpha


def coloured(alpha: Image.Image, rgb: tuple[int, int, int], shadow: bool) -> Image.Image:
    """One flat colour, shaped by the alpha mask, optionally with a soft shadow."""
    out = Image.new('RGBA', alpha.size, (0, 0, 0, 0))

    if shadow:
        # A very soft dark halo is what stops a white mark disappearing against
        # a white wall or a bright window. Barely visible on its own.
        pad = 6
        out = Image.new('RGBA', (alpha.width + pad * 2, alpha.height + pad * 2), (0, 0, 0, 0))
        halo = Image.new('RGBA', out.size, (0, 0, 0, 0))
        halo.putalpha(Image.new('L', out.size, 0))
        blur = Image.new('L', out.size, 0)
        blur.paste(alpha, (pad, pad))
        blur = blur.filter(ImageFilter.GaussianBlur(4))
        blur = blur.point(lambda v: int(v * 0.45))
        halo = Image.merge('RGBA', (
            Image.new('L', out.size, 0), Image.new('L', out.size, 0),
            Image.new('L', out.size, 0), blur,
        ))
        out = Image.alpha_composite(out, halo)
        layer = Image.new('RGBA', out.size, (0, 0, 0, 0))
        ink = Image.new('L', out.size, 0)
        ink.paste(alpha, (pad, pad))
        layer = Image.merge('RGBA', (
            Image.new('L', out.size, rgb[0]), Image.new('L', out.size, rgb[1]),
            Image.new('L', out.size, rgb[2]), ink,
        ))
        return Image.alpha_composite(out, layer)

    return Image.merge('RGBA', (
        Image.new('L', alpha.size, rgb[0]), Image.new('L', alpha.size, rgb[1]),
        Image.new('L', alpha.size, rgb[2]), alpha,
    ))


def main() -> None:
    logo = trimmed_logo()
    alpha = to_alpha(logo)

    # Wide enough that it stays crisp when placed on a 2400px photo, small
    # enough not to be a heavy file.
    target_w = 900
    alpha = alpha.resize((target_w, round(alpha.height * target_w / alpha.width)), Image.LANCZOS)

    white = coloured(alpha, (255, 255, 255), shadow=True)
    navy = coloured(alpha, (26, 35, 62), shadow=False)

    white.save(BRAND / 'watermark-light.png')
    navy.save(BRAND / 'watermark-dark.png')

    print(f'trimmed logo   {logo.size[0]}x{logo.size[1]}')
    print(f'watermark-light.png  {white.size[0]}x{white.size[1]}  (white + soft shadow, for most photos)')
    print(f'watermark-dark.png   {navy.size[0]}x{navy.size[1]}  (navy, for very bright photos)')


if __name__ == '__main__':
    main()
