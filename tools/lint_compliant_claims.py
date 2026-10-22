#!/usr/bin/env python3
"""
lint_compliant_claims.py — flag UNQUALIFIED "compliant" / "compliance" overclaims
on regulated, customer-facing Purple Directive surfaces.

WHY THIS EXISTS
---------------
Purple Directive has a PERMANENT truthful-language rule:
  this repository's regulated-language rule (see DIRECTIVE.md)
Never write "21 CFR Part 11 Compliant" / "HIPAA Compliant" (or any bare
"<standard> compliant") on a product surface. Part 11, HIPAA, SOC 2, ISO 27001,
UETA/E-SIGN, etc. have no certification body that issues a "Compliant" stamp, so a
bare claim invites a sponsor/auditor follow-up the product cannot substantiate.
Approved phrasings instead:
  - "designed and tested against 21 CFR Part 11"
  - "implements the controls of HIPAA §164.312"
  - "validated against ICH-GCP §X.X"
  - "designed to meet the requirements of UETA / E-SIGN"

This overclaim has recurred. A per-review manual catch is probabilistic; this
lint makes it structural — it runs locally and in CI (pre-merge), converting a
recurring manual catch into a guard.

WHAT IT FLAGS  (see the matcher docs below)
--------------------------------------------------------------
The base tokens are `compliant` / `compliance` (case-insensitive, word-boundary).
To target the *overclaim* shape and not the many legitimate uses ("compliance-first"
positioning, "HIPAA Compliance" section headings, "compliance status" feature
labels, CSS class names, correctly-qualified copy), a token is reported ONLY when
it reads as an unqualified product claim:

  - "<standard> compliant"        e.g. "UETA / E-SIGN compliant", "HIPAA compliant"
  - "compliant with <standard>"   e.g. "compliant with 21 CFR Part 11"
  - "<intensifier> compliant"     e.g. "fully compliant", "legally compliant"
  - "<claim-verb> <standard> compliance" / "compliance with <standard>" /
    "<intensifier> compliance"    e.g. "guarantees HIPAA compliance"

...and is NOT any of:
  - QUALIFIED — preceded by "designed to / designed and tested against /
                validated against / intended to meet / implements the controls of
                / requirements of / support(s) / built to / aligned with ..."
  - NEGATED   — "not / never / non- / your own / responsible for ..."
                (e.g. "we are NOT HIPAA compliant")
  - a QUESTION — "Are you HIPAA compliant?"
  - inside an HTML (`<!-- -->`) or Jinja (`{# #}`) comment
  - a code IDENTIFIER (snake_case `_`, or inside class="..."/id="...")
  - ALLOWLISTED — inline `noqa: compliant-claim`, or listed in the allowlist file
    (tools/compliant-claims-allowlist.txt) — used for statutory quotes that
    legitimately contain the word.

DOCUMENTED GAP (precision over recall — a merge-blocking lint must not cry wolf):
a bare "we are compliant" with NO standard token and NO intensifier on the line is
deliberately NOT flagged — it collides with legitimate UI states ("All compliant",
a delegation log that "is compliant" once signed). Every one of the 3 historical
incidents was a "<standard> Compliant" claim, all of which ARE caught. Reviewers
still catch the rare standardless case; new patterns can be added here.

USAGE
-----
  tools/lint_compliant_claims.py                 # scan default customer-facing surfaces
  tools/lint_compliant_claims.py <path> [<path>] # scan specific files/dirs
  tools/lint_compliant_claims.py --selftest      # run built-in matcher fixtures
  tools/lint_compliant_claims.py --list-targets  # print the files that would be scanned

Exit codes: 0 = clean, 1 = one or more violations, 2 = usage/self-test failure.
Dependency-light: Python 3.8+ standard library only (no pip installs).
"""

from __future__ import annotations

import argparse
import fnmatch
import os
import re
import subprocess
import sys

# --------------------------------------------------------------------------- #
# Scope: which files count as "regulated customer-facing surfaces"            #
# --------------------------------------------------------------------------- #

