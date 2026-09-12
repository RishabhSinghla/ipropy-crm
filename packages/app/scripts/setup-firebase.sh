#!/usr/bin/env bash
#
# Set Firebase up for the phone app's notifications.
#
# Firebase is used for exactly one thing here: reaching a phone whose app is
# closed. The bell inside the CRM and browser push both work without it. On
# Android that channel is Firebase; on iPhone it is Firebase handing over to
# Apple. There is no second option on either platform, and no part of Firebase
# other than that channel is used — no analytics, no database, no hosting.
#
# It is free. Google does not charge for this.
#
# Everything below is done for you except signing in, which only you can do.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ANDROID_APP="$ROOT/packages/app/android/app"
PROJECT_ID="${FIREBASE_PROJECT:-ipropy-crm}"
FB="npx --yes firebase-tools@latest"

say() { printf '\n%s\n' "$*"; }

say "→ checking you are signed in to Firebase…"
if ! $FB login:list 2>/dev/null | grep -q '@'; then
  cat >&2 <<'MSG'

  Not signed in yet. Run this one command, approve in the browser it opens,
  then run this script again:

      npx --yes firebase-tools@latest login

  That is the only step that needs you. Everything after it is automatic.
MSG
  exit 1
fi
$FB login:list 2>/dev/null | grep '@' | head -1

# Create the project, or carry on with it if it is already there. Firebase
# project ids are global, so the first choice may be taken by a stranger —
# `FIREBASE_PROJECT=something-else bash …` picks another.
# Same lesson as the app id below: ask for JSON, never read the drawn table.
project_exists() {
  $FB projects:list --json 2>/dev/null | python3 -c '
import json, sys
try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(1)
projects = payload.get("result", payload) if isinstance(payload, dict) else payload
sys.exit(0 if any(p.get("projectId") == sys.argv[1] for p in projects or []) else 1)
' "$PROJECT_ID"
}

say "→ project '$PROJECT_ID'…"
if project_exists; then
  echo "   already exists, using it"
else
  $FB projects:create "$PROJECT_ID" --display-name "iPropy CRM" \
    || { echo "Could not create '$PROJECT_ID' — the id may be taken. Try FIREBASE_PROJECT=ipropy-crm-2 bash $0" >&2; exit 1; }
fi

# The Android app. The package name must match `applicationId` in
# android/app/build.gradle exactly, or Firebase hands out a config the app
# refuses and notifications fail with nothing logged.
PACKAGE="com.ipropy.crm"

# Read the app id out of --json, never out of the printed table.
#
# The table is drawn with box characters and does not include the package name
# at all, so the obvious `apps:list | grep <package> | awk '{print $4}'` matches
# nothing, the pipeline fails, and `set -e` ends the run one step from the
# finish with no explanation. That is exactly what happened the first time this
# was used.
app_id_for_package() {
  $FB apps:list ANDROID --project "$PROJECT_ID" --json 2>/dev/null | python3 -c '
import json, sys
try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)
apps = payload.get("result", payload) if isinstance(payload, dict) else payload
for app in apps or []:
    if app.get("packageName") == sys.argv[1]:
        print(app.get("appId", ""))
        break
' "$PACKAGE"
}

say "→ registering the Android app ($PACKAGE)…"
APP_ID="$(app_id_for_package)"
if [ -n "$APP_ID" ]; then
  echo "   already registered"
else
  $FB apps:create ANDROID "iPropy" --package-name "$PACKAGE" --project "$PROJECT_ID"
  APP_ID="$(app_id_for_package)"
fi
[ -n "$APP_ID" ] || { echo "Registered the app but could not read its id back." >&2; exit 1; }
echo "   $APP_ID"

say "→ writing google-services.json…"
CONFIG="$ANDROID_APP/google-services.json"

# `--out` refuses to overwrite, so an already-configured checkout would end the
# run here with an error that reads like a fault rather than "nothing to do".
# Written to a temporary file and moved into place, and only when it differs.
TMP_CONFIG="$(mktemp -t google-services)"
trap 'rm -f "$TMP_CONFIG"' EXIT
rm -f "$TMP_CONFIG"
$FB apps:sdkconfig ANDROID "$APP_ID" --project "$PROJECT_ID" --out "$TMP_CONFIG" >/dev/null
[ -s "$TMP_CONFIG" ] || { echo "The config file came back empty." >&2; exit 1; }

if [ -f "$CONFIG" ] && cmp -s "$TMP_CONFIG" "$CONFIG"; then
  echo "   already up to date"
else
  mv "$TMP_CONFIG" "$CONFIG"
  echo "   written"
fi
echo "   $CONFIG"

cat <<MSG

Done, except one thing only you can click.

The app half is finished. The server needs a key so it can *send*, and
Firebase will not hand that one out over the command line:

  1. Open  https://console.firebase.google.com/project/$PROJECT_ID/settings/serviceaccounts/adminsdk
  2. Click "Generate new private key", then "Generate key". A .json downloads.
  3. In the CRM: Admin → Integrations → "Alerts on the phone app" → Set up.
     Open the downloaded file in any text editor, copy all of it, paste it in,
     Save, and switch the card on.

Then rebuild and publish the app so the phones carry the Firebase config:

    bash packages/app/scripts/publish-apk.sh

Until both halves are in place nothing breaks — the in-app bell and browser
push carry on, and the app simply receives nothing while it is closed.
MSG
