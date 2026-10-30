#!/usr/bin/env bash
# `pnpm demo`: open the demo kitchen at http://localhost:5173. Run `pnpm screenshots` once first.
# Sign in with the OWNER address and password in e2e/fixtures.ts.
set -euo pipefail
cd "$(dirname "$0")/../.."

. e2e/screenshots/demo-env.sh

pnpm --filter @hearth/server dev &
trap 'kill 0' EXIT
pnpm --filter @hearth/web dev
