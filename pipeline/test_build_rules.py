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

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
