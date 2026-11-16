#!/usr/bin/env python3
"""Check the Open Food Facts fixtures against OFF.md.

Usage
    python3 shared/off/check_fixtures.py

For every recorded response in fixtures/ the script derives the query text exactly as OFF.md §3
defines it and compares it with the hand-written expectedQueryText in fixtures/cases.json. It also
checks the barcode-exact-match contract (OFF.md §6) on the recorded texts plus a few synthetic
normalisation cases, and verifies that every fixture file is referenced.

Exit status: 0 = all checks pass, 1 = mismatch or malformed fixture, 2 = usage error.
No third-party dependency and no network access.

The fixtures store RAW derived text (never the prompts.json prefix); this script never adds a prefix.
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent / "fixtures"
MAX_QUERY_CODEPOINTS = 160

# Unicode White_Space property. U+200B (ZWSP) and U+FEFF (BOM) are deliberately absent.
WS = re.compile("[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+")


def clean(value: object) -> str:
    """OFF.md §3.1 step 1-4: NFC, collapse White_Space runs, trim spaces."""
    if not isinstance(value, str):
        return ""
    s = unicodedata.normalize("NFC", value)
    return WS.sub(" ", s).strip(" ")


def clean_brands(value: object) -> str:
    """OFF.md §3.1: comma-split, clean, casefold-dedupe keeping first spelling, join with ', '."""
    s = clean(value)
    if not s:
        return ""
    out: list[str] = []
    seen: set[str] = set()
    for part in s.split(","):
        part = clean(part)
        if not part:
            continue
        key = part.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(part)
    return ", ".join(out)


def derive(body: dict) -> str | None:
    """OFF.md §3.2/§3.3/§3.4: product_name > generic_name > brands, then hard 160-code-point cut."""
    if body.get("status") != 1:
        return None
    product = body.get("product") or {}
    for candidate in (
        clean(product.get("product_name")),
        clean(product.get("generic_name")),
        clean_brands(product.get("brands")),
    ):
        if candidate:
            return candidate[:MAX_QUERY_CODEPOINTS].rstrip(" ")
    return None


def norm(text: str) -> str:
    """OFF.md §6 / RANK.md §3.1: NFC, casefold, collapse White_Space runs, trim spaces."""
    return WS.sub(" ", unicodedata.normalize("NFC", text).casefold()).strip(" ")


def boost_match(barcode_name: str | None, item_name: str, aliases: list[str]) -> bool:
    """OFF.md §6: exact equality after norm() against the item name or any alias."""
    if not barcode_name:
        return False
    target = norm(barcode_name)
    if not target:
        return False
    return norm(item_name) == target or any(norm(a) == target for a in aliases)


def main() -> int:
    cases_path = FIXTURES / "cases.json"
    if not cases_path.is_file():
        print(f"error: missing {cases_path}", file=sys.stderr)
        return 2
    data = json.loads(cases_path.read_text(encoding="utf-8"))
    cases = data.get("cases", [])
    failures: list[str] = []
    barcode_text: dict[str, str | None] = {}
    referenced: set[str] = {"cases.json"}

    print("derived query texts (raw, no prompts.json prefix):")
    for case in cases:
        barcode = case["barcode"]
        name = case["file"]
        referenced.add(name)
        path = FIXTURES / name
        if not path.is_file():
            failures.append(f"{barcode}: fixture file {name} is missing")
            continue
        try:
            body = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            failures.append(f"{barcode}: {name} is not valid JSON ({exc})")
            continue

        actual = derive(body)
        barcode_text[barcode] = actual
        expected = case.get("expectedQueryText")

        if "code" in body and str(body["code"]) != barcode:
            failures.append(f"{barcode}: response code {body['code']!r} != barcode")
        if case.get("outcome") == "hit":
            if case.get("httpStatus") != 200 or body.get("status") != 1:
                failures.append(f"{barcode}: expected a hit but status/http disagree")
            if not isinstance(body.get("product"), dict):
                failures.append(f"{barcode}: hit without a product object")
        elif case.get("outcome") == "miss":
            if case.get("httpStatus") not in (200, 404) or body.get("status") != 0:
                failures.append(f"{barcode}: expected a miss but status/http disagree")
        else:
            failures.append(f"{barcode}: unknown outcome {case.get('outcome')!r}")

        if actual != expected:
            failures.append(f"{barcode}: derived {actual!r} != expected {expected!r}")
        shown = "(none)" if actual is None else json.dumps(actual, ensure_ascii=False)
        print(f"  PASS {barcode:14s} {case['outcome']:4s} {shown}")

    # every fixture file is referenced by cases.json
    for path in sorted(FIXTURES.glob("*.json")):
        if path.name not in referenced:
            failures.append(f"orphan fixture not listed in cases.json: {path.name}")

    print("\nbarcode exact-match boost (OFF.md §6):")
    for case in data.get("boostCases", []):
        barcode_name = barcode_text.get(case["barcode"], None)
        actual = boost_match(barcode_name, case["itemName"], case.get("aliases", []))
        if actual != case["expectMatch"]:
            failures.append(
                f"boost {case['barcode']} {case['itemName']!r}: {actual} != {case['expectMatch']}"
            )
        print(f"  PASS {actual!s:5s} {json.dumps(case['itemName'], ensure_ascii=False):40s} "
              f"({'match' if actual else 'no match'}; {case['why']})")

    print("\nsynthetic norm() cases (OFF.md §6):")
    for case in data.get("normCases", []):
        actual = norm(case["a"]) == norm(case["b"])
        if actual != case["expectEqual"]:
            failures.append(f"norm {case['a']!r} vs {case['b']!r}: {actual} != {case['expectEqual']}")
        print(f"  PASS {actual!s:5s} {json.dumps(case['a'], ensure_ascii=False)} vs "
              f"{json.dumps(case['b'], ensure_ascii=False)} ({case['why']})")

    hits = sum(1 for c in cases if c.get("outcome") == "hit")
    misses = sum(1 for c in cases if c.get("outcome") == "miss")
    if failures:
        print("\nFAIL:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    print(f"\nOK: {len(cases)} fixtures ({hits} hits, {misses} misses), "
          f"{len(data.get('boostCases', []))} boost cases, "
          f"{len(data.get('normCases', []))} norm cases; all derived query texts match.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
