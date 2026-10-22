# Runtime rules delivery: what the stores say

Read 2026-10-01. Question: may Quell fetch rule DATA (declarativeNetRequest rules, hide selectors)
from github.com/PurpleDirective/quell at runtime, instead of shipping every rule update in a store release?

**Verdict: stop here. Nothing was built.** Chrome says yes in so many words. Edge pushes back on remote
declarativeNetRequest rules specifically. Firefox and Opera do not say either way, and Opera bans external
JavaScript outright. The task rule was: if any store is unclear, stop at the doc. Every quote below was read from
the live page on the date above (the pages are quoted as served; they can change).

| Store | Remote data / config | Remote declarativeNetRequest rules | Verdict |
|---|---|---|---|
| Chrome Web Store | Allowed, in words | Not named; the same rule covers them | Clear for data |
| Microsoft Edge Add-ons | Not named | Discouraged in words: "should not be imported remotely unless necessary" | Unclear to unfavourable |
| Firefox (AMO) | Not named; code is banned | Not named | Unclear |
| Opera add-ons | Not named; "External APIs are ok" | Not named | Unclear |

## Chrome Web Store: allowed for data

Manifest V3 requirements, https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements

> The extension may reference and load data and other information sources that are external to the extension, but these external resources must not contain any logic.

> Building an interpreter to run complex commands fetched from a remote source, even if those commands are fetched as data

(listed there as a common violation)

> Fetching a remote configuration file for A/B testing or determining enabled features, where all logic for the functionality is contained within the extension package

(listed as still allowed)

Extension docs, https://developer.chrome.com/docs/extensions/develop/migrate/improve-security

> In Manifest V3, all of your extension's logic must be part of the extension package. You can no longer load and execute remotely hosted files according to Chrome Web Store policy.

> Configuration-driven features and logic Your extension loads and caches a remote configuration (for example a JSON file) at runtime. The cached configuration determines which features are enabled.

Reading: a list of CSS selectors or declarativeNetRequest rule objects is data that Quell's own packaged code
applies. It is not a script, not eval, and not an interpreter. The one edge to watch is "must not contain any
logic": selectors and rule objects would have to stay plain declarative data, with no expressions, no
conditions Quell evaluates, and no commands.

## Microsoft Edge Add-ons: unclear, leaning no for rules

Publish guide, https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension

> Remote code is only supported for Manifest V2, not Manifest V3. In Manifest V3, loading and executing remotely hosted code is not permitted.

Developer policies, https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies (1.2)

> Any declarativeNetRequest rules must be clearly declared within the extension, and should not be imported remotely unless necessary for functionality.

Reading: this is the one store that names remote declarativeNetRequest rules, and it says not to unless
necessary. Quell works without it (the rules ship in the package), so "necessary for functionality" would be
hard to claim. The same page's 1.1.7 also bars obfuscated code "as well as any external code or resource fetched
from the web", so anything fetched has to stay readable.

## Firefox (AMO): unclear

Add-on Policies, https://extensionworkshop.com/documentation/publish/add-on-policies/ (section 4)

> Add-ons must be self-contained and not load remote code for execution.

(section 3)

> If external resources are used in combination with add-on code, the functionality of the code must not be obscured.

Build a secure extension, https://extensionworkshop.com/documentation/develop/build-a-secure-extension/

> If you identify a service that you wish to use in your extension, don't inject the service's script from a remote source.

Reading: remote code is banned; remote data is not mentioned by the policy. The only place anyone says JSON is
fine is a community forum thread (https://discourse.mozilla.org/t/is-it-allowed-to-load-json-data-from-remote-resource/61691),
which is a user's opinion, not policy. A reviewer could still treat a fetched selector list as "external
resources used in combination with add-on code". AMO also needs the source for anything generated; fetched files
would have to be reproducible from the public repository.

## Opera add-ons: unclear

Acceptance Criteria, https://help.opera.com/en/extensions/acceptance-criteria/

> No external JavaScript is allowed. All JavaScript code must be contained in the extension. External APIs are ok.

> The extension must not send private data to an external store, for example through XHR.

Reading: JavaScript must be in the package. "External APIs are ok" suggests a data fetch is fine, but nothing
says rule lists or selectors are data and not code. Opera's moderation is also slow and manual (0.6.0 has been in
review since 2026-09-26), so a guess that turns out wrong costs a rejection round.

## What it would take to ship this later

1. A written yes from Mozilla and Opera (and an answer from Microsoft on policy 1.2), through each store's
   reviewer-notes field or support channel on a real submission, not a forum thread. Chrome needs no ask.
2. Only then: dynamic declarativeNetRequest rules and runtime-fetched selectors from
   `raw.githubusercontent.com/PurpleDirective/quell/...`, with a SHA-256 manifest check, size limits, a fall back to
   the bundled rules on any failure, no other network request, and the privacy copy changed to "fetches only rule
   data from GitHub". That fetch sends the user's IP address to GitHub, so it is a new data flow: per the
   versioning rule it is a minor bump, and the Chrome and Edge data-usage answers and the privacy policy change first.
3. Until then, rules ship the way they do now: the weekly refresh, a release, a store upload.
