"""ScanList reference implementation: flatten a list and rank items against queries.

Normative sources (read these, not this file, when in doubt):

* ``shared/spec/FLATTEN.md`` — traversal order, item ids, ``docText`` (§4/§6).
* ``shared/spec/RANK.md`` — truncation, q6, fusion, barcode boost, EMA, hysteresis,
  output order, degraded states, 400 ms cadence (§1–§9), worked example (§10).

This module is pure Python + numpy: no model, no I/O beyond :func:`load_list`.
It is the oracle the Kotlin / React Native / Web tracks are compared against
(``shared/fixtures/golden.json``, card S3/S8), so every number that is stored or
compared goes through :func:`q6` exactly as RANK.md §5 defines it.

Typical use::

    items = flatten(load_list("shared/spec/samples/van-weekly.json"))
    out = rank(items, {"text": [q_vec], "image": []},
               {"smoothed": {}, "topId": None}, barcode_name=None)
    out["entries"][0]["id"]  # highlighted item

``vec`` (already-truncated, L2-normalised 256-d; ``null`` while not yet embedded)
lives on the **input** items passed to ``rank()`` (RANK.md §1). Neither
``flatten()`` output nor ``rank()``'s ``entries`` carry a ``vec`` key — FLATTEN.md
§1 and RANK.md §1 are exact, and cross-track equality depends on it. Attach
vectors to the flattened items before calling ``rank()``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import time
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, Optional

import numpy as np

__all__ = [
    "DIMS_ACTIVE",
    "EMA_ALPHA",
    "HYSTERESIS",
    "MIN_INTERVAL_MS",
    "BARCODE_BOOST",
    "MAX_TEXT_QUERIES",
    "q6",
    "cosine",
    "truncate_and_normalize",
    "norm_barcode_text",
    "barcode_match",
    "flatten",
    "doc_text",
    "doc_texts",
    "item_vector_cache_key",
    "load_list",
    "item_vector",
    "rank",
    "decide_top",
    "sort_candidates",
    "unranked",
    "RankTicker",
    "now_ms",
]

logger = logging.getLogger(__name__)

# --- RANK.md constants (v1 defaults, not calibrated; card X1 revises) --------
DIMS_ACTIVE = 256          # §2 active dims, first 256 components
EMA_ALPHA = 0.5            # §4
HYSTERESIS = 0.02          # §5/§6, strictly greater than this switches the top
MIN_INTERVAL_MS = 400      # §7
BARCODE_BOOST = 0.15       # §3
MAX_TEXT_QUERIES = 16      # §2.2 barcode + OCR lines per tick
_CACHE_KEY_SALT = "scanlist-item-vector/1\n"


# ---------------------------------------------------------------------------
# §5 canonical rounding
# ---------------------------------------------------------------------------
def q6(x: float) -> float:
    """Round to 6 decimals, half away from zero (RANK.md §5).

    ``q6(-0.0) == 0.0`` and a tiny negative that rounds to zero returns ``+0.0``.
    Non-finite input is not a score; it degrades to ``0.0`` instead of crashing
    (RANK.md §8 requires bad vectors to be dropped, never propagated).
    """
    x = float(x)
    if not math.isfinite(x):
        return 0.0
    if x == 0.0:
        return 0.0
    rounded = math.copysign(math.floor(abs(x) * 1e6 + 0.5) / 1e6, x)
    return 0.0 if rounded == 0.0 else rounded


def _q6_array(x: np.ndarray) -> np.ndarray:
    """Vectorised :func:`q6`; identical IEEE-754 operations, same result."""
    with np.errstate(invalid="ignore", over="ignore"):
        rounded = np.copysign(np.floor(np.abs(x) * 1e6 + 0.5) / 1e6, x)
        rounded = np.where(rounded == 0.0, 0.0, rounded)
        rounded = np.where(np.isfinite(rounded), rounded, 0.0)
    return rounded


# ---------------------------------------------------------------------------
# §2 vectors: truncation, normalisation, cosine
# ---------------------------------------------------------------------------
def truncate_and_normalize(vec: Sequence[float], dims: int = DIMS_ACTIVE) -> np.ndarray:
    """First ``dims`` components, widened to float64, then L2-normalised (§2).

    Model output is float32; widening to float64 is exact. Truncation happens
    *before* normalisation. A vector whose norm is below ``1e-12`` becomes the
    all-zero vector (cosine 0.0 with everything, never NaN).
    """
    v = np.asarray(vec, dtype=np.float64).reshape(-1)
    if v.size < dims:
        raise ValueError(f"vector has {v.size} dims, need at least {dims}")
    t = np.array(v[:dims], dtype=np.float64, copy=True)
    if not np.all(np.isfinite(t)):
        raise ValueError("vector contains NaN/Inf")
    n = math.sqrt(math.fsum(float(c) * float(c) for c in t))
    if n < 1e-12:
        return np.zeros(dims, dtype=np.float64)
    return t / n


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    """Dot product of two same-length vectors, summed in ascending index order.

    Exact (``math.fsum`` → correctly rounded) and therefore platform-stable,
    which is what the golden fixtures want. ``rank`` uses a matrix product for
    speed; RANK.md §5 allows that because q6 absorbs sub-1e-6 dot-order noise.
    """
    return math.fsum(float(x) * float(y) for x, y in zip(a, b))


def item_vector(item: Mapping[str, Any], dims: int = DIMS_ACTIVE) -> Optional[np.ndarray]:
    """Return the item's usable vector, or ``None`` if it must be skipped (§8).

    Items carry vectors that are already truncated and L2-normalised; this only
    validates dims/finiteness (it never renormalises, so golden values cannot
    drift). ``None`` means "not embedded yet / broken" and blocks the tick.
    """
    raw = item.get("vec")
    if raw is None:
        return None
    try:
        v = np.asarray(raw, dtype=np.float64).reshape(-1)
    except (TypeError, ValueError):
        logger.error("item %r: unreadable vector, treated as missing", item.get("id"))
        return None
    if v.size != dims:
        logger.error(
            "item %r: vector has %d dims, expected %d; treated as missing",
            item.get("id"), v.size, dims,
        )
        return None
    if not np.all(np.isfinite(v)):
        logger.error("item %r: vector contains NaN/Inf; treated as missing", item.get("id"))
        return None
    return v


def _prepare_queries(queries: Any, dims: int) -> tuple[list[np.ndarray], list[np.ndarray]]:
    """Validate/pool ``{"text": [...], "image": [...]}`` per RANK.md §2.2/§8.

    Zero vectors are kept (cosine 0.0); NaN/Inf and wrong-dim vectors are
    dropped so they can never leak into a score. Text queries are capped at 16.
    """
    if queries is None:
        return [], []
    if not isinstance(queries, Mapping):
        raise TypeError("queries must be a mapping with 'text' and/or 'image' keys")

    def _clean(raw_vecs: Iterable[Any], kind: str) -> list[np.ndarray]:
        out: list[np.ndarray] = []
        for i, raw in enumerate(() if raw_vecs is None else raw_vecs):
            try:
                v = np.asarray(raw, dtype=np.float64).reshape(-1)
            except (TypeError, ValueError):
                logger.error("dropping unreadable %s query #%d", kind, i)
                continue
            if v.size != dims:
                logger.error("dropping %s query #%d: %d dims, expected %d",
                             kind, i, v.size, dims)
                continue
            if not np.all(np.isfinite(v)):
                logger.error("dropping %s query #%d: NaN/Inf", kind, i)
                continue
            out.append(v)
        return out

    text = _clean(queries.get("text"), "text")
    image = _clean(queries.get("image"), "image")
    if len(text) > MAX_TEXT_QUERIES:
        logger.warning("using the first %d of %d text queries (RANK.md §2.2)",
                       MAX_TEXT_QUERIES, len(text))
        text = text[:MAX_TEXT_QUERIES]
    return text, image


# ---------------------------------------------------------------------------
# §3.1 barcode matching
# ---------------------------------------------------------------------------
def norm_barcode_text(s: str) -> str:
    """NFC, casefold, trim, collapse every run of Unicode whitespace to one space."""
    folded = unicodedata.normalize("NFC", str(s)).casefold()
    return " ".join(folded.split())


def _matches_normalised(item: Mapping[str, Any], target: str) -> bool:
    if norm_barcode_text(item.get("name", "")) == target:
        return True
    return any(norm_barcode_text(a) == target for a in (item.get("aliases") or ()))


def barcode_match(item: Mapping[str, Any], barcode_name: Optional[str]) -> bool:
    """Exact (normalised) match against the item name or one of its aliases."""
    if not barcode_name:
        return False
    target = norm_barcode_text(barcode_name)
    if not target:
        return False
    return _matches_normalised(item, target)


# ---------------------------------------------------------------------------
# FLATTEN.md: traversal, ids, doc text
# ---------------------------------------------------------------------------
def flatten(list_obj: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Depth-first flatten (items before sub-sections), FLATTEN.md §2/§3/§5.

    Ids are explicit when present (trimmed verbatim), otherwise
    ``"sha1:" + sha1(utf8(pathKey + name + "#" + index))``; collisions get
    ``~2``, ``~3`` suffixes in flatten order. ``order`` is the global position.
    """
    out: list[dict[str, Any]] = []
    used: set[str] = set()

    def walk(section: Mapping[str, Any], path: list[str]) -> None:
        for i, item in enumerate(section.get("items") or ()):
            explicit = item.get("id")
            explicit = explicit.strip() if isinstance(explicit, str) and explicit.strip() else None
            if explicit is None:
                key = ("/".join(path) + "/" if path else "") + item["name"] + "#" + str(i)
                base = "sha1:" + hashlib.sha1(key.encode("utf-8")).hexdigest()
            else:
                base = explicit
            item_id, n = base, 2
            while item_id in used:
                item_id = f"{base}~{n}"
                n += 1
            used.add(item_id)

            aliases: list[str] = []
            seen: set[str] = set()
            for raw_alias in item.get("aliases") or ():
                alias = raw_alias.strip() if isinstance(raw_alias, str) else ""
                norm = unicodedata.normalize("NFC", alias).casefold()
                if alias and norm not in seen:
                    seen.add(norm)
                    aliases.append(alias)

            amount = item.get("amount")
            if isinstance(amount, str) and not amount.strip():
                amount = None
            unit = item.get("unit")
            unit = unit.strip() if isinstance(unit, str) else ""
            note = item.get("note")
            note = note.strip() if isinstance(note, str) else ""

            out.append({
                "id": item_id,
                "name": item["name"].strip(),
                "amount": amount,
                "unit": unit or None,
                "note": note or None,
                "aliases": aliases,
                "done": bool(item.get("done", False)),
                "path": list(path),
                "pathText": " > ".join(path),
                "index": i,
                "order": len(out),
            })
        for child in section.get("sections") or ():
            walk(child, path + [child["name"]])

    for section in list_obj.get("sections") or ():
        walk(section, [section["name"]])
    return out