# Rendered/marketing surfaces. NOTE: internal compliance docs (*.md under
# compliance/, validation/, audits/) are intentionally OUT of scope — they
# legitimately discuss compliance and are not customer-facing rendered copy.
INCLUDE_EXTS = (".html", ".htm", ".jinja", ".jinja2", ".j2", ".astro")

# Explicit cert/claim-builder source files scanned even though they are .py.
# (Add basenames here when claim strings live in code rather than templates.)
INCLUDE_BASENAMES = ("signature_service.py",)

EXCLUDE_DIRS = {
    ".git", "node_modules", ".next", ".open-next", ".wrangler", ".venv",
    "__pycache__", "dist", "build", ".pytest_cache", "archive", ".mypy_cache",
    # Per-product archive folders (e.g. products/*/_archive/) are retired,
    # non-customer-facing copy — same intent as the top-level archive
    # exclusion. Without this, a stale claim in archived HTML (that git now
    # tracks) fails the lint on every unrelated PR.
    "_archive",
}

DEFAULT_ALLOWLIST = "tools/compliant-claims-allowlist.txt"
RULE_PATH = "DIRECTIVE.md (regulated language)"

# --------------------------------------------------------------------------- #
# Matching vocabulary                                                          #
# --------------------------------------------------------------------------- #

# Regulatory / security / privacy standards that turn a "compliant" claim into a
# *regulated* claim. Extend this list as PD makes new claims.
#   NOTE: tokens carry word boundaries so a standard acronym is not matched
#   inside an unrelated word — most importantly E-SIGN must NOT match the "e-sign"
#   in "e-signature(s)" (an e-signature product is in scope, so that substring
#   sits next to "compliant" all over its templates).
_STANDARDS = [
    r"21\s*CFR\s*Part\s*11\b", r"CFR\s*Part\s*11\b", r"\bPart\s*11\b",
    r"\b21\s*CFR\b", r"\bPart\s*820\b", r"\bQSR\b",
    r"\bHIPAA\b", r"\bHITECH\b",
    r"\bUETA\b", r"\bE-?SIGN(?:\s+Act)?\b",
    r"ICH[-\s]?GCP\b", r"\bICH\s*E6(?:\s*\(R\d\))?\b", r"\bGCP\b", r"\bGxP\b",
    r"\bGLP\b", r"\bGMP\b",
    r"\bSOC\s*2\b", r"\bSOC2\b", r"\bSOC\s*1\b",
    r"\bISO\s*2700[17]\b", r"\bISO\s*9001\b", r"\bISO\s*13485\b",
    r"\bNIST\b(?:\s*800-\d+)?", r"\b800-\d+\b", r"\bFedRAMP\b", r"\bFISMA\b",
    r"\bGDPR\b", r"\bCCPA\b", r"\bCPRA\b", r"\beIDAS\b", r"\bPIPEDA\b",
    r"\bPCI[-\s]?DSS\b", r"\bPCI\b", r"\bFERPA\b",
]
STD_RE = re.compile("(?:" + "|".join(_STANDARDS) + ")", re.IGNORECASE)

# Adjective intensifiers that make a standardless "compliant" a claim, anchored
# to the END of the preceding context (i.e. immediately before the word).
INTENS_BEFORE_RE = re.compile(
    r"(?:fully|full|legally|wholly|totally|completely|100\s*%|certified|guaranteed)"
    r"[\s\-]*$",
    re.IGNORECASE,
)

# Approved hedging — if present in the preceding context, the claim is QUALIFIED
# (truthful) and must NOT be flagged.
_QUALIFIERS = [
    r"designed\s+(?:and\s+tested\s+)?(?:to|against)",
    r"designed\s*/\s*tested\s+against",
    r"designed\s+against",
    r"tested\s+against",
    r"validated\s+against",
    r"intended\s+to(?:\s+meet)?",
    r"built\s+to",
    r"aligned\s+with",
    r"maps?\s+to",
    r"implements?\s+(?:the\s+)?controls\s+of",
    r"controls\s+of",
    r"requirements\s+of",
    r"in\s+accordance\s+with",
    r"support(?:s|ing)?",   # "designed to support HIPAA-compliant operations"
    r"help(?:s|ing)?",
]
QUALIFIER_RE = re.compile("(?:" + "|".join(_QUALIFIERS) + ")", re.IGNORECASE)

