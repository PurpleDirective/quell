# quell-report — the "This site looks broken" endpoint

A dependency-free Cloudflare Worker. It receives the one thing Quell ever
sends to Purple Directive: a report the user clicks, whose body is exactly

```json
{"host": "example.com", "version": "0.6.0"}
```

and keeps one aggregate row per (UTC day, host, Quell version) with a count.
No IP address, user-agent, headers or finer timestamp is stored, and Workers
Logs are disabled for this Worker (`wrangler.jsonc`). The client IP is used
only to key the edge rate limiter, as a salted SHA-256; the limiter's counter
for that key covers a 60-second period (`ratelimits` in `wrangler.jsonc`).

Only Quell may post: the `Origin` must be `chrome-extension://<CHROME_EXTENSION_ID>`,
`chrome-extension://<OPERA_EXTENSION_ID>` (empty until the Opera listing publishes =
not accepted) or any `moz-extension://<uuid>` (Firefox gives each install a
random UUID). Both ids are `vars` in `wrangler.jsonc`. Anything else gets 403
before the body is read or the limiter is touched, and replies echo the one
allowed origin, never `*`. This stops cross-site abuse from web pages; it is
not authentication (a non-browser client can forge Origin), which is why the
rate limits stay.

The host rule (public DNS names only) is shared with the extension's
`src/shared/report-host.js`; `test.mjs` fails if the copies drift.

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/api/quell/report` | POST | extension Origin (CORS, text/plain body) | record a report |
| `/api/quell/reports?days=7` | GET | `Authorization: Bearer $READ_TOKEN` | aggregated rows for the weekly rules work |

Limits: 5 reports/minute per client, 300/minute overall, 512-byte bodies;
rows older than 180 days are purged daily by the cron trigger.

## Test

```sh
node server/report-worker/test.mjs   # Node 22.13+ (node:sqlite)
```

Runs the real `src/index.js` against a real SQLite database behind a
D1-shaped adapter. Also run by `tests/run.sh`.

## Deploy (operator — not done by the PR that added this)

From `server/report-worker/`:

0. Supply the account and database ids from the environment, never the repo:
   `export CLOUDFLARE_ACCOUNT_ID=<account id>` (wrangler reads it directly) and
   `export QUELL_D1_DATABASE_ID=<database id>`. `./deploy.sh` copies `wrangler.jsonc`
   to the git-ignored `wrangler.deploy.jsonc` with `REPLACE_WITH_D1_DATABASE_ID`
   replaced, then runs wrangler against that copy. Run every wrangler command
   below through it: `./deploy.sh d1 execute ...`, `./deploy.sh secret put ...`,
   `./deploy.sh` alone = `wrangler deploy`.
1. First time only: `npx wrangler d1 create quell-reports` (needs no database id)
   and keep the returned `database_id` as `QUELL_D1_DATABASE_ID`.
2. `./deploy.sh d1 execute quell-reports --remote --file schema.sql`
3. `openssl rand -hex 32 | ./deploy.sh secret put READ_TOKEN`
4. `openssl rand -hex 32 | ./deploy.sh secret put RATE_SALT`
5. Check the two `ratelimits` `namespace_id` values (4201, 4202) are not
   already used by another Worker on the account; change them if they are.
6. `./deploy.sh`
8. Smoke it:
   ```sh
   curl -si -X POST https://purpledirective.com/api/quell/report \
     -H 'Origin: chrome-extension://hipifmmjmbnkhfajkbmcjkajlfjiehho' \
     -H 'Content-Type: text/plain' -d '{"host":"example.com","version":"0.6.0"}'   # 204
   curl -si -X POST https://purpledirective.com/api/quell/report \
     -H 'Content-Type: text/plain' -d '{"host":"example.com","version":"0.6.0"}'   # 403 (no Origin)
   curl -s -H "Authorization: Bearer $READ_TOKEN" \
     'https://purpledirective.com/api/quell/reports?days=1'                          # the row
   ```
   Then delete the smoke row:
   `./deploy.sh d1 execute quell-reports --remote --command "DELETE FROM reports WHERE host='example.com'"`

The route `purpledirective.com/api/quell/*` only claims those paths on the
apex zone; the rest of the site is untouched.

To move the endpoint, change `REPORT_ENDPOINT` in
`extension/src/shared/config.js` (the one place the extension names it) and
ship an extension update.

## Reading reports in the weekly rules work

`pipeline/fetch_reports.py` prints the last N days as a Markdown table:

```sh
QUELL_REPORTS_TOKEN=<READ_TOKEN> python3 pipeline/fetch_reports.py 7
```

The weekly `quell-rules-refresh` workflow runs it and writes the table to the
job summary when a repository secret named `QUELL_REPORTS_TOKEN` exists
(adding that secret is an operator step). Without the secret the step prints a
skip line and the workflow carries on.
