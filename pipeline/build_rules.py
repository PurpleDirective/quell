#!/usr/bin/env python3
"""Quell — EasyList Cookie → extension rules pipeline (Phase 2).

Fetches the EasyList Cookie List (CC BY-SA 3.0, see /NOTICE) and emits:

  extension/rules/cookie-cmp-easylist.json  — declarativeNetRequest block rules
      (generated ruleset; the hand-curated cookie-cmp.json stays as-is)
  extension/rules/cookie-generic.css        — generic hide selectors as a CSS
      file registered with the cookies content script; Chrome injects it
      natively (no per-page message passing or string building). Selectors are
      chunked so one upstream-invalid selector can't void the whole sheet.
  extension/rules/cookie-domains.json       — domain-specific selectors
      {"example.com": [...]}; the background serves each page ONLY its own
      host's slice (no web_accessible_resources — keeps the extension
      un-fingerprintable, and messages stay tiny).

Deliberately CONSERVATIVE: only filter syntax we can translate with full
confidence is converted; everything else is dropped AND COUNTED. Run with
no args; prints a stats table and fails loudly on suspiciously small output.
"""

import json
import re
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

# EasyList Cookie List is published as "Fanboy Cookie Monster"; the uBO CDN
# mirror serves the same list and acts as fallback.
LIST_URLS = [
    "https://secure.fanboy.co.nz/fanboy-cookiemonster.txt",
    "https://ublockorigin.github.io/uAssetsCDN/thirdparties/easylist-cookies.txt",
]
ROOT = Path(__file__).resolve().parent.parent
RULES_DIR = ROOT / "extension" / "rules"

# ABP option → dNR resourceType (only ones we translate; unknown option = drop)
TYPE_MAP = {
    "script": "script",
    "subdocument": "sub_frame",
    "xmlhttprequest": "xmlhttprequest",
    "image": "image",
    "stylesheet": "stylesheet",
    "ping": "ping",
    "websocket": "websocket",
}
DEFAULT_TYPES = ["script", "xmlhttprequest", "sub_frame", "stylesheet", "image"]

# Extended/procedural cosmetic syntax we cannot express as plain CSS.
EXTENDED_TOKENS = (":-abp-", "[-ext-", ":has(", ":has-text(", ":xpath(",
                   ":style(", ":remove(", ":upward(", ":matches-", "+js(")
# Conservative selector charset — anything outside is dropped (one bad selector
# can invalidate a whole CSS rule chunk).
SELECTOR_OK = re.compile(r"^[A-Za-z0-9\s#.\[\]=^$*|~:,'\"()>+_-]+$")
HOST_OK = re.compile(r"^[a-z0-9.-]+$")


