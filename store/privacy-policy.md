# Quell Privacy Policy

**Effective date:** 2026-09-25

Quell is a browser extension by Purple Directive that hides content you did
not ask for — AI answers on search engines, cookie-consent banners and, if you
switch it on, newsletter pop-ups, chat widgets and "open in app" banners. It
does this in your browser. This policy covers Quell for Chrome and the browsers that install from the Chrome Web Store, and for Firefox (desktop and Android).

## What Quell sends to Purple Directive

**Nothing, unless you press "This site looks broken" and then "Send report".**

That report contains exactly two things, and Quell shows them to you before
anything is sent:

- the **domain** of the site you are on (for example `shop.example.com`) —
  not the page address, not the path or search terms, not any page content;
- the **Quell version** (for example `0.6.0`).

No identifier, account, cookie or browsing history is attached. Like any web
request, the report reaches our server from your IP address; the server does
not log or store IP addresses. To limit how often reports can be sent, it
turns the address into a one-way, salted hash and uses that hash as the key of
a rate-limit counter that covers 60 seconds (five reports per minute); it keeps
nothing else about the request. What it stores is a count per domain, per Quell
version, per day. Those counts are deleted after 180 days. We use them only to
find and fix sites Quell breaks.

On Firefox, the browser itself also asks your permission the first time you
send a report.

Quell has no analytics, no telemetry and no accounts, and it never sends your
browsing anywhere else.

**How the stores list this.** Because a reported domain is a piece of your
browsing, Quell's store listings declare it: on the Chrome Web Store as *web history* (limited to the domain you choose to
report), on Firefox Add-ons as optional *browsing activity* plus *technical
data* (the version number). It is used only to fix site breakage. It is never
sold, never shared, and never used for anything unrelated to Quell or to
determine creditworthiness or for lending.

## Where your settings are kept

- **Your choices** (which features are on or off, sites where you have paused
  Quell) are saved in your browser's extension **sync** storage. If you are
  signed in to your browser (for example a Google account in Chrome or a Mozilla account in Firefox) and sync is on, **your browser** copies
  those settings to your own account so your other computers get them. That
  sync is run by your browser's maker under their privacy terms; Purple
  Directive never receives it and cannot read it. If you are not signed in, or
  sync is off, the settings stay on this device. Firefox for Android does not sync extension settings, so there
  they always stay on the device.
- **Three switches stay on each device** and are never synced: other search
  engines, cookie banners and pop-ups. They need site access that your
  browser grants on each device separately.
- A running **count of hidden items** stays on this device.

All of it is removed when you uninstall Quell (synced copies are removed by
your browser's sync).

## What Quell can access

- **Google and Bing search result pages**, to hide AI features there. This is
  the only site access Quell is installed with. (Firefox may ask you to allow
  it.)
- **DuckDuckGo, Brave Search and Yahoo Search** — only if you switch them on,
  which asks your browser for access to those three sites and nothing else. On
  DuckDuckGo and Brave you may instead choose "off at the source", which adds
  that engine's own "no AI answer" setting to the search address you are
  already loading; that request goes to the search engine, as your search
  already did. Quell only adds that setting when it is absent — a value you set
  yourself is never overwritten.
- **All sites** — only if you switch on Cookie banners or Pop-ups. Quell then
  runs on the pages you visit to hide those elements. When you switch both of
  them off, Quell gives this access back to your browser; switching either one
  on again asks for it again. It looks at a page only
  to decide what to hide — for example, never hiding the page's own article, a
  sign-in or checkout form, or your cart — does that on your device, keeps
  nothing and sends nothing from those pages.
- If you additionally switch on **"Say reject all for me"** (off by default),
  Quell clicks the *Reject all* button of consent banners it recognises. It
  checks that consent tool's own saved-choice cookie first, on your device, so
  a choice you have already made is left alone. For the consent tool to record
  your refusal it has to load, so with this switch on Quell no longer blocks
  the consent tools it can answer for you (OneTrust, Cookiebot, Didomi, Osano);
  they load from their providers as the site intended. Quell sends them
  nothing itself. It only ever presses controls
  belonging to a recognised consent tool, never a site's own buttons.

## Network activity

Apart from a breakage report you choose to send, Quell makes no network
requests of its own. Its blocklists ship inside the extension and are updated
through normal extension updates.

## Changes & contact

Material changes to this policy will be reflected in the extension's changelog
and this page. Questions: support@purpledirective.com
