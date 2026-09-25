# Quell

**Quiet the web.** A free, open-source browser extension that removes the noise you
didn't ask for — forced AI features (Google AI Overviews, AI Mode, Gemini, Bing
Copilot, DuckDuckGo/Brave/Yahoo AI answers), cookie-consent banners, and — if you
want — newsletter pop-ups, chat widgets and "open in app" banners.

**[→ Install from the Chrome Web Store](https://chromewebstore.google.com/detail/hipifmmjmbnkhfajkbmcjkajlfjiehho)** — for Chrome, Brave, Vivaldi and other browsers that install from the Chrome Web Store.

Chrome (and the other browsers that install from the Chrome Web Store) and Firefox (desktop and
Android), from one source tree.
Free. No account. No tracking. Made by Purple Directive.

## Why

Only ~30% of people find new AI features in their apps useful; 40%+ call them an
annoyance or hype (Prophet 2026; Stanford HAI 2026). Existing "AI blockers" are
either paywalled with dark patterns or fragile single-site hacks. Quell is the
honest one: the blocking core is **free forever**, it collects **nothing** to run,
it **never hides a real search result** (every surface has an organic-result guard
with a regression test), and its blocklist is kept fresh by an automated pipeline
so it doesn't rot when sites change.

## Three groups, plain switches

The popup has three groups — **Search**, **Cookie banners**, **Pop-ups** — each
with one switch for the group and plain-language switches for each surface, plus:

- **This site** — every per-site control in one card: *Keep AI on this site*,
  *Allow cookie banners here*, *Allow pop-ups here*, and **This site looks
  broken** (see below).
- **On this page Quell hid N things** — so you can see it working.
- **It asks before AI comes back.** Switching Quell off, or showing any AI
  surface again, asks for confirmation first; hiding more never asks.
- A **first-run page** (once, on install — never on update) says what Quell
  does, what it will never do, and where the switches are.

## What it blocks today

- **Google** — AI Overviews and AI Mode, on all 190 Google country domains. Two modes:
  - *Hide AI* — surgically removes the AI blocks, keeps the rest of Google.
  - *Classic results* ("Clean Web" in the code) — forces Google's classic web results (`udm=14`); selector-proof,
    so it does not depend on Google's markup staying the same.
  Per-surface switches: the AI Overview, AI Mode entry points, Gemini promos and
  People-also-ask answers are each independently controllable.
- **People-also-ask** — Google builds these answers with the same AI as the
  Overview, and renders them as the same object, so a single switch hides both.
  Quell tells them apart: an overview you did not ask for is hidden, an answer
  you clicked open is kept. Both are yours to change.
- **Bing** — hides the Copilot sidebar, its buttons, every `/copilotsearch`
  entry point (the "Search" tab and any other link into Copilot search) and the
  Copilot suggestion chips, under one switch. Each chip routes into Copilot, not
  into a web search, so 0.6.0 treats it as the entry point it is. An organic
  result that links to `/copilotsearch` is still never touched.
- **DuckDuckGo, Brave, Yahoo** *(opt-in)* — these three are **off until you
  switch them on**, because reaching them needs site access Quell does not ship
  with. Quell's required access is frozen at Google and Bing: Chrome disables an
  extension for every existing user when an update widens its required hosts, so
  every engine added from here on is an optional permission you grant with one
  click, and updates stay silent.
  Once enabled, each engine offers *Hide it* (the default) or *Off at the
  source*. Off-at-the-source uses the engine's own no-AI parameter — DuckDuckGo
  `assist=false`, Brave `summary=0` — which is selector-proof and so does not
  depend on their markup staying the same, but it redirects the page, so it is a
  choice rather than a default. Quell only ever **adds** that parameter: if you have set it
  yourself, or toggled the engine's own AI switch, Quell leaves your value
  alone. Yahoo publishes no such parameter, so the option is absent rather than
  inert. On Yahoo, *Hide it* also covers Yahoo Scout, its AI chat: the Scout
  tab, the "Try Yahoo Scout" promo and the right-rail "Explore AI results"
  panel (Yahoo's own "People also ask" answers, inside the results, are left
  alone). Ecosia is unverified (bot-walled) and deliberately ships no selectors.
- **Cookie banners** *(beta, opt-in)* — blocks consent platforms at the network
  layer (337 rules) and hides banners with the **full EasyList Cookie List**:
  ~15,000 generic selectors plus domain-specific rules for ~16,000 sites. Rules
  derive from the open EasyList Cookie list (CC BY-SA 3.0 — see [NOTICE](NOTICE)).
  If a site misbehaves, **Allow cookie banners here** (in the popup's *This
  site* card) turns the cookie layer off for that site only — network and
  cosmetic layers both.
  Quell's own two cosmetic layers lift immediately on the open page; the
  generic EasyList sheet is injected natively by Chrome and cannot be pulled
  back out of a loaded page, so that one clears on the next reload.
  **Say "reject all" for me** *(opt-in, off by default)* clicks the consent
  platform's own *Reject all* button, so the choice is actually recorded rather
  than left unmade. Strictly scoped to recognised consent platforms — Quell
  never clicks a site's own controls. A platform has to load to record a
  refusal, so with this switch on Quell stops blocking the four it can press
  that its network layer otherwise blocks (OneTrust, Cookiebot, Didomi, Osano —
  one dynamic allow rule, removed again when the switch goes off); every other
  consent platform stays blocked. Before 0.6.0's live verification this was
  missed: the network layer blocked `cdn.cookielaw.org` and the reject click
  had nothing to press. The click waits until the page has
  finished parsing (so the platform's own script is listening), counts only
  once the platform hides its banner or records the choice, and is retried at
  most twice if it did not — including when the platform re-renders its banner
  (a replaced banner is followed to its replacement, not taken as an answer).
  A choice you already made is never overridden: before every click Quell
  checks the platform's own saved-choice cookie (OneTrust, Cookiebot, Didomi,
  CookieYes, cookie-law-info, Complianz, Borlabs), so a banner re-opened to
  review consent is left alone; a banner the site has dismissed — by inline
  style, attribute, or a recognised vendor state class — is left alone; and for
  the two platforms whose saved choice Quell cannot read (Osano, Termly), a
  banner that appears after being hidden is hidden, never clicked.
- **Pop-ups** *(opt-in, off by default)* — newsletter sign-up modals, chat-widget
  launchers and "open in app" banners, each with its own switch. Rules derive
  from EasyList's *Newsletter Notices*, *Chat Widgets* and (app-banner rules
  only) *Notifications* lists via the same pipeline, plus a short curated list of
  chat-vendor launchers and sign-up vendors EasyList misses (Attentive's
  e-mail/SMS sign-up). **Cosmetic only — Quell blocks no requests here** — and
  it can never hide page content: the pipeline drops any structural selector
  (`main`, `article`, `#content`, `.wrapper`…), any rule aimed at `html` or
  `body` in any form (`body.newsletter-open` included), and any rule that is
  only a site's generic modal shell (`.modal`, `.modal-backdrop`, `#popup`,
  `.ui-widget-overlay`…). At run time nothing that is or holds `main`,
  `article`, `[role=main]`, an `<h1>`, an article's worth of text, a password
  field, or a sign-in / cart / checkout form or dialog is ever hidden; and a
  **per-site** rule hides an element only once it looks like what this layer
  is for — an e-mail field or sign-up wording, a known chat widget, or an
  app-install banner. If a hidden overlay left
  the page scroll-locked, the lock is released (and handed back when you pause
  the site). Needs the same all-sites access as cookie banners.