# Negation / customer-obligation framing — present => not a product claim.
_NEGATORS = [
    r"\bnot\b", r"n['’]t\b", r"\bnever\b", r"\bno\b", r"\bnon[-\s]",
    r"\byour\s+own\b", r"\bresponsible\s+for\b",
    r"\bcustomer['’]?s?\b", r"\bclient['’]?s?\b",
]
NEGATOR_RE = re.compile("(?:" + "|".join(_NEGATORS) + ")", re.IGNORECASE)

# Claim verbs that turn "<standard> compliance" (a noun) into a claim.
CLAIM_VERB_RE = re.compile(
    r"(?:achieve|achieves|achieving|ensure|ensures|ensuring|guarantee|guarantees|"
    r"guaranteed|provide|provides|providing|deliver|delivers|delivering|maintain|"
    r"maintains|maintaining|certif\w+|in\s+full)",
    re.IGNORECASE,
)

COMPLIANT_RE = re.compile(r"\bcompliant\b", re.IGNORECASE)
COMPLIANCE_RE = re.compile(r"\bcompliance\b", re.IGNORECASE)
NOQA_RE = re.compile(r"noqa:\s*compliant-claim", re.IGNORECASE)
ATTR_RE = re.compile(r"(?:class|id)\s*=\s*\"([^\"]*)\"", re.IGNORECASE)

# Headline positions: the browser-tab title, the social-share title, and the
# hero <h1>. A bare "compliant" here is a claim about the product even with no
# standard on the same line, because the page's own subject supplies the
# standard. This closes the gap documented in classify_compliant(): purplesign.app
# served "Send documents for signature. Compliant where it counts." in all three
# of these positions for 44 days while the body copy correctly said "designed and
# tested against 21 CFR Part 11" — and every gate passed it.
HEADLINE_RE = re.compile(
    r"<title[^>]*>.*?</title>"
    r"|<meta[^>]*(?:og:title|twitter:title)[^>]*>"
    r"|<h1[^>]*>.*?</h1>",
    re.IGNORECASE | re.DOTALL,
)

WINDOW_BEFORE = 60
WINDOW_AFTER = 50


# --------------------------------------------------------------------------- #
# Comment masking (so matches inside comments are ignored, line #s preserved)  #
# --------------------------------------------------------------------------- #

def _blank_keep_newlines(match: "re.Match[str]") -> str:
    return re.sub(r"[^\n]", " ", match.group(0))


def mask_comments(text: str, is_python: bool) -> str:
    """Blank out comment interiors with spaces, preserving every newline so that
    line numbers and column offsets of the *surviving* text are unchanged."""
    text = re.sub(r"<!--.*?-->", _blank_keep_newlines, text, flags=re.S)
    text = re.sub(r"\{#.*?#\}", _blank_keep_newlines, text, flags=re.S)
    if is_python:
        # Mask only whole-line `#` comments to avoid quote/string tracking.
        masked = []
        for ln in text.split("\n"):
            masked.append(" " * len(ln) if ln.lstrip().startswith("#") else ln)
        text = "\n".join(masked)
    return text


# --------------------------------------------------------------------------- #
# Classification                                                               #
# --------------------------------------------------------------------------- #

def _inside_attr(line: str, pos: int) -> bool:
    for am in ATTR_RE.finditer(line):
        if am.start(1) <= pos < am.end(1):
            return True
    return False


def _is_question(after: str) -> bool:
    # The clause continuing from the match ends with '?' before any '.'/'!'.
    return bool(re.match(r"[^.!?]*\?", after))


