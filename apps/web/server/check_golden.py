#!/usr/bin/env python3
"""Card C3's golden check: server vectors vs ``shared/fixtures/golden.json``.

Runs the real EmbeddingGemma 2 embedder (the same code the server serves) over
every golden input - 88 item docTexts, 43 text queries, 15 product photos - and
reports cosine / max-abs-diff against the fixture, then re-ranks with the S2
oracle and compares the top-3 ids. Exit code 0 only when everything passes.

    cd apps/web/server
    .venv/bin/python check_golden.py                 # uses the default snapshot
    EMBEDDINGGEMMA_SNAPSHOT=/models/embeddinggemma-2 .venv/bin/python check_golden.py

Thresholds (C3): cos >= 0.999 and max |diff| <= 1e-5 per vector; all 58
queries must reproduce ``expectedTop3``. S3 measured bitwise identity on this
stack, so the real numbers are ~1e-7.

This is the pytest parity test (``tests/test_golden_parity.py``) as a runnable
report, for the laptop and for Oracle where pytest may not be installed.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(REPO / "shared" / "ref"))

from embedder_gemma import GemmaEmbedder  # noqa: E402

import scanlist_ref as ref  # noqa: E402

GOLDEN_JSON = REPO / "shared" / "fixtures" / "golden.json"
COS_MIN = 0.999
MAX_ABS_DIFF = 1e-5


def cos(a, b) -> float:
    return math.fsum(float(x) * float(y) for x, y in zip(a, b))


def max_diff(a, b) -> float:
    return max(abs(float(x) - float(y)) for x, y in zip(a, b))


def summarise(label: str, rows: list[tuple[str, float, float]]) -> tuple[float, float]:
    worst_cos, worst_diff, worst_id = min(rows, key=lambda row: row[1])[1], max(
        row[2] for row in rows
    ), min(rows, key=lambda row: row[1])[0]
    print(
        f"{label:14} {len(rows):4d}  min cos {worst_cos:.15f}  "
        f"max|diff| {worst_diff:.3e}  (worst {worst_id})"
    )
    return worst_cos, worst_diff


def main() -> int:
    golden = json.loads(GOLDEN_JSON.read_text(encoding="utf-8"))
    embedder = GemmaEmbedder()
    print(
        f"model {embedder.name} revision {golden['model']['revision']} "
        f"dtype {golden['model']['dtype']} prefixes {embedder.prefixes.active!r}"
    )

    failures: list[str] = []

    item_rows: list[tuple[str, float, float]] = []
    item_vectors: dict[str, dict[str, list[float]]] = {}
    for entry in golden["lists"]:
        docs = [ref.doc_text(item) for item in entry["items"]]
        got = embedder.embed_docs(docs)
        item_vectors[entry["id"]] = {}
        for item, vector in zip(entry["items"], got):
            want = entry["itemVectors"][item["id"]]
            item_vectors[entry["id"]][item["id"]] = vector
            item_rows.append((f"{entry['id']}/{item['id']}", cos(vector, want), max_diff(vector, want)))
    worst_cos, worst_diff = summarise("item vectors", item_rows)
    if worst_cos < COS_MIN or worst_diff > MAX_ABS_DIFF:
        failures.append("item vectors out of tolerance")

    text_queries = [q for q in golden["queries"] if q["kind"] == "text"]
    text_vectors = dict(
        zip([q["id"] for q in text_queries], embedder.embed_queries([q["text"] for q in text_queries]))
    )
    text_rows = [
        (q["id"], cos(text_vectors[q["id"]], q["vector"]), max_diff(text_vectors[q["id"]], q["vector"]))
        for q in text_queries
    ]
    worst_cos, worst_diff = summarise("text queries", text_rows)
    if worst_cos < COS_MIN or worst_diff > MAX_ABS_DIFF:
        failures.append("text query vectors out of tolerance")

    image_queries = [q for q in golden["queries"] if q["kind"] == "image"]
    image_vectors = dict(
        zip(
            [q["id"] for q in image_queries],
            embedder.embed_images([(REPO / q["file"]).read_bytes() for q in image_queries]),
        )
    )
    image_rows = [
        (q["id"], cos(image_vectors[q["id"]], q["vector"]), max_diff(image_vectors[q["id"]], q["vector"]))
        for q in image_queries
    ]
    worst_cos, worst_diff = summarise("image queries", image_rows)
    if worst_cos < COS_MIN or worst_diff > MAX_ABS_DIFF:
        failures.append("image query vectors out of tolerance")

    lists = {entry["id"]: entry for entry in golden["lists"]}
    mismatches = []
    for query in golden["queries"]:
        entry = lists[query["list"]]
        items = []
        for item in entry["items"]:
            clone = dict(item)
            clone["vec"] = item_vectors[query["list"]][item["id"]]
            items.append(clone)
        group = "text" if query["kind"] == "text" else "image"
        queries = {"text": [], "image": []}
        queries[group] = [text_vectors[query["id"]] if group == "text" else image_vectors[query["id"]]]
        result = ref.rank(items, queries, prev=None)
        got = [row["id"] for row in result["entries"] if not row["done"]][:3]
        if got != query["expectedTop3"]:
            mismatches.append((query["id"], got, query["expectedTop3"]))
    print(
        f"ranking        {len(golden['queries']) - len(mismatches)}/{len(golden['queries'])} "
        f"queries reproduce expectedTop3"
    )
    for mismatch in mismatches[:10]:
        print(f"  MISMATCH {mismatch}")
    if mismatches:
        failures.append(f"{len(mismatches)} ranking mismatches")

    if failures:
        print("\nFAIL: " + "; ".join(failures))
        return 1
    print("\nPASS: golden.json reproduced within cos >= 0.999 / max|diff| <= 1e-5")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
