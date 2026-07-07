# Quell

**Quiet the web.** A free, open-source browser extension that removes the noise you
didn't ask for — starting with forced AI features (Google AI Overviews, AI Mode,
Gemini, Bing Copilot), and growing to cookie-consent nags and other annoyances.

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
    never breaks.
- **Bing** — hides the Copilot sidebar and entry points.
- **Cookie banners** *(beta, opt-in)* — blocks consent platforms at the network
  layer (317 rules) and hides banners with the **full EasyList Cookie List**:
  ~15,000 generic selectors plus domain-specific rules for ~16,000 sites. Rules
  derive from the open EasyList Cookie list (CC BY-SA 3.0 — see [NOTICE](NOTICE)).
  If a site misbehaves, the popup's **Pause on this site** switch turns the
  cookie layer off for that site only — network and cosmetic layers both.

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