def _is_identifier_edge(line: str, start: int, end: int) -> bool:
    prev_char = line[start - 1] if start > 0 else ""
    next_char = line[end] if end < len(line) else ""
    return prev_char == "_" or next_char == "_"


def classify_compliant(line: str, m: "re.Match[str]",
                       in_headline: bool = False,
                       file_names_standard: bool = False):
    """Return a reason string if this `compliant` is a violation, else None."""
    start, end = m.start(), m.end()
    if _is_identifier_edge(line, start, end) or _inside_attr(line, start):
        return None
    before = line[max(0, start - WINDOW_BEFORE):start]
    after = line[end:end + WINDOW_AFTER]

    has_std = bool(STD_RE.search(before) or STD_RE.search(after))
    has_int = bool(INTENS_BEFORE_RE.search(before))
    # A bare "compliant" in a headline, on a page that names a regulated
    # standard anywhere, is a claim about the product — the standard does not
    # have to sit on the same line to be the one the reader supplies.
    has_headline = in_headline and file_names_standard
    if not (has_std or has_int or has_headline):
        return None  # documented gap: bare "compliant" with no standard/intensifier

    if QUALIFIER_RE.search(before):
        return None
    if NEGATOR_RE.search(before):
        return None
    if _is_question(after):
        return None

    if has_std:
        return "unqualified '<standard> compliant' claim"
    if has_int:
        return "intensified 'compliant' claim with no qualifier"
    return ("bare 'compliant' in a headline (title / og:title / h1) on a page "
            "that names a regulated standard")


def classify_compliance(line: str, m: "re.Match[str]"):
    """Return a reason string if this `compliance` is a violation, else None.
    Conservative: only claim-shaped frames, so positioning ('compliance-first'),
    feature labels ('compliance status'), and headings ('HIPAA Compliance') pass.
    """
    start, end = m.start(), m.end()
    if _is_identifier_edge(line, start, end) or _inside_attr(line, start):
        return None
    before = line[max(0, start - 45):start]
    after = line[end:end + 45]

    frame_a = bool(re.match(r"\s*with\b", after) and STD_RE.search(after))
    std_before = bool(STD_RE.search(before[-25:]))
    frame_b = bool(std_before and CLAIM_VERB_RE.search(before))
    frame_c = bool(INTENS_BEFORE_RE.search(before))
    if not (frame_a or frame_b or frame_c):
        return None

    if QUALIFIER_RE.search(before):
        return None
    if NEGATOR_RE.search(before):
        return None
    if _is_question(after):
        return None

    return "unqualified 'compliance' claim"


def scan_text(text: str, is_python: bool):
    """Yield (lineno, col, matched_text, reason) for every violation in `text`.

    Matching runs on a comment-masked copy; reporting uses the original line so
    the message shows the real source text.
    """
    masked = mask_comments(text, is_python)
    masked_lines = masked.split("\n")
    orig_lines = text.split("\n")
    # File-level context for the headline rule. Headline spans are collected as
    # (line, col) offsets against the MASKED text so a headline inside a comment
    # cannot arm the rule.
    file_names_standard = bool(STD_RE.search(masked))
    headline_cells = set()
    if file_names_standard:
        for hm in HEADLINE_RE.finditer(masked):
            pre = masked[:hm.start()]
            ln = pre.count("\n")
            col = hm.start() - (pre.rfind("\n") + 1)
            for off in range(hm.end() - hm.start()):
                headline_cells.add((ln, col + off))
                if masked[hm.start() + off] == "\n":
                    ln, col = ln + 1, -off - 1
    for i, mline in enumerate(masked_lines):
        if not ("compliant" in mline.lower() or "compliance" in mline.lower()):
            continue
        oline = orig_lines[i]
        if NOQA_RE.search(oline):
            continue
        for m in COMPLIANT_RE.finditer(mline):
            reason = classify_compliant(
                mline, m,
                in_headline=(i, m.start()) in headline_cells,
                file_names_standard=file_names_standard,
            )
            if reason:
                yield (i + 1, m.start() + 1, oline.strip(), reason)
        for m in COMPLIANCE_RE.finditer(mline):
            reason = classify_compliance(mline, m)
            if reason:
                yield (i + 1, m.start() + 1, oline.strip(), reason)


