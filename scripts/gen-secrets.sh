#!/usr/bin/env bash
# Generate strong random values for the production secrets.
# Paste the output into your production .env — never reuse dev defaults.
set -euo pipefail

echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
echo
echo "Notes:"
echo "  - JWT_SECRET also derives the integration-credential encryption key."
echo "    Rotating it in production means re-entering saved credentials."