def doc_text(item: Mapping[str, Any]) -> str:
    """Embedding text: ``name; aliases; section > path`` (FLATTEN.md §4)."""
    parts = [item["name"]]
    aliases = item.get("aliases") or ()
    if aliases:
        parts.append(", ".join(aliases))
    path = item.get("path") or ()
    if path:
        parts.append(" > ".join(path))
    return "; ".join(parts).strip()


def doc_texts(items: Iterable[Mapping[str, Any]]) -> list[str]:
    return [doc_text(item) for item in items]


def item_vector_cache_key(
    doc_text_value: str,
    *,
    model_id: str,
    doc_prefix: str,
    dims: int = DIMS_ACTIVE,
) -> str:
    """Lowercase hex SHA-1 cache key for an item vector (RANK.md §2.1).

    ``"scanlist-item-vector/1\\n" + modelId + "\\n" + str(dims) + "\\n" +
    docPrefix + "\\n" + docText`` — changing model, dims or prefix invalidates
    the cache by construction. ``doc_prefix`` is the exact prefix, trailing
    space included (it comes from ``prompts.json``).
    """
    material = (
        _CACHE_KEY_SALT
        + str(model_id) + "\n"
        + str(int(dims)) + "\n"
        + str(doc_prefix) + "\n"
        + str(doc_text_value)
    )
    return hashlib.sha1(material.encode("utf-8")).hexdigest()


