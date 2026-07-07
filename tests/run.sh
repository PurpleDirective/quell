#!/usr/bin/env bash
# Quell smoke suite — links the global playwright install (ESM ignores
# NODE_PATH), then runs the tests. node_modules/ here is gitignored.
set -euo pipefail
cd "$(dirname "$0")"
GLOBAL_ROOT="$(npm root -g)"
PW=""
for c in "$GLOBAL_ROOT/playwright" "$GLOBAL_ROOT/@playwright/cli/node_modules/playwright"; do
  [ -d "$c" ] && PW="$c" && break
done
[ -n "$PW" ] || { echo "playwright not found — npm i -g playwright"; exit 1; }
mkdir -p node_modules
ln -sfn "$PW" node_modules/playwright
exec node smoke.mjs
