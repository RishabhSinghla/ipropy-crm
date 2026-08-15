#!/usr/bin/env python3
"""
Builds a fake property folder that has the problems real ones have.

Testing this pipeline on clean studio images would prove nothing. The photos it
will actually meet are 4032x3024 from an iPhone, yellow from tube light, black
in the corners, sideways in EXIF, and sometimes HEIC. So the fixture has all of
that on purpose.

    python3 make_test_property.py /tmp/test-property
"""
import pathlib
import subprocess
import sys

from PIL import Image, ImageDraw

OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/test-property')


def room(width: int, height: int, base: tuple[int, int, int], label: str,
         warm: bool, dark_corners: bool) -> Image.Image:
    """A crude room: a wall, a window, a floor, some furniture blocks."""
    im = Image.new('RGB', (width, height), base)
    d = ImageDraw.Draw(im)

    d.rectangle([0, int(height * 0.72), width, height], fill=(120, 92, 64))      # floor
    d.rectangle([int(width * 0.62), int(height * 0.18),
                 int(width * 0.92), int(height * 0.62)], fill=(238, 240, 245))    # window
    d.rectangle([int(width * 0.08), int(height * 0.48),
                 int(width * 0.42), int(height * 0.74)], fill=(86, 96, 112))      # sofa
    d.text((int(width * 0.06), int(height * 0.06)), label, fill=(40, 40, 40))

    if warm:
        # Tube light: push red and green up, blue down.
        r, g, b = im.split()
        im = Image.merge('RGB', (
            r.point(lambda v: min(255, int(v * 1.16))),
            g.point(lambda v: min(255, int(v * 1.07))),
            b.point(lambda v: int(v * 0.80)),
        ))
    if dark_corners:
        # Crude vignette — the corners of a real room photo really do go black.
        mask = Image.new('L', (width, height), 0)
        md = ImageDraw.Draw(mask)
        md.ellipse([-width // 3, -height // 3, width + width // 3, height + height // 3], fill=255)
        im = Image.composite(im, Image.new('RGB', im.size, (8, 8, 10)), mask)
    return im


def main() -> None:
    originals = OUT / '01 Originals'
    originals.mkdir(parents=True, exist_ok=True)
    for old in originals.glob('*'):
        old.unlink()

    plan = [
        ('IMG_4471', 'drawing room', (176, 168, 156), True, True, 'jpg'),
        ('IMG_4472', 'drawing room again', (176, 168, 156), True, True, 'heic'),
        ('IMG_4473', 'kitchen', (196, 190, 178), True, False, 'jpg'),
        ('IMG_4474', 'bedroom', (168, 160, 150), False, True, 'jpg'),
        ('IMG_4475', 'bathroom', (206, 208, 210), False, False, 'heic'),
        ('IMG_4476', 'balcony', (188, 196, 210), False, False, 'jpg'),
    ]

    made = []
    for stem, label, base, warm, dark, fmt in plan:
        im = room(4032, 3024, base, label, warm, dark)
        jpg = originals / f'{stem}.jpg'
        im.save(jpg, 'JPEG', quality=95)
        if fmt == 'heic':
            heic = originals / f'{stem}.HEIC'
            r = subprocess.run(['sips', '-s', 'format', 'heic', str(jpg), '--out', str(heic)],
                               capture_output=True)
            if r.returncode == 0:
                jpg.unlink()
                made.append(heic.name)
                continue
        made.append(jpg.name)

    # A file that is not a photograph at all — the pipeline must ignore it
    # rather than fall over.
    (originals / 'notes.txt').write_text('owner wants 2.4 cr\n')

    total = sum(f.stat().st_size for f in originals.iterdir() if f.is_file())
    print(f'{OUT}')
    print(f'  {len(made)} photos ({total / 1_048_576:.1f} MB) + 1 non-photo')
    for name in made:
        print(f'    {name}')


if __name__ == '__main__':
    main()
