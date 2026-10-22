#!/usr/bin/env bash
# Bump Quell's version — the ONLY way the version changes. extension/manifest.json holds
# it; make_manifest.py derives the Firefox manifest from it.
#
#   pipeline/bump.sh patch   0.6.0 -> 0.6.1  fixes, selector/rule updates (the weekly
#                                            EasyList refresh), copy and performance fixes
#   pipeline/bump.sh minor   0.6.1 -> 0.7.0  something users will see as new: a feature,
#                                            switch, engine or browser; a new OPTIONAL
#                                            permission; a new data flow
#   pipeline/bump.sh major   0.7.0 -> 1.0.0  a break for existing users: a NEW REQUIRED
#                                            permission (Chrome disables the extension on
#                                            update until the user accepts), a removed
#                                            feature, reset or migrated settings, a changed
#                                            default. 1.0.0 itself is the owner's call.
#
# When unsure between two, the smaller bump is wrong only if users would be surprised.
# Refuses to run if the current version is not the latest published release, so a
# version can't be skipped or bumped twice before it ships.
set -euo pipefail
cd "$(dirname "$0")/.."
kind="${1:-}"
case "$kind" in patch|minor|major) ;; *) sed -n '2,17p' "$0"; exit 2 ;; esac

cur=$(python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")
IFS=. read -r MA MI PA <<<"$cur"
case "$kind" in
  patch) new="$MA.$MI.$((PA+1))" ;;
  minor) new="$MA.$((MI+1)).0" ;;
  major) new="$((MA+1)).0.0" ;;
esac

if command -v gh >/dev/null && [ -z "${QUELL_BUMP_OFFLINE:-}" ]; then
  latest=$(gh release view -R PurpleDirective/quell --json tagName -q .tagName 2>/dev/null || true)
  latest="${latest#v}"; latest="${latest#quell/v}"
  if [ -n "$latest" ] && [ "$latest" != "$cur" ]; then
    echo "refusing: manifest is $cur but the latest published release is $latest."
    echo "Release $cur first (tag + GitHub Release), or fix the manifest." >&2
    exit 1
  fi
fi

python3 - "$new" <<'PY'
import json, sys
p = "extension/manifest.json"
s = open(p).read()
old = json.loads(s)["version"]
open(p, "w").write(s.replace(f'"version": "{old}"', f'"version": "{sys.argv[1]}"', 1))
PY
echo "$cur -> $new ($kind). Next: tests/run.sh, pipeline/package.sh, submit, then tag v$new + GitHub Release."
