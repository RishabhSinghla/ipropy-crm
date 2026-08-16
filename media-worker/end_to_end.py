#!/usr/bin/env python3
"""
The whole pipeline, start to finish, without credentials.

Everything except the two model calls is real: a fixture property with HEIC
files and yellow, dark rooms; the running worker; real HTTP; real files on
disk. The model is stubbed because its answers are a matter of taste and this
is checking the machinery, not the taste.

What it proves that the unit checks cannot: the worker and the workflow agree
about the shape of `plan`, the folders come out with the right names, the right
are cropped to the shape each platform wants, and the text files land where a
person will look.

    python3 end_to_end.py
"""
from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

WORKER = 'http://127.0.0.1:8712'
TOKEN = 'e2e-token'
ROOT = pathlib.Path('/tmp/ipropy-e2e')
PROPERTY = 'GREENFIELD/B12-4BHK-250SQYD'

failures = 0


def check(label: str, ok: bool, detail: str = '') -> None:
    global failures
    print(f'  {"ok  " if ok else "FAIL"}  {label}' + ('' if ok else f'  <- {detail}'))
    if not ok:
        failures += 1


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        WORKER + path, method='POST',
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'X-Worker-Token': TOKEN},
    )
    with urllib.request.urlopen(req, timeout=900) as res:
        return json.loads(res.read())


def main() -> int:
    shutil.rmtree(ROOT, ignore_errors=True)
    (ROOT / PROPERTY).mkdir(parents=True)

    here = pathlib.Path(__file__).parent
    subprocess.run([sys.executable, str(here / 'make_test_property.py'), str(ROOT / PROPERTY)],
                   check=True, capture_output=True)

    server = subprocess.Popen(
        [sys.executable, str(here / 'server.py')],
        env={**__import__('os').environ, 'IPROPY_ROOT': str(ROOT), 'IPROPY_TOKEN': TOKEN,
             'IPROPY_PORT': '8712'},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(40):
            try:
                urllib.request.urlopen(WORKER + '/health', timeout=1).read()
                break
            except Exception:
                time.sleep(0.25)

        print('\n1. prepare — originals become masters')
        t0 = time.time()
        prepared = post('/prepare', {'folder': PROPERTY})
        check('every original produced a master',
              len(prepared['masters']) == prepared['originals'],
              f"{len(prepared['masters'])} of {prepared['originals']}")
        check('HEIC was decoded, not skipped', prepared['skipped'] == [], str(prepared['skipped']))
        check('a preview exists for each master', len(prepared['previews']) == len(prepared['masters']))
        check('previews are small enough to send to a model',
              all(len(p['preview']) < 200_000 for p in prepared['previews']),
              f"largest {max(len(p['preview']) for p in prepared['previews'])} bytes")
        print(f'      {len(prepared["masters"])} photos in {time.time() - t0:.1f}s')

        # --- the model's part, stubbed -----------------------------------
        rooms = ['drawing room', 'drawing room', 'kitchen', 'bedroom', 'bathroom', 'balcony']
        labelled = [{'master': m, 'room': rooms[i % len(rooms)], 'subject': '', 'broken': False}
                    for i, m in enumerate(prepared['masters'])]

        # Same ordering rule the workflow uses, so the shapes are checked to match.
        ROOM_ORDER = ['drawing room', 'kitchen', 'bedroom', 'bathroom', 'balcony']
        seen: set[str] = set()
        first, rest = [], []
        for p in sorted(labelled, key=lambda p: ROOM_ORDER.index(p['room'])
                        if p['room'] in ROOM_ORDER else 99):
            (rest if p['room'] in seen else first).append(p)
            seen.add(p['room'])
        plan = [{'master': p['master'], 'label': p['room'], 'order': i + 1}
                for i, p in enumerate(first + rest)]

        print('\n2. publish — masters become the four delivery folders')
        t0 = time.time()
        result = post('/finish', {
            'folder': PROPERTY,
            'plan': plan,
            'files': {
                'captions.md': '# Captions\n\n## Instagram\nFour bedrooms in Greenfield.\n',
                'listing.md': '# Portal listing\n\n**Title**\n4 BHK Builder Floor\n',
                '_status.json': json.dumps({'ok': True, 'photos_published': len(plan)}, indent=2),
            },
        })
        print(f'      {len(plan)} photos x 4 folders in {time.time() - t0:.1f}s')

        folder = ROOT / PROPERTY
        expected = ['03 Portals and Website', '04 Google and Marketplace',
                    '05 Instagram and Facebook', '06 Reels Stories Status']
        for name in expected:
            check(f'{name} has every photo',
                  len(list((folder / name).glob('*.jpg'))) == len(plan))

        check('named and numbered for upload order',
              (folder / '03 Portals and Website' / '01-drawing-room.jpg').exists(),
              str(sorted(p.name for p in (folder / '03 Portals and Website').glob('*.jpg'))[:3]))
        check('the three text files are where a person looks',
              all((folder / n).exists() for n in ('captions.md', 'listing.md', '_status.json')))
        check('originals were not touched',
              len(list((folder / '01 Originals').iterdir())) == 7)  # 6 photos + notes.txt

        print('\n3. shapes')
        from PIL import Image, ImageStat
        ratios = {}
        for name in expected:
            im = Image.open(folder / name / '01-drawing-room.jpg')
            ratios[name] = round(im.width / im.height, 2)
        check('portals keep the landscape shape', ratios['03 Portals and Website'] > 1.2, str(ratios))
        check('google/marketplace is square', ratios['04 Google and Marketplace'] == 1.0)
        check('instagram is 4:5', abs(ratios['05 Instagram and Facebook'] - 0.8) < 0.02)
        check('stories are 9:16', abs(ratios['06 Reels Stories Status'] - 0.5625) < 0.02)

        tall = Image.open(folder / '06 Reels Stories Status' / '01-drawing-room.jpg')
        bottom = tall.convert('L').crop((0, int(tall.height * 0.93), tall.width, tall.height))
        check('nothing is written into the bottom of a 9:16 frame, where the buttons go',
              ImageStat.Stat(bottom).stddev[0] < 30, 'something is down there')

        print('\n4. size')
        sizes = {d.name: sum(f.stat().st_size for f in d.iterdir() if f.is_file())
                 for d in sorted(folder.iterdir()) if d.is_dir()}
        total = sum(sizes.values())
        for name, size in sizes.items():
            print(f'      {name:30} {size / 1024:7.0f} KB')
        print(f'      {"TOTAL":30} {total / 1_048_576:7.2f} MB')
        check('a whole property stays well under the demo\'s 673 MB',
              total < 100 * 1_048_576, f'{total / 1_048_576:.1f} MB')
    finally:
        server.terminate()
        server.wait(timeout=10)

    print(f'\n{"PASS" if failures == 0 else "FAIL"} — {failures} problem(s)\n')
    return 0 if failures == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
