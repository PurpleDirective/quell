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
ok(derived("opera")["name"] != src["name"] and derived("firefox")["background"] != src["background"],
   "Opera and Firefox still differ from Chrome where they must")
pkg = (ROOT / "pipeline" / "package.sh").read_text()
ok("for target in chrome firefox opera edge; do" in pkg, "package.sh builds the Edge zip")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
