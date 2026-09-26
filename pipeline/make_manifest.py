#!/usr/bin/env python3
"""Quell — per-browser manifest from the one source manifest.

extension/manifest.json IS the Chrome manifest (what tests load). This
script derives the Firefox and Opera ones; everything else in the tree is
shared.

  python3 pipeline/make_manifest.py firefox > build/firefox/manifest.json
  python3 pipeline/make_manifest.py opera   > build/opera/manifest.json

Opera takes the Chrome package with one difference: its add-ons site rejects
the 50-character Chrome name, so it gets the same short name as Firefox.

Firefox differences, and why:
  background            Firefox MV3 runs an event page, not a service worker:
                        background.scripts, with settings.js listed first
                        (Chrome loads it via importScripts instead).
  name                  AMO caps names at 45 characters; the Chrome name is 50.
  minimum_chrome_version  Chrome-only key; dropped.
  browser_specific_settings.gecko
    id                  required for storage.sync and for AMO.
    strict_min_version  140.0 — the first Firefox that understands
                        data_collection_permissions (below). Everything else
                        Quell uses is older: MV3 declarativeNetRequest (113),
                        scripting.registerContentScripts (102),
                        storage.session (115), CSS :has() (121).
    data_collection_permissions
                        required ["none"]: Quell collects nothing to run.
                        optional: the breakage report the user may choose to
                        send — a site's domain (browsingActivity) and the
                        Quell version (technicalAndInteraction). Firefox asks
                        the user the first time they send one.
  browser_specific_settings.gecko_android
    strict_min_version  142.0 — data_collection_permissions on Android.
"""

import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GECKO_ID = "quell@purpledirective.com"
SHORT_NAME = "Quell — Block AI Overviews & Cookie Popups"  # ≤ 45 chars (AMO, Opera)
FIREFOX_NAME = SHORT_NAME


def firefox(m):
    m = copy.deepcopy(m)
    m["name"] = FIREFOX_NAME
    m["background"] = {"scripts": ["src/shared/settings.js", "src/background.js"]}
    m.pop("minimum_chrome_version", None)
    m["browser_specific_settings"] = {
        "gecko": {
            "id": GECKO_ID,
            "strict_min_version": "140.0",
            "data_collection_permissions": {
                "required": ["none"],
                "optional": ["browsingActivity", "technicalAndInteraction"],
            },
        },
        "gecko_android": {"strict_min_version": "142.0"},
    }
    return m


def chrome(m):
    return copy.deepcopy(m)


def opera(m):
    m = copy.deepcopy(m)
    m["name"] = SHORT_NAME
    return m


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else "chrome"
    src = json.loads((ROOT / "extension" / "manifest.json").read_text())
    out = {"chrome": chrome, "firefox": firefox, "opera": opera}.get(target)
    if out is None:
        sys.exit(f"unknown target {target!r} (chrome | firefox | opera)")
    json.dump(out(src), sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
