# Quell — store listings (v0.7.4)

Build with `pipeline/package.sh`:

| Store | Upload |
|---|---|
| Chrome Web Store | `dist/quell-<version>-chrome.zip` |
| Firefox Add-ons (AMO) | `dist/quell-<version>-firefox.zip` |
| Microsoft Edge Add-ons | **DROPPED 2026-10-02.** No Edge package is built or uploaded. |

---

# Chrome Web Store

Everything the Developer Dashboard asks for, in order.

## Store listing

**Name** (from manifest, 41 characters): Hide AI Overviews & Cookie Popups — Quell

**Summary** (from manifest, ≤132 chars):
Hide Google AI Overviews, AI Mode and Bing Copilot and keep every real result. Blocks cookie banners and pop-ups too. Free.

**Category:** Tools
**Language:** English

**Description:**

Hide Google's AI Overview and keep the results you came for.

Quell removes the AI answers search engines put above your results, and can quiet the cookie banners and pop-ups that cover the page. It never hides a real search result, and every release is tested against that.

WHAT IT DOES
• Google: hides AI Overviews, AI Mode and Gemini buttons, with a switch for each. Or choose Classic results, Google's own plain list of links with no AI at all.
• Bing: hides the Copilot panel, its buttons and its suggestions, with one switch.
• DuckDuckGo, Brave and Yahoo: hides their AI answers too. Off until you switch it on; your browser then asks once for access to those three sites and nothing else.
• Cookie banners: hides "we use cookies" notices. Off until you switch it on. Optionally says "reject all" for you on the consent tools Quell recognises. That is a separate switch, off by default, and Quell never overrides a choice you already made.
• Pop-ups: newsletter sign-up boxes, chat bubbles, "open in app" banners, and the "sign up or log in to keep reading" boxes that cover a page whose text is already there, each with its own switch. Off until you switch it on. It hides them and lets the page scroll again; it never blocks a page, never gets around a paywall, and never touches the sign-in button a site gives you or a login you opened yourself.
• Links: takes tracking codes (utm_, fbclid, gclid and the like) off links, and sends a Google or Bing result straight to its site. On once you have allowed all-sites access on a new install; if you update from an earlier version it stays off until you turn it on from a one-time card in the popup. Affiliate codes are never touched. A separate switch, off by default, warns you if a shopping page swaps its affiliate code; it only warns, and your browser asks once for one more permission when you turn it on.

Cookie banners, pop-ups and links need your browser's all-sites access. Quell asks once, only when you turn one on, and gives it back when you turn all of them off.

