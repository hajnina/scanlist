"""Open Food Facts barcode lookup: proxy + in-process TTL cache.

Card S4 (`shared/off/OFF.md`) is the source of truth for the barcode -> query-text
spec and the recorded fixtures. Until it lands, this module implements the agreed
shape generically (fields=product_name,brands,generic_name,categories,
User-Agent `ScanList/0.1`, positive cache 30 days / negative 1 day) so the proxy
can be exercised end to end and re-aligned with one small function change
(`derive_query_text`) when S4's spec merges.

Deliberately no personal data is sent: one anonymous GET per barcode.
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass
from typing import Any, Callable

import httpx

OFF_BASE_URL = "https://world.openfoodfacts.org"
OFF_FIELDS = "product_name,brands,generic_name,categories"
OFF_USER_AGENT = "ScanList/0.1"
POSITIVE_TTL_SECONDS = 30 * 24 * 60 * 60  # 30 days
NEGATIVE_TTL_SECONDS = 24 * 60 * 60  # 1 day
HTTP_TIMEOUT_SECONDS = 8.0

BARCODE_RE = re.compile(r"^\d{8,14}$")


class OffUpstreamError(RuntimeError):
    """Open Food Facts could not be reached / answered unusably (-> HTTP 502)."""


@dataclass
class _CacheEntry:
    expires_at: float  # monotonic seconds
    payload: dict[str, Any]
    ttl_seconds: int


def is_valid_barcode(barcode: str) -> bool:
    # fullmatch, not match: `$` also matches before a trailing newline, so
    # "12345678\n" would pass `.match()` and then blow up inside httpx
    # (InvalidURL is not an httpx.HTTPError) -> uncaught 500.
    return BARCODE_RE.fullmatch(barcode) is not None


def derive_query_text(product: dict[str, Any] | None) -> str | None:
    """Build the text we embed as a *query* from a product payload.

    Generic on purpose: name first, then brand and category context, de-duplicated
    case-insensitively. S4's OFF.md may refine this (aliases, ordering) - when it
    merges, change only this function and the fixtures test.
    """
    if not product:
        return None
    parts: list[str] = []
    seen: set[str] = set()
    for key in ("product_name", "generic_name", "brands", "categories"):
        raw = product.get(key)
        if not isinstance(raw, str):
            continue
        for part in raw.split(","):
            part = " ".join(part.split())
            if part and part.casefold() not in seen:
                seen.add(part.casefold())
                parts.append(part)
    return ", ".join(parts) or None


class OffClient:
    """Async OFF v2 product lookup with positive/negative TTL caching.

    `transport` is injectable so tests use `httpx.MockTransport` (no network).
    The cache is an in-process dict for now; a shared Redis cache is out of scope
    until the server is deployed behind more than one worker.
    """

    def __init__(
        self,
        *,
        base_url: str = OFF_BASE_URL,
        transport: httpx.AsyncBaseTransport | None = None,
        positive_ttl: int = POSITIVE_TTL_SECONDS,
        negative_ttl: int = NEGATIVE_TTL_SECONDS,
        timeout: float = HTTP_TIMEOUT_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.positive_ttl = positive_ttl
        self.negative_ttl = negative_ttl
        self.clock = clock
        self._cache: dict[str, _CacheEntry] = {}
        self._lock = asyncio.Lock()
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=timeout,
            transport=transport,
            headers={"User-Agent": OFF_USER_AGENT, "Accept": "application/json"},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    def cache_size(self) -> int:
        return len(self._cache)

    def clear_cache(self) -> None:
        self._cache.clear()

    async def lookup(self, barcode: str) -> dict[str, Any]:
        """Return the normalised lookup payload, serving it from cache when fresh."""
        if not is_valid_barcode(barcode):
            raise ValueError("barcode must be 8-14 digits")

        cached = self._cached(barcode)
        if cached is not None:
            return cached

        async with self._lock:
            # Another coroutine may have filled the cache while we waited.
            cached = self._cached(barcode)
            if cached is not None:
                return cached
            payload = await self._fetch(barcode)
            ttl = self.positive_ttl if payload["found"] else self.negative_ttl
            payload["ttl_seconds"] = ttl
            self._cache[barcode] = _CacheEntry(
                expires_at=self.clock() + ttl, payload=payload, ttl_seconds=ttl
            )
            return payload

    def _cached(self, barcode: str) -> dict[str, Any] | None:
        entry = self._cache.get(barcode)
        if entry is None:
            return None
        if self.clock() >= entry.expires_at:
            self._cache.pop(barcode, None)
            return None
        # Cached responses say so, and keep the original fetch's ttl for debugging.
        return {**entry.payload, "source": "cache", "ttl_seconds": entry.ttl_seconds}

    async def _fetch(self, barcode: str) -> dict[str, Any]:
        try:
            response = await self._client.get(
                f"/api/v2/product/{barcode}.json", params={"fields": OFF_FIELDS}
            )
        except httpx.HTTPError as exc:  # network errors / timeouts
            raise OffUpstreamError(f"Open Food Facts request failed: {exc}") from exc

        if response.status_code == 404:
            # Some OFF edges answer 404 for unknown barcodes instead of status=0.
            return self._payload(barcode, None, found=False, status=404)
        if response.status_code >= 500:
            raise OffUpstreamError(f"Open Food Facts returned HTTP {response.status_code}")
        if response.status_code != 200:
            raise OffUpstreamError(f"Open Food Facts returned HTTP {response.status_code}")

        try:
            body = response.json()
        except ValueError as exc:
            raise OffUpstreamError("Open Food Facts returned non-JSON") from exc

        product = body.get("product") if isinstance(body, dict) else None
        if not isinstance(product, dict) or not _has_product_content(product):
            return self._payload(barcode, None, found=False, status=_status_of(body))
        return self._payload(barcode, _pick_fields(product), found=True, status=_status_of(body))

    @staticmethod
    def _payload(
        barcode: str, product: dict[str, Any] | None, *, found: bool, status: int
    ) -> dict[str, Any]:
        return {
            "barcode": barcode,
            "found": found,
            "status": status,
            "product": product,
            "query_text": derive_query_text(product),
            "source": "network",
            "ttl_seconds": None,  # filled in by lookup()
        }


def _has_product_content(product: dict[str, Any]) -> bool:
    return any(
        isinstance(product.get(key), str) and product[key].strip()
        for key in ("product_name", "generic_name", "brands", "categories")
    )


def _pick_fields(product: dict[str, Any]) -> dict[str, Any]:
    picked: dict[str, Any] = {}
    for key in ("product_name", "brands", "generic_name", "categories"):
        value = product.get(key)
        picked[key] = value.strip() if isinstance(value, str) else None
    return picked


def _status_of(body: Any) -> int:
    if isinstance(body, dict) and isinstance(body.get("status"), int):
        return body["status"]
    return 1