## "This site looks broken"

One button in the popup. It opens a dialog showing **exactly** what will be
sent — `{"host": "<the site's domain>", "version": "<Quell version>"}` — and
sends only that, only when you press *Send report*. No page address, no page
content, no identifier. The button is only offered for a public website's
address (the same host rule the endpoint enforces, in
`extension/src/shared/report-host.js`), and the endpoint only accepts reports
from Quell's own extension origins. The endpoint (`server/report-worker`, a small
Cloudflare Worker) stores a count per domain, per version, per day; it does not
log or keep IP addresses. The weekly rules job reads the counts
(`pipeline/fetch_reports.py`). The endpoint URL is one constant,
`REPORT_ENDPOINT` in `extension/src/shared/config.js`. On Firefox the browser
also asks the user's permission (an optional data-collection permission) the
first time.

## Rule pipeline (Phase 2 — live)

`pipeline/build_rules.py` regenerates the cookie rules from the EasyList Cookie
List (and, since 0.6.0, `rules/popups.json` for the pop-ups layer): network block rules (`rules/cookie-cmp-easylist.json`), a generic hide
stylesheet Chrome injects natively (`rules/cookie-generic.css`), and a
domain-specific selector map (`rules/cookie-domains.json`) that the background
serves to each page one host-slice at a time — pages never see the whole map,
and the files aren't web-accessible (sites can't fingerprint Quell). Only filter
syntax that translates with full confidence is converted; everything else is
dropped *and counted*, and the build fails loudly if output shrinks
suspiciously. A weekly GitHub Action (`quell-rules-refresh`) opens a PR when
upstream rules change.

