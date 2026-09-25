#!/usr/bin/env python3
"""Quell — read the "this site looks broken" reports for the weekly rules work.

Prints a Markdown table of reported hosts (busiest first) from the report
Worker's read endpoint (server/report-worker). Stdlib only.

  QUELL_REPORTS_TOKEN=... python3 pipeline/fetch_reports.py [days]

Environment:
  QUELL_REPORTS_TOKEN  the Worker's READ_TOKEN secret (required; without it
                       the script says so and exits 0, so the weekly job
                       does not fail before the Worker is deployed)
  QUELL_REPORTS_URL    defaults to https://purpledirective.com/api/quell/reports

Each row is a hostname and a count — nothing else is collected. A host that
shows up here is a candidate for a rule exception or a selector fix; open it,
reproduce, and fix in extension/ with a regression fixture in tests/.
"""

import json
import os
import sys
import urllib.request

URL = os.environ.get("QUELL_REPORTS_URL", "https://purpledirective.com/api/quell/reports")


def main():
    token = os.environ.get("QUELL_REPORTS_TOKEN", "")
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 7
    if not token:
        print("QUELL_REPORTS_TOKEN not set — skipping breakage reports.")
        return 0
    req = urllib.request.Request(f"{URL}?days={days}", headers={
        "Authorization": f"Bearer {token}", "User-Agent": "Quell-rules-pipeline/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    rows = data.get("rows", [])
    print(f"### Quell breakage reports — last {data.get('days', days)} days (since {data.get('since')})\n")
    if not rows:
        print("No reports.")
        return 0
    print("| Reports | Host | Quell version | First | Last |")
    print("|---:|---|---|---|---|")
    for row in rows:
        print(f"| {row['reports']} | `{row['host']}` | {row['version']} | {row['first_day']} | {row['last_day']} |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
