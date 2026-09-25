# Quell — store listings (v0.6.0)

Build with `pipeline/package.sh`:

| Store | Upload |
|---|---|
| Chrome Web Store | `dist/quell-<version>-chrome.zip` |
| Firefox Add-ons (AMO) | `dist/quell-<version>-firefox.zip` |

---

# Chrome Web Store

Everything the Developer Dashboard asks for, in order.

## Store listing

**Name** (from manifest): Quell — Block AI Overviews, Gemini & Cookie Popups

**Summary** (from manifest, ≤132 chars):
Quiet the web. Turn off AI answers on Google, Bing, DuckDuckGo, Brave & Yahoo,
and block cookie pop-ups. Free, private, open source.

**Category:** Tools
**Language:** English

**Description:**

Quell removes the noise you didn't ask for — and never the things you did.

★ GOOGLE — hide AI Overviews and AI Mode, or switch to Classic results for
Google's plain list of links (zero AI, and it doesn't rely on page markup).
Works on all 190 Google country domains. Separate switches per surface, so you
decide what goes.

★ NEVER HIDES A REAL RESULT — every search engine Quell handles has a guard
that keeps organic results out of reach, and every release is tested against
it. Search for "Copilot" or "Gemini" and the real results are still there.

★ ANSWERS YOU OPEN STAY — Google builds "People also ask" answers with the
same AI as the Overview above your results. Most blockers hide both. Quell
tells them apart: the overview you didn't ask for goes, the answer you clicked
open stays. Turn that off too if you'd rather.

★ BING — hides the Copilot panel, its buttons, and the Copilot suggestion
chips, with one switch.

★ DUCKDUCKGO, BRAVE & YAHOO (opt-in) — switch these on and your browser asks
once for access to those three sites; nothing else. Quell then hides their AI
answers, or — on DuckDuckGo and Brave — uses the engines' OWN setting for
turning AI off. If you've already set that switch yourself, Quell leaves your
choice alone.

★ COOKIE BANNERS (beta, opt-in) — blocks the major consent platforms at the
network layer and hides banners using the full EasyList Cookie List, rebuilt
weekly. Optionally says "reject all" for you on consent platforms it
recognises — and checks the platform's own saved choice first, so a choice
you already made is left alone. To do that it lets the consent platform load
(hide-only mode keeps it blocked), so it can record your "no".

★ POP-UPS (opt-in) — newsletter sign-up boxes, chat bubbles and "open in app"
banners, each with its own switch. Hides only — never blocks page content.

★ THIS SITE — one card for the site you're on: keep AI here, allow cookie
banners here, allow pop-ups here, or tell us "this site looks broken" in one
click.

WHY QUELL?
• Free forever. No account, no paywall, no "pro" upsell on the blocking core.
• Private. No analytics, no telemetry. Your settings sync through your own
  browser account like bookmarks do — never to us. The only thing Quell ever
  sends us is a "this site looks broken" report you choose to send: the
  site's domain and Quell's version, shown to you before it goes.
• Asks before AI comes back — switching an AI surface back on needs a
  confirmation, so a stray click doesn't undo your choice.
• Honest. Quell doesn't claim to "delete your data from AI servers" — no
  browser tool can. It quiets what you see, in your browser.
• Open source (MIT).
• Quell ships with access to Google and Bing search only. DuckDuckGo, Brave and
  Yahoo are asked for one click at a time, and the all-sites permission is
  requested only if you turn on cookie banners or pop-ups — and handed back
  the moment you turn both off. Revoke any of it whenever you like, from your
  browser's extensions page.

For ads, use uBlock Origin — it's the better tool for that job. Quell focuses
on what it does best: AI features and web nags.

## Privacy tab

**Single purpose:**
Quell removes unwanted content from web pages — AI feature blocks on search
engines, cookie-consent banners and (optionally) sign-up pop-ups, chat widgets
and app banners — in the user's browser.

**Permission justifications:**
- `storage` — saves the user's settings (in `storage.sync`, so the browser can
  sync them to the user's own browser account) and, locally, the per-device
  feature switches and the hidden-items counter. Nothing is sent to us.
