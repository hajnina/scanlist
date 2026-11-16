"""Open Food Facts barcode lookup: proxy + in-process cache.

`shared/off/OFF.md` (normative spec v1, card S4) is the source of truth for the
request contract, the derived query text and the cache rules implemented here.
Card C8 aligned this module with it; the derived text is the only thing that
matters for correctness and `tests/test_off_parity.py` imports the spec's own
checker (`shared/off/check_fixtures.py`) and fails if the two ever drift.

Deliberately no personal data is sent: one anonymous GET per barcode, fixed
`User-Agent`, exactly five `fields=` values (OFF.md §2).
"""

from __future__ import annotations

import asyncio
import re
import time
import unicodedata
from dataclasses import dataclass
from datetime import timezone
from email.utils import parsedate_to_datetime
from typing import Any, Awaitable, Callable

import httpx

OFF_BASE_URL = "https://world.openfoodfacts.org"
# OFF.md §2: exactly these five fields. `categories` is provenance/debug only and
# never influences the derived text; `code` is requested so the response can be
# cross-checked against the barcode.
OFF_FIELDS = "code,product_name,brands,generic_name,categories"
OFF_USER_AGENT = "ScanList/0.1"

POSITIVE_TTL_SECONDS = 30 * 24 * 60 * 60  # 30 days (OFF.md §4)
NEGATIVE_TTL_SECONDS = 24 * 60 * 60  # 1 day (OFF.md §4)

# OFF.md §2: 3 s connect / 10 s total. httpx only has per-phase timeouts, so the
# per-phase caps stop a stuck connect/read, and `TOTAL_TIMEOUT_SECONDS` is enforced
# by `asyncio.wait_for` around the whole request (a slow-dripping body cannot
# stretch one attempt past the budget).
CONNECT_TIMEOUT_SECONDS = 3.0
READ_TIMEOUT_SECONDS = 10.0
TOTAL_TIMEOUT_SECONDS = 10.0
HTTP_TIMEOUT = httpx.Timeout(
    connect=CONNECT_TIMEOUT_SECONDS,
    read=READ_TIMEOUT_SECONDS,
    write=READ_TIMEOUT_SECONDS,
    pool=READ_TIMEOUT_SECONDS,
)

# OFF.md §3.3: hard cap in Unicode code points (scalar values, not UTF-16 units/bytes).
MAX_QUERY_CODEPOINTS = 160

# OFF.md §4.4: 5xx/timeout -> 1 s, 2 s, 4 s ... capped at 60 s, at most 3 attempts.
MAX_ATTEMPTS = 3
BACKOFF_BASE_SECONDS = 1.0
BACKOFF_CAP_SECONDS = 60.0
DEFAULT_RETRY_AFTER_SECONDS = 60.0

# OFF.md §4.6: SHOULD cap the cache at 1,000 entries.
MAX_CACHE_ENTRIES = 1000

# OFF.md §3.1: Unicode White_Space. U+200B (ZWSP) and U+FEFF (BOM) are NOT
# whitespace and are deliberately absent from this class.
_WHITESPACE_RUN = re.compile(
    "[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+"
)

BARCODE_RE = re.compile(r"^\d{8,14}$")

# OFF.md §3.1/§3.2: the only fields allowed to produce query text.
DERIVATION_FIELDS = ("product_name", "generic_name", "brands")


class OffUpstreamError(RuntimeError):
    """Open Food Facts could not be reached / answered unusably (-> HTTP 502)."""


class _RateLimited(Exception):
    """Internal: OFF answered 429; the caller records the Retry-After cooldown."""

    def __init__(self, retry_after: float) -> None:
        super().__init__(f"Open Food Facts rate limited; Retry-After {retry_after:g}s")
        self.retry_after = retry_after


@dataclass
class _CacheEntry:
    """OFF.md §4: text/hit/fetchedAt. `fetched_at` uses the injected clock."""

    fetched_at: float
    ttl_seconds: int
    payload: dict[str, Any]


