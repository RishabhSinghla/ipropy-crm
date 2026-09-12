#!/usr/bin/env bash
#
# Create the signing key this app is released with. Run once, ever.
#
# Android decides whether one APK may replace another by comparing signatures.
# Lose this key and there is no route back: every handset with the app
# installed has to uninstall it before it can take an update, and uninstalling
# takes the pairing and the stored session with it. So the keystore is worth
# backing up somewhere that is not this laptop, and the file is gitignored
# because a signing key in a public repository is the same as no signing key.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
KEYSTORE="$HERE/android/ipropy-release.keystore"
PROPS="$HERE/android/keystore.properties"

: "${JAVA_HOME:=/opt/homebrew/opt/openjdk@21}"
export JAVA_HOME

if [ -f "$KEYSTORE" ]; then
  echo "A key already exists at $KEYSTORE."
  echo "Refusing to overwrite it — a new key cannot update apps signed with the old one."
  exit 1
fi

# Generated rather than chosen. A password somebody types here is a password
# that ends up in a chat message.
#
# `set +o pipefail` inside the subshell, and it is load-bearing. `head -c 32`
# closes the pipe as soon as it has enough, `tr` is killed by SIGPIPE, and with
# pipefail on that reads as a failed command — so `set -e` ends the script
# immediately after this line, silently, with no key created and nothing said.
PASSWORD="$(set +o pipefail; LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"

"$JAVA_HOME/bin/keytool" -genkeypair \
  -keystore "$KEYSTORE" \
  -alias ipropy \
  -keyalg RSA -keysize 4096 \
  -validity 10000 \
  -storepass "$PASSWORD" -keypass "$PASSWORD" \
  -dname "CN=iPropy, OU=iPropy CRM, O=iPropy, L=Pune, ST=Maharashtra, C=IN"

cat > "$PROPS" <<EOF
# Written by scripts/make-release-key.sh. Never commit this file.
storeFile=$KEYSTORE
storePassword=$PASSWORD
keyAlias=ipropy
keyPassword=$PASSWORD
EOF
chmod 600 "$PROPS" "$KEYSTORE"

echo
echo "Signing key created."
echo "  keystore: $KEYSTORE"
echo "  settings: $PROPS"
echo
echo "Back both files up somewhere off this machine. Without them you cannot"
echo "ship an update that installs over the copy already on a rep's phone."
