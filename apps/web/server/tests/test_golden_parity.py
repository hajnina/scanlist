"""Golden parity: the server's real EmbeddingGemma 2 vectors vs ``golden.json``.

This is card C3's "Done when" check: given the same texts and photos card S3
embedded, this embedder must reproduce the fixture. S3 measured bitwise identity
on the same stack, so the bar is easy - we require **cos >= 0.999** and
**max |diff| <= 1e-5** per vector, then re-run the S2 ranker and require the
golden ``expectedTop3`` for all 58 queries (43 text + 15 image).

It is skipped unless the weights are mounted (``EMBEDDINGGEMMA_SNAPSHOT`` or the
default ``~/models/scanlist/hf-cache`` snapshot) and torch +
sentence-transformers are installed, so CI stays green without the 1.5 GB
checkpoint. Force the skip with ``SCANLIST_SKIP_GEMMA=1``.

    cd apps/web/server
    .venv/bin/python -m pytest tests/test_golden_parity.py -q -s
"""

from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

import pytest

_numpy = pytest.importorskip("numpy")  # golden/list math + scanlist_ref
pytest.importorskip("torch")
pytest.importorskip("sentence_transformers")
pytest.importorskip("PIL")

from embedder_gemma import (  # noqa: E402
    MODEL_REVISION,
    WEIGHTS_BYTES,
    WEIGHTS_SHA256,
    GemmaEmbedder,
    resolve_snapshot,
)

REPO = Path(__file__).resolve().parents[4]
GOLDEN_JSON = REPO / "shared" / "fixtures" / "golden.json"
sys.path.insert(0, str(REPO / "shared" / "ref"))
import scanlist_ref as ref  # noqa: E402

COS_MIN = 0.999
MAX_ABS_DIFF = 1e-5


def _weights_available() -> tuple[bool, str]:
    if os.environ.get("SCANLIST_SKIP_GEMMA", "").lower() in {"1", "true", "yes"}:
        return False, "SCANLIST_SKIP_GEMMA is set"
    try:
        snapshot = resolve_snapshot()
    except Exception as exc:  # NoModelError and friends: skip, never fail CI
        return False, f"EmbeddingGemma weights not available ({exc})"
    return True, str(snapshot)


_AVAILABLE, _REASON = _weights_available()
pytestmark = pytest.mark.skipif(not _AVAILABLE, reason=f"needs weights: {_REASON}")


def _cos(a, b) -> float:
    return math.fsum(float(x) * float(y) for x, y in zip(a, b))


def _max_diff(a, b) -> float:
    return max(abs(float(x) - float(y)) for x, y in zip(a, b))


@pytest.fixture(scope="module")
def golden() -> dict:
    return json.loads(GOLDEN_JSON.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def embedder() -> GemmaEmbedder:
    # Load once for the whole module: ~3 s load + one model in RAM.
    return GemmaEmbedder()


@pytest.fixture(scope="module")
def vectors(embedder: GemmaEmbedder, golden: dict) -> dict:
    """Embed every golden input once and collect per-group parity statistics."""
    stats: dict = {"items": {}, "text": {}, "image": {}}

    for entry in golden["lists"]:
        list_id = entry["id"]
        docs = [ref.doc_text(item) for item in entry["items"]]
        got = embedder.embed_docs(docs)
        stats["items"][list_id] = {}
        for item, vector in zip(entry["items"], got):
            want = entry["itemVectors"][item["id"]]
            stats["items"][list_id][item["id"]] = {
                "vector": vector,
                "cos": _cos(vector, want),
                "maxDiff": _max_diff(vector, want),
            }

    text_queries = [q for q in golden["queries"] if q["kind"] == "text"]
    got = embedder.embed_queries([q["text"] for q in text_queries])
    for query, vector in zip(text_queries, got):
        stats["text"][query["id"]] = {
            "vector": vector,
            "cos": _cos(vector, query["vector"]),
            "maxDiff": _max_diff(vector, query["vector"]),
        }

    image_queries = [q for q in golden["queries"] if q["kind"] == "image"]
    blobs = [(REPO / q["file"]).read_bytes() for q in image_queries]
    got = embedder.embed_images(blobs)
    for query, vector in zip(image_queries, got):
        stats["image"][query["id"]] = {
            "vector": vector,
            "cos": _cos(vector, query["vector"]),
            "maxDiff": _max_diff(vector, query["vector"]),
        }
    return stats


def _summarise(label: str, rows: dict) -> tuple[float, float]:
    worst_cos = min(row["cos"] for row in rows.values())
    worst_diff = max(row["maxDiff"] for row in rows.values())
    worst_id = min(rows, key=lambda key: rows[key]["cos"])
    print(
        f"\n{label}: {len(rows)} vectors, min cos={worst_cos:.15f}, "
        f"max|diff|={worst_diff:.3e} (worst id {worst_id})"
    )
    return worst_cos, worst_diff


def test_model_identity_matches_the_fixture(golden: dict) -> None:
    assert golden["model"]["revision"] == MODEL_REVISION
    assert golden["model"]["weightsSha256"] == WEIGHTS_SHA256
    assert golden["model"]["dtype"] == "float32"
    assert golden["dims"]["active"] == 256
    assert golden["prompts"]["active"] == GemmaEmbedder().prefixes.active


def test_item_vectors_match_golden(vectors: dict, golden: dict) -> None:
    rows = {
        f"{list_id}/{item_id}": row
        for list_id, items in vectors["items"].items()
        for item_id, row in items.items()
    }
    assert len(rows) == sum(len(entry["itemVectors"]) for entry in golden["lists"]) == 88
    worst_cos, worst_diff = _summarise("item vectors", rows)
    assert worst_cos >= COS_MIN
    assert worst_diff <= MAX_ABS_DIFF


def test_text_query_vectors_match_golden(vectors: dict) -> None:
    worst_cos, worst_diff = _summarise("text queries", vectors["text"])
    assert len(vectors["text"]) == 43
    assert worst_cos >= COS_MIN
    assert worst_diff <= MAX_ABS_DIFF


def test_image_query_vectors_match_golden(vectors: dict) -> None:
    worst_cos, worst_diff = _summarise("image queries", vectors["image"])
    assert len(vectors["image"]) == 15
    assert worst_cos >= COS_MIN
    assert worst_diff <= MAX_ABS_DIFF


def test_server_vectors_reproduce_golden_expected_top3(vectors: dict, golden: dict) -> None:
    """The end-to-end check: rank with the server's vectors, same answer as S3."""
    lists = {entry["id"]: entry for entry in golden["lists"]}
    mismatches = []
    for query in golden["queries"]:
        entry = lists[query["list"]]
        items = []
        for item in entry["items"]:
            clone = dict(item)
            clone["vec"] = vectors["items"][query["list"]][item["id"]]["vector"]
            items.append(clone)
        group = "text" if query["kind"] == "text" else "image"
        queries = {"text": [], "image": []}
        queries[group] = [vectors[group][query["id"]]["vector"]]
        result = ref.rank(items, queries, prev=None)
        got = [row["id"] for row in result["entries"] if not row["done"]][:3]
        if got != query["expectedTop3"]:
            mismatches.append((query["id"], got, query["expectedTop3"]))

    print(
        f"\nranking: {len(golden['queries']) - len(mismatches)}/{len(golden['queries'])} "
        f"queries reproduce expectedTop3 from server vectors"
    )
    assert not mismatches, mismatches[:5]
