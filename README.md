# Quell

**Quiet the web.** A free, open-source browser extension that removes the noise you
didn't ask for — starting with forced AI features (Google AI Overviews, AI Mode,
Gemini, Bing Copilot), and growing to cookie-consent nags and other annoyances.

**[→ Install from the Chrome Web Store](https://chromewebstore.google.com/detail/hipifmmjmbnkhfajkbmcjkajlfjiehho)** — for Chrome, Brave, Vivaldi and other browsers that install from the Chrome Web Store.

Free. No account. No tracking. Made by Purple Directive.

## Why

Only ~30% of people find new AI features in their apps useful; 40%+ call them an
annoyance or hype (Prophet 2026; Stanford HAI 2026). Existing "AI blockers" are
either paywalled with dark patterns or fragile single-site hacks. Quell is the
honest one: the blocking core is **free forever**, it collects **nothing**, and its
blocklist is kept fresh by an automated pipeline so it doesn't rot when sites change.

## What it blocks today

- **Google** — AI Overviews and AI Mode, on all 190 Google country domains. Two modes:
  - *Hide* — surgically removes the AI blocks, keeps the rest of Google.
  - *Clean Web* — forces Google's classic web results (`udm=14`); selector-proof,
    so it does not depend on Google's markup staying the same.
  Per-surface switches: the AI Overview, AI Mode entry points, Gemini promos and
  People-also-ask answers are each independently controllable.
- **People-also-ask** — Google builds these answers with the same AI as the
  Overview, and renders them as the same object, so a single switch hides both.
  Quell tells them apart: an overview you did not ask for is hidden, an answer
  you clicked open is kept. Both are yours to change.
- **Bing** — hides the Copilot sidebar and entry points. The `/copilotsearch`
  suggestion chips carry real search queries, so they have their own switch and
  are kept by default.
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
  inert. Ecosia is unverified (bot-walled) and deliberately ships no selectors.
- **Cookie banners** *(beta, opt-in)* — blocks consent platforms at the network
  layer (337 rules) and hides banners with the **full EasyList Cookie List**:
  ~15,000 generic selectors plus domain-specific rules for ~16,000 sites. Rules
  derive from the open EasyList Cookie list (CC BY-SA 3.0 — see [NOTICE](NOTICE)).
  If a site misbehaves, the popup's **Pause on this site** switch turns the
  cookie layer off for that site only — network and cosmetic layers both.
  Quell's own two cosmetic layers lift immediately on the open page; the
  generic EasyList sheet is injected natively by Chrome and cannot be pulled
  back out of a loaded page, so that one clears on the next reload.
  **Reject instead of hide** *(opt-in, off by default)* clicks the consent
  platform's own *Reject all* button, so the choice is actually recorded rather
  than left unmade. Strictly scoped to recognised consent platforms — Quell
  never clicks a site's own controls. The click waits until the page has
  finished parsing (so the platform's own script is listening), counts only
  once the platform hides its banner in response, and is retried at most
  twice if it did not; a banner the site itself has already dismissed — by
  inline style, attribute, or a recognised vendor state class — is left alone,
  so a choice you already made is never overridden.

## Rule pipeline (Phase 2 — live)

`pipeline/build_rules.py` regenerates the cookie rules from the EasyList Cookie
List: network block rules (`rules/cookie-cmp-easylist.json`), a generic hide
stylesheet Chrome injects natively (`rules/cookie-generic.css`), and a
domain-specific selector map (`rules/cookie-domains.json`) that the background
serves to each page one host-slice at a time — pages never see the whole map,
and the files aren't web-accessible (sites can't fingerprint Quell). Only filter
syntax that translates with full confidence is converted; everything else is
dropped *and counted*, and the build fails loudly if output shrinks
suspiciously. A weekly GitHub Action (`quell-rules-refresh`) opens a PR when
upstream rules change.

## Roadmap

- **Other annoyances** — newsletter modals, chat-widget popups (Annoyances lists).
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
- It does **not** track you or phone home.

## Install (developer / unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select the `extension/` folder.
4. Pin Quell, run a Google search, open the popup to toggle modes.

## Tests

`tests/run.sh` loads the real extension into Playwright's Chromium and verifies
every surface against local fixtures (no live Google/Bing traffic): AI-block
hiding, the organic-result false-positive guard, clean-web redirect, master-switch
gating of the network ruleset, cookie-banner hiding, scroll-lock release, the
no-blanket-unlock regression, and the per-site pause. Requires a global
playwright install (`npm i -g playwright` + `playwright install chromium`).

## Privacy & permissions

No analytics, no remote storage, no telemetry. Settings live in
`chrome.storage.local` on your machine. Quell never sends your browsing anywhere.

The base install requests only `storage`, `declarativeNetRequest` (rule-based
blocking Quell can't read your traffic through), and `scripting`. The broad
**all-sites** permission is *optional* — it's requested only if you turn on
**Cookie banners**, and only then can the cosmetic layer run on the pages you
visit. Leave that feature off and Quell never touches a page outside Google/Bing
search.

## License

MIT — see [LICENSE](LICENSE).
