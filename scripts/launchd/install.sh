#!/usr/bin/env bash
# Installs the nightly local database backup on this Mac.
#
#   bash scripts/launchd/install.sh
#
# The job runs at 02:00 and backs up the database on THIS machine, not the live
# one. Production backups are Neon's job, see DEPLOYMENT.md section 7.
#
# Why a script rather than "copy this file": the plist needs the absolute path
# to this checkout, which differs on every machine. Copied by hand with the
# wrong path, launchd reports exit 127 and silently backs up nothing. That is
# exactly what had happened on the first Mac.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LABEL="com.ipropy.backup"
TEMPLATE="$ROOT/scripts/launchd/$LABEL.plist"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

[ -f "$TEMPLATE" ] || { echo "Cannot find $TEMPLATE"; exit 1; }
[ -x "$ROOT/scripts/db-backup.sh" ] || chmod +x "$ROOT/scripts/db-backup.sh"

mkdir -p "$HOME/Library/LaunchAgents"

# Unload any earlier copy first, including a broken one, or launchctl refuses
# to replace it and the old path keeps failing every night. Read the list into a
# variable rather than piping it into grep: `grep -q` stops at the first match,
# launchctl gets SIGPIPE, and under `pipefail` the whole check reads as a failure,
# so the stale job would be left in place. That is not hypothetical, it happened
# on the first run of this script.
LOADED="$(launchctl list 2>/dev/null || true)"
case "$LOADED" in
  *"$LABEL"*)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null \
      || launchctl unload "$TARGET" 2>/dev/null \
      || true
    echo "removed the previous job"
    ;;
esac

sed "s|__REPO_ROOT__|$ROOT|g" "$TEMPLATE" > "$TARGET"
launchctl bootstrap "gui/$(id -u)" "$TARGET" 2>/dev/null || launchctl load "$TARGET"

echo "installed: $TARGET"
echo "backs up:  $ROOT/scripts/db-backup.sh"
echo "runs at:   02:00 daily"
echo

# Run it once now and read the exit code. A launchd job that fails does so at
# 2am into a log nobody opens, so an install that does not test itself is how
# this went unnoticed for months: the path was wrong, the job exited 127 every
# night, and the backup directory just quietly stopped filling up.
echo "Testing it now rather than trusting it..."
launchctl kickstart -p "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
until [ -z "$(launchctl list 2>/dev/null | grep -E "^[0-9]+[[:space:]].*$LABEL")" ]; do sleep 2; done

STATUS="$(launchctl list 2>/dev/null | awk -v l="$LABEL" '$3 == l { print $2 }')"
case "${STATUS:-unknown}" in
  0)
    echo "It works. Last run succeeded."
    LATEST="$(ls -t "$ROOT/backups"/*.dump 2>/dev/null | head -1 || true)"
    [ -n "$LATEST" ] && echo "Newest backup: $LATEST"
    ;;
  126)
    echo "FAILED with a permissions error, and this one needs you in System Settings."
    echo
    echo "macOS does not let a background job read anything inside Downloads,"
    echo "Documents or Desktop unless you allow it. This checkout is at:"
    echo "    $ROOT"
    echo
    echo "Two ways out, pick one:"
    echo "  1. System Settings, Privacy & Security, Full Disk Access, turn on"
    echo "     /bin/bash. Broad, so only do this on a machine you control."
    echo "  2. Move the project out of Downloads, for example to ~/ipropy, then"
    echo "     run this installer again. Nothing in the project depends on where"
    echo "     it lives."
    echo
    echo "Until then the nightly backup does not run. Backing up by hand still"
    echo "works: npm run db:backup"
    ;;
  *)
    echo "FAILED with exit code ${STATUS:-unknown}."
    echo "The reason is in these two files:"
    echo "    /tmp/ipropy-backup.err.log"
    echo "    /tmp/ipropy-backup.out.log"
    echo "Backing up by hand still works: npm run db:backup"
    ;;
esac
echo
echo "This covers the database on THIS machine only. The live one is Neon's job,"
echo "see DEPLOYMENT.md section 7."