- `declarativeNetRequest` — blocks known cookie-consent-platform scripts by
  URL rule, without Quell ever reading the user's traffic.
- `scripting` — registers and unregisters content scripts at runtime as the user
  turns optional features on and off: the cookie-banner and pop-up scripts
  (with `<all_urls>`) and the AI-hiding script for DuckDuckGo, Brave and Yahoo
  (with those three optional host permissions). It is also used to inject those
  same scripts into tabs the user already has open at the moment they switch a
  feature on, so the change applies without a reload. Nothing is injected or
  registered until the matching permission has been granted.
- Host permissions (google.* / bing.com content scripts) — inject the CSS/JS
  that hides AI feature blocks on search result pages only. These are the ONLY
  hosts Quell is installed with.
- `*://duckduckgo.com/*`, `*://*.duckduckgo.com/*`, `*://search.brave.com/*`,
  `*://search.yahoo.com/*`, `*://*.search.yahoo.com/*` (OPTIONAL) — requested at
  runtime only when the user switches on the DuckDuckGo / Brave / Yahoo engines;
  same job as the Google and Bing host permissions. Optional so that existing
  users are not disabled on update.
- `<all_urls>` (OPTIONAL) — requested at runtime only when the user enables
  Cookie banners or Pop-ups, and **given back** (`permissions.remove`) as soon
  as both are switched off again — Quell does not keep all-sites access it is
  not using. Used to hide those elements on the sites the user visits; to read
  the active tab's hostname so the popup can offer the per-site switches and
  the breakage report; and, if the user additionally switches on "Say reject
  all for me" (off by default), to click the consent platform's own Reject-all
  control.
- No new permission is needed for the breakage report: it is a plain CORS
  request from the popup to purpledirective.com.

**Data usage — the dashboard's answers for 0.6.0 (owner decision 2026-09-25):**

*What user data do you plan to collect from users now or in the future?*
Tick **Web history** — and nothing else.

> Web history: only the hostname of a site the user chooses to report with
> "This site looks broken" (for example `shop.example.com`), sent with the
> Quell version number, and only when the user presses *Send report* after
> seeing exactly what will be sent. No page address, path, query, page
> content, identifier or cookie is sent. Used only to find and fix sites
> Quell breaks.

Leave every other category unticked — Quell collects none of them:
personally identifiable information, health information, financial and
payment information, authentication information, personal communications,
location, user activity, website content.

*Certifications* — tick all three:
- I do not sell or transfer user data to third parties, outside of the
  approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my
  item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for
  lending purposes.

The same answer, in words, for any free-text field: *Quell does not collect
data to work. The only data it ever sends is a report the user chooses to
send — the hostname of the site they report, and Quell's version — used only
for fixing site breakage. It is not sold, not shared, and not used for any
unrelated purpose or to determine creditworthiness or for lending.*

**Privacy policy URL:** https://purpledirective.com/quell/privacy/
(LIVE since 2026-07-14 — trailing slash matters: the bare path 308-redirects,
the slash URL serves 200 directly. Verified serving the actual policy, not the
homepage. The v0.4.0 rejection — "Purple Nickel", User Data Privacy — was this
URL 200-serving the homepage via the CF Pages SPA fallback before the page and
a real 404.html existed.) **Publish the 2026-09-25 policy
(store/privacy-policy.md) to that URL before submitting 0.6.0** — the listing
now describes the breakage report and sync, and the live policy must match.

## Assets (store/assets/)