# --------------------------------------------------------------------------- #
# File discovery + allowlist                                                   #
# --------------------------------------------------------------------------- #

def repo_root() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()
    except Exception:
        return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def is_target(path: str) -> bool:
    base = os.path.basename(path)
    return path.lower().endswith(INCLUDE_EXTS) or base in INCLUDE_BASENAMES


def iter_targets(roots, root_dir):
    for root in roots:
        if os.path.isfile(root):
            yield root
            continue
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE_DIRS)
            for fn in sorted(filenames):
                full = os.path.join(dirpath, fn)
                if is_target(full):
                    yield full


def load_allowlist(path: str):
    entries = []
    if not os.path.exists(path):
        return entries
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            s = raw.strip()
            if not s or s.startswith("#"):
                continue
            # The file's own header instructs every entry to carry a trailing
            # rationale comment, but the entry was stored verbatim including
            # that comment, so it never matched a path. Undetectable until now
            # because the list had no active entries to fail with.
            s = s.split("#", 1)[0].strip()
            if s:
                entries.append(s)
    return entries


def is_allowlisted(relpath: str, lineno: int, entries) -> bool:
    key = f"{relpath}:{lineno}"
    for e in entries:
        if e in (relpath, key):
            return True
        if fnmatch.fnmatch(relpath, e) or fnmatch.fnmatch(key, e):
            return True
    return False


# --------------------------------------------------------------------------- #
# Self-test (also a built-in "planted violation" regression suite)            #
# --------------------------------------------------------------------------- #

_SELFTEST_POSITIVE = [
    '<p class="footnote">Signed via PurpleSign. UETA / E-SIGN compliant.</p>',
    "<p>Signed via PurpleSign. UETA/E-SIGN compliant.</p>",
    "Our CTMS is 21 CFR Part 11 compliant.",
    "HIPAA compliant document storage for clinical sites.",
    "PI e-signatures — legally compliant, timestamped, re-sign built in.",
    "Fully compliant with SOC 2 Type II controls.",
    "Our platform is compliant with 21 CFR Part 11.",
    "We guarantee HIPAA compliance for your trial site.",
    "Achieve full Part 11 compliance out of the box.",
    "Signed via PurpleSign. E-SIGN Act compliant.",  # real E-SIGN token, still caught
]

_SELFTEST_NEGATIVE = [
    '<!-- never an unqualified "compliant" claim here -->',
    "{# CSP nonce keeps the indicator styles CSP-compliant #}",
    "Designed and tested against 21 CFR Part 11.",
    "Nexrial is designed to support HIPAA-compliant clinical research operations.",
    "We are not HIPAA compliant. Do not use QuillPDF for PHI.",
    "not covered by a BAA and is not a HIPAA-compliant service.",
    'q: "Are you HIPAA compliant?",',
    '<div class="compliance-row">',
    '<h2><span class="sec-num">9</span> HIPAA Compliance</h2>',
    "Compliance-first CTMS for clinical research sites.",
    "Never miss a compliance date. Deadlines surface on your dashboard.",
    "{% if reg_urgent == 0 %}All compliant{% endif %}",
    "Structured, compliant, precise.",
    "    is_compliant = signature.verified and chain_ok",
    "implements the controls of HIPAA §164.312",
    "Your site is in good compliance standing. Keep monitoring.",
    "You are responsible for ensuring your own HIPAA compliance.",
    "managing audit trails and related regulatory compliance workflows.",
    # "e-sign" inside "e-signature(s)" must NOT count as the E-SIGN standard:
    "Our e-signature platform keeps every signer record compliant.",
    "Compliant e-signatures with a full audit trail.",
]


