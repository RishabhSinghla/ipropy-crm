#!/usr/bin/env python3
"""
Which key signed this APK — without an Android SDK.

`apksigner` would answer this in one line and lives in the SDK, which this
container cannot install (dl.google.com is blocked by its egress proxy). So
this reads the APK Signing Block itself. It is about forty lines because the
format is simple: a ZIP, with a block of id/value pairs wedged between the
last entry and the central directory.

Why it matters here. Android refuses an update signed by a different key from
the build already on the phone, and the only way to know whether two builds
share a key is to read their certificates. On 21 September 2026 that answered
a question that had been assumed rather than checked: 1.0.0 and 2.1.0 are
signed by **two different keys**, with no rotation lineage, so the handsets
still on 1.0.0 must uninstall whatever happens next.

    python3 packages/app/scripts/which-key-signed-it.py <apk> [<apk> ...]

Prints each signer's SHA-256 fingerprint and subject, and which signature
schemes are present. A `v3.1` block with a lineage would mean the key was
properly rotated and an update WOULD install — so its absence is the finding,
not a detail.
"""
import hashlib
import os
import struct
import subprocess
import sys

SCHEMES = {
    0x7109871A: 'v2',
    0xF05368C0: 'v3',
    0x1B93AD61: 'v3.1 (key rotation)',
    0x42726577: 'padding',
}


def signing_block(path: str) -> bytes | None:
    data = open(path, 'rb').read()
    eocd = data.rfind(b'PK\x05\x06')
    if eocd < 0:
        return None
    central_dir = struct.unpack_from('<I', data, eocd + 16)[0]
    if data[central_dir - 16:central_dir] != b'APK Sig Block 42':
        return None
    size = struct.unpack_from('<Q', data, central_dir - 24)[0]
    return data[central_dir - 8 - size:central_dir]


def certificates(block: bytes) -> list[tuple[str, str]]:
    """Every DER certificate in the block, by brute scan.

    Walking the nested length-prefixed structure properly would be longer and
    no more correct for this question: a run of bytes either parses as X.509
    or it does not, and openssl is the authority on that.
    """
    found, i = [], 0
    while i < len(block) - 4:
        if block[i] == 0x30 and block[i + 1] == 0x82:
            length = struct.unpack_from('>H', block, i + 2)[0] + 4
            candidate = block[i:i + length]
            shown = subprocess.run(
                ['openssl', 'x509', '-inform', 'DER', '-noout',
                 '-fingerprint', '-sha256', '-subject', '-startdate'],
                input=candidate, capture_output=True,
            )
            if shown.returncode == 0:
                found.append((hashlib.sha256(candidate).hexdigest(), shown.stdout.decode()))
                i += length
                continue
        i += 1
    return found


def schemes(block: bytes) -> list[str]:
    names, offset = [], 8
    while offset < len(block) - 24:
        length = struct.unpack_from('<Q', block, offset)[0]
        if length < 4 or offset + 8 + length > len(block):
            break
        pair_id = struct.unpack_from('<I', block, offset + 8)[0]
        if pair_id in SCHEMES and SCHEMES[pair_id] != 'padding':
            names.append(SCHEMES[pair_id])
        offset += 8 + length
    return names


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip())
        return 2
    for path in sys.argv[1:]:
        print(f'=== {os.path.basename(path)}')
        block = signing_block(path)
        if block is None:
            print('  no APK Signing Block — JAR-signed only, or not an APK')
            continue
        print(f'  schemes: {", ".join(schemes(block)) or "none recognised"}')
        seen = set()
        for digest, text in certificates(block):
            if digest in seen:
                continue
            seen.add(digest)
            for line in text.strip().splitlines():
                print(f'  {line}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
