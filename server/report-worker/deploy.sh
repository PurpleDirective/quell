#!/bin/bash
# Run wrangler for the report worker with the real ids supplied from the environment.
# wrangler.jsonc is committed with a placeholder database id and no account id.
#   export CLOUDFLARE_ACCOUNT_ID=...   (read by wrangler itself)
#   export QUELL_D1_DATABASE_ID=...
#   ./deploy.sh                          # = wrangler deploy
#   ./deploy.sh d1 execute quell-reports --remote --file schema.sql
set -euo pipefail
cd "$(dirname "$0")"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
: "${QUELL_D1_DATABASE_ID:?set QUELL_D1_DATABASE_ID}"
case "$QUELL_D1_DATABASE_ID" in *[!A-Za-z0-9-]*) echo "QUELL_D1_DATABASE_ID has unexpected characters" >&2; exit 2;; esac
sed "s/REPLACE_WITH_D1_DATABASE_ID/$QUELL_D1_DATABASE_ID/" wrangler.jsonc > wrangler.deploy.jsonc
trap 'rm -f wrangler.deploy.jsonc' EXIT
[ $# -gt 0 ] || set -- deploy
npx wrangler "$@" -c wrangler.deploy.jsonc