def is_valid_barcode(barcode: str) -> bool:
    # fullmatch, not match: `$` also matches before a trailing newline, so
    # "12345678\n" would pass `.match()` and then blow up inside httpx
    # (InvalidURL is not an httpx.HTTPError) -> uncaught 500.
    return BARCODE_RE.fullmatch(barcode) is not None


def clean(value: object) -> str:
    """OFF.md §3.1 steps 1-4: non-strings are absent, NFC, collapse White_Space, trim."""
    if not isinstance(value, str):
        return ""
    return _WHITESPACE_RUN.sub(" ", unicodedata.normalize("NFC", value)).strip(" ")


def clean_brands(value: object) -> str:
    """OFF.md §3.1: comma-split, clean, casefold-dedupe (first spelling), join with ', '."""
    s = clean(value)
    if not s:
        return ""
    parts: list[str] = []
    seen: set[str] = set()
    for piece in s.split(","):
        piece = clean(piece)
        if not piece:
            continue
        key = piece.casefold()
        if key in seen:
            continue
        seen.add(key)
        parts.append(piece)
    return ", ".join(parts)


def derive_query_text(product: dict[str, Any] | None) -> str | None:
    """OFF.md §3.2-§3.4: product_name > generic_name > brands, 160 code points, else null.

    Strictly ONE field wins - never a concatenation, and never `categories`
    (requested for provenance only). `product_name` wins even when
    `generic_name`/`brands` are longer.
    """
    if not isinstance(product, dict):
        return None
    for candidate in (
        clean(product.get("product_name")),
        clean(product.get("generic_name")),
        clean_brands(product.get("brands")),
    ):
        if candidate:
            return candidate[:MAX_QUERY_CODEPOINTS].rstrip(" ")
    return None


def derive_from_body(body: Any) -> str | None:
    """OFF.md §3.6 `derive(body)`: status 1 + product object, then the field priority.

    The `code` value is not used: the text depends only on the returned fields.
    """
    if not isinstance(body, dict) or body.get("status") != 1:
        return None
    product = body.get("product")
    if not isinstance(product, dict):
        return None
    return derive_query_text(product)


def parse_retry_after(value: str | None, *, now_wall: float | None = None) -> float:
    """OFF.md §4.4: `Retry-After` is seconds or an HTTP-date; absent/invalid -> 60 s."""
    if not value or not value.strip():
        return DEFAULT_RETRY_AFTER_SECONDS
    text = value.strip()
    try:
        return max(0.0, float(text))
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(text)
    except (TypeError, ValueError):
        return DEFAULT_RETRY_AFTER_SECONDS
    if when is None:  # pragma: no cover - parsedate_to_datetime already raises
        return DEFAULT_RETRY_AFTER_SECONDS
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    now = time.time() if now_wall is None else now_wall
    return max(0.0, when.timestamp() - now)


def backoff_delay(attempt: int) -> float:
    """OFF.md §4.4: delay AFTER a failed attempt (1-based): 1, 2, 4, ... capped at 60 s."""
    return min(BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)), BACKOFF_CAP_SECONDS)


