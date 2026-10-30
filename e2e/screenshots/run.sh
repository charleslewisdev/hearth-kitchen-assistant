#!/usr/bin/env bash
# `pnpm screenshots`: rebuild the invented demo kitchen and photograph it into docs/screenshots.
#
# It has its own database and data directory, so it leaves the dev and test-kitchen data alone.
# The database stays afterwards, which is why `pnpm demo` can open it.
set -euo pipefail
cd "$(dirname "$0")/../.."

for port in 3000 5173; do
  if ss -ltn | grep -q ":$port\b"; then
    echo "Port $port is in use. Stop the dev servers first: they could be reading another database." >&2
    exit 1
  fi
done

. e2e/screenshots/demo-env.sh

rm -rf apps/server/.data/demo
pnpm exec playwright test -c e2e/screenshots/playwright.config.ts
