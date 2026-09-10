#!/usr/bin/env bash
# Sets up a brand new Mac to run iPropy CRM. Safe to run more than once —
# every step checks first and skips what is already done.
#
#   bash scripts/setup-new-laptop.sh
#
# What it does NOT do: it cannot invent your secrets. If .env is missing it
# tells you which file to copy from Rishabh's Mac and stops there.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

green()  { printf '\033[32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }
red()    { printf '\033[31m%s\033[0m\n' "$1"; }
step()   { printf '\n\033[1m== %s\033[0m\n' "$1"; }

FAILED=0
note_fail() { red "   $1"; FAILED=1; }

step "1 of 9  Checking the basics"

if ! command -v brew >/dev/null 2>&1; then
  yellow "   Homebrew is missing. Installing it now (it will ask for your Mac password)."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || {
    note_fail "Homebrew would not install. Open https://brew.sh and follow the one line there, then run this script again."
    exit 1
  }
  # Apple Silicon puts brew here; make it usable in this shell and future ones.
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    grep -q 'brew shellenv' ~/.zprofile 2>/dev/null || \
      echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
  fi
else
  green "   Homebrew is here."
fi

NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "${NODE_MAJOR:-0}" -ge 20 ]; then NODE_OK=1; fi
fi
if [ "$NODE_OK" -eq 1 ]; then
  green "   Node $(node -v) is fine (needs 20 or newer)."
else
  yellow "   Installing Node."
  brew install node || note_fail "Node would not install."
fi

if command -v docker >/dev/null 2>&1; then
  green "   Docker is installed."
else
  yellow "   Installing Docker Desktop. This one is a big download."
  brew install --cask docker || note_fail "Docker would not install. Get it from https://docker.com instead."
fi

if command -v gh >/dev/null 2>&1; then
  green "   GitHub tool is installed."
else
  yellow "   Installing the GitHub command line tool."
  brew install gh || yellow "   Could not install gh. Not fatal, you just won't be able to open pull requests from the terminal."
fi

if [ "$FAILED" -eq 1 ]; then
  red "Stopping. Fix the lines above, then run this script again."
  exit 1
fi

step "2 of 9  Starting Docker"
if docker info >/dev/null 2>&1; then
  green "   Docker is already running."
else
  yellow "   Docker is not running. Opening it. This takes about a minute the first time."
  open -a Docker 2>/dev/null || open -a "Docker Desktop" 2>/dev/null || true
  for i in $(seq 1 90); do
    if docker info >/dev/null 2>&1; then break; fi
    sleep 2
  done
  if docker info >/dev/null 2>&1; then
    green "   Docker is running now."
  else
    red "   Docker still isn't running. Open the Docker app from Applications, wait for the whale icon"
    red "   in the top menu bar to stop animating, then run this script again."
    exit 1
  fi
fi

step "3 of 9  Your settings file (.env)"
if [ -f .env ]; then
  green "   .env is here."
else
  if [ -f "$HOME/Desktop/ipropy-handover/.env" ]; then
    cp "$HOME/Desktop/ipropy-handover/.env" .env
    green "   Copied .env out of the handover folder on your Desktop."
  else
    red "   There is no .env file, and the CRM cannot start without one."
    red ""
    red "   This file holds the passwords and keys. It is deliberately not in GitHub, so it has"
    red "   to be handed to you directly. Ask Rishabh to run this on his Mac:"
    red ""
    red "       bash scripts/handover-bundle.sh"
    red ""
    red "   He will get a folder to AirDrop you. Put it on your Desktop, then run:"
    red ""
    red "       bash scripts/install-handover.sh ~/Desktop/ipropy-handover"
    red ""
    exit 1
  fi
fi

step "4 of 9  Starting the database"
docker compose up -d db || { red "   The database would not start."; exit 1; }
printf '   waiting for it to answer'
for i in $(seq 1 60); do
  if docker compose exec -T db pg_isready -U ipropy -d ipropy >/dev/null 2>&1; then break; fi
  printf '.'; sleep 2
done
printf '\n'
if docker compose exec -T db pg_isready -U ipropy -d ipropy >/dev/null 2>&1; then
  green "   Database is up."
else
  red "   Database is not answering. Run 'docker compose logs db' and send Rishabh the last 20 lines."
  exit 1
fi

step "5 of 9  Installing the app's parts (a few minutes)"
npm install || { red "   npm install failed. Run it again, it is usually a slow network."; exit 1; }

step "6 of 9  Building and filling the database"
npm run build:deps || { red "   Build failed."; exit 1; }
npm run db:migrate || { red "   Setting up the database tables failed."; exit 1; }
npm run db:seed    || { red "   Loading the starting data failed."; exit 1; }

step "7 of 9  Installing the browser the tests drive"
# `npm test` needs nothing extra, but `npm run test:e2e` drives a real browser
# that Playwright downloads separately. Without this, asking Claude to "run the
# tests" dead-ends on an error about a missing executable that reads like a
# broken project rather than a missing download.
if npx playwright install chromium 2>&1 | tail -3; then
  green "   Test browser ready."
else
  yellow "   Could not download the test browser. Everything else still works;"
  yellow "   only 'npm run test:e2e' needs it. Retry later with:"
  yellow "       npx playwright install chromium"
fi

step "8 of 9  Checking it actually runs"
green "   Starting the CRM for 40 seconds to make sure it answers."
env -u ANTHROPIC_API_KEY API_PORT=4000 npm run dev >/tmp/ipropy-first-run.log 2>&1 &
DEV_PID=$!
HEALTH=""
for i in $(seq 1 40); do
  HEALTH="$(curl -s -m 2 http://localhost:4000/api/health || true)"
  case "$HEALTH" in *ok*|*healthy*|*status*) break ;; esac
  sleep 1
done
kill "$DEV_PID" 2>/dev/null || true
pkill -P "$DEV_PID" 2>/dev/null || true
case "$HEALTH" in
  *ok*|*healthy*|*status*) green "   The CRM answered. Setup worked." ;;
  *) yellow "   The CRM did not answer in 40 seconds. It may just be slow on the first run."
     yellow "   Look at /tmp/ipropy-first-run.log, or ask Claude Code to read it for you." ;;
esac

step "9 of 9  Done"
cat <<'DONE_EOF'

   To use the CRM from now on, two commands:

       docker compose up -d db     (only needed after restarting the Mac)
       npm run dev

   Then open  http://localhost:5173  in your browser.

   Log in with the email and password in SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
   inside the .env file.

   Read START-HERE.md next. It is written for you, not for a developer.

DONE_EOF
