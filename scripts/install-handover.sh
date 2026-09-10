#!/usr/bin/env bash
# Run this on the NEW laptop, inside the cloned repo, once the handover folder
# is on the Desktop.
#
#   bash scripts/install-handover.sh ~/Desktop/ipropy-handover
#
# It puts the settings file where the CRM expects it, and puts Claude's notes
# where Claude Code expects them on THIS Mac (the folder name depends on your
# username, so it cannot simply be copied).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:-$HOME/Desktop/ipropy-handover}"

if [ ! -d "$SRC" ]; then
  echo "Cannot find the handover folder at: $SRC"
  echo "Pass the right path, for example:"
  echo "    bash scripts/install-handover.sh ~/Downloads/ipropy-handover"
  exit 1
fi

echo "Installing from: $SRC"
echo

# 1. The settings file.
if [ -f "$SRC/.env" ]; then
  if [ -f "$ROOT/.env" ]; then
    cp "$ROOT/.env" "$ROOT/.env.backup.$(date +%Y%m%d%H%M%S)"
    echo "  kept a backup of the .env that was already here"
  fi
  cp "$SRC/.env" "$ROOT/.env"
  chmod 600 "$ROOT/.env"
  echo "  installed  .env"
else
  echo "  MISSING  .env in the handover folder. The CRM will not start."
fi

# 2. Claude's notes. The folder Claude Code reads is named after the full path
#    of the folder you open it on, with the slashes turned into dashes.
if [ -d "$SRC/claude-memory" ]; then
  PARENT="$(dirname "$ROOT")"
  SLUG="$(printf '%s' "$PARENT" | sed 's|/|-|g')"
  DEST="$HOME/.claude/projects/$SLUG/memory"
  mkdir -p "$DEST"
  cp -R "$SRC/claude-memory/." "$DEST/"
  COUNT="$(find "$DEST" -name '*.md' | wc -l | tr -d ' ')"
  echo "  installed  $COUNT notes into $DEST"
  echo
  echo "  IMPORTANT: open Claude Code on this exact folder for the notes to load:"
  echo "      $PARENT"
  echo "  Not on the repo folder inside it."
else
  echo "  skipped  claude-memory (not in the handover folder)"
fi

echo
echo "Done. Next:"
echo "    bash scripts/setup-new-laptop.sh"
