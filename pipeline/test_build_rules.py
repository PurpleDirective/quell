#!/usr/bin/env python3
"""Quell — pop-ups rule filter tests (stdlib only, no network).

  python3 pipeline/test_build_rules.py

Exercises popup_selector_ok() directly, then re-checks the SHIPPED
extension/rules/popups.json with the same predicate, so a rules refresh that
somehow bypassed the filter fails here too.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_rules as b  # noqa: E402

passed = failed = 0


def ok(cond, name):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✓ {name}")
    else:
        failed += 1
        print(f"  ✗ FAIL {name}")


print("Pop-ups rule filter — html/body in any form (review #2):")
for sel in ["body", "html", "body.newsletter-open", "html.no-scroll", "body[data-modal]",
            "body:not(.x)", "html > body.modal-open", ".page body.nl", "BODY.Newsletter", ":root"]:
    ok(not b.popup_selector_ok(sel), f"rejects {sel!r}")
for sel in [".body-newsletter", "#bodyNewsletter", "div.newsletter[data-body]", ".htmlwidget-signup"]:
    ok(b.popup_selector_ok(sel), f"keeps {sel!r} (names contain html/body, subject is not the page)")

print("Pop-ups rule filter — bare generic modal / overlay shells (review #1):")
for sel in [".modal", ".modal-backdrop", ".overlay", "#popup", ".ui-widget-overlay", ".ui-dialog",
            "div.modal", ".modal.fade.in", 'div[class^="background-"]', "#modal-overlay",
            ".mfp-bg", ".pum", ".elementor-popup-modal", ".dialog-lightbox-widget",
            ".page .modal", "div[role=\"dialog\"]", ".needsclick[aria-label][style]"]:
    ok(not b.popup_selector_ok(sel), f"rejects {sel!r}")
for sel in [".newsletter", "#mc_embed_signup", ".newsletter-popup", 'div[class*="subscribeDialog-"]',
            ".modal.newsletter-modal", "#emailPopUpModal", 'div[aria-label="Sign up now"]',
            ".ck-modal--newsletter-modal-wrapper", ".smartbanner", "#intercom-container"]:
    ok(b.popup_selector_ok(sel), f"keeps {sel!r} (names what it is)")
ok(b.subject_compound('div[aria-label="Sign up now"] > .x') == ".x"
   and b.subject_compound('div[aria-label="a b"]') == 'div[aria-label="a b"]',
   "subject compound respects quoted attribute values")

print("Shipped rules/popups.json passes the same filter:")
rules = json.loads((b.RULES_DIR / "popups.json").read_text())
bad = [(cat, s) for cat, r in rules.items()
       for s in r["generic"] + [x for v in r["domains"].values() for x in v]
       if not b.popup_selector_ok(s)]
ok(not bad, f"no shipped selector fails popup_selector_ok ({bad[:3] or 'none'})")
for host in ["artnet.com", "ardene.com", "bathandbodyworks.com", "answear.ua"]:
    sels = rules["newsletter"]["domains"].get(host, [])
    ok(not any(b.is_generic_overlay(b.subject_compound(s)) for s in sels),
       f"{host}: no bare modal/overlay rule ships ({sels or 'no rules'})")

print("Cookie generic sheet — every rule sits inside the off switch:")
css = b.generic_css([f"#c{i}" for i in range(450)] + ["html.cookie-open .bar", ":root > .consent", ".htmlish"])
lines = css.splitlines()
ok(lines[0].startswith("/* GENERATED") and len(lines) == 4, f"450+3 selectors make three chunks of 200 ({len(lines) - 1})")
ok(all(l.startswith(b.GENERIC_GATE + "{") and l.endswith("{display:none!important;}}") for l in lines[1:]),
   "each chunk is nested inside GENERIC_GATE")
ok("&.cookie-open .bar" in lines[3] and "& > .consent" in lines[3] and ",.htmlish{" in lines[3],
   "a selector starting at the page root takes the gate as its root (&); a name that merely starts with html does not")
shipped = (b.RULES_DIR / "cookie-generic.css").read_text().splitlines()
ok(len(shipped) > 10 and all(l.startswith(b.GENERIC_GATE + "{") for l in shipped[1:]),
   f"the shipped sheet is gated the same way ({len(shipped) - 1} chunks)")

print("Per-browser manifests (make_manifest.py):")
import subprocess  # noqa: E402
ROOT = Path(__file__).resolve().parent.parent
src = json.loads((ROOT / "extension" / "manifest.json").read_text())


def derived(target):
    return json.loads(subprocess.check_output(
        [sys.executable, str(Path(__file__).resolve().parent / "make_manifest.py"), target]))


edge = derived("edge")
ok({k: v for k, v in edge.items() if k != "description"} == {k: v for k, v in src.items() if k != "description"},
   "Edge's manifest is the Chrome manifest except for the description")
ok(len(edge["description"]) <= 132 and not any(w in edge["description"] for w in ("Brave", "Chrome", "Firefox", "Opera", "Safari")),
   f"Edge's description is within 132 characters and names no other browser ({len(edge['description'])})")
ok("browser_specific_settings" not in edge and "scripts" not in edge["background"],
   "Edge keeps the service worker and carries no Firefox keys")
ok(edge["version"] == src["version"] and edge["name"] == src["name"], "Edge keeps the Chrome version and name")
ok(derived("opera")["name"] == src["name"] == derived("firefox")["name"] and len(src["name"]) <= 45
   and derived("firefox")["background"] != src["background"],
   "one store name everywhere (within AMO's 45 characters); Firefox still differs from Chrome in its background")
pkg = (ROOT / "pipeline" / "package.sh").read_text()
ok("for target in chrome firefox opera; do" in pkg,
   "package.sh builds chrome, firefox and opera")
ok("edge" not in pkg.split("for target in")[1].split("do")[0],
   "package.sh does NOT build an Edge zip (Edge dropped 2026-10-02)")

print("AI on websites rules (generated from pipeline/sources/ai-web.json):")
import build_ai_web as aw  # noqa: E402

AW_SRC = json.loads((aw.SRC).read_text())
RULES_DIR = aw.OUT
shipped = {g: json.loads((RULES_DIR / f"ai-web-{g}.json").read_text()) for g in ("chat", "support", "replay")}
shipped_cos = json.loads((RULES_DIR / "ai-web-cosmetic.json").read_text())["rules"]
ok(all(shipped[g] == aw.net_rules(AW_SRC, g) for g in shipped) and shipped_cos == aw.cosmetic(AW_SRC),
   "shipped rules are exactly what the generator emits from the source (nothing hand-edited)")
ok(all(len(v) > 0 for v in shipped.values()) and len(shipped_cos) >= 25,
   f"each ruleset is non-empty ({', '.join(f'{g} {len(v)}' for g, v in shipped.items())}; {len(shipped_cos)} cosmetic rules)")
all_ids = [r["id"] for v in shipped.values() for r in v]
ok(len(all_ids) == len(set(all_ids)), "network rule ids are unique across the three rulesets")
doms = [d for v in shipped.values() for r in v for d in r["condition"]["requestDomains"]]
ok(not any(d in aw.NEVER_BLOCK or aw.base(d) in aw.NEVER_BLOCK for d in doms),
   "no shared host is ever blocked (CDNs, algolia.net, googleapis ...)")
ok(all("/" not in d and "*" not in d for d in doms), "every blocked host is a plain domain, no path or wildcard")
ok(all(r["action"] == {"type": "block"} and r["condition"]["excludedInitiatorDomains"]
       for v in shipped.values() for r in v),
   "every rule only blocks, and excludes the vendor's own sites as initiators")
ok(all(set(r["condition"]["resourceTypes"]) <= aw.TYPES_OK for v in shipped.values() for r in v),
   "resource types are all ones dNR accepts")
vendors = {n["vendor"]: n["group"] for n in AW_SRC["network"]}
ok("Algolia Ask AI / DocSearch" not in vendors and "Mintlify AI assistant" not in vendors and not any("OpenAI" in v for v in vendors),
   "vendors marked skip (or with an unverified purpose) are not in the source")
ok(all(vendors[v] == "replay" for v in vendors if any(k in v for k in ("Hotjar", "Fullstory", "Clarity", "LogRocket", "Heap"))),
   "session-replay vendors are in the opt-in replay group only")
ok(all(vendors[v] == "support" for v in vendors if any(k in v for k in ("Intercom", "Zendesk", "HubSpot", "Gorgias", "LiveChat"))),
   "support-chat vendors are in the opt-in support group, not the default one")
ok(shipped_cos and all(c["g"] in ("buttons", "chat", "support") and c["h"] and (c["sel"] or c.get("t")) and c["what"] for c in shipped_cos),
   "every cosmetic rule has a group, hosts, selectors and a label")
src_c = {c["id"]: c for c in AW_SRC["cosmetic"]}
ok(not any("tawk" in " ".join(c["hosts"]) or "tawk" in c["id"] for c in AW_SRC["cosmetic"]),
   "tawk.to has no cosmetic rule (it sets inline !important): its network rule only")
ok(all(c["what"] and (c["selectors"] or c.get("text")) for c in AW_SRC["cosmetic"]), "every rule has selectors or a heading to find by its words")
ok(all(len(c["sel"]) == 1 for c in shipped_cos if src_c[c["id"]]["hide"].startswith("ancestor:")),
   "rules that name a container hide the container itself, so no empty box is left")
man = json.loads((aw.ROOT / "extension" / "manifest.json").read_text())
res = {r["id"]: r for r in man["declarative_net_request"]["rule_resources"]}
ok(all(res.get("ai_web_" + g, {}).get("path") == f"rules/ai-web-{g}.json" and res["ai_web_" + g]["enabled"] is False for g in shipped),
   "the manifest declares the three rulesets, off until the background enables them")
ok("activeTab" in man["permissions"] and "<all_urls>" not in man.get("host_permissions", []),
   "the matched-rule count comes through activeTab; <all_urls> stays optional")
# declarativeNetRequestFeedback warns "Read your browsing history": a new warning
# disables the extension on update until the user accepts it again.
ok("declarativeNetRequestFeedback" not in man["permissions"] + man.get("optional_permissions", []),
   "no permission that warns 'Read your browsing history' (an update would switch Quell off)")

print("Links ruleset (0.7.4):")
gen = b.links_ruleset()
shipped = json.loads((Path(__file__).resolve().parent.parent / "extension" / "rules" / "links-clean.json").read_text())
ok(gen == shipped, "rules/links-clean.json is exactly what the pipeline generates (never hand-edited)")
ok(not set(b.LINK_PROTECTED_PARAMS) & set(b.LINK_TRACKING_PARAMS), "no protected (affiliate / page-changing) parameter is in the tracking list")
ok(not set(b.YOUTUBE_ONLY_PARAMS) & set(b.LINK_PROTECTED_PARAMS - {"si"} if isinstance(b.LINK_PROTECTED_PARAMS, set) else b.LINK_PROTECTED_PARAMS), "the YouTube-only parameter is not a protected one")
ok(len(set(b.LINK_TRACKING_PARAMS)) == len(b.LINK_TRACKING_PARAMS), "the tracking list has no duplicates")
ok(all(len(r["condition"]["regexFilter"]) < 1500 for r in gen), "each regexFilter is well under Chrome's 2 KB regex limit")
ok(len(gen) < 50, f"{len(gen)} static redirect rules, far under the unsafe-rule limit")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
