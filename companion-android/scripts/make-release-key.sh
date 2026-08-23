#!/usr/bin/env bash
#
# Make the signing key the companion APK is released with, once.
#
# Android identifies an app by its signature, not by its name. An APK signed
# with a different key will not install over one signed with this key: the
# phone refuses it, and the only way out is uninstalling first, which throws
# away the pairing and the sync watermark on every handset. So this key is
# generated once and then kept for the life of the app.
#
# It lives outside the repository on purpose, so that `git clean` cannot take
# it. Back up the whole ~/.ipropy/companion folder somewhere that is not this
# laptop.
set -euo pipefail

KEY_DIR="${HOME}/.ipropy/companion"
KEY_FILE="${KEY_DIR}/ipropy-release.jks"
PROPS="$(cd "$(dirname "$0")/.." && pwd)/keystore.properties"

if [ -f "$KEY_FILE" ]; then
  echo "Key already exists at $KEY_FILE — keeping it."
  exit 0
fi

mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

# Generated rather than chosen. Nobody types this password; Gradle reads it
# from keystore.properties, which is not committed.
#
# openssl rather than piping /dev/urandom through `head`: `head` closes the pipe
# as soon as it has enough, the process upstream takes SIGPIPE, and `pipefail`
# turns that into a failed script that has already looked like it worked.
PASSWORD="$(openssl rand -hex 24)"

keytool -genkeypair \
  -keystore "$KEY_FILE" \
  -storepass "$PASSWORD" \
  -keypass "$PASSWORD" \
  -alias ipropy \
  -keyalg RSA -keysize 4096 \
  -validity 10950 \
  -dname "CN=iPropy Realty, OU=Companion App, O=iPropy Realty, L=Faridabad, ST=Haryana, C=IN" \
  >/dev/null 2>&1

cat > "$PROPS" <<EOF
# Written by scripts/make-release-key.sh. Not committed; see .gitignore.
storeFile=${KEY_FILE}
storePassword=${PASSWORD}
keyAlias=ipropy
keyPassword=${PASSWORD}
EOF
chmod 600 "$PROPS" "$KEY_FILE"

echo "Key written to $KEY_FILE"
echo "Password written to $PROPS"
echo
echo "Back up ~/.ipropy/companion. Without it, a future APK cannot install over this one."
