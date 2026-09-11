#!/usr/bin/env bash
# Start n8n and the media worker, from settings that live outside this repo.
#
# Why this exists: the API key and the n8n callback secret were rotated on
# 11 September 2026 and, for a few minutes, the only copy of the new key was
# inside a running container. Recreating that container without carrying
# `IPROPY_API_KEY` across would have stopped media delivery — silently, because
# the poll still succeeds and only the *delivery* call carries the key — and
# there is no way to read a key back out of the CRM, only to rotate it again.
#
# So the settings are the file and the containers are disposable, rather than
# the other way round.
#
#   ~/.ipropy/automation.env     chmod 600, never committed, not in the repo
#
# `MEDIA_`-prefixed names go to the media worker with the prefix stripped;
# everything else goes to n8n. That keeps one file for two containers without
# the two of them sharing a namespace — both want a variable called `CRM_URL`
# and they do not mean the same thing.
set -euo pipefail

ENV_FILE="${IPROPY_AUTOMATION_ENV:-$HOME/.ipropy/automation.env}"
PROPERTIES_DIR="${IPROPY_PROPERTIES_DIR:-$HOME/Library/CloudStorage/OneDrive-Personal/IPROPY-PROPERTIES}"

if [ ! -f "$ENV_FILE" ]; then
  echo "No settings at $ENV_FILE." >&2
  echo "It holds the CRM url, the API key and the callback secret for both" >&2
  echo "containers. Without it they start unauthenticated and fail quietly." >&2
  exit 1
fi

mode=$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE" 2>/dev/null || echo '?')
if [ "$mode" != "600" ]; then
  echo "warning: $ENV_FILE is mode $mode; it holds live credentials. chmod 600 it." >&2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

grep -vE '^(MEDIA_|#|$)' "$ENV_FILE" > "$work/n8n.env" || true
# Strip the prefix, and only for real assignments.
grep -E '^MEDIA_[A-Za-z0-9_]+=' "$ENV_FILE" | sed 's/^MEDIA_//' > "$work/media.env" || true

for name in n8n ipropy-media; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
    docker rm -f "$name" >/dev/null
  fi
done

# The name matters: n8n reaches the worker at http://ipropy-media:8080, so a
# container called anything else is a worker n8n cannot see.
docker run -d --name ipropy-media --restart unless-stopped \
  --env-file "$work/media.env" \
  -v "$PROPERTIES_DIR:/data/properties" \
  ipropy-media:local >/dev/null

docker run -d --name n8n --restart unless-stopped -p 5678:5678 \
  --env-file "$work/n8n.env" \
  -v n8n_data:/home/node/.n8n \
  -v "$PROPERTIES_DIR:/data/properties" \
  n8nio/n8n >/dev/null

echo "→ started:"
docker ps --format '   {{.Names}}\t{{.Status}}' | grep -E 'n8n|ipropy-media'
echo
echo "→ check they match this repo:  python3 scripts/check-deployed.py"
