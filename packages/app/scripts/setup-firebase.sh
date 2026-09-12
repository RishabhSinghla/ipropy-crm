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
say "→ project '$PROJECT_ID'…"
if $FB projects:list 2>/dev/null | grep -q "\b$PROJECT_ID\b"; then
  echo "   already exists, using it"
else
  $FB projects:create "$PROJECT_ID" --display-name "iPropy CRM" \
    || { echo "Could not create '$PROJECT_ID' — the id may be taken. Try FIREBASE_PROJECT=ipropy-crm-2 bash $0" >&2; exit 1; }
fi

# The Android app. The package name must match `applicationId` in
# android/app/build.gradle exactly, or Firebase hands out a config the app
# refuses and notifications fail with nothing logged.
PACKAGE="com.ipropy.crm"
say "→ registering the Android app ($PACKAGE)…"
if $FB apps:list ANDROID --project "$PROJECT_ID" 2>/dev/null | grep -q "$PACKAGE"; then
  echo "   already registered"
else
  $FB apps:create ANDROID "iPropy" --package-name "$PACKAGE" --project "$PROJECT_ID"
fi

APP_ID="$($FB apps:list ANDROID --project "$PROJECT_ID" 2>/dev/null | grep "$PACKAGE" | awk '{print $4}' | head -1)"
[ -n "$APP_ID" ] || { echo "Registered the app but could not read its id back." >&2; exit 1; }

say "→ writing google-services.json…"
$FB apps:sdkconfig ANDROID "$APP_ID" --project "$PROJECT_ID" --out "$ANDROID_APP/google-services.json"
[ -s "$ANDROID_APP/google-services.json" ] || { echo "The config file came back empty." >&2; exit 1; }
echo "   $ANDROID_APP/google-services.json"

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