## Roadmap

- More AI surfaces — Gemini in Gmail/Docs/Drive, Meta AI, Grok on X, YouTube AI.
- A device-wide DNS option, and "Do Not Train" / opt-out signals.

**Not on the roadmap: ad-blocking.** uBlock Origin already does that better than
anyone, for free. For ads, we recommend uBlock Origin — pointing you to the better
tool is the honest thing to do.

## What it does NOT do (on purpose)

- It does **not** "delete your data from AI servers" — no client tool can. The
  honest version (send opt-out signals, surface every platform's opt-out controls)
  ships in a later phase.
- It does **not** stop AI globally — only in your browser, on your device.
- It does **not** track you or phone home. The only thing it ever sends is a
  breakage report you choose to send (a domain and a version number).

## Install (developer / unpacked)

Chrome and other Chromium browsers:
1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → select the `extension/` folder.
4. Pin Quell, run a Google search, open the popup to toggle modes.

Firefox: `bash pipeline/package.sh`, then `about:debugging` → *This Firefox* →
*Load Temporary Add-on* → `dist/build/firefox/manifest.json`.

## Browsers — one source tree

`extension/manifest.json` is the Chrome manifest. `pipeline/make_manifest.py`
derives the Firefox one (event-page background instead of a service worker,
`browser_specific_settings.gecko` with id `quell@purpledirective.com`,
`strict_min_version` 140.0 desktop / 142.0 Android, Firefox's optional
data-collection permission for the breakage report, and a ≤45-character name).
`pipeline/package.sh` emits `dist/quell-<v>-chrome.zip`
and `dist/quell-<v>-firefox.zip`; `npx web-ext lint` passes on the Firefox build.
Firefox closes a toolbar popup when its permission prompt opens, so on Firefox
the switches that need a grant open the same settings page in a tab and ask
there.

## Tests

`tests/run.sh` loads the real extension into Playwright's Chromium and verifies
every surface against local fixtures (no live Google/Bing traffic): AI-block
hiding, the organic-result false-positive guard, clean-web redirect, master-switch
gating of the network ruleset, cookie-banner hiding and reject-all, the pop-ups
layer and its content guard, scroll-lock release, the per-site pauses, the popup
(confirmations, site card, breakage report), the welcome page, the settings
migration to `storage.sync`, and the report Worker. Requires a global
playwright install (`npm i -g playwright` + `playwright install chromium`).
`tests/firefox.mjs` runs the Firefox build in a real headless Firefox when
`QUELL_FIREFOX_BIN` and `QUELL_PUPPETEER` are set (it skips otherwise).

## Privacy & permissions

No analytics, no telemetry, no account. Your choices are kept in the browser's
extension **sync** storage, so the browser syncs them to **your own** browser
account (Google / Microsoft / Mozilla) when you are signed in with sync on —
Purple Directive never receives them. Three grant-bound switches (other engines,
cookie banners, pop-ups) and the hidden-items counter stay on each device.
Settings from 0.5.x move from `storage.local` to `storage.sync` on update without
loss. The only thing sent to Purple Directive is a breakage report you choose
to send.

The base install requests only `storage`, `declarativeNetRequest` (rule-based
blocking Quell can't read your traffic through), and `scripting`. The broad
**all-sites** permission is *optional* — it's requested only if you turn on
**Cookie banners** or **Pop-ups**, and only then can those layers run on the
pages you visit. Switch both off and Quell hands the access back
(`permissions.remove`, from the popup on that click, and on browser start for
state that is already off — except while the DuckDuckGo / Brave / Yahoo switch is
on, because in Chrome removing all-sites access takes those hosts with it and only
a click in the popup may ask for them back; then it is handed back the next time
you switch Cookie banners or Pop-ups off in the popup); switching either on again
asks again. Leave both
off and Quell never touches a page outside Google/Bing search.
If the access is revoked from the browser's extensions page instead, both
switches go off with it, so the popup never shows a feature as on that cannot
run.

**Store data declarations** (0.6.0): Chrome Web Store — *Web history*,
limited to the hostname the user chooses to report; Firefox —
`data_collection_permissions` required `none`, optional `browsingActivity` +
`technicalAndInteraction`. Used only for fixing site breakage; never sold,
shared, or used for unrelated purposes or creditworthiness. Full answers in
`store/LISTING.md`. The breakage report needs no extra permission (it is a
plain CORS request).

## License

MIT — see [LICENSE](LICENSE).