def run_selftest() -> int:
    failures = []
    for s in _SELFTEST_POSITIVE:
        is_py = s.lstrip().startswith(("is_compliant", "q:"))
        hits = list(scan_text(s, is_python=is_py))
        if not hits:
            failures.append(f"  EXPECTED violation, got none:  {s}")
    for s in _SELFTEST_NEGATIVE:
        is_py = s.lstrip().startswith(("is_compliant", "q:"))
        hits = list(scan_text(s, is_python=is_py))
        if hits:
            failures.append(f"  FALSE POSITIVE ({hits[0][3]}):  {s}")
    if failures:
        print("SELF-TEST FAILED:")
        print("\n".join(failures))
        return 2
    n = len(_SELFTEST_POSITIVE) + len(_SELFTEST_NEGATIVE)
    print(f"Self-test passed: {len(_SELFTEST_POSITIVE)} positive + "
          f"{len(_SELFTEST_NEGATIVE)} negative = {n} fixtures.")
    return 0


# --------------------------------------------------------------------------- #
# CLI                                                                          #
# --------------------------------------------------------------------------- #

REMEDIATION = f"""
How to fix a flagged line — replace the bare claim with qualified language
(rule: {RULE_PATH}):
  "Part 11 compliant"      ->  "designed and tested against 21 CFR Part 11"
  "HIPAA compliant"        ->  "implements the controls of HIPAA §164.312"
  "UETA / E-SIGN compliant" -> "designed to meet the requirements of UETA / E-SIGN"
  "SOC 2 compliant"        ->  "designed against the SOC 2 trust criteria"

Legitimately need the word (e.g. quoting a statute verbatim)? Allowlist it:
  - inline:  add  `noqa: compliant-claim`  to the line (any comment syntax), or
  - file:    add  `<path>` or `<path>:<line>`  to {DEFAULT_ALLOWLIST}
"""


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Flag unqualified 'compliant'/'compliance' overclaims on "
                    "regulated customer-facing surfaces.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=REMEDIATION,
    )
    parser.add_argument("paths", nargs="*",
                        help="files/dirs to scan (default: repo customer-facing surfaces)")
    parser.add_argument("--allowlist", default=None,
                        help=f"allowlist file (default: {DEFAULT_ALLOWLIST})")
    parser.add_argument("--selftest", action="store_true",
                        help="run built-in matcher fixtures and exit")
    parser.add_argument("--list-targets", action="store_true",
                        help="print files that would be scanned, then exit")
    args = parser.parse_args(argv)

    if args.selftest:
        return run_selftest()

    root = repo_root()
    roots = args.paths if args.paths else [root]
    allowlist_path = args.allowlist or os.path.join(root, DEFAULT_ALLOWLIST)
    allowlist = load_allowlist(allowlist_path)

    targets = list(iter_targets(roots, root))
    if args.list_targets:
        for t in targets:
            print(os.path.relpath(t, root))
        print(f"\n{len(targets)} target file(s).", file=sys.stderr)
        return 0

    violations = []
    for path in targets:
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            continue
        is_py = path.endswith(".py")
        rel = os.path.relpath(path, root)
        for lineno, col, snippet, reason in scan_text(text, is_python=is_py):
            if is_allowlisted(rel, lineno, allowlist):
                continue
            violations.append((rel, lineno, col, snippet, reason))

    if not violations:
        print(f"OK — no unqualified compliant/compliance claims in "
              f"{len(targets)} customer-facing file(s).")
        return 0

    print("Unqualified compliance claim(s) found "
          f"({len(violations)} in {len(targets)} scanned files):\n")
    last_file = None
    for rel, lineno, col, snippet, reason in violations:
        if rel != last_file:
            print(f"\n{rel}")
            last_file = rel
        if len(snippet) > 140:
            snippet = snippet[:137] + "..."
        print(f"  {lineno}:{col}: {reason}")
        print(f"      | {snippet}")
    print(REMEDIATION)
    return 1


if __name__ == "__main__":
    sys.exit(main())
