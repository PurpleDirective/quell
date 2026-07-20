# Quell — Chrome Web Store listing (v0.4.1)

Everything the Developer Dashboard asks for, in order. Upload `dist/quell-<version>.zip`
(build with `pipeline/package.sh`).

## Store listing

**Name** (from manifest): Quell — Block AI Overviews, Gemini & Cookie Popups

**Summary** (from manifest, ≤132 chars):
Quiet the web. Turn off AI Overviews, Gemini, Copilot and block cookie-consent
popups. Free, no account, no tracking, open source. By Purple Directive.

**Category:** Tools
**Language:** English

**Description:**

Quell removes the noise you didn't ask for.

★ GOOGLE — hide AI Overviews and AI Mode, or switch to Clean Web mode for
Google's classic link results (zero AI, never breaks). Works on all 190 Google
country domains.

★ BING — hides the Copilot sidebar and its entry points.

★ COOKIE BANNERS (beta, opt-in) — blocks the major consent platforms at the
network layer and hides banners using the full EasyList Cookie List (~15,000
generic rules + domain-specific rules for ~16,000 sites), rebuilt weekly by
an automated pipeline and shipped with each extension update. A per-site
pause switch gives you an instant escape hatch if any site misbehaves.

WHY QUELL?
• Free forever. No account, no paywall, no "pro" upsell on the blocking core.
• Collects NOTHING. No analytics, no telemetry, no remote servers. Settings
  live only on your device.
• Honest. Quell doesn't claim to "delete your data from AI servers" — no
  browser tool can. It quiets what you see, on your device.
• Open source (MIT).
• The all-sites permission is OPTIONAL — requested only if you turn on cookie
  blocking. Leave it off and Quell never touches a page outside Google/Bing
  search.

For ads, use uBlock Origin — it's the better tool for that job. Quell focuses
on what it does best: AI features and consent nags.

## Privacy tab

**Single purpose:**
Quell removes unwanted forced content surfaces from web pages — AI feature
blocks on search engines and cookie-consent pop-ups — entirely locally.

**Permission justifications:**
- `storage` — saves the user's on/off settings and the blocked-elements counter
  locally. Nothing leaves the device.
- `declarativeNetRequest` — blocks known cookie-consent-platform scripts by
  URL rule, without Quell ever reading the user's traffic.
- `scripting` — registers/unregisters the cookie-banner hiding content script
  when the user toggles that feature.
- Host permissions (google.* / bing.com content scripts) — inject the CSS/JS
  that hides AI feature blocks on search result pages only.
- `<all_urls>` (OPTIONAL) — requested at runtime only when the user enables
  Cookie banners; needed to hide consent banners on the sites they visit.

**Data usage:** Quell does not collect, transmit, sell, or share ANY user data.
All state is chrome.storage.local on the user's machine.

**Privacy policy URL:** https://purpledirective.com/quell/privacy/
(LIVE since 2026-07-14 — trailing slash matters: the bare path 308-redirects,
the slash URL serves 200 directly. Verified serving the actual policy, not the
homepage. The v0.4.0 rejection — "Purple Nickel", User Data Privacy — was this
URL 200-serving the homepage via the CF Pages SPA fallback before the page and
a real 404.html existed.)

## Assets (store/assets/)

- `screenshot-1-1280x800.png` — popup on brand background (AI features)
- `screenshot-2-1280x800.png` — counter + cookie feature view
- `tile-small-440x280.png` — small promo tile
- Icon: `extension/icons/icon128.png` (uploaded from the zip automatically)

## Submission runbook (one-time)

1. https://chrome.google.com/webstore/devconsole → sign in with the Purple
   Directive Google account → pay the one-time $5 developer registration fee.
2. "New item" → upload `dist/quell-<version>.zip`.
3. Paste the fields above (listing, privacy, single purpose, justifications).
4. Upload the 2 screenshots + small tile; set category Tools; visibility Public.
5. Submit for review. Expect a few days (the optional `<all_urls>` permission
   usually routes it to deeper review — the justifications above cover it).
6. After publish: put the real listing URL into the popup's "Rate Quell" link
   (`extension/src/popup/popup.html`, id="rate") and bump a patch release.
