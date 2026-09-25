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
# All three must pass. background.mjs executes the service worker's
# grant/revoke path against a recording chrome (no browser — Chrome's grant
# prompt cannot be driven by Playwright); smoke.mjs proves Quell works alone;
# compat.mjs proves it works next to another extension, which is how it is
# actually installed.
rc=0
node background.mjs || rc=1
echo
node smoke.mjs || rc=1
echo
node compat.mjs || rc=1
exit "$rc"
