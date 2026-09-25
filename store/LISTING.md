# Quell — Chrome Web Store listing (v0.5.0)

Everything the Developer Dashboard asks for, in order. Upload `dist/quell-<version>.zip`
(build with `pipeline/package.sh`).

## Store listing

**Name** (from manifest): Quell — Block AI Overviews, Gemini & Cookie Popups

**Summary** (from manifest, ≤132 chars):
Quiet the web. Turn off AI answers on Google, Bing, DuckDuckGo, Brave & Yahoo,
and block cookie pop-ups. Free, private, open source.

**Category:** Tools
**Language:** English

**Description:**

Quell removes the noise you didn't ask for.

★ GOOGLE — hide AI Overviews and AI Mode, or switch to Clean Web mode for
Google's classic link results (zero AI, and it doesn't rely on page markup).
Works on all 190 Google
country domains. Separate switches per surface, so you decide what goes.

★ ANSWERS YOU CLICKED STAY — Google builds "People also ask" answers with the
same AI as the Overview above your results. Most blockers hide both. Quell
tells them apart: the overview you didn't ask for goes, the answer you clicked
open stays. Turn that off too if you'd rather.

★ BING — hides the Copilot sidebar and its entry points. The suggestion chips
carry real search queries, so those get their own switch and stay by default.

★ DUCKDUCKGO, BRAVE & YAHOO (opt-in) — switch these on and Chrome asks once
for access to those three sites; nothing else. Quell then hides their AI
answers, or — on DuckDuckGo and Brave — uses the engines' OWN setting for
turning AI off, which doesn't depend on their page markup staying the same. If
you've already set that switch yourself, Quell leaves your choice alone. Yahoo
publishes no such setting, so Quell hides its AI Summary instead — and doesn't
pretend otherwise.

★ COOKIE BANNERS (beta, opt-in) — blocks the major consent platforms at the
network layer and hides banners using the full EasyList Cookie List (~15,000
generic rules + domain-specific rules for ~16,000 sites), rebuilt weekly by
an automated pipeline and shipped with each extension update. A per-site
pause switch gives you an instant escape hatch if any site misbehaves.

WHY QUELL?
• Free forever. No account, no paywall, no "pro" upsell on the blocking core.
• Collects NOTHING. No analytics, no telemetry, no remote servers. Settings
  live only on your device.
• Cookie banners can be REJECTED, not just hidden — optional, off by default,
  because rejecting makes a choice on your behalf and that should be yours.
• Honest. Quell doesn't claim to "delete your data from AI servers" — no
  browser tool can. It quiets what you see, on your device.
• Open source (MIT).
• Quell ships with access to Google and Bing search only. DuckDuckGo, Brave and
  Yahoo are asked for one click at a time, and the all-sites permission is
  requested only if you turn on cookie blocking. Grant nothing and Quell never
  touches a page outside Google and Bing search. Revoke any of it whenever you
  like, from Chrome's own extensions page.

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
- `scripting` — registers and unregisters content scripts at runtime as the user
  turns optional features on and off: the cookie-banner script (with
  `<all_urls>`) and the AI-hiding script for DuckDuckGo, Brave and Yahoo (with
  those three optional host permissions). It is also used to inject those same
  scripts into tabs the user already has open at the moment they switch a
  feature on, so the change applies without making them reload. Nothing is
  injected or registered until the matching permission has been granted.
- Host permissions (google.* / bing.com content scripts) — inject the CSS/JS
  that hides AI feature blocks on search result pages only. These are the ONLY
  hosts Quell is installed with.
- `*://duckduckgo.com/*`, `*://*.duckduckgo.com/*`, `*://search.brave.com/*`,
  `*://search.yahoo.com/*`, `*://*.search.yahoo.com/*` (OPTIONAL) — requested at
  runtime only when the user switches on the DuckDuckGo / Brave / Yahoo engines;
  they do the same job as the Google and Bing host permissions above, hiding AI
  feature blocks on those engines' search result pages. They are optional rather
  than required so that existing users are not disabled on update.
- `<all_urls>` (OPTIONAL) — requested at runtime only when the user enables
  Cookie banners. It is used to hide consent banners on the sites the user
  visits; to read the active tab's hostname so the popup can offer "Pause on
  this site"; and, if the user additionally switches on the separate
  "Reject instead of hide" option (off by default), to click the consent
  platform's own Reject-all control. Nothing is read from the page or
  transmitted anywhere.

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
