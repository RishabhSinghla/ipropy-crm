#!/usr/bin/env bash
#
# Put the app's signing key where GitHub can build with it. Run once, ever.
#
# Why this exists: the key that signed the version on the team's phones lives
# on one laptop. Android refuses an update signed by any other key -- every
# handset would have to uninstall the app first, losing its pairing -- so no
# machine but that one can ship an update, and the app stops moving the day
# that laptop is busy, lost or replaced.
#
# This copies the key into the repository's Actions secrets, encrypted by
# GitHub, so `.github/workflows/build-the-app.yml` can build and publish the
# app from anywhere, by anybody, with no laptop involved.
#
# Run it on the machine that holds the key:
#
#     bash packages/app/scripts/share-release-key.sh
#
# It needs the `gh` CLI signed in as somebody with admin on the repository
# (`gh auth login`). Nothing is printed: the key is read and handed to GitHub
# without ever reaching your terminal, your clipboard or a chat window.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PROPS="$HERE/android/keystore.properties"
REPO="${REPO:-RishabhSinghla/ipropy-crm}"

# `keystore.properties` names its own file, so read the name from there rather
# than assuming one. Whoever ran `make-release-key.sh` may have called it
# anything, and a script that knows only one name sends somebody back to a chat
# window to ask -- which is the round trip this exists to avoid.
KEYSTORE=""
if [ -f "$PROPS" ]; then
  NAMED="$(grep -E '^storeFile=' "$PROPS" | head -1 | cut -d= -f2-)"
  case "$NAMED" in
    /*) KEYSTORE="$NAMED" ;;
    ?*) KEYSTORE="$HERE/android/$NAMED" ;;
  esac
fi

# Nothing named, or named something that is not there: take the only keystore
# in that folder, when there is exactly one.
if [ -z "$KEYSTORE" ] || [ ! -f "$KEYSTORE" ]; then
  FOUND="$(ls "$HERE"/android/*.keystore "$HERE"/android/*.jks 2>/dev/null || true)"
  if [ "$(printf '%s' "$FOUND" | grep -c .)" = "1" ]; then KEYSTORE="$FOUND"; fi
fi

if [ ! -f "$PROPS" ] || [ -z "$KEYSTORE" ] || [ ! -f "$KEYSTORE" ]; then
  echo "No signing key on this machine."
  echo "  looked in: $HERE/android/"
  echo "  needs:     keystore.properties, and the .keystore or .jks it names"
  echo
  echo "What is actually there:"
  ls -1 "$HERE"/android/ 2>/dev/null | grep -Ei 'keystore|\.jks' || echo "  (nothing that looks like a key)"
  echo
  echo "This has to run on the laptop that built the version already on the"
  echo "team's phones. A key made here instead would produce an app every rep"
  echo "must uninstall before they can install it."
  exit 1
fi

echo "Using $KEYSTORE"

if ! command -v gh >/dev/null 2>&1; then
  echo "The GitHub CLI is not installed. On a Mac: brew install gh && gh auth login"
  exit 1
fi

# From the file, never from an argument: a password typed on a command line is
# a password in the shell history.
value_of() { grep -E "^$1=" "$PROPS" | head -1 | cut -d= -f2-; }

STORE_PASSWORD="$(value_of storePassword)"
KEY_ALIAS="$(value_of keyAlias)"
KEY_PASSWORD="$(value_of keyPassword)"

if [ -z "$STORE_PASSWORD" ] || [ -z "$KEY_ALIAS" ] || [ -z "$KEY_PASSWORD" ]; then
  echo "$PROPS is missing storePassword, keyAlias or keyPassword."
  exit 1
fi

# `base64 -w0` is GNU; macOS base64 wraps unless told not to, and a wrapped
# secret decodes to a corrupt keystore on the runner — which fails much later,
# during signing, saying nothing about this line.
if base64 --help 2>&1 | grep -q '\-w'; then
  ENCODED="$(base64 -w0 < "$KEYSTORE")"
else
  ENCODED="$(base64 < "$KEYSTORE" | tr -d '\n')"
fi

printf '%s' "$ENCODED"        | gh secret set ANDROID_KEYSTORE_BASE64   --repo "$REPO"
printf '%s' "$STORE_PASSWORD" | gh secret set ANDROID_KEYSTORE_PASSWORD --repo "$REPO"
printf '%s' "$KEY_ALIAS"      | gh secret set ANDROID_KEY_ALIAS         --repo "$REPO"
printf '%s' "$KEY_PASSWORD"   | gh secret set ANDROID_KEY_PASSWORD      --repo "$REPO"

echo
echo "Done. GitHub can build and publish the app now:"
echo "  Actions → Build the app → Run workflow → publish ✓"
echo
echo "Keep the key file itself backed up somewhere off this machine. GitHub"
echo "stores these encrypted and will not hand them back."