def load_list(source: Any) -> dict[str, Any]:
    """Load a list object from a path, an open file, a JSON string or a dict.

    Parsing/validation is LIST.md's job (``shared/spec/validate.py``); this only
    reads JSON so the reference ranker stays dependency-free and testable.
    """
    if isinstance(source, Mapping):
        return dict(source)
    if hasattr(source, "read"):
        return json.load(source)
    if isinstance(source, (bytes, bytearray)):
        return json.loads(source)
    if isinstance(source, os.PathLike):
        with open(source, "r", encoding="utf-8") as fh:
            return json.load(fh)
    if isinstance(source, str):
        if os.path.exists(source):
            with open(source, "r", encoding="utf-8") as fh:
                return json.load(fh)
        return json.loads(source)
    raise TypeError(f"cannot load a list from {type(source).__name__}")


# ---------------------------------------------------------------------------
# §6 ordering helpers
# ---------------------------------------------------------------------------
def _is_done(item: Mapping[str, Any]) -> bool:
    return bool(item.get("done", False))


def _order_of(item: Mapping[str, Any], fallback: int) -> int:
    order = item.get("order", fallback)
    try:
        return int(order)
    except (TypeError, ValueError):
        return fallback


def sort_candidates(candidates: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Sort scored candidates by ``smoothed`` desc, then ``order`` asc (§6).

    Python's sort is stable, so duplicate orders (impossible after flatten)
    still keep input order, which is flatten order.
    """
    return sorted(candidates, key=lambda e: (-e["smoothed"], e["order"]))


def decide_top(
    candidates: Sequence[Mapping[str, Any]],
    current_top_id: Optional[str],
) -> Optional[dict[str, Any]]:
    """Pick the highlighted entry: hysteresis, or None when there is no candidate.

    ``candidates`` must already be sorted by :func:`sort_candidates`.

    This is deliberately the *only* place the highlight is decided. Card S10
    (post-S3 calibration) adds the margin rule (``top1 - top2 >= M``) and the
    no-match threshold (``top1 >= T``) here and nowhere else — ranking order,
    scores and state must not change, only whether a hero card is shown.
    """
    if not candidates:
        return None
    best = candidates[0]
    if current_top_id is None:
        return best
    current = next((e for e in candidates if e["id"] == current_top_id), None)
    if current is None:
        # Current top was ticked, removed or unscored: first candidate wins now.
        return best
    if best["id"] != current["id"] and q6(best["smoothed"] - current["smoothed"]) > HYSTERESIS:
        return best
    return current


def _public_entry(entry: Mapping[str, Any]) -> dict[str, Any]:
    """The four documented ``entries`` fields (RANK.md §1)."""
    return {
        "id": entry["id"],
        "raw": entry["raw"],
        "smoothed": entry["smoothed"],
        "done": bool(entry["done"]),
    }


def unranked(items: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """``ranked=false`` output: flatten order, no scores, empty state (§8 row 1)."""
    return {
        "ranked": False,
        "topId": None,
        "entries": [
            {"id": item["id"], "raw": None, "smoothed": None, "done": _is_done(item)}
            for item in items
        ],
        "state": {"smoothed": {}, "topId": None},
    }


def _normalise_prev(prev: Any) -> tuple[dict[str, float], Optional[str]]:
    """Accept a ``state``, a whole ``rank()`` output, a bare ``{id: score}`` map, or None."""
    if prev is None:
        return {}, None
    if not isinstance(prev, Mapping):
        raise TypeError("prev must be a mapping (state, rank output or {id: score})")
    if "state" in prev and isinstance(prev["state"], Mapping):
        return _normalise_prev(prev["state"])
    if "smoothed" in prev or "topId" in prev:
        raw_smoothed = prev.get("smoothed") or {}
        smoothed: dict[str, float] = {}
        for key, value in raw_smoothed.items():
            try:
                fvalue = float(value)
            except (TypeError, ValueError):
                continue
            if math.isfinite(fvalue):
                smoothed[str(key)] = q6(fvalue)   # stored state is always q6-rounded
        top_id = prev.get("topId")
        return smoothed, (str(top_id) if top_id is not None else None)
    # Bare previous scores: {itemId: smoothed}.
    smoothed = {}
    for key, value in prev.items():
        try:
            fvalue = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(fvalue):
            smoothed[str(key)] = q6(fvalue)
    return smoothed, None


# ---------------------------------------------------------------------------
# §1/§9 rank()
# ---------------------------------------------------------------------------
def rank(
    items: Sequence[Mapping[str, Any]],
    queries: Optional[Mapping[str, Sequence[Sequence[float]]]] = None,
    prev: Any = None,
    barcode_name: Optional[str] = None,
    *,
    prev_output: Optional[Mapping[str, Any]] = None,
    dims: int = DIMS_ACTIVE,
) -> dict[str, Any]:
    """Score, smooth and order the list for one evaluation tick.

    Parameters mirror RANK.md §1: ``items`` are flattened (with ``vec``), ``queries``
    is ``{"text": [...], "image": [...]}``, ``prev`` is the previous ``state``
    (or a ``rank()`` result, or a bare ``{itemId: smoothed}`` map) and
    ``barcode_name`` is the already-resolved OFF product name.

    ``prev_output`` is the caller's cached last output; it is what §8's
    "vectors still missing" row returns (first tick: flatten order).
    ``dims`` is 256 in production and 4 in the §10 toy example.

    Returns ``{ranked, topId, entries, state}``; ``entries`` is top first, then
    the remaining candidates, then every checked item in flatten order.
    """
    items = list(items)
    prev_smoothed, prev_top_id = _normalise_prev(prev)
    text_queries, image_queries = _prepare_queries(queries, dims)

    # §8 row 1: no signal at all → unranked, state cleared.
    if not text_queries and not image_queries:
        return unranked(items)

    evaluated: list[tuple[Mapping[str, Any], np.ndarray]] = []
    missing_vector = False
    for item in items:
        if _is_done(item):
            continue
        vec = item_vector(item, dims)
        if vec is None:
            missing_vector = True
            continue
        evaluated.append((item, vec))

    if missing_vector:
        # §8 "some item vectors missing": keep the previous output, no state change.
        if prev_output is not None:
            carried = dict(prev_output)
            carried["state"] = {
                "smoothed": dict(prev_smoothed),
                "topId": prev_top_id,
            }
            return carried
        first_tick = unranked(items)
        first_tick["state"] = {"smoothed": dict(prev_smoothed), "topId": prev_top_id}
        return first_tick

    done_items = sorted(
        (item for item in items if _is_done(item)),
        key=lambda item: _order_of(item, 0),
    )
    done_entries = [
        {"id": item["id"], "raw": None, "smoothed": None, "done": True}
        for item in done_items
    ]

    # All items checked (or the list is empty): ranked but nothing to highlight.
    if not evaluated:
        return {
            "ranked": True,
            "topId": None,
            "entries": done_entries,
            "state": {"smoothed": {}, "topId": None},
        }

    # §3: cosine per (item, query) pair, then q6 per cosine, then max within a
    # source and max across the sources that are present (never a mean/sum).
    item_matrix = np.stack([vec for _, vec in evaluated])
    base = np.full(len(evaluated), -np.inf, dtype=np.float64)
    with np.errstate(invalid="ignore", over="ignore"):
        for query_group in (text_queries, image_queries):
            if not query_group:
                continue
            dots = item_matrix @ np.stack(query_group).T
            np.clip(dots, -1.0, 1.0, out=dots)
            group_max = _q6_array(dots).max(axis=1)
            base = np.maximum(base, group_max)

    barcode_target = norm_barcode_text(barcode_name) if barcode_name else ""
    smoothed_by_id: dict[str, float] = {}
    candidates: list[dict[str, Any]] = []
    for row, (item, _vec) in enumerate(evaluated):
        boost = BARCODE_BOOST if (
            barcode_target and _matches_normalised(item, barcode_target)
        ) else 0.0
        raw = q6(float(base[row]) + boost)
        prev_score = prev_smoothed.get(item["id"])
        smoothed = raw if prev_score is None else q6(EMA_ALPHA * raw + (1 - EMA_ALPHA) * prev_score)
        smoothed_by_id[item["id"]] = smoothed
        candidates.append({
            "id": item["id"],
            "raw": raw,
            "smoothed": smoothed,
            "done": False,
            "order": _order_of(item, row),
        })

    candidates = sort_candidates(candidates)
    top = decide_top(candidates, prev_top_id)

    if top is None:
        ordered = list(candidates)
    elif candidates and top["id"] == candidates[0]["id"]:
        ordered = list(candidates)
    else:
        ordered = [top] + [entry for entry in candidates if entry["id"] != top["id"]]

    entries = [_public_entry(entry) for entry in ordered] + done_entries
    state = {
        "smoothed": smoothed_by_id,
        "topId": top["id"] if top is not None else None,
    }
    return {
        "ranked": True,
        "topId": state["topId"],
        "entries": entries,
        "state": state,
    }


# ---------------------------------------------------------------------------
# §7 cadence / lifecycle (400 ms)
# ---------------------------------------------------------------------------
def now_ms() -> int:
    """Monotonic milliseconds for :class:`RankTicker` calls."""
    return int(time.monotonic() * 1000)


class RankTicker:
    """Thin stateful wrapper for RANK.md §7: at most one evaluation per 400 ms.

    The ranker itself stays pure; this class only owns the lifecycle the spec
    assigns to the caller:

    * :meth:`submit` / :meth:`submit_queries` — newest signal replaces the
      pending query set (no queue, no accumulation).
    * :meth:`tick` — evaluates only when ``min_interval_ms`` has elapsed since
      the last evaluation; returns ``None`` when a tick is not due.
    * :meth:`tick_now` — immediate evaluation (item ticked/unticked) and it
      resets the clock.
    * :meth:`list_changed` — clears state/top/output, then evaluates immediately.
    * :meth:`scan_started` — empty state, immediate evaluation once a query exists.
    * :meth:`scan_stopped` — clears everything and returns the unranked output.

    Two ticks inside one window never see half-updated state: the same
    ``state``/``last_output`` the last tick produced is what the next tick
    smooths from.
    """

    def __init__(
        self,
        *,
        min_interval_ms: int = MIN_INTERVAL_MS,
        dims: int = DIMS_ACTIVE,
    ) -> None:
        self.min_interval_ms = int(min_interval_ms)
        self.dims = int(dims)
        self.state: dict[str, Any] = {"smoothed": {}, "topId": None}
        self.last_output: Optional[dict[str, Any]] = None
        self.queries: dict[str, list[Any]] = {"text": [], "image": []}
        self.last_eval_ms: Optional[int] = None

    # -- signals ---------------------------------------------------------
    def submit(self, text: Optional[Iterable[Any]] = None,
               image: Optional[Iterable[Any]] = None) -> "RankTicker":
        """Replace the pending query set; ``None`` keeps that source unchanged."""
        if text is not None:
            self.queries["text"] = list(text)
        if image is not None:
            self.queries["image"] = list(image)
        return self

    submit_queries = submit

    def reset(self) -> "RankTicker":
        """Empty state and cached output (list changed / scan start)."""
        self.state = {"smoothed": {}, "topId": None}
        self.last_output = None
        self.last_eval_ms = None
        return self

    # -- ticks -----------------------------------------------------------
    def tick(self, items: Sequence[Mapping[str, Any]], at_ms: Optional[int] = None,
             barcode_name: Optional[str] = None) -> Optional[dict[str, Any]]:
        """Evaluate if due; ``None`` means "not this frame, keep the last output"."""
        return self.evaluate(items, at_ms, barcode_name, immediate=False)

    def tick_now(self, items: Sequence[Mapping[str, Any]], at_ms: Optional[int] = None,
                 barcode_name: Optional[str] = None) -> dict[str, Any]:
        """Immediate evaluation (item ticked/unticked); resets the 400 ms clock."""
        return self.evaluate(items, at_ms, barcode_name, immediate=True)

    def evaluate(self, items: Sequence[Mapping[str, Any]], at_ms: Optional[int] = None,
                 barcode_name: Optional[str] = None, *,
                 immediate: bool = False) -> Optional[dict[str, Any]]:
        at = now_ms() if at_ms is None else int(at_ms)
        if (
            not immediate
            and self.last_eval_ms is not None
            and at - self.last_eval_ms < self.min_interval_ms
        ):
            return None
        output = rank(
            items,
            self.queries,
            self.state,
            barcode_name,
            prev_output=self.last_output,
            dims=self.dims,
        )
        self.last_eval_ms = at
        self.state = output["state"]
        self.last_output = output
        return output

    def list_changed(self, items: Sequence[Mapping[str, Any]], at_ms: Optional[int] = None,
                     barcode_name: Optional[str] = None) -> dict[str, Any]:
        """Add/remove/rename/amount edit: clear state and top, then re-evaluate now."""
        self.reset()
        return self.evaluate(items, at_ms, barcode_name, immediate=True)

    def scan_started(self, items: Sequence[Mapping[str, Any]], at_ms: Optional[int] = None,
                     barcode_name: Optional[str] = None) -> dict[str, Any]:
        """New scan session: empty state, immediate tick."""
        self.reset()
        return self.evaluate(items, at_ms, barcode_name, immediate=True)

    def scan_stopped(self, items: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        """Scan stopped / camera closed: unranked JSON order, state cleared."""
        self.reset()
        self.queries = {"text": [], "image": []}
        self.last_output = unranked(items)
        return self.last_output
