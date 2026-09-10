#!/usr/bin/env bash
# Run this on Rishabh's Mac. It gathers the few things that are deliberately
# NOT in GitHub and cannot be, then leaves them in one folder to hand over.
#
#   bash scripts/handover-bundle.sh
#
# Hand the folder over by AirDrop or a USB stick. Do not email it and do not
# put it in WhatsApp or Google Drive: it contains live passwords and keys.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$HOME/Desktop/ipropy-handover}"

mkdir -p "$OUT"
chmod 700 "$OUT"

echo "Building the handover folder at: $OUT"
echo

# 1. The settings file with all the keys.
if [ -f "$ROOT/.env" ]; then
  cp "$ROOT/.env" "$OUT/.env"
  chmod 600 "$OUT/.env"
  echo "  added  .env                 (all the keys and passwords)"
else
  echo "  MISSING  .env — nothing to copy. The other laptop cannot start without it."
fi

# 2. Everything Claude has learned about this project. This is the difference
#    between a Claude that knows the project and one starting from nothing.
PARENT="$(dirname "$ROOT")"
SLUG="$(printf '%s' "$PARENT" | sed 's|/|-|g')"
MEM="$HOME/.claude/projects/$SLUG/memory"
if [ -d "$MEM" ]; then
  rm -rf "$OUT/claude-memory"
  cp -R "$MEM" "$OUT/claude-memory"
  COUNT="$(find "$OUT/claude-memory" -name '*.md' | wc -l | tr -d ' ')"
  echo "  added  claude-memory/       ($COUNT notes Claude has written about this project)"
else
  echo "  skipped claude-memory/      (none found at $MEM)"
fi

# 3. Deliberately NOT copied, and why.
cat > "$OUT/READ-ME-FIRST.txt" <<'NOTE_EOF'
iPropy handover folder
======================

Put this whole folder on the new laptop's Desktop, then inside the cloned
repo run:

    bash scripts/install-handover.sh ~/Desktop/ipropy-handover

What is in here
---------------
.env             Every key and password the CRM needs. Treat it like a bank
                 login. Never paste it into a chat, an email or a website.

claude-memory/   The notes Claude Code has built up about this project. Copying
                 these is what makes Claude on the new laptop as useful as it is
                 on Rishabh's. Without them it starts from zero every session.

What is deliberately NOT in here
--------------------------------
The linked WhatsApp session files. Those are the keys to a real WhatsApp
account, and anyone holding a copy can read and send messages as that person.
The new laptop must scan its own QR code instead.

The production database. The new laptop runs its own local copy with demo data.
Real customer records stay in production.

After the new laptop is set up, DELETE this folder from both Desktops.
NOTE_EOF
echo "  added  READ-ME-FIRST.txt"

echo
echo "Done. Now AirDrop the folder to the other laptop:"
echo "  open \"$OUT\""
echo
echo "When the other laptop is working, delete it from your Desktop."