AI ON OTHER WEBSITES
Quell can also hide "Ask AI" buttons and panels on sites such as docs and shops, and stop AI chat widgets from loading. Off after an update until you turn it on. Four switches: AI buttons and panels, AI chat assistants, support chats that use AI (off by default, because it can remove a site's support chat), and AI session recording (off by default). Hiding buttons and panels needs your browser's all-sites access, asked once; stopping chat scripts needs none. Pause it for a site any time.
Covered today: YouTube (Ask buttons, AI summaries, Ask questions), Amazon (Rufus / Alexa for shopping, AI highlights and review summaries), X (Grok buttons and drawer, Today's News), Airbnb (the AI search bar), many documentation and shopping sites, and the chat launchers of many AI chat services. Not covered: Quora. Reddit's AI features did not appear for our test account, so we do not claim them.
What it does not do: AI crawlers work on servers and AI built into your browser is out of reach, and features that only some accounts or regions see may be missed.

SEE WHAT IT HID
Open Quell on any page to see what it hid there. Peek at an item, or bring it back with Undo. If a site looks wrong, pause Quell on it for an hour, for today, or until you resume. You can also send a "this site looks broken" report from the same place.

ANSWERS YOU ASK FOR STAY
Google builds "People also ask" answers with the same AI as the Overview. Most blockers hide both. Quell hides the Overview you didn't ask for and keeps the answers you open. Turn that off too if you prefer.

PRIVATE BY DESIGN
Your settings stay in your browser and sync through your own browser account, never to us. On first run Quell asks whether it may send anonymous usage counts: which features are used and how many items were hidden. They never include the pages you visit, your searches or your browsing history, and you can turn them off at any time. When you remove Quell, your browser opens a short page on our site asking why. A "this site looks broken" report is sent only when you press Send, after showing you exactly what goes.

FREE AND OPEN SOURCE
No account, no ads, no paid tier on the blocking. MIT licensed, with the code on GitHub. Works in Chrome and other Chromium browsers.

What it is not: Quell does not block ads (uBlock Origin does that well), and it cannot delete anything from AI companies' servers. It quiets what you see, in your browser.

## Privacy tab

**Single purpose:**
Quell removes unwanted content from web pages — AI features in search engines and on websites, cookie banners, sign-up prompts and pop-ups — and removes tracking codes from links, in the user's browser.

**Permission justifications:**
- `storage` — saves the user's settings (in `storage.sync`, so the browser can
  sync them to the user's own browser account) and, locally, the per-device
  feature switches, the hidden-items counter, your usage-counts answer and,
  only if you said yes, the queued counts. Settings are never sent to us.
- `declarativeNetRequest` — blocks known cookie-consent-platform scripts by
  URL rule, without Quell ever reading the user's traffic; and, for the Links
  switch, a fixed set of redirect rules that take known tracking parameters
  (utm_*, fbclid, gclid and similar) out of a page address.
- `webNavigation` (OPTIONAL) — requested only when the user turns on "Warn me
  if a site swaps an affiliate code", and given back when they turn it off. It
  lets Quell see, on Amazon pages only, whether a page was reached by a
  redirect and whether its tag= code changed, to show a notice in the page.
  Nothing is stored beyond the tab's life and nothing is sent.
- `scripting` — registers and unregisters content scripts at runtime as the user
  turns optional features on and off: the cookie-banner and pop-up scripts
  (with `<all_urls>`) and the AI-hiding script for DuckDuckGo, Brave and Yahoo
  (with those three optional host permissions). It is also used to inject those
  same scripts into tabs the user already has open at the moment they switch a
  feature on, so the change applies without a reload. Nothing is injected or
  registered until the matching permission has been granted.
- `declarativeNetRequestFeedback` — lets Quell's popup read, for the open tab
  only, how many AI scripts its own block rules stopped (`getMatchedRules`),
  so it can say "Blocked 2 AI scripts". It carries no page content and the
  count is not sent anywhere.
- Host permissions (google.* / bing.com content scripts) — inject the CSS/JS
  that hides AI feature blocks on search result pages only. These are the ONLY
  hosts Quell is installed with.
- `*://duckduckgo.com/*`, `*://*.duckduckgo.com/*`, `*://search.brave.com/*`,
  `*://search.yahoo.com/*`, `*://*.search.yahoo.com/*` (OPTIONAL) — requested at
  runtime only when the user switches on the DuckDuckGo / Brave / Yahoo engines;
  same job as the Google and Bing host permissions. Optional so that existing
  users are not disabled on update.
- `<all_urls>` (OPTIONAL) — requested at runtime only when the user enables
  Cookie banners, Pop-ups, Links (on by default once access exists on a new install; off after an update until turned on), or the
  page-level part of AI on websites (hiding AI buttons and chat launchers from
  rules shipped inside the extension), and **given back** (`permissions.remove`)
  as soon as none of them is in use — Quell does not keep all-sites access it is
  not using. Used to hide those elements on the sites the user visits; to read
  the active tab's hostname so the popup can offer the per-site switches; to
  clean tracking parameters out of links on the page and show the affiliate
  notice (nothing is sent); and
  the breakage report; and, if the user additionally switches on "Say reject
  all for me" (off by default), to click the consent platform's own Reject-all
  control.
- No new permission is needed for the breakage report or the usage counts:
  both are plain CORS requests to purpledirective.com. The daily send is
  attempted when the worker starts and on the first count of a new day, so
  the `alarms` permission is not requested.
- Uninstall survey: `runtime.setUninstallURL` (no permission) opens
  https://purpledirective.com/quell/goodbye?v=<version>&b=<browser> when Quell
  is removed; `&i=<install id>` is added only while usage counts are on.

**Data usage — the dashboard's answers for 0.7.4:**

*What user data do you plan to collect from users now or in the future?*
Tick **Web history** (the breakage report) and **User activity** (the usage
counts, asked once on first run, ticked by default) — and nothing else.

> User activity: only after the user ticks the first-run box (ticked by
> default; nothing is sent until they answer). Per UTC day: counts of popup
> actions and of items hidden per feature, which Quell switches are on, the
> Quell version and browser, a random install id, and error text with web
> addresses removed. No page address, domain, search term, page content or
> browsing history. At most one request a day. Used only to see which
> features are used and to fix errors. The user can turn it off at any time,
> which stops sending and deletes the queue and id.

> Web history: only the hostname of a site the user chooses to report with
> "This site looks broken" (for example `shop.example.com`), sent with the
> Quell version number, and only when the user presses *Send report* after
> seeing exactly what will be sent. No page address, path, query, page
> content, identifier or cookie is sent. Used only to find and fix sites
> Quell breaks.

Leave every other category unticked — Quell collects none of them:
personally identifiable information, health information, financial and
payment information, authentication information, personal communications,
location, website content.

*Certifications* — tick all three:
- I do not sell or transfer user data to third parties, outside of the
  approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my
  item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for
  lending purposes.

The same answer, in words, for any free-text field: *Quell collects nothing
to work. It sends data in three cases only: a report the user chooses to send
(the hostname of the site they report, and Quell's version); the uninstall
page the browser opens on removal (Quell version and browser, plus the
install id only if usage counts were on); and anonymous
daily usage counts if the user answers yes on the first-run card (feature
counts, switch states, version, browser, a random install id, scrubbed error
text; never a page address, domain, search term or page content). Used only
to fix site breakage and to see which features are used. Not sold, not
shared, not used for any unrelated purpose or to determine creditworthiness
or for lending. The use of information received from Google APIs will adhere
to the Chrome Web Store User Data Policy, including the Limited Use
requirements.*

**Privacy policy URL:** https://purpledirective.com/quell/privacy/
(LIVE since 2026-07-14 — trailing slash matters: the bare path 308-redirects,
the slash URL serves 200 directly. Verified serving the actual policy, not the
homepage. The v0.4.0 rejection — "Purple Nickel", User Data Privacy — was this
URL 200-serving the homepage via the CF Pages SPA fallback before the page and
a real 404.html existed.) **Publish the current policy (v3.1.0,
effective 2026-11-06; store/privacy-policy.md) to that URL before submitting 0.7.3** — the listing
now describes the usage counts and the uninstall page, and the live policy must match.

## Assets (store/assets/)

Regenerated for 0.7.3 and re-run for 0.7.4 (new icon) from real renders (`node store/make-assets.mjs`): the popup
and welcome page are screenshotted from the loaded extension, and the lead image
loads the local fixture `tests/fixtures/google-results.html` once with Quell off
and once with it on. Captions, labels and framing are the only things drawn.

- `screenshot-1-1280x800.png` — "Hide the AI answer. Keep the results." the
  same results page without and with Quell, and the popup ("Hid 2 things on this page.")
- `screenshot-2-1280x800.png` — "See what Quell hid. Bring it back in one click."
  the popup with Peek and Undo, and the paused-on-this-site state
- `screenshot-3-1280x800.png` — "Cookie banners and pop-ups, quietly gone."
  the welcome page: the three features and the one-time ask
- `tile-small-440x280.png` — small promo tile
- `marquee-1400x560.png` — marquee promo tile (optional upload)
- Icon: `extension/icons/icon128.png` (uploaded from the zip automatically)

## Submission runbook (one-time)

1. https://chrome.google.com/webstore/devconsole → sign in with the publisher
   account → pay the one-time developer registration fee.
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

**Name** (from the Firefox manifest; the same name as Chrome, 41 characters, under AMO's 45):
Hide AI Overviews & Cookie Popups — Quell

**Add-on URL slug (suggested):** `quell-quiet-the-web`

**Summary** (≤250 chars):
Hide Google AI Overviews, AI Mode and Bing Copilot, plus AI answers on DuckDuckGo, Brave and Yahoo, and keep every real result. Quiets cookie banners and pop-ups too. Free and open source.

**Description:** the Chrome description above, with these edits:
- Last line of "FREE AND OPEN SOURCE": replace "Works in Chrome and other Chromium browsers." with "Works on Firefox for desktop and Android."
- DuckDuckGo, Brave and Yahoo, and the cookie banners and pop-ups paragraph: "your browser then asks once" / "Quell asks once" becomes "Firefox asks once, on a Quell settings tab" (a Firefox popup cannot hold a permission prompt, so Quell opens a tab).
- PRIVATE BY DESIGN: after "never to us." add "Firefox for Android keeps them on the device." On Firefox the usage-counts choice is Firefox's own data-collection prompt, and Quell sends counts only while you have allowed it.
- AI ON OTHER WEBSITES: "your browser asks once" becomes "Firefox asks once, on a Quell settings tab".
- Add after SEE WHAT IT HID: "WORKS ON FIREFOX FOR ANDROID: the same switches, where AI Overviews are hardest to escape."

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
  Quell's version (technicalAndInteraction); and the daily usage counts, asked once on first run
  (technicalAndInteraction): feature counts, switch states, version, browser,
  random install id, scrubbed error text. Quell sends the counts only while
  `browser.permissions.contains({data_collection: ["technicalAndInteraction"]})`
  is true. Firefox asks the user; declining sends nothing.
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
> the extension makes are the user-initiated breakage report
> (POST https://purpledirective.com/api/quell/report, body
> {"host","version"}) and, only after the user answers yes on the first-run
> card AND the optional technicalAndInteraction permission is granted, one
> anonymous usage-counts POST a day (https://purpledirective.com/api/quell/events;
> payload documented in src/shared/analytics.js). Both are gated on the optional
> data-collection permission.
> Test: search Google for "what is photosynthesis" — the AI Overview is
> hidden, the results are not.

**Screenshots:** reuse the Chrome set (re-shot for 0.6.0), 1280×800.

`RATE_URL_FIREFOX` in `extension/src/shared/config.js` points at the AMO
listing (public since 0.7.0; set in 0.7.1). If the listing's address ever
changes, change it there. A `null` hides the "Rate Quell" link on Firefox
rather than pointing at a page that does not exist — the Opera entry is still
`null` for that reason.