def parse(lines):
    net_rules, generic, per_domain = [], [], defaultdict(list)
    generic_excl = set()
    stats = defaultdict(int)

    for raw in lines:
        line = raw.strip()
        if not line or line.startswith(("!", "[")):
            stats["comment/blank"] += 1
            continue

        # --- cosmetic exceptions: strip the selector from the generic set.
        # Domain-scoped exceptions are applied GLOBALLY on purpose — the
        # conservative direction (hide less → break less).
        if "#@#" in line:
            generic_excl.add(line.split("#@#", 1)[1].strip())
            stats["cosmetic-exception"] += 1
            continue

        # --- extended cosmetic / scriptlets: not expressible as plain CSS
        if "#?#" in line or "#$#" in line or any(t in line for t in EXTENDED_TOKENS):
            stats["dropped-extended"] += 1
            continue

        # --- element hiding
        if "##" in line:
            domains_part, selector = line.split("##", 1)
            selector = selector.strip()
            if not selector or not SELECTOR_OK.match(selector):
                stats["dropped-selector-charset"] += 1
                continue
            if not domains_part:
                generic.append(selector)
                stats["generic-selector"] += 1
            else:
                domains = domains_part.split(",")
                if any(d.startswith("~") for d in domains):
                    stats["dropped-negated-domain"] += 1
                    continue
                for d in domains:
                    d = d.strip().lower()
                    if HOST_OK.match(d):
                        per_domain[d].append(selector)
                stats["domain-selector"] += 1
            continue

        # --- network exceptions: dNR "allow" translation is riskier; drop+count
        if line.startswith("@@"):
            stats["dropped-network-exception"] += 1
            continue

        # --- network filters: ONLY pure host anchors  ||host^[$options]
        if line.startswith("||"):
            body, _, opts = line[2:].partition("$")
            if not body.endswith("^") or "/" in body or "*" in body:
                stats["dropped-network-shape"] += 1
                continue
            host = body[:-1].lower()
            if not HOST_OK.match(host):
                stats["dropped-network-shape"] += 1
                continue

            types, third_party, bad = [], False, False
            if opts:
                for o in opts.split(","):
                    o = o.strip()
                    if o in TYPE_MAP:
                        types.append(TYPE_MAP[o])
                    elif o == "third-party":
                        third_party = True
                    else:  # domain=, popup, document, important, ~type, …
                        bad = True
                        break
            if bad:
                stats["dropped-network-option"] += 1
                continue

            cond = {"urlFilter": f"||{host}^",
                    "resourceTypes": sorted(set(types)) or DEFAULT_TYPES}
            if third_party:
                cond["domainType"] = "thirdParty"
            net_rules.append(cond)
            stats["network-rule"] += 1
            continue

        stats["dropped-other"] += 1

    generic = sorted(set(generic) - generic_excl)
    # dedupe identical network conditions
    seen, deduped = set(), []
    for c in net_rules:
        key = json.dumps(c, sort_keys=True)
        if key not in seen:
            seen.add(key)
            deduped.append(c)
    return deduped, generic, dict(per_domain), stats


def main():
    text = None
    for url in LIST_URLS:
        print(f"fetching {url}")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Quell-rules-pipeline/1.0"})
            with urllib.request.urlopen(req, timeout=60) as r:
                text = r.read().decode("utf-8", "replace")
            break
        except Exception as e:
            print(f"  failed: {e}")
    if text is None:
        sys.exit("FATAL: no list source reachable")

    net, generic, domains, stats = parse(text.splitlines())

    for k in sorted(stats):
        print(f"  {k:32s} {stats[k]}")
    print(f"  => network rules: {len(net)}  generic selectors: {len(generic)}  domain entries: {len(domains)}")

    # Loud sanity floor — a format change upstream must fail the pipeline,
    # not silently ship an empty ruleset.
    if len(net) < 50 or len(generic) < 1000:
        sys.exit("FATAL: output suspiciously small — upstream format change? Not writing.")
    if len(net) > 25000:
        sys.exit("FATAL: network rules exceed safe static-rule budget (30k shared).")

    rules = [{"id": i + 1, "priority": 1, "action": {"type": "block"}, "condition": c}
             for i, c in enumerate(net)]
    (RULES_DIR / "cookie-cmp-easylist.json").write_text(
        json.dumps(rules, separators=(",", ":")) + "\n")

    # Chunk generic selectors (200/rule) so one bad selector only voids its chunk.
    CHUNK = 200
    css_rules = [
        ",".join(generic[i:i + CHUNK]) + "{display:none!important;}"
        for i in range(0, len(generic), CHUNK)
    ]
    (RULES_DIR / "cookie-generic.css").write_text(
        "/* GENERATED by pipeline/build_rules.py from EasyList Cookie List"
        " (CC BY-SA 3.0 — see /NOTICE). Do not edit by hand. */\n"
        + "\n".join(css_rules) + "\n")

    (RULES_DIR / "cookie-domains.json").write_text(
        json.dumps(domains, separators=(",", ":")) + "\n")

    for f in ("cookie-cmp-easylist.json", "cookie-generic.css", "cookie-domains.json"):
        kb = (RULES_DIR / f).stat().st_size // 1024
        print(f"  wrote extension/rules/{f} ({kb} KB)")


if __name__ == "__main__":
    main()
