#!/usr/bin/env bash
# Build the store upload zips from the ONE source tree in extension/.
#   dist/quell-<v>-chrome.zip   Chrome Web Store
#   dist/quell-<v>-firefox.zip  addons.mozilla.org (desktop + Android)
# Only manifest.json differs; pipeline/make_manifest.py derives it.
# Excludes Chrome's _metadata artifacts and OS junk.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")
mkdir -p dist
BUILD="dist/build"
rm -rf "$BUILD"

for target in chrome firefox; do
  dir="$BUILD/$target"
  mkdir -p "$dir"
  (cd extension && tar --exclude='_metadata' --exclude='.DS_Store' -cf - .) | (cd "$dir" && tar -xf -)
  python3 pipeline/make_manifest.py "$target" > "$dir/manifest.json"
  out="dist/quell-${VERSION}-${target}.zip"
  rm -f "$out"
  (cd "$dir" && zip -qrX "../../../$out" . -x '.DS_Store' -x '*/.DS_Store')
  echo "built $out ($(du -h "$out" | cut -f1))"
done
