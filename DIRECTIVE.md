# Quell — browser extension

Quell quiets the web: AI answers in search results, cookie banners, newsletter pop-ups, chat
widgets and "open in app" banners. One source tree builds the Chrome (Chromium family), Firefox
and Opera packages. The repository root is the product. Start with [README.md](README.md).

## Truth map
Code and tests are the truth; docs record intent — verify against the tree.
`extension/` (manifest, `src/`, generated `rules/`) · `pipeline/` (rules build, packaging,
version bump) · `server/report-worker/` (the breakage-report Cloudflare Worker) · `store/`
(listings, privacy policy, assets) · `tests/` (Playwright suite) · `docs/RUNTIME-RULES-POLICY.md`
(what the stores allow for rule delivery) · `tools/` (compliant-claims linter).
Internal research, live-site evidence and strategy are kept outside this repository.

## Standing product rules
- Organic results are never hidden: every surface keeps its organic-result guard and a
  regression test in `tests/smoke.mjs`. A change that weakens a guard needs a test first.
- Privacy surface is a promise: no analytics, no telemetry, no identifiers. The only thing ever
  sent is the user-initiated breakage report (`{"host", "version"}`). `<all_urls>` stays an
  OPTIONAL permission (CI checks this); required hosts stay frozen at Google and Bing, every
  later engine is an optional permission.
- Rules are generated: change `pipeline/build_rules.py`, never hand-edit `extension/rules/*.json`
  or `cookie-generic.css`. Upstream EasyList attribution lives in `NOTICE` (CC BY-SA 3.0).
- Tests run against local fixtures, never live Google/Bing traffic.
- Versioning: `pipeline/bump.sh patch|minor|major` is the only way the version changes
  (MAJOR.MINOR.PATCH, both manifests). Every version sent to a store is a git tag plus a GitHub
  Release carrying the exact packages submitted. Store uploads stay manual.
- Regulated language: never an unqualified "compliant" claim; say "designed and tested against".
  Lint customer-facing copy: `python3 tools/lint_compliant_claims.py` (CI runs it).
- Pricing: none lives here, and no price numbers go in docs or listings.
- Public attribution is bare "Purple Directive". Legal pages (Terms/Privacy) get their entity wording in a dedicated legal pass — do not add entity lines ad hoc. No customer, family or operator names in this repository.
- No AGPL dependencies. The extension has no runtime dependencies; keep it that way.

## Deploy
Report worker: `server/report-worker/deploy.sh` supplies the Cloudflare account id and D1
database id from `CLOUDFLARE_ACCOUNT_ID` / `QUELL_D1_DATABASE_ID`; the committed
`wrangler.jsonc` holds placeholders only. Secrets (`READ_TOKEN`, `RATE_SALT`) are wrangler
secrets; `QUELL_REPORTS_TOKEN` is a repository Actions secret. A production deploy or a store
upload needs explicit human authorization.
