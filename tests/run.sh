#!/usr/bin/env bash
# Quell smoke suite — links the global playwright install (ESM ignores
# NODE_PATH), then runs the tests. node_modules/ here is gitignored.
set -euo pipefail
# QUELL_HEADLESS_ONLY=1: new headless Chromium only, never a visible window.
cd "$(dirname "$0")"
GLOBAL_ROOT="$(npm root -g)"
PW=""
for c in "$GLOBAL_ROOT/playwright" "$GLOBAL_ROOT/@playwright/cli/node_modules/playwright"; do
  [ -d "$c" ] && PW="$c" && break
done
[ -n "$PW" ] || { echo "playwright not found — npm i -g playwright"; exit 1; }
mkdir -p node_modules
ln -sfn "$PW" node_modules/playwright
# All must pass (firefox.mjs skips unless configured). background.mjs executes the service worker's
# grant/revoke path against a recording chrome (no browser — Chrome's grant
# prompt cannot be driven by Playwright); smoke.mjs proves Quell works alone;
# compat.mjs proves it works next to another extension, which is how it is
# actually installed.
rc=0
node background.mjs || rc=1
echo
# Usage counts: consent gate, queue clearing, payload scrubbing, Firefox gate.
node analytics.mjs || rc=1
echo
node links.mjs || rc=1
echo
node smoke.mjs || rc=1
echo
node compat.mjs || rc=1
echo
# The pop-ups rule filter (pipeline) and the shipped rules it produced.
python3 ../pipeline/test_build_rules.py || rc=1
echo
# The breakage-report Worker (server side of the popup's report button).
node --no-warnings ../server/report-worker/test.mjs || rc=1
echo
# Real Firefox (optional): SKIPs unless QUELL_FIREFOX_BIN and QUELL_PUPPETEER are set.
node firefox.mjs || rc=1
exit "$rc"
