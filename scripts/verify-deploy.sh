#!/usr/bin/env bash
# Is the code I just pushed actually the code being served?
#
# A green local build is not evidence, and neither is a green CI run — see
# CLAUDE.md and DEPLOYMENT.md. This asks the running site.
#
#   scripts/verify-deploy.sh 'Save this layout to' 'Drag a thumbnail to reorder'
#
# Each argument is a string that exists in the new code and did not exist in
# the old one. Exit 0 only when every one of them is found in what the site is
# serving right now.
#
# Three traps this exists to encode, all of which have cost time:
#
#   1. `grep` on a fetched bundle needs `-a`. BSD grep decides the file is
#      binary and prints nothing, which reads as "string absent" when it means
#      "grep refused to look".
#   2. The lazy route chunks are not named in index.html — only the entry and
#      the vendor chunks are. Every screen worth checking (ListView,
#      RecordDetail, Outreach, Admin) is a dynamic import whose filename
#      appears *inside* the entry chunk. Checking only what the HTML mentions
#      finds nothing and looks like a failed deploy. And one level is not
#      enough either: Admin lazily imports PicklistManager, so that chunk's
#      name only appears inside Admin's. The crawl below follows references
#      until it stops finding new ones.
#   3. A restarted container is not a new build. render.yaml sets
#      `autoDeployTrigger: checksPass`, so a red CI run means Render never
#      builds at all while the process happily restarts for other reasons.
set -uo pipefail

BASE="${CRM_URL:-https://ipropy-crm.onrender.com}"
[ "$#" -gt 0 ] || { echo "usage: verify-deploy.sh <marker> [marker…]" >&2; exit 2; }

HEALTH=$(curl -fsS -m 25 "$BASE/api/health") || { echo "unreachable: $BASE" >&2; exit 1; }
echo "$HEALTH"

HTML=$(curl -fsS -m 25 "$BASE/") || { echo "could not fetch $BASE/" >&2; exit 1; }
ENTRY=$(printf '%s' "$HTML" | grep -oE 'src="/assets/[A-Za-z0-9._-]+\.js"' | head -1 | sed 's/src="//; s/"//')
[ -n "$ENTRY" ] || { echo "no entry chunk in the served HTML" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
: > "$WORK/all.js"
: > "$WORK/fetched"
echo "${ENTRY#/}" > "$WORK/queue"

# Breadth-first over chunk references. A route chunk names the chunks *it*
# lazily imports, so stopping at the entry chunk's list misses anything one
# more hop away — Admin → PicklistManager is exactly that.
while [ -s "$WORK/queue" ]; do
  c=$(head -1 "$WORK/queue"); sed -i.bak '1d' "$WORK/queue"
  grep -qxF "$c" "$WORK/fetched" && continue
  echo "$c" >> "$WORK/fetched"
  body=$(curl -fsS -m 60 "$BASE/$c" 2>/dev/null) || continue
  printf '%s\n' "$body" >> "$WORK/all.js"
  printf '%s' "$body" | grep -ao 'assets/[A-Za-z0-9._-]*\.js' | sort -u >> "$WORK/queue"
done

echo "checked $(wc -l < "$WORK/fetched" | tr -d ' ') chunks reachable from $ENTRY"

STATUS=0
for marker in "$@"; do
  if grep -aqF "$marker" "$WORK/all.js"; then
    echo "  found:   $marker"
  else
    echo "  MISSING: $marker"
    STATUS=1
  fi
done

[ "$STATUS" -eq 0 ] && echo "LIVE — every marker is in what the site is serving." \
  || echo "NOT LIVE — the served build predates at least one of these changes."
exit "$STATUS"
