"""Parity with the normative OFF spec (`shared/off/OFF.md`, card S4).

`shared/off/check_fixtures.py` is the executable contract for the barcode -> query
text derivation, and `shared/off/fixtures/` holds the raw recorded API responses.
This module imports the spec's own checker and asserts that `app.off` produces
byte-identical output:

* every recorded fixture derives the hand-written `expectedQueryText`;
* server and spec agree on a set of synthetic edge cases (whitespace classes, NFC,
  brand de-duplication, the 160-code-point cut, non-string values, categories-only);
* the request contract (`fields=`, User-Agent, 160 cap) matches `cases.json`;
* `check_fixtures.py` itself still exits 0.

Any future drift between the server and `shared/off/` therefore fails loudly here
instead of silently in production.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest

from app import off as server_off

REPO_ROOT = Path(__file__).resolve().parents[4]  # apps/web/server/tests -> repo root
OFF_SPEC_DIR = REPO_ROOT / "shared" / "off"
FIXTURES_DIR = OFF_SPEC_DIR / "fixtures"
CASES_PATH = FIXTURES_DIR / "cases.json"


def _load_spec_checker() -> Any:
    """Import `shared/off/check_fixtures.py` under a private module name."""
    path = OFF_SPEC_DIR / "check_fixtures.py"
    if not path.is_file():
        raise RuntimeError(
            f"normative OFF spec checker missing: {path} - the server proxy cannot be "
            "verified against OFF.md, so this parity suite refuses to run"
        )
    spec = importlib.util.spec_from_file_location("off_spec_check_fixtures", path)
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise RuntimeError(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    # Do not write __pycache__ into shared/off/ (read-only for the web track).
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


spec_checker = _load_spec_checker()

if not CASES_PATH.is_file():  # pragma: no cover - defensive
    raise RuntimeError(f"missing OFF fixture metadata: {CASES_PATH}")

CASES_JSON: dict[str, Any] = json.loads(CASES_PATH.read_text(encoding="utf-8"))
CASES: list[dict[str, Any]] = CASES_JSON["cases"]


def _fixture_body(file_name: str) -> dict[str, Any]:
    return json.loads((FIXTURES_DIR / file_name).read_text(encoding="utf-8"))


def test_request_contract_matches_the_spec() -> None:
    assert server_off.OFF_FIELDS == CASES_JSON["fields"]
    assert server_off.OFF_FIELDS == "code,product_name,brands,generic_name,categories"
    assert server_off.OFF_USER_AGENT == CASES_JSON["userAgent"] == "ScanList/0.1"
    assert CASES_JSON["endpoint"] == (
        "https://world.openfoodfacts.org/api/v2/product/{barcode}.json"
    )
    assert server_off.OFF_BASE_URL == "https://world.openfoodfacts.org"
    assert server_off.MAX_QUERY_CODEPOINTS == spec_checker.MAX_QUERY_CODEPOINTS == 160
    assert server_off.POSITIVE_TTL_SECONDS == 2_592_000
    assert server_off.NEGATIVE_TTL_SECONDS == 86_400


@pytest.mark.parametrize("case", CASES, ids=[case["barcode"] for case in CASES])
def test_recorded_fixture_derives_expected_query_text(case: dict[str, Any]) -> None:
    """The recorded API bodies, the hand-written expectations and the server all agree."""
    body = _fixture_body(case["file"])
    expected = case["expectedQueryText"]

    assert server_off.derive_from_body(body) == expected
    # The executable contract itself, imported from shared/off/.
    assert spec_checker.derive(body) == expected
    # And the product-level entry point the proxy uses after the hit/miss check.
    assert server_off.derive_query_text(body.get("product")) == expected


SYNTHETIC_BODIES: list[tuple[str, dict[str, Any]]] = [
    (
        "brands-fallback",
        {"status": 1, "product": {"product_name": "", "generic_name": "", "brands": "Carrefour"}},
    ),
    (
        "brands-dedupe-keeps-first-spelling",
        {"status": 1, "product": {"brands": "Ferrero,  Nutella , FERRERO, nutella"}},
    ),
    (
        "categories-only-yields-null",
        {"status": 1, "product": {"code": "123", "categories": "Spreads, Sweet spreads"}},
    ),
    (
        "generic-name-fallback",
        {"status": 1, "product": {"product_name": " \u00a0 ", "generic_name": "Désodorisant pour litière"}},
    ),
    ("nfc-composition", {"status": 1, "product": {"product_name": "Mle\u0301ko polotučné"}}),
    (
        "whitespace-classes",
        {"status": 1, "product": {"product_name": "\t Dulce\u00a0\u00a0de\u2003leche\r\n"}},
    ),
    ("zwsp-is-not-whitespace", {"status": 1, "product": {"product_name": "a\u200bb c"}}),
    ("bom-is-not-whitespace", {"status": 1, "product": {"product_name": "\ufeffmilk"}}),
    ("160-cap", {"status": 1, "product": {"product_name": "x" * 159 + " y"}}),
    ("160-cap-emoji", {"status": 1, "product": {"product_name": "🎉" * 100}}),
    ("160-cap-trailing-space", {"status": 1, "product": {"product_name": "z" * 159 + "  tail"}}),
    ("non-string-values", {"status": 1, "product": {"product_name": 12, "generic_name": ["a"], "brands": {"b": 1}}}),
    ("empty-product", {"status": 1, "product": {}}),
    ("missing-product", {"status": 1}),
    ("status-0-with-a-full-product", {"status": 0, "product": {"product_name": "Nutella"}}),
    (
        "status-verbose-is-never-parsed",
        {
            "status": 0,
            "status_verbose": "product found with a different product type: petfood",
            "product": {"product_name": "Cat food"},
        },
    ),
]


@pytest.mark.parametrize("body", [body for _, body in SYNTHETIC_BODIES], ids=[name for name, _ in SYNTHETIC_BODIES])
def test_server_and_spec_agree_on_synthetic_bodies(body: dict[str, Any]) -> None:
    """Edge cases the recorded fixtures do not exercise compare against the spec code."""
    assert server_off.derive_from_body(body) == spec_checker.derive(body)


def test_server_and_spec_agree_on_every_product_payload() -> None:
    """`derive_query_text(product)` == spec `derive()` for status-1 bodies.

    This is the function the proxy calls, so it must be the spec's algorithm.
    """
    products = [body["product"] for _, body in SYNTHETIC_BODIES if "product" in body]
    products += [
        {"product_name": "Nutella", "generic_name": "Hazelnut", "brands": "Ferrero"},
        {"product_name": "  ", "brands": "A, a, B"},
        {"product_name": None, "generic_name": None, "brands": None},
        {"product_name": "🎉" * 100},
    ]
    for product in products:
        expected = spec_checker.derive({"status": 1, "product": product})
        assert server_off.derive_query_text(product) == expected, product


CLEAN_INPUTS: list[Any] = [
    "Nutella",
    "Dulce   de leche",
    "Mle\u0301ko polotučné s obsahem  1,5% tuku",
    "\t\n\u00a0\u2003\u3000a b\r\n",
    "a\u200bb",
    "\ufeffleading bom",
    "Spaghetti Nº5",
    "",
    "   ",
    None,
    12,
    ["x"],
]


@pytest.mark.parametrize("value", CLEAN_INPUTS, ids=repr)
def test_clean_and_clean_brands_match_the_spec(value: Any) -> None:
    assert server_off.clean(value) == spec_checker.clean(value)
    assert server_off.clean_brands(value) == spec_checker.clean_brands(value)


def test_spec_checker_still_exits_ok(capsys: pytest.CaptureFixture[str]) -> None:
    """Run the executable contract exactly as CI / a human would: `python3 check_fixtures.py`."""
    assert spec_checker.main() == 0
    output = capsys.readouterr().out
    assert f"OK: {len(CASES)} fixtures" in output
    assert "all derived query texts match." in output


def test_fixture_directory_is_fully_covered() -> None:
    """Every recorded response is referenced by cases.json (no silent fixture drift)."""
    referenced = {case["file"] for case in CASES} | {"cases.json"}
    on_disk = {path.name for path in FIXTURES_DIR.glob("*.json")}
    assert on_disk == referenced
