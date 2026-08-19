#!/usr/bin/env bash
#
# Turn a bare Ubuntu box into the machine that runs iPropy's automation.
#
# Everything here is safe to run twice. It is written that way on purpose: the
# first run of a server script is never the one that works, and a script you are
# afraid to re-run gets finished by hand, after which nobody knows what the
# server actually has on it.
#
# What it does NOT do is authenticate OneDrive. That needs a browser, and this
# machine has none — the token is minted on a laptop and pasted in. See the
# instructions printed at the end.
#
#   ./provision.sh
#
set -euo pipefail

MOUNT_POINT="${MOUNT_POINT:-/mnt/ipropy-properties}"
REMOTE_NAME="${REMOTE_NAME:-onedrive}"
REMOTE_PATH="${REMOTE_PATH:-IPROPY-PROPERTIES}"
APP_DIR="${APP_DIR:-$HOME/ipropy}"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

say "Packages"
sudo apt-get update -qq
# fuse3 is what lets a normal process expose OneDrive as a folder; without
# allow_other the containers cannot see inside the mount even when root can.
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  ca-certificates curl gnupg fuse3 unzip

say "Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
else
  echo "already installed"
fi
sudo usermod -aG docker "$USER" || true

say "rclone"
if ! command -v rclone >/dev/null 2>&1; then
  curl -fsSL https://rclone.org/install.sh | sudo bash
else
  echo "already installed"
fi

say "Mount point"
sudo mkdir -p "$MOUNT_POINT"
sudo chown "$USER":"$USER" "$MOUNT_POINT"

# Containers run as their own users, so the mount has to be readable by more
# than the person who created it. This is the line that is always missing when
# a container reports an empty folder that is plainly full from the shell.
if ! grep -q '^user_allow_other' /etc/fuse.conf 2>/dev/null; then
  echo 'user_allow_other' | sudo tee -a /etc/fuse.conf >/dev/null
fi

say "Keeping the mount up by itself"
sudo tee /etc/systemd/system/ipropy-media-mount.service >/dev/null <<UNIT
[Unit]
Description=iPropy property media (OneDrive via rclone)
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=$USER
ExecStart=/usr/bin/rclone mount ${REMOTE_NAME}:${REMOTE_PATH} ${MOUNT_POINT} \\
  --allow-other \\
  --vfs-cache-mode full \\
  --vfs-cache-max-size 8G \\
  --dir-cache-time 1m \\
  --poll-interval 30s \\
  --umask 002
ExecStop=/bin/fusermount3 -uz ${MOUNT_POINT}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
UNIT
sudo systemctl daemon-reload

say "Done with the parts that need no browser"
cat <<NEXT

Two things are left, and both need a browser, so they happen on your laptop.

1. Authorise OneDrive. On the LAPTOP run:

     rclone authorize "onedrive"

   It opens a browser, you sign in, and it prints a long token. Copy all of it.

2. On THIS machine run:

     rclone config

   Choose: n (new remote) -> name it "${REMOTE_NAME}" -> storage "onedrive"
   -> leave client id and secret blank -> when it asks
   "Use auto config?" answer **n** -> paste the token from step 1
   -> choose "OneDrive Personal or Business" -> pick your drive -> confirm.

Then start the mount and check it:

     sudo systemctl enable --now ipropy-media-mount
     ls ${MOUNT_POINT}

If you can see your property folders there, the hard part is over. Then:

     cd ${APP_DIR} && docker compose up -d

NEXT
