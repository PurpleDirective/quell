#!/bin/bash
# Quell rules refresh — run by hand from a clone of PurpleDirective/quell (no
# scheduler installed; the quell-rules-refresh workflow also runs weekly). Use
# this to land a refresh that CI will actually test: it opens the PR under the
# gh login and sets auto-merge.
#
# Why here and not only in GitHub Actions: a PR opened with the Actions
# GITHUB_TOKEN never triggers pull_request workflows, so its checks never run.
# A PR opened with the operator's own gh login runs CI like any other PR, and
# auto-merge lands it once the required checks pass. Auto-merge needs branch
# protection with required checks on main; without it `gh pr merge --auto` fails.
#
# The store never sees a rule change until a human builds and uploads a
# release, so merging on green does not ship anything by itself.
#
#   DRY_RUN=1 pipeline/weekly-refresh.sh   # regenerate + report, no push
#   REPO=/path/to/clone pipeline/weekly-refresh.sh
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

REPO="${REPO:-$HOME/quell}"
SLUG="PurpleDirective/quell"
STAMP="$(date +%Y%m%d)"
BR="quell/rules-refresh-$STAMP"
WT="$(mktemp -d)/quell-rules-$STAMP"

git -C "$REPO" fetch -q origin main
git -C "$REPO" worktree add -q --detach "$WT" origin/main
cleanup() { git -C "$REPO" worktree remove --force "$WT" 2>/dev/null || true; }
trap cleanup EXIT

cd "$WT"
python3 pipeline/build_rules.py

if git diff --quiet -- extension/rules; then
  echo "quell-rules-refresh: no rule changes this week"
  exit 0
fi
git diff --stat -- extension/rules

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "quell-rules-refresh: DRY_RUN — not pushing"
  exit 0
fi

# An earlier refresh still open is superseded by this one (same files, newer pull).
for n in $(gh pr list --repo "$SLUG" --state open --search "head:quell/rules-refresh-" --json number -q '.[].number'); do
  gh pr close "$n" --repo "$SLUG" --delete-branch --comment "Superseded by the $STAMP refresh."
done

git switch -q -c "$BR"
git add extension/rules
git commit -q -m "chore(quell): weekly EasyList Cookie rules refresh $STAMP"
# HTTPS + the gh login: no dependency on an SSH agent, which a scheduled job may not have.
git -c credential.helper= -c credential.helper='!gh auth git-credential' \
  push -q "https://github.com/$SLUG.git" "$BR"
gh pr create --repo "$SLUG" --base main --head "$BR" \
  --title "chore(quell): weekly cookie-rules refresh $STAMP" \
  --body "Automated EasyList Cookie List regeneration (pipeline/build_rules.py), opened from the operator's machine so CI runs. Auto-merges when required checks pass. Store releases stay a manual build + upload."
gh pr merge "$BR" --repo "$SLUG" --auto --squash --delete-branch
echo "quell-rules-refresh: opened $BR with auto-merge"