class OffClient:
    """Async OFF v2 product lookup implementing OFF.md §2/§4.

    Properties that the tests pin down:
    - fresh entries never hit the network; misses are negative-cached for 1 day;
    - a status-1 200 with no usable name is still a *positive* 30-day hit with
      `query_text: null` (OFF.md §2.1/§3.4);
    - transient failures write nothing, and an expired entry is still served as
      stale (stale-while-revalidate) without extending `fetchedAt`;
    - 5xx/timeouts retry with exponential backoff (max 3 attempts), 429 honours
      `Retry-After` before the next attempt at that barcode.

    `transport`, `clock`, `wall_clock` and `sleep` are injectable so tests use
    `httpx.MockTransport` with a fake clock and no real waiting.
    """

    def __init__(
        self,
        *,
        base_url: str = OFF_BASE_URL,
        transport: httpx.AsyncBaseTransport | None = None,
        positive_ttl: int = POSITIVE_TTL_SECONDS,
        negative_ttl: int = NEGATIVE_TTL_SECONDS,
        timeout: float | httpx.Timeout | None = None,
        total_timeout: float = TOTAL_TIMEOUT_SECONDS,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
        max_attempts: int = MAX_ATTEMPTS,
        max_entries: int = MAX_CACHE_ENTRIES,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.positive_ttl = positive_ttl
        self.negative_ttl = negative_ttl
        self.total_timeout = total_timeout
        self.clock = clock
        self.wall_clock = wall_clock
        self.sleep = sleep
        self.max_attempts = max(1, max_attempts)
        self.max_entries = max_entries
        self._cache: dict[str, _CacheEntry] = {}
        self._rate_limited_until: dict[str, float] = {}
        self._lock = asyncio.Lock()
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=HTTP_TIMEOUT if timeout is None else timeout,
            transport=transport,
            headers={"User-Agent": OFF_USER_AGENT, "Accept": "application/json"},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    def cache_size(self) -> int:
        return len(self._cache)

    def clear_cache(self) -> None:
        self._cache.clear()
        self._rate_limited_until.clear()

    def cache_entry_age(self, barcode: str) -> float | None:
        """Seconds since `fetchedAt` for a cached barcode (debug/tests)."""
        entry = self._cache.get(barcode)
        if entry is None:
            return None
        return max(0.0, self.clock() - entry.fetched_at)

    async def lookup(self, barcode: str) -> dict[str, Any]:
        """Return the normalised lookup payload, serving it from cache when fresh."""
        if not is_valid_barcode(barcode):
            raise ValueError("barcode must be 8-14 digits")

        fresh = self._fresh_cached(barcode)
        if fresh is not None:
            return fresh

        async with self._lock:
            # Another coroutine may have filled the cache while we waited.
            fresh = self._fresh_cached(barcode)
            if fresh is not None:
                return fresh

            stale = self._cache.get(barcode)
            retry_at = self._rate_limited_until.get(barcode)
            if retry_at is not None and self.clock() < retry_at:
                # OFF.md §4.4: never re-attempt a 429'd barcode before Retry-After.
                if stale is not None:
                    return self._stale_payload(stale)
                raise OffUpstreamError(
                    "Open Food Facts rate limited; "
                    f"retry in {max(0.0, retry_at - self.clock()):.0f}s"
                )

            try:
                payload = await self._fetch_with_retry(barcode)
            except OffUpstreamError:
                if stale is not None:
                    # OFF.md §4.3 stale-while-revalidate: serve the expired text for
                    # this tick, write nothing, leave `fetchedAt` untouched so the
                    # next scan retries.
                    return self._stale_payload(stale)
                raise

            self._rate_limited_until.pop(barcode, None)
            ttl = self.positive_ttl if payload["found"] else self.negative_ttl
            payload = {**payload, "ttl_seconds": ttl}
            self._cache[barcode] = _CacheEntry(
                fetched_at=self.clock(), ttl_seconds=ttl, payload=dict(payload)
            )
            self._evict_if_needed()
            return payload

    def _fresh_cached(self, barcode: str) -> dict[str, Any] | None:
        entry = self._cache.get(barcode)
        if entry is None:
            return None
        age = self.clock() - entry.fetched_at
        # OFF.md §4: expired exactly at TTL; a wall clock that moved backwards is fresh.
        if age < 0:
            age = 0.0
        if age >= entry.ttl_seconds:
            return None
        return {**entry.payload, "source": "cache", "ttl_seconds": entry.ttl_seconds}

    @staticmethod
    def _stale_payload(entry: _CacheEntry) -> dict[str, Any]:
        return {**entry.payload, "source": "stale", "ttl_seconds": entry.ttl_seconds}

    def _evict_if_needed(self) -> None:
        """OFF.md §4.6: cap the cache, evicting expired entries first, then oldest."""
        if len(self._cache) <= self.max_entries:
            return
        now = self.clock()
        for barcode, entry in list(self._cache.items()):
            if now - entry.fetched_at >= entry.ttl_seconds:
                self._cache.pop(barcode, None)
        while len(self._cache) > self.max_entries:
            oldest = min(self._cache.items(), key=lambda item: item[1].fetched_at)[0]
            self._cache.pop(oldest, None)

    async def _fetch_with_retry(self, barcode: str) -> dict[str, Any]:
        last: OffUpstreamError | None = None
        for attempt in range(1, self.max_attempts + 1):
            try:
                return await self._fetch(barcode)
            except _RateLimited as exc:
                self._rate_limited_until[barcode] = self.clock() + exc.retry_after
                raise OffUpstreamError(str(exc)) from exc
            except OffUpstreamError as exc:
                last = exc
                if attempt >= self.max_attempts:
                    break
                await self.sleep(backoff_delay(attempt))
        assert last is not None  # max_attempts >= 1 guarantees one failure
        raise last

    async def _fetch(self, barcode: str) -> dict[str, Any]:
        try:
            request = self._client.get(
                f"/api/v2/product/{barcode}.json", params={"fields": OFF_FIELDS}
            )
            # OFF.md §2: 10 s total, not just per phase (a slow-dripping body must
            # not stretch one attempt past the budget).
            response = await asyncio.wait_for(request, self.total_timeout)
        except (httpx.HTTPError, TimeoutError) as exc:  # connect/DNS/TLS and timeouts
            raise OffUpstreamError(f"Open Food Facts request failed: {exc}") from exc

        status_code = response.status_code
        if status_code == 429:
            raise _RateLimited(
                parse_retry_after(
                    response.headers.get("Retry-After"), now_wall=self.wall_clock()
                )
            )
        if status_code == 404:
            # Some OFF edges answer 404 for unknown barcodes instead of status=0.
            return self._payload(barcode, None, found=False, status=404)
        if status_code != 200:
            # 5xx, 3xx past the redirect limit, HTML/error pages: transient (never a miss).
            raise OffUpstreamError(f"Open Food Facts returned HTTP {status_code}")

        try:
            body = response.json()
        except ValueError as exc:
            raise OffUpstreamError("Open Food Facts returned non-JSON") from exc
        if not isinstance(body, dict):
            raise OffUpstreamError("Open Food Facts returned non-object JSON")

        # HTTP status and `status` are authoritative; `status_verbose` is never parsed.
        product = body.get("product")
        if body.get("status") != 1 or not isinstance(product, dict):
            return self._payload(barcode, None, found=False, status=_status_of(body))

        # OFF.md §2.1/§3.4: this is a hit even when every derivation field is empty
        # (positive 30-day cache with `query_text: null`), so it must never be
        # downgraded to a 1-day negative entry.
        picked = _pick_fields(product) if _has_product_content(product) else None
        return self._payload(
            barcode,
            picked,
            found=True,
            status=1,
            query_text=derive_query_text(product),
        )

    @staticmethod
    def _payload(
        barcode: str,
        product: dict[str, Any] | None,
        *,
        found: bool,
        status: int,
        query_text: str | None = None,
    ) -> dict[str, Any]:
        return {
            "barcode": barcode,
            "found": found,
            "status": status,
            "product": product,
            "query_text": query_text,
            "source": "network",
            "ttl_seconds": None,  # filled in by lookup()
        }


def _has_product_content(product: dict[str, Any]) -> bool:
    """True when at least one *derivation* field survives `clean()`.

    OFF.md §3.2: only `product_name`, `generic_name` and `brands` can produce text.
    Counting `categories` here used to make category-only products look like real
    hits with a category-derived query text.
    """
    return any(clean(product.get(key)) for key in DERIVATION_FIELDS)


def _pick_fields(product: dict[str, Any]) -> dict[str, Any]:
    picked: dict[str, Any] = {}
    for key in ("product_name", "brands", "generic_name", "categories"):
        value = product.get(key)
        picked[key] = value.strip() if isinstance(value, str) else None
    return picked


def _status_of(body: Any) -> int:
    if isinstance(body, dict) and isinstance(body.get("status"), int):
        return int(body["status"])
    return 0
