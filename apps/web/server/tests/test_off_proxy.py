"""OFF proxy: normalisation, derived query text, TTL caching, failure mapping."""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app.off import OffClient, derive_query_text

BARCODE = "3017620422003"
NUTELLA = {
    "code": BARCODE,
    "product": {
        "product_name": "Nutella",
        "brands": "Ferrero",
        "generic_name": "Hazelnut spread with cocoa",
        "categories": "Spreads, Sweet spreads, Chocolate spreads",
    },
    "status": 1,
    "status_verbose": "product found",
}
NOT_FOUND = {"code": "0000000000000", "status": 0, "status_verbose": "product not found"}


class Recorder:
    """Records upstream requests and replays canned httpx responses per barcode."""

    def __init__(self, responses: dict[str, httpx.Response]) -> None:
        self.responses = responses
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        barcode = request.url.path.rsplit("/", 1)[-1].removesuffix(".json")
        response = self.responses.get(barcode)
        if response is None:
            return httpx.Response(500, json={"error": "unexpected barcode"})
        return response


def test_lookup_normalises_fields_and_derives_query_text(api, off_factory) -> None:
    recorder = Recorder({BARCODE: httpx.Response(200, json=NUTELLA)})
    client = api(off_factory(recorder))

    response = client.get(f"/off/{BARCODE}")
    assert response.status_code == 200
    body = response.json()

    assert body["barcode"] == BARCODE
    assert body["found"] is True
    assert body["source"] == "network"
    assert body["product"] == {
        "product_name": "Nutella",
        "brands": "Ferrero",
        "generic_name": "Hazelnut spread with cocoa",
        "categories": "Spreads, Sweet spreads, Chocolate spreads",
    }
    assert body["query_text"] == (
        "Nutella, Hazelnut spread with cocoa, Ferrero, Spreads, Sweet spreads, Chocolate spreads"
    )
    assert body["query_text"] == derive_query_text(body["product"])
    assert body["ttl_seconds"] == 30 * 24 * 60 * 60

    sent = recorder.requests[0]
    assert sent.url.params["fields"] == "product_name,brands,generic_name,categories"
    assert sent.headers["user-agent"] == "ScanList/0.1"
    assert "/api/v2/product/3017620422003.json" in str(sent.url)


def test_positive_lookup_is_cached_for_30_days(api, off_factory) -> None:
    now = [1000.0]
    recorder = Recorder({BARCODE: httpx.Response(200, json=NUTELLA)})
    client = api(off_factory(recorder, clock=lambda: now[0]))

    first = client.get(f"/off/{BARCODE}").json()
    second = client.get(f"/off/{BARCODE}").json()
    assert len(recorder.requests) == 1
    assert first["source"] == "network"
    assert second["source"] == "cache"
    assert second["query_text"] == first["query_text"]

    # Just inside the 30-day window: still cached.
    now[0] += 30 * 24 * 60 * 60 - 1
    assert client.get(f"/off/{BARCODE}").json()["source"] == "cache"
    assert len(recorder.requests) == 1

    # Past it: refetch.
    now[0] += 2
    assert client.get(f"/off/{BARCODE}").json()["source"] == "network"
    assert len(recorder.requests) == 2


def test_negative_lookup_is_cached_for_one_day(api, off_factory) -> None:
    now = [0.0]
    recorder = Recorder({"0000000000000": httpx.Response(200, json=NOT_FOUND)})
    client = api(off_factory(recorder, clock=lambda: now[0]))

    first = client.get("/off/0000000000000").json()
    assert first["found"] is False
    assert first["product"] is None
    assert first["query_text"] is None
    assert first["ttl_seconds"] == 24 * 60 * 60

    now[0] += 24 * 60 * 60 - 1
    cached = client.get("/off/0000000000000").json()
    assert cached["found"] is False
    assert cached["source"] == "cache"
    assert len(recorder.requests) == 1

    now[0] += 2
    assert client.get("/off/0000000000000").json()["source"] == "network"
    assert len(recorder.requests) == 2


def test_upstream_404_is_a_negative_answer(api, off_factory) -> None:
    recorder = Recorder({"12345678": httpx.Response(404, json={"status": 0})})
    client = api(off_factory(recorder))

    response = client.get("/off/12345678")
    assert response.status_code == 200
    body = response.json()
    assert body["found"] is False
    assert body["status"] == 404
    assert body["ttl_seconds"] == 24 * 60 * 60


def test_product_without_usable_fields_is_not_found(api, off_factory) -> None:
    empty = {"code": BARCODE, "product": {"product_name": "", "brands": None}, "status": 1}
    recorder = Recorder({BARCODE: httpx.Response(200, json=empty)})
    client = api(off_factory(recorder))

    body = client.get(f"/off/{BARCODE}").json()
    assert body["found"] is False
    assert body["product"] is None
    assert body["query_text"] is None


def test_upstream_5xx_maps_to_502_and_is_not_cached(api, off_factory) -> None:
    recorder = Recorder({BARCODE: httpx.Response(503, text="nope")})
    off = off_factory(recorder)
    client = api(off)

    first = client.get(f"/off/{BARCODE}")
    second = client.get(f"/off/{BARCODE}")
    assert first.status_code == 502
    assert second.status_code == 502
    assert len(recorder.requests) == 2
    assert off.cache_size() == 0


def test_upstream_network_error_maps_to_502(api) -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline", request=request)

    off = OffClient(transport=httpx.MockTransport(boom))
    client = api(off)

    response = client.get(f"/off/{BARCODE}")
    assert response.status_code == 502
    assert "Open Food Facts request failed" in response.json()["detail"]


@pytest.mark.parametrize("barcode", ["1234567", "123456789012345", "301762042200X", "abcdefgh"])
def test_invalid_barcode_is_422(api, off_factory, barcode: str) -> None:
    recorder = Recorder({})
    client = api(off_factory(recorder))

    assert client.get(f"/off/{barcode}").status_code == 422
    assert recorder.requests == []


@pytest.mark.parametrize(
    "path", ["/off/12345678%0A", "/off/12345678%0D%0A", "/off/%2012345678", "/off/12345678%20"]
)
def test_barcode_with_trailing_newline_is_rejected_not_500(api, off_factory, path: str) -> None:
    """Regression (PR #5 review): `BARCODE_RE.match` accepted "12345678\\n" because `$`
    matches before a trailing newline; the barcode then reached httpx, whose InvalidURL
    is *not* an httpx.HTTPError, escaping the handlers as an uncaught 500."""
    recorder = Recorder({})
    client = api(off_factory(recorder))

    response = client.get(path)
    assert response.status_code in (400, 422), response.text
    assert recorder.requests == []


def test_derive_query_text_dedupes_and_skips_empty_parts() -> None:
    product = {
        "product_name": "Nutella",
        "generic_name": "",
        "brands": "Ferrero, Nutella",
        "categories": None,
    }
    assert derive_query_text(product) == "Nutella, Ferrero"
    assert derive_query_text(None) is None
    assert derive_query_text({}) is None