Regenerated 2026-09-25 from real renders of the 0.6.0 popup and welcome page
(`node store/make-assets.mjs`; captions are the only thing drawn on top, plus a
highlight ring placed from the rendered row's own box):

- `screenshot-1-1280x800.png` — "Hide the AI you didn't ask for." + the popup
  in its first-run state
- `screenshot-2-1280x800.png` — "Keep the answers you open." + close-up of the
  Search group, the People-also-ask row ringed
- `screenshot-3-1280x800.png` — "Quiet, on your terms." + the welcome page
  (Cookie banners / Pop-ups off until asked; access given back)
- `tile-small-440x280.png` — small promo tile
- `marquee-1400x560.png` — marquee promo tile (optional upload)
- Icon: `extension/icons/icon128.png` (uploaded from the zip automatically)

No before/after Google screenshot: every Google load in the 2026-09-25 live
run hit the `/sorry/` bot wall (see
`verification-2026-09-25/LIVE-VERIFICATION-2026-09-25.md`). make-assets.mjs
builds a fourth screenshot from any real before/after pair via
`QUELL_BEFORE` / `QUELL_AFTER` once a clean one exists.

## Submission runbook (one-time)

1. https://chrome.google.com/webstore/devconsole → sign in with the Purple
   Directive Google account → pay the one-time $5 developer registration fee.
2. "New item" → upload `dist/quell-<version>-chrome.zip`.
3. Paste the fields above (listing, privacy, single purpose, justifications).
4. Upload the 3 screenshots + small tile (+ marquee); set category Tools; visibility Public.
5. Submit for review. Expect a few days (the optional `<all_urls>` permission
   usually routes it to deeper review — the justifications above cover it).
6. After publish: the popup's "Rate Quell" link reads `RATE_URL_CHROME` in
   `extension/src/shared/config.js`.

---

# Firefox Add-ons (AMO)

Upload `dist/quell-<version>-firefox.zip` at
https://addons.mozilla.org/developers/ → Submit a New Add-on → "On this site".
Compatibility: Firefox 140+ desktop, Firefox for Android 142+.

**Name** (from the Firefox manifest, AMO caps names at 45 characters):
Quell — Block AI Overviews & Cookie Popups

**Add-on URL slug (suggested):** `quell-quiet-the-web`

**Summary** (≤250 chars):
Quiet the web. Hide AI answers on Google, Bing, DuckDuckGo, Brave and Yahoo —
never a real result — and block cookie banners and pop-ups. Free, open source,
no tracking.

**Description:** use the Chrome description above, with two edits:
- "your browser asks once" wording is already browser-neutral; keep it.
- Add after THIS SITE: "★ WORKS ON FIREFOX FOR ANDROID — the same switches,
  where AI Overviews are hardest to escape."

**Categories:** Privacy & Security; Search Tools
**Tags:** ai, google, bing, cookies, annoyances

**License:** MIT (Quell's code) — the generated filter rules are CC BY-SA 3.0
(EasyList); see NOTICE in the package.

**Privacy policy:** paste store/privacy-policy.md (AMO hosts its own copy) and
link https://purpledirective.com/quell/privacy/.

**Data collection (declared in the manifest as
`browser_specific_settings.gecko.data_collection_permissions`, shown by
Firefox at install and on the AMO listing):**
- `required: ["none"]` — Quell collects nothing to work.
- `optional: ["browsingActivity", "technicalAndInteraction"]` — the breakage
  report: the hostname of the site the user chooses to report
  (browsingActivity — AMO's counterpart of Chrome's "Web history") and
  Quell's version (technicalAndInteraction). Firefox asks the user the first
  time they send one; declining sends nothing.
- Use, for the listing's privacy notes and any reviewer question: only for
  fixing site breakage; not sold, not shared, not used for unrelated purposes
  or to determine creditworthiness — the same answer as the Chrome Web Store.

**Notes to reviewer:**
> One source tree for Chrome/Firefox; the Firefox manifest is derived by
> pipeline/make_manifest.py. No remote code, no minification, no build step
> for the JS — the zip is the source. rules/*.json and rules/*.css are
> generated from EasyList by pipeline/build_rules.py (source in the public
> repo). Optional host permissions: DuckDuckGo/Brave/Yahoo (engine switch)
> and <all_urls> (Cookie banners / Pop-ups switches). The only network request
> the extension makes is the user-initiated breakage report
> (POST https://purpledirective.com/api/quell/report, body
> {"host","version"}), gated on the optional data-collection permission.
> Test: search Google for "what is photosynthesis" — the AI Overview is
> hidden, the results are not.

**Screenshots:** reuse the Chrome set (re-shot for 0.6.0), 1280×800.

After AMO publishes the listing, set `RATE_URL_FIREFOX` in
`extension/src/shared/config.js` (it is `null` until then, which hides the
"Rate Quell" link on Firefox rather than pointing at a page that does not
exist).
