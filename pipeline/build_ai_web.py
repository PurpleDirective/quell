#!/usr/bin/env python3
"""Quell — "AI on websites" rules, generated from pipeline/sources/ai-web.json.

Never hand-edit the outputs; change the source file and re-run
    python3 pipeline/build_ai_web.py

Outputs (extension/rules/):
  ai-web-chat.json      declarativeNetRequest block rules for AI chat assistants
                        (vendors whose product is the AI agent itself)
  ai-web-support.json   the same for support-chat vendors that sell AI agents
                        (opt-in: blocking one can remove a site's support chat)
  ai-web-replay.json    session-recording / replay vendors (opt-in)
  ai-web-cosmetic.json  the page-level hide rules: {"rules": [{id, g, h, sel, what}]}
                        g = buttons | chat | support, h = hosts ("*" = any site),
                        sel = selectors to hide (the "hide" field of the source
                        already names the container, so no empty box is left)

Safety rules enforced here (and by pipeline/test_build_rules.py):
  * shared hosts are never blocked (CDNs, search APIs);
  * every block rule excludes the vendor's own sites as initiators;
  * only domains, no paths: a rule blocks a vendor's hosts, nothing else.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "pipeline" / "sources" / "ai-web.json"
OUT = ROOT / "extension" / "rules"

NEVER_BLOCK = {"cdn.jsdelivr.net", "jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "algolia.net",
               "googleapis.com", "gstatic.com", "cloudflare.com", "amazonaws.com", "cloudfront.net"}
# Where a vendor's own product pages are first-party: never block there.
EXTRA_OWN = {
    "Microsoft Clarity": ["microsoft.com", "bing.com", "live.com", "msn.com", "office.com", "azure.com"],
    "Salesforce Agentforce / Embedded Service": ["salesforce.com", "force.com"],
    "Amplitude (session replay)": ["amplitude.com"],
}
RANGES = {"chat": 1, "support": 1001, "replay": 2001}
TYPES_OK = {"script", "xmlhttprequest", "sub_frame", "stylesheet", "image", "media", "ping", "websocket"}


def base(domain):
    parts = domain.split(".")
    return ".".join(parts[-2:])


def net_rules(src, group):
    rules = []
    rid = RANGES[group]
    for v in src["network"]:
        if v["group"] != group:
            continue
        doms = sorted(set(v["domains"]))
        for d in doms:
            if d in NEVER_BLOCK or base(d) in NEVER_BLOCK:
                sys.exit(f"{v['vendor']}: {d} is a shared host and must never be blocked")
            if "/" in d or "*" in d or " " in d:
                sys.exit(f"{v['vendor']}: {d} is not a plain domain")
        own = sorted({base(d) for d in doms} | set(EXTRA_OWN.get(v["vendor"], [])))
        types = [t for t in v["types"] if t in TYPES_OK]
        rules.append({
            "id": rid, "priority": 1, "action": {"type": "block"},
            "condition": {"requestDomains": doms, "excludedInitiatorDomains": own, "resourceTypes": types},
        })
        rid += 1
    return rules


def cosmetic(src):
    out = []
    for c in src["cosmetic"]:
        hide = c["hide"]
        sel = [hide[len("ancestor:"):]] if hide.startswith("ancestor:") else list(c["selectors"])
        rule = {"id": c["id"], "g": c["group"], "h": c["hosts"], "sel": sel, "what": c["what"]}
        if c.get("text"):  # a heading found by its exact words (no stable selector exists)
            rule["t"] = c["text"]
        out.append(rule)
    return out


def main():
    src = json.loads(SRC.read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    for group in ("chat", "support", "replay"):
        rules = net_rules(src, group)
        (OUT / f"ai-web-{group}.json").write_text(json.dumps(rules, separators=(",", ":")) + "\n")
        print(f"ai-web-{group}.json: {len(rules)} rules")
    cos = cosmetic(src)
    (OUT / "ai-web-cosmetic.json").write_text(json.dumps({"rules": cos}, separators=(",", ":")) + "\n")
    print(f"ai-web-cosmetic.json: {len(cos)} rules")


if __name__ == "__main__":
    main()
