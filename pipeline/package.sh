#!/usr/bin/env bash
# Build the Chrome Web Store upload zip from extension/ (excludes Chrome's
# _metadata artifacts and OS junk). Output: dist/quell-<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")
mkdir -p dist
OUT="dist/quell-${VERSION}.zip"
rm -f "$OUT"
(cd extension && zip -qr "../$OUT" . -x '_metadata/*' -x '.DS_Store' -x '*/.DS_Store')
echo "built $OUT ($(du -h "$OUT" | cut -f1)) —"
unzip -l "$OUT" | tail -3
