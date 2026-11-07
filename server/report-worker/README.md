# quell-report — the "This site looks broken" and usage-counts endpoint

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
| `/api/quell/events` | POST | extension Origin (CORS, text/plain body) | record one install's daily usage counts (0.7.3) |
| `/api/quell/stats?days=14` | GET | `Authorization: Bearer $READ_TOKEN` | active installs, switch adoption, hides, events, errors |

## Usage counts (`/api/quell/events`)

Sent by the extension at most once a day, and only after the user answered yes on the
first-run card (and, on Firefox, only with the `technicalAndInteraction` permission). The
body is validated strictly; any extra key, unknown event or feature name, non-integer
count, bad date or malformed id is a 400 and nothing is stored:

```json
{"v":1,"id":"<uuid v4>","version":"0.7.3","browser":"chrome",
 "days":[{"day":"2026-11-05",
          "switches":{"enabled":true,"ai":true,"cookies":false,"popups":false,"engines":false,"reject":false},
          "events":{"popup_open":3,"peek":1},
          "hides":{"ai":12,"cookies":0,"popups":0},
          "errors":[{"m":"message with no URL","f":"background.js","n":2}]}]}
```

Up to 7 days per request (catch-up after being offline), body at most 6 KB. Event names:
`popup_open peek undo pause report_open firstrun_turn_on firstrun_skip`. Error messages
are scrubbed of URLs and host names in the extension and again here.

Stored (`schema.sql`): `quell_install_days` (one row per install id and UTC day; this is
what makes "active installs" countable and a replayed day a no-op; purged after 90 days),
and aggregates without the id, `quell_daily`, `quell_events`, `quell_errors` (purged after
180 days). No IP, user-agent or finer timestamp is stored; the rate limiter uses the same
salted hash and limits as `/report`. The privacy policy (`store/privacy-policy.md`) states
these retention periods: change both together.

`/stats` returns `active_installs_per_day`, `weekly_active_installs` (distinct ids over 7
days), `by_browser`, `by_version`, `adoption_and_hides_per_day` (installs and how many had
each switch on, plus hide counts), `events` and the top `errors`.

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
   (idempotent: `CREATE TABLE IF NOT EXISTS`. Re-run it for 0.7.3 to add the four
   `quell_*` usage-count tables to the existing database.)
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
   Usage-counts smoke (use a throwaway uuid, then remove its rows):
   ```sh
   curl -si -X POST https://purpledirective.com/api/quell/events \
     -H 'Origin: chrome-extension://hipifmmjmbnkhfajkbmcjkajlfjiehho' -H 'Content-Type: text/plain' \
     -d '{"v":1,"id":"3b241101-e2bb-4255-8caf-4136c566a962","version":"0.7.3","browser":"chrome","days":[{"day":"'$(date -u -v-1d +%F)'","switches":{"enabled":true,"ai":true,"cookies":false,"popups":false,"engines":false,"reject":false},"events":{},"hides":{},"errors":[]}]}'   # 204
   curl -s -H "Authorization: Bearer $READ_TOKEN" 'https://purpledirective.com/api/quell/stats?days=2'
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
