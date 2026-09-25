# Quell Privacy Policy

**Effective date:** 2026-09-10

Quell is a browser extension by Purple Directive that hides unwanted content
(AI feature blocks, cookie-consent pop-ups) locally in your browser.

## What Quell collects

**Nothing.** Quell has no analytics, no telemetry, no accounts, and no servers.

## What Quell stores

Your settings (which features are on/off, sites where you've paused blocking)
and a running count of blocked elements are stored in your browser's local
extension storage (`chrome.storage.local`) on your device. This data never
leaves your machine and is deleted when you uninstall the extension.

## What Quell can access

- Google and Bing search result pages, to hide AI feature blocks there. This is
  the only site access Quell is installed with.
- If — and only if — you enable the optional DuckDuckGo / Brave / Yahoo engines,
  Quell can run on those three search sites and nowhere else, to hide AI feature
  blocks there. On DuckDuckGo and Brave you may instead choose "off at the
  source", which adds those engines' own "no AI answer" parameter to the search
  URL you are already loading — that request goes to the search engine, as your
  search already did, and nowhere else. Quell only adds that parameter when it is
  absent; a value you set yourself is never overwritten.
- If — and only if — you enable the optional Cookie banners feature, Quell can
  run on the pages you visit to hide consent banners. It reads nothing and
  sends nothing; the access exists solely to inject hiding rules.
- If — and only if — you additionally enable "Reject instead of hide" (off by
  default), Quell will click the *Reject all* button on consent banners it
  recognises. This is the one place Quell acts on a page rather than only
  hiding part of it, which is why it is a separate opt-in switch. It only ever
  activates controls belonging to a recognised consent platform, never a
  site's own buttons.

## Network activity

The published extension makes no network requests. Blocklists ship inside the
extension package and are updated through normal extension updates.

## Changes & contact

Material changes to this policy will be reflected in the extension's changelog
and this page. Questions: support@purpledirective.com
