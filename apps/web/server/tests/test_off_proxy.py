"""OFF proxy: OFF.md §3 derivation, §2 request contract, §4 cache/backoff/honesty.

Every test is offline: `httpx.MockTransport` replays canned OFF responses and the
client's clock/sleep are injected so retry backoff costs no wall-clock time.
Spec parity itself is checked in `test_off_parity.py`.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from app.off import (
    CONNECT_TIMEOUT_SECONDS,
    MAX_QUERY_CODEPOINTS,
    OFF_FIELDS,
    READ_TIMEOUT_SECONDS,
    TOTAL_TIMEOUT_SECONDS,
    OffClient,
    backoff_delay,
    clean,
    clean_brands,
    derive_from_body,
    derive_query_text,
    parse_retry_after,
)

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


class Sleeper:
    """Records backoff delays instead of waiting for them."""

    def __init__(self) -> None:
        self.delays: list[float] = []

    async def __call__(self, delay: float) -> None:
        self.delays.append(delay)


def test_lookup_derives_query_text_per_off_md(api, off_factory) -> None:
    recorder = Recorder({BARCODE: httpx.Response(200, json=NUTELLA)})
    client = api(off_factory(recorder))

    response = client.get(f"/off/{BARCODE}")
    assert response.status_code == 200
    body = response.json()

    assert body["barcode"] == BARCODE
    assert body["found"] is True
    assert body["status"] == 1
    assert body["source"] == "network"
    assert body["product"] == {
        "product_name": "Nutella",
        "brands": "Ferrero",
        "generic_name": "Hazelnut spread with cocoa",
        "categories": "Spreads, Sweet spreads, Chocolate spreads",
    }
    # OFF.md §3.2: strictly ONE field wins - no concatenation, no categories.
    assert body["query_text"] == "Nutella"
    assert body["query_text"] == derive_query_text(body["product"])
    assert body["ttl_seconds"] == 30 * 24 * 60 * 60


def test_request_contract_fields_user_agent_timeouts(api, off_factory) -> None:
    """OFF.md §2: five `fields` values exactly, fixed UA, 3 s connect / 10 s total."""
    recorder = Recorder({BARCODE: httpx.Response(200, json=NUTELLA)})
    off = off_factory(recorder)
    client = api(off)

    client.get(f"/off/{BARCODE}")

    sent = recorder.requests[0]
    assert sent.url.params["fields"] == "code,product_name,brands,generic_name,categories"
    assert sent.url.params["fields"] == OFF_FIELDS
    assert "product_name" in OFF_FIELDS and "generic_name" in OFF_FIELDS
    assert OFF_FIELDS.split(",")[0] == "code"
    assert sent.headers["user-agent"] == "ScanList/0.1"
    assert sent.headers["accept"] == "application/json"
    assert sent.url.host == "world.openfoodfacts.org"
    assert "/api/v2/product/3017620422003.json" in str(sent.url)

    timeout = off._client.timeout
    assert timeout.connect == CONNECT_TIMEOUT_SECONDS == 3.0
    assert timeout.read == READ_TIMEOUT_SECONDS == 10.0
    assert off.total_timeout == TOTAL_TIMEOUT_SECONDS == 10.0


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

    # OFF.md §4: exactly at TTL the entry is expired.
    now[0] += 1
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

    now[0] += 1  # exactly at TTL -> expired (OFF.md §4)
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
    assert body["query_text"] is None
    assert body["ttl_seconds"] == 24 * 60 * 60


def test_hit_without_usable_name_is_a_positive_30_day_hit(api, off_factory) -> None:
    """OFF.md §2.1/§3.4: HTTP 200 + status 1 is a hit even with `text: null`.

    Before C8 the empty product was a 1-day negative entry, so the app re-asked
    OFF every day for a badly-filled product that the API had answered for.
    """
    now = [0.0]
    empty = {"code": BARCODE, "product": {"product_name": "", "brands": None}, "status": 1}
    recorder = Recorder({BARCODE: httpx.Response(200, json=empty)})
    client = api(off_factory(recorder, clock=lambda: now[0]))

    body = client.get(f"/off/{BARCODE}").json()
    assert body["found"] is True
    assert body["product"] is None  # nothing usable to show the UI
    assert body["query_text"] is None
    assert body["ttl_seconds"] == 30 * 24 * 60 * 60

    now[0] += 24 * 60 * 60 + 1  # past the old 1-day negative TTL
    assert client.get(f"/off/{BARCODE}").json()["source"] == "cache"
    assert len(recorder.requests) == 1


def test_categories_never_produce_query_text(api, off_factory) -> None:
    """Regression for C8 fix 1/3: `categories` is provenance only (OFF.md §2/§3.2)."""
    now = [0.0]
    body = {
        "code": BARCODE,
        "product": {
            "product_name": "",
            "generic_name": "   ",
            "brands": "",
            "categories": "Spreads, Sweet spreads",
        },
        "status": 1,
    }
    recorder = Recorder({BARCODE: httpx.Response(200, json=body)})
    client = api(off_factory(recorder, clock=lambda: now[0]))

    answer = client.get(f"/off/{BARCODE}").json()
    assert answer["query_text"] is None
    # A category-only product is still a status-1 hit: positive, not 1-day negative.
    assert answer["found"] is True
    assert answer["ttl_seconds"] == 30 * 24 * 60 * 60
    now[0] += 24 * 60 * 60 + 1
    assert client.get(f"/off/{BARCODE}").json()["source"] == "cache"


def test_upstream_5xx_is_retried_then_502_and_not_cached(api, off_factory) -> None:
    recorder = Recorder({BARCODE: httpx.Response(503, text="nope")})
    sleeper = Sleeper()
    off = off_factory(recorder, sleep=sleeper)
    client = api(off)

    first = client.get(f"/off/{BARCODE}")
    assert first.status_code == 502
    assert "HTTP 503" in first.json()["detail"]
    # OFF.md §4.4: at most 3 attempts per scan, backoff 1 s then 2 s.
    assert len(recorder.requests) == 3
    assert sleeper.delays == [1.0, 2.0]
    assert off.cache_size() == 0

    second = client.get(f"/off/{BARCODE}")
    assert second.status_code == 502
    assert len(recorder.requests) == 6  # nothing cached, so a fresh 3-attempt burst
    assert off.cache_size() == 0


def test_retry_recovers_on_second_attempt(api, off_factory) -> None:
    responses = [httpx.Response(500, text="oops"), httpx.Response(200, json=NUTELLA)]
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return responses.pop(0)

    sleeper = Sleeper()
    client = api(off_factory(handler, sleep=sleeper))

    body = client.get(f"/off/{BARCODE}").json()
    assert body["found"] is True
    assert body["query_text"] == "Nutella"
    assert len(calls) == 2
    assert sleeper.delays == [1.0]


def test_timeout_is_transient_and_retried(api, off_factory) -> None:
    attempts: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(request)
        raise httpx.ConnectTimeout("slow", request=request)

    sleeper = Sleeper()
    off = off_factory(handler, sleep=sleeper)
    client = api(off)

    response = client.get(f"/off/{BARCODE}")
    assert response.status_code == 502
    assert len(attempts) == 3
    assert sleeper.delays == [1.0, 2.0]
    assert off.cache_size() == 0


def test_total_timeout_caps_a_slow_body_and_is_transient(api, off_factory) -> None:
    """OFF.md §2: 10 s total - a slow-dripping response cannot stretch an attempt."""
    attempts: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(request)
        await asyncio.sleep(0.05)
        return httpx.Response(200, json=NUTELLA)

    sleeper = Sleeper()
    off = off_factory(handler, total_timeout=0.005, sleep=sleeper)
    client = api(off)

    response = client.get(f"/off/{BARCODE}")
    assert response.status_code == 502
    assert len(attempts) == 3  # timeouts are retried, then mapped to 502
    assert sleeper.delays == [1.0, 2.0]
    assert off.cache_size() == 0


def test_backoff_delay_is_exponential_and_capped() -> None:
    assert [backoff_delay(n) for n in (1, 2, 3, 4, 5)] == [1.0, 2.0, 4.0, 8.0, 16.0]
    assert backoff_delay(7) == 60.0
    assert backoff_delay(30) == 60.0


def test_non_json_200_is_transient(api, off_factory) -> None:
    recorder = Recorder({BARCODE: httpx.Response(200, text="<html>captive portal</html>")})
    sleeper = Sleeper()
    off = off_factory(recorder, sleep=sleeper)
    client = api(off)

    assert client.get(f"/off/{BARCODE}").status_code == 502
    assert len(recorder.requests) == 3
    assert off.cache_size() == 0


def test_upstream_429_honours_retry_after(api, off_factory) -> None:
    """OFF.md §4.4: wait at least Retry-After before the next attempt at that barcode."""
    now = [500.0]
    recorder = Recorder(
        {BARCODE: httpx.Response(429, headers={"Retry-After": "120"}, json={})}
    )
    sleeper = Sleeper()
    off = off_factory(recorder, clock=lambda: now[0], sleep=sleeper)
    client = api(off)

    first = client.get(f"/off/{BARCODE}")
    assert first.status_code == 502
    assert "rate limited" in first.json()["detail"]
    assert len(recorder.requests) == 1  # 429 is never retried in the same scan
    assert sleeper.delays == []
    assert off.cache_size() == 0  # transient failures write nothing

    # Inside the Retry-After window: no new upstream request at all.
    now[0] += 119
    assert client.get(f"/off/{BARCODE}").status_code == 502
    assert len(recorder.requests) == 1

    # Once Retry-After has elapsed the next scan may ask again.
    now[0] += 2
    assert client.get(f"/off/{BARCODE}").status_code == 502
    assert len(recorder.requests) == 2


def test_transient_failure_serves_stale_text_without_extending_fetched_at(api, off_factory) -> None:
    """OFF.md §4.3 stale-while-revalidate: serve stale, write nothing, keep fetchedAt."""
    now = [1000.0]
    recorder = Recorder({BARCODE: httpx.Response(200, json=NUTELLA)})
    sleeper = Sleeper()
    off = off_factory(recorder, clock=lambda: now[0], sleep=sleeper)
    client = api(off)

    assert client.get(f"/off/{BARCODE}").json()["query_text"] == "Nutella"

    # Entry expires, OFF starts failing: the cached text must still be used.
    now[0] += 30 * 24 * 60 * 60 + 10
    recorder.responses[BARCODE] = httpx.Response(503, text="maintenance")
    stale = client.get(f"/off/{BARCODE}")
    assert stale.status_code == 200
    body = stale.json()
    assert body["source"] == "stale"
    assert body["query_text"] == "Nutella"
    assert body["ttl_seconds"] == 30 * 24 * 60 * 60
    assert len(recorder.requests) == 4  # 1 hit + one 3-attempt burst
    # Nothing written and `fetchedAt` not extended, so the next scan retries.
    assert off.cache_size() == 1
    assert off.cache_entry_age(BARCODE) == pytest.approx(30 * 24 * 60 * 60 + 10)

    # Once OFF recovers, the retry refreshes the entry with a brand-new fetchedAt.
    recorder.responses[BARCODE] = httpx.Response(
        200, json={**NUTELLA, "product": {**NUTELLA["product"], "product_name": "Nutella 2"}}
    )
    fresh = client.get(f"/off/{BARCODE}").json()
    assert fresh["source"] == "network"
    assert fresh["query_text"] == "Nutella 2"
    assert off.cache_entry_age(BARCODE) == 0
    assert len(recorder.requests) == 5


def test_transient_failure_without_entry_is_502(api, off_factory) -> None:
    """A failed *first* lookup yields nothing for that tick and writes no cache entry."""
    recorder = Recorder({BARCODE: httpx.Response(503, text="down")})
    off = off_factory(recorder, sleep=Sleeper())
    client = api(off)

    response = client.get(f"/off/{BARCODE}")
    assert response.status_code == 502
    assert "detail" in response.json()
    assert off.cache_size() == 0
    assert off.cache_entry_age(BARCODE) is None


def test_429_cooldown_also_serves_stale_text(api, off_factory) -> None:
    now = [0.0]
    recorder = Recorder({BARCODE: httpx.Response(200, json=NUTELLA)})
    off = off_factory(recorder, clock=lambda: now[0])
    client = api(off)

    client.get(f"/off/{BARCODE}")
    now[0] += 30 * 24 * 60 * 60 + 1
    recorder.responses[BARCODE] = httpx.Response(
        429, headers={"Retry-After": "60"}, json={}
    )
    body = client.get(f"/off/{BARCODE}").json()
    assert body["source"] == "stale"
    assert body["query_text"] == "Nutella"

    # Still inside the cooldown: no request, stale text again.
    recorder.responses[BARCODE] = httpx.Response(200, json=NUTELLA)
    before = len(recorder.requests)
    assert client.get(f"/off/{BARCODE}").json()["source"] == "stale"
    assert len(recorder.requests) == before

    now[0] += 61
    assert client.get(f"/off/{BARCODE}").json()["source"] == "network"


def test_clock_moving_backwards_keeps_entry_fresh(api, off_factory) -> None:
    """OFF.md §4: `now < fetchedAt` is treated as fresh (age clamped to 0)."""
    now = [10_000.0]
    recorder = Recorder({BARCODE: httpx.Response(200, json=NUTELLA)})
    client = api(off_factory(recorder, clock=lambda: now[0]))

    client.get(f"/off/{BARCODE}")
    now[0] -= 5_000
    assert client.get(f"/off/{BARCODE}").json()["source"] == "cache"
    assert len(recorder.requests) == 1


def test_cache_is_capped(api, off_factory) -> None:
    """OFF.md §4.6: SHOULD cap at 1,000 entries; oldest entry is evicted here."""
    now = [0.0]
    recorder = Recorder(
        {barcode: httpx.Response(200, json={**NUTELLA, "code": barcode})
         for barcode in ("11111111", "22222222", "33333333")}
    )

    off = off_factory(recorder, clock=lambda: now[0], max_entries=2)
    client = api(off)

    for barcode in ("11111111", "22222222", "33333333"):
        now[0] += 1
        assert client.get(f"/off/{barcode}").status_code == 200
    assert off.cache_size() == 2


def test_parse_retry_after_accepts_seconds_and_http_dates() -> None:
    assert parse_retry_after("120") == 120.0
    assert parse_retry_after(" 0 ") == 0.0
    assert parse_retry_after(None) == 60.0
    assert parse_retry_after("soon-ish") == 60.0

    http_date = "Mon, 16 Nov 2026 20:00:00 GMT"
    from email.utils import parsedate_to_datetime

    deadline = parsedate_to_datetime(http_date).timestamp()
    assert parse_retry_after(http_date, now_wall=deadline - 90) == pytest.approx(90.0, abs=1)


def test_upstream_network_error_maps_to_502(api) -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline", request=request)

    off = OffClient(transport=httpx.MockTransport(boom), sleep=Sleeper())
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


# --- derivation unit tests (OFF.md §3) -------------------------------------------------


def test_clean_composes_nfc_collapses_whitespace_and_keeps_the_rest() -> None:
    assert clean("Dulce   de leche") == "Dulce de leche"
    assert clean("Mle\u0301ko") == "Mléko"  # NFC composition
    assert clean("\u00a0 a \t\u3000b\u200b ") == "a b\u200b"  # NBSP/ideographic space collapse
    assert clean("Spaghetti Nº5") == "Spaghetti Nº5"
    assert clean("Coca-Cola Original") == "Coca-Cola Original"
    assert clean(None) == ""
    assert clean(42) == ""
    assert clean(["x"]) == ""


def test_clean_brands_splits_cleans_dedupes_and_joins() -> None:
    assert clean_brands("Ferrero,  Nutella , FERRERO") == "Ferrero, Nutella"
    assert clean_brands("a,,b, ,A") == "a, b"
    assert clean_brands("") == ""
    assert clean_brands(None) == ""


def test_derive_priority_is_strictly_one_field() -> None:
    assert (
        derive_query_text(
            {
                "product_name": "Nutella",
                "generic_name": "Hazelnut And Cocoa Spread",
                "brands": "Ferrero, Nutella",
            }
        )
        == "Nutella"
    )
    assert (
        derive_query_text({"product_name": "  ", "generic_name": "Désodorisant pour litière"})
        == "Désodorisant pour litière"
    )
    assert derive_query_text({"product_name": "", "generic_name": "", "brands": "Carrefour"}) == (
        "Carrefour"
    )
    assert derive_query_text({"categories": "Spreads, Sweet spreads"}) is None
    assert derive_query_text({}) is None
    assert derive_query_text(None) is None


def test_derive_caps_at_160_code_points_and_trims_trailing_space() -> None:
    assert MAX_QUERY_CODEPOINTS == 160
    long_name = "é" * 170
    assert len(derive_query_text({"product_name": long_name}) or "") == 160
    cut = derive_query_text({"product_name": "a" * 159 + " b"})
    assert cut == "a" * 159
    assert len(cut or "") == 159


def test_derive_from_body_requires_status_1() -> None:
    assert derive_from_body(NUTELLA) == "Nutella"
    assert derive_from_body({**NUTELLA, "status": 0}) is None
    assert derive_from_body({"status": 1}) is None
    assert derive_from_body({"status": 1, "product": "nope"}) is None
    assert derive_from_body(None) is None
    # 404 fixture shape: status 0 + status_verbose must not fool the derivation.
    assert derive_from_body(
        {
            "code": "3560070829668",
            "status": 0,
            "status_verbose": "product found with a different product type: petfood",
        }
    ) is None


def test_payload_shape_is_stable(api, off_factory) -> None:
    """Frontend contract: the same keys as C1, whoever answers."""
    recorder = Recorder({BARCODE: httpx.Response(200, json=NUTELLA)})
    client = api(off_factory(recorder))

    body = client.get(f"/off/{BARCODE}").json()
    assert set(body) == {
        "barcode",
        "found",
        "status",
        "product",
        "query_text",
        "source",
        "ttl_seconds",
    }
