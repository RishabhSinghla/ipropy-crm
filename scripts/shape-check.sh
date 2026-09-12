#!/usr/bin/env bash
# Run the integration suite on production's field shape and report only 42703.
#
# `npm run test:integration` runs against a fresh seed: ~60 columns per module,
# every field named after its own column, nothing in JSONB. Production has 15
# and 16 columns, several renamed, the rest permanently deleted. Every outage
# this project keeps rediscovering — a query naming a column an admin removed —
# is invisible on the first shape and certain on the second.
#
# Running the whole suite on the second shape produces a lot of red that is not
# a bug: a test that creates a property with a `city` fails because production
# has no city field, and that is the test asserting the seeded shape rather than
# the product being broken. So this does not count failures. It looks for the
# one thing that is always a defect:
#
#     42703 — column "x" does not exist
#
# A clean run means no query in the CRM names a column production does not have.
# A hit names the file and the statement, and it is a live production bug.
#
#   bash scripts/shape-check.sh
set -uo pipefail

cd "$(dirname "$0")/.."
LOG="$(mktemp -t ipropy-shape)"
trap 'rm -f "$LOG"' EXIT

echo "→ running the integration suite on production's field shape (a few minutes)"
MIRROR_PROD_SHAPE=1 npm --prefix packages/server run test:integration >"$LOG" 2>&1 || true

# A 42703 raised by a query the *test file* issued is not a product bug — the
# suite reads columns directly to assert on them, and on this shape some of
# those are gone. So each hit is attributed by its stack: a frame in
# `tests/integration/` means the test named the column, anything else means the
# CRM did.
python3 - "$LOG" <<'PYTHON'
import json, sys, re

product, from_tests = [], []
for line in open(sys.argv[1], errors='replace'):
    if '42703' not in line:
        continue
    start = line.find('{')
    if start < 0:
        continue
    try:
        entry = json.loads(line[start:])
    except ValueError:
        continue
    err = entry.get('err') or {}
    message = err.get('message') or ''
    if 'does not exist' not in message:
        continue
    stack = err.get('stack') or ''
    sql = ' '.join((entry.get('sql') or '').split())
    where = re.findall(r'(?:packages/server/(?:src|tests)/[^\s:)]+:\d+)', stack)
    # pool.ts is where every query is issued from, so it says nothing about
    # who wrote it; the frame above it does.
    origin = next(
        (w for w in where if '/src/' in w and '/src/db/pool.ts' not in w),
        None,
    )
    test_frame = next((w for w in where if '/tests/' in w), None)
    row = (message, origin or test_frame or 'unknown', sql[:160])
    (from_tests if origin is None else product).append(row)

def show(title, rows):
    seen = set()
    print(title)
    for message, origin, sql in rows:
        key = (message, origin)
        if key in seen:
            continue
        seen.add(key)
        print(f"  {message}")
        print(f"    at {origin}")
        if sql:
            print(f"    {sql}")

if product:
    show("\u2717 the CRM names a column production does not have:", product)
    if from_tests:
        print()
        show("  (also, in the suite's own assertions — not a product bug:)", from_tests)
    sys.exit(1)

print("\u2713 no 42703 from the CRM: every query survives production's field set")
if from_tests:
    print()
    show("  Only the suite's own assertions read a column that is gone:", from_tests)
PYTHON
STATUS=$?

echo
grep -E '^ Test Files|^      Tests ' "$LOG" | sed 's/^/  /'
echo "  (red tests are expected here: many assert on fields production has deleted."
echo "   The signal this script exists for is 42703, above.)"
exit $STATUS
