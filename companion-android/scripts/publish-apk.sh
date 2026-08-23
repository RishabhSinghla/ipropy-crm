#!/usr/bin/env bash
#
# Build the companion APK and put it where the CRM serves it from.
#
# One command, because the alternative is remembering four: build, find the
# output, copy it, write down the version. The version is read back out of the
# APK itself rather than typed, so what the download page claims and what the
# phone installs cannot disagree.
#
# Run this whenever the Android app changes. Then commit the two files it
# writes and push; Render carries them into the image.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT_DIR="$ROOT/packages/server/public/companion"
APK_OUT="$OUT_DIR/ipropy-companion.apk"

: "${JAVA_HOME:=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
: "${ANDROID_HOME:=/opt/homebrew/share/android-commandlinetools}"
export JAVA_HOME ANDROID_HOME

if [ ! -d "$JAVA_HOME" ]; then
  echo "No JDK 17 at $JAVA_HOME. Install it with: brew install openjdk@17" >&2
  exit 1
fi
if [ ! -d "$ANDROID_HOME/platforms" ]; then
  echo "No Android SDK at $ANDROID_HOME. See companion-android/README.md." >&2
  exit 1
fi
if [ ! -f "$HERE/keystore.properties" ]; then
  echo "No signing key. Run companion-android/scripts/make-release-key.sh first." >&2
  exit 1
fi

echo "→ building…"
(cd "$HERE" && ./gradlew --no-daemon assembleRelease -q)

BUILT="$HERE/app/build/outputs/apk/release/app-release.apk"
[ -f "$BUILT" ] || { echo "Gradle reported success but produced no APK at $BUILT" >&2; exit 1; }

# Read the version out of the APK rather than out of build.gradle.kts. Same
# reason the app reads it from BuildConfig: one source, no drift.
AAPT="$(find "$ANDROID_HOME/build-tools" -name aapt2 -maxdepth 2 | sort -r | head -1)"
BADGING="$("$AAPT" dump badging "$BUILT")"
VERSION_NAME="$(sed -n "s/.*versionName='\([^']*\)'.*/\1/p" <<<"$BADGING" | head -1)"
VERSION_CODE="$(sed -n "s/.*versionCode='\([^']*\)'.*/\1/p" <<<"$BADGING" | head -1)"
MIN_SDK="$(sed -n "s/.*sdkVersion:'\([^']*\)'.*/\1/p" <<<"$BADGING" | head -1)"

mkdir -p "$OUT_DIR"
cp "$BUILT" "$APK_OUT"
SIZE="$(wc -c < "$APK_OUT" | tr -d ' ')"
SHA="$(shasum -a 256 "$APK_OUT" | cut -d' ' -f1)"

cat > "$OUT_DIR/companion.json" <<EOF
{
  "versionName": "$VERSION_NAME",
  "versionCode": $VERSION_CODE,
  "minSdk": $MIN_SDK,
  "sizeBytes": $SIZE,
  "sha256": "$SHA",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "→ published $VERSION_NAME (code $VERSION_CODE), $(( SIZE / 1024 / 1024 )) MB"
echo "   $APK_OUT"
echo
echo "Commit packages/server/public/companion and push to put it on the live CRM."
