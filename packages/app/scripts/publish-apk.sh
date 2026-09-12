#!/usr/bin/env bash
#
# Build the app and put it where the CRM hands it to a rep.
#
# One command, because the alternative is remembering five: build the web
# bundle, copy it into the Android project, build the APK, find the output,
# write down the version. The version is read back out of the built APK rather
# than typed, so what the download page claims and what the phone installs
# cannot disagree.
#
# Then commit the two files it writes and push. The container has no Android
# SDK and Render has no artefact store, so the APK travels in git — about
# twelve megabytes, which is the price of the CRM being able to hand somebody
# the app with no second service, no login and no monthly bill.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT_DIR="$ROOT/packages/server/public/companion"
APK_OUT="$OUT_DIR/ipropy-companion.apk"
META_OUT="$OUT_DIR/companion.json"

: "${JAVA_HOME:=/opt/homebrew/opt/openjdk@21}"
: "${ANDROID_HOME:=/opt/homebrew/share/android-commandlinetools}"
export JAVA_HOME ANDROID_HOME

# JDK 21, not 17 and not whatever `java` happens to be. Capacitor 8's plugins
# declare a Java 21 toolchain and Gradle will not substitute a different one —
# it fails with "Cannot find a Java installation matching languageVersion=21",
# which reads like a broken Gradle rather than a missing JDK.
[ -d "$JAVA_HOME" ] || { echo "No JDK 21 at $JAVA_HOME. Install it: brew install openjdk@21" >&2; exit 1; }
[ -d "$ANDROID_HOME/platforms" ] || { echo "No Android SDK at $ANDROID_HOME. See packages/app/README.md." >&2; exit 1; }
[ -f "$HERE/android/keystore.properties" ] || {
  echo "No signing key. Run packages/app/scripts/make-release-key.sh first." >&2
  echo "Deliberately not falling back to the debug key: a debug-signed release" >&2
  echo "installs fine and then blocks every properly signed update after it." >&2
  exit 1
}

echo "→ building the web bundle…"
# No VITE_API_BASE: a release build talks to production. Setting it here is how
# a build pointed at somebody's laptop reaches a rep's phone.
(cd "$ROOT" && npm run build:deps >/dev/null && npm run build -w @ipropy/web >/dev/null)

echo "→ copying it into the Android project…"
(cd "$ROOT/packages/web" && npx cap sync android >/dev/null)

echo "→ building the APK…"
(cd "$HERE/android" && ./gradlew --no-daemon assembleRelease -q)

BUILT="$HERE/android/app/build/outputs/apk/release/app-release.apk"
[ -f "$BUILT" ] || { echo "Gradle reported success but produced no APK at $BUILT" >&2; exit 1; }

# Read the version out of the APK itself rather than out of build.gradle. They
# are the same number until somebody edits one and rebuilds the other.
AAPT="$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort -V | tail -1)aapt2"
BADGING="$("$AAPT" dump badging "$BUILT")"
VERSION_NAME="$(sed -n "s/.*versionName='\([^']*\)'.*/\1/p" <<<"$BADGING" | head -1)"
VERSION_CODE="$(sed -n "s/.*versionCode='\([^']*\)'.*/\1/p" <<<"$BADGING" | head -1)"
MIN_SDK="$(sed -n "s/.*sdkVersion:'\([^']*\)'.*/\1/p" <<<"$BADGING" | head -1)"

# A release APK that is not signed installs on nothing. Checking here rather
# than discovering it on a handset.
"$AAPT" dump badging "$BUILT" >/dev/null
APKSIGNER="$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort -V | tail -1)apksigner"
"$APKSIGNER" verify "$BUILT" >/dev/null || { echo "The built APK is not properly signed." >&2; exit 1; }

mkdir -p "$OUT_DIR"
cp "$BUILT" "$APK_OUT"

SIZE="$(wc -c < "$APK_OUT" | tr -d ' ')"
SHA="$(shasum -a 256 "$APK_OUT" | cut -d' ' -f1)"
cat > "$META_OUT" <<EOF
{
  "versionName": "$VERSION_NAME",
  "versionCode": $VERSION_CODE,
  "minSdk": $MIN_SDK,
  "sizeBytes": $SIZE,
  "sha256": "$SHA",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo
echo "Published v$VERSION_NAME ($VERSION_CODE), $((SIZE / 1024 / 1024)) MB, Android API $MIN_SDK+"
echo "  $APK_OUT"
echo "  $META_OUT"
echo
echo "Commit both and push. Render carries them into the image, and Settings →"
echo "Phones offers the new build straight away."
