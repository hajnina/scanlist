#!/usr/bin/env python3
"""Card S3 — build ``shared/fixtures/golden.json`` with the real EmbeddingGemma 2 model.

What it does
------------
1. Flattens ``shared/spec/samples/*.json`` (the S2 oracle: ``shared/ref/scanlist_ref.py``).
2. Embeds every item's ``docText`` (FLATTEN.md §4) with the **document prefix** from
   ``shared/spec/prompts.json`` — for *both* prefix sets (the A/B test).
3. Embeds ~43 text queries (clean names, OCR-like noise, Spanish/Czech) with the matching
   **query prefix**, and 15 Open Food Facts product photos with **no prefix** (§5: images
   take no prefix).
4. Truncates to the active 256 dims and L2-normalises with ``truncate_and_normalize`` from
   the reference implementation, so the stored vectors are exactly what RANK.md §2 says
   (truncate first, then normalise, float64; never float16 — model card).
5. Runs the S2 ranker (``rank()``) for every query and records the expected top-3 ids.
6. Writes ``golden.json`` (active prefix set only) and ``ab_stats.json`` (both sets),
   and prints the A/B tables that ``fixtures/PREFIX_AB.md`` quotes.

The output is **model-free**: a consumer only needs json + the ranker. Flattened items in
``golden.json`` carry **no ``vec`` key** (FLATTEN.md §1); item vectors live in the side
table ``itemVectors`` (id -> 256-d unit vector), which the consumer attaches as
``item["vec"]`` before calling ``rank()`` (RANK.md §1). See ``fixtures/README.md``.

Usage
-----
    shared/tools/.venv/bin/python shared/tools/make_golden.py            # A/B + write
    shared/tools/.venv/bin/python shared/tools/make_golden.py --verify   # no model: re-rank golden.json
    shared/tools/.venv/bin/python shared/tools/make_golden.py --no-write  # print tables only

Model: google/embeddinggemma-2 @ f9972ac22e696a105c482202646979e33e4b5a1e, HF snapshot
in ~/models/scanlist/hf-cache (weights sha256 197a3296...553d79, 1,488,915,288 B), loaded
on CPU in **float32** (the model card forbids float16). Override the path with
``--model`` or ``EMBEDDINGGEMMA_SNAPSHOT``.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SPEC_DIR = REPO / "shared" / "spec"
FIXTURES = REPO / "shared" / "fixtures"
PHOTOS = FIXTURES / "photos"
sys.path.insert(0, str(REPO / "shared" / "ref"))

import numpy as np  # noqa: E402

import scanlist_ref as ref  # noqa: E402

DEFAULT_SNAPSHOT = os.environ.get(
    "EMBEDDINGGEMMA_SNAPSHOT",
    os.path.expanduser(
        "~/models/scanlist/hf-cache/hub/models--google--embeddinggemma-2/"
        "snapshots/f9972ac22e696a105c482202646979e33e4b5a1e"
    ),
)
MODEL_REVISION = "f9972ac22e696a105c482202646979e33e4b5a1e"
WEIGHT_SHA256 = "197a32965d4b1105faf060417baa899e193fb73cd401f42ec9295234d5553d79"

SAMPLE_LISTS = ["van-weekly", "string-amounts", "aliases-es-cz", "deep-nesting"]
PHOTO_CORPUS_ID = "photo-corpus"

# --- text queries -----------------------------------------------------------
# (id, list, query text, target item names, note). Targets [] => "not on the list"
# distractor: nothing may be highlighted (>= 8 required by the card).
TEXT_QUERIES: list[tuple[str, str, str, list[str], str]] = [
    # van-weekly — clean names + OCR-like labels
    ("t01", "van-weekly", "bananas", ["Bananas"], "plain name"),
    ("t02", "van-weekly", "BANANE 1,2KG", ["Bananas"], "OCR label: no accents, digits, no spaces"),
    ("t03", "van-weekly", "olive oil", ["Olive oil"], "plain name"),
    ("t04", "van-weekly", "ACEITE DE OLIVA VIRGEN EXTRA 1 L", ["Olive oil"], "Spanish OCR, uppercase"),
    ("t05", "van-weekly", "toilet paper", ["Toilet paper"], "plain name"),
    ("t06", "van-weekly", "oat milk 2 l", ["Oat milk"], "name + amount, must not win over Oat milk"),
    ("t07", "van-weekly", "dish soap", ["Dish soap"], "plain name"),
    ("t08", "van-weekly", "CAFÉ EN GRANOS 1 KG", ["Coffee beans"], "Spanish OCR, accented"),
    # string-amounts
    ("t09", "string-amounts", "sourdough bread 800 g", ["Sourdough loaf"], "name-ish, must not pick Bread elsewhere"),
    ("t10", "string-amounts", "butter", ["Butter"], "plain name"),
    ("t11", "string-amounts", "HONEY 500G", ["Honey"], "OCR label"),
    ("t12", "string-amounts", "eggs", ["Eggs"], "plain name"),
    ("t13", "string-amounts", "olives", ["Olives"], "plain name (Ice cream is done in this list)"),
    ("t14", "string-amounts", "apples", ["Apples"], "plain name"),
    ("t15", "string-amounts", "BATERÍAS AA 4 UNIDADES", ["Batteries"], "Spanish OCR"),
    # aliases-es-cz — the multilingual case (aliases are part of docText)
    ("t16", "aliases-es-cz", "mléko", ["Milk"], "Czech alias"),
    ("t17", "aliases-es-cz", "MLÉKO POLOTUČNÉ 1,5% TUKU", ["Milk"], "Czech OCR label"),
    ("t18", "aliases-es-cz", "leche entera", ["Milk"], "Spanish, not an alias verbatim"),
    ("t19", "aliases-es-cz", "chléb", ["Bread"], "Czech alias"),
    ("t20", "aliases-es-cz", "hovězí maso 500 g", ["Beef"], "Czech alias + amount"),
    ("t21", "aliases-es-cz", "kuřecí stehna", ["Chicken thighs"], "Czech alias"),
    ("t22", "aliases-es-cz", "queso curado", ["Cheese"], "Spanish, aged cheese"),
    ("t23", "aliases-es-cz", "jogurt bílý", ["Yoghurt"], "Czech, word order swapped vs alias"),
    ("t24", "aliases-es-cz", "papel higiénico", ["Toilet paper"], "Spanish alias"),
    # deep-nesting — deep paths, done items excluded (RANK.md §3)
    ("t25", "deep-nesting", "comino molido", ["Cumin"], "Spanish, ground cumin"),
    ("t26", "deep-nesting", "uzená paprika", ["Smoked paprika"], "Czech alias"),
    ("t27", "deep-nesting", "arroz basmati 2 kg", ["Basmati rice"], "Spanish, Basmati not just rice"),
    ("t28", "deep-nesting", "cuscús", ["Couscous"], "Spanish alias"),
    ("t29", "deep-nesting", "DIJON MUSTARD 200G", ["Dijon mustard"], "OCR label"),
    ("t30", "deep-nesting", "toothpaste", ["Toothpaste"], "plain name"),
    ("t31", "deep-nesting", "shampoo", ["Shampoo"], "plain name"),
    # ---- "not on the list" distractors: nothing may be highlighted ----------
    ("d01", "van-weekly", "Coca-Cola 1,5 l", [], "brand not on the list"),
    ("d02", "string-amounts", "Nutella", [], "brand not on the list"),
    ("d03", "van-weekly", "cat food", [], "category not on the list"),
    ("d04", "deep-nesting", "light bulbs", [], "category not on the list"),
    ("d05", "aliases-es-cz", "beer", [], "near-miss: 'Beef' is on the list"),
    ("d06", "van-weekly", "wine", [], "category not on the list"),
    ("d07", "string-amounts", "chocolate", [], "category not on the list"),
    ("d08", "aliases-es-cz", "crisps", [], "category not on the list"),
    ("d09", "van-weekly", "shampoo", [], "on another sample list, not this one"),
    ("d10", "deep-nesting", "dog food", [], "category not on the list"),
    ("d11", "string-amounts", "Oreo biscuits", [], "brand not on the list"),
    ("d12", "aliases-es-cz", "washing powder", [], "category not on the list (Dish soap exists)"),
]


# ---------------------------------------------------------------------------
# vectors
# ---------------------------------------------------------------------------
def vec256(raw: np.ndarray) -> np.ndarray:
    """RANK.md §2: first 256 components in float64, then L2-normalise."""
    return ref.truncate_and_normalize(raw, ref.DIMS_ACTIVE)


def floats(v: np.ndarray) -> list[float]:
    """float64 -> JSON floats; ``repr`` round-trips the double exactly."""
    return [float(x) for x in np.asarray(v, dtype=np.float64).reshape(-1)]


class Encoder:
    def __init__(self, path: str, dtype: str = "float32", threads: int = 8):
        import torch
        from sentence_transformers import SentenceTransformer

        torch.set_num_threads(threads)
        torch.manual_seed(0)
        # float16 is forbidden by the model card (NaN / silent degradation); fp32 on CPU.
        td = {"float32": torch.float32, "bfloat16": torch.bfloat16}[dtype]
        self.model = SentenceTransformer(path, model_kwargs={"torch_dtype": td})
        self.model.eval()
        self.dtype = dtype

    def texts(self, texts: list[str], batch_size: int = 16) -> np.ndarray:
        out = self.model.encode(
            texts,
            batch_size=batch_size,
            truncate_dim=None,          # truncate ourselves, RANK.md §2 order
            normalize_embeddings=False,  # normalise ourselves, after truncation
            show_progress_bar=False,
            convert_to_numpy=True,
        )
        out = np.asarray(out, dtype=np.float32)
        assert out.shape[1] == 768, out.shape
        return np.stack([vec256(row) for row in out])

    def images(self, paths: list[Path]) -> np.ndarray:
        from PIL import Image

        vectors = []
        for p in paths:
            with Image.open(p) as im:
                im = im.convert("RGB")
                raw = self.model.encode(
                    {"image": im},
                    truncate_dim=None,
                    normalize_embeddings=False,
                    show_progress_bar=False,
                    convert_to_numpy=True,
                )
            raw = np.asarray(raw, dtype=np.float32).reshape(-1)
            assert raw.shape == (768,), raw.shape
            vectors.append(vec256(raw))
        return np.stack(vectors)


# ---------------------------------------------------------------------------
# corpora
# ---------------------------------------------------------------------------
def load_prompts() -> dict:
    return json.loads((SPEC_DIR / "prompts.json").read_text())


def prefix_sets(prompts: dict) -> dict[str, dict[str, str]]:
    return {name: prompts[name] for name in ("mnemothera", "modelcard")}


def _walk_items(section: dict):
    for item in section.get("items") or ():
        yield item
    for child in section.get("sections") or ():
        yield from _walk_items(child)


def build_corpora() -> dict[str, dict]:
    """Sample lists (own corpus each) + one merged corpus for the product photos.

    Photos are ranked against all four sample lists at once (44 items): a 10-item
    corpus makes image top-1 look better than it is.
    """
    corpora: dict[str, dict] = {}
    merged_sections = []
    for name in SAMPLE_LISTS:
        obj = ref.load_list(SPEC_DIR / "samples" / f"{name}.json")
        corpora[name] = {
            "source": f"shared/spec/samples/{name}.json",
            "title": obj.get("title"),
            "items": ref.flatten(obj),
        }
        merged_sections.append(
            {"name": name, "sections": json.loads(json.dumps(obj.get("sections") or []))}
        )
    merged = {"title": "Photo corpus — all four sample lists", "version": 1,
              "sections": merged_sections}
    # "done" is a shopping-list state, not a retrieval label: a photo probe ranks every
    # product in the corpus, so the merged corpus clears the flag (RANK.md §3 would
    # otherwise drop items like "Ice cream" that happen to be ticked in a sample list).
    for section in merged["sections"]:
        for item in _walk_items(section):
            item["done"] = False
    corpora[PHOTO_CORPUS_ID] = {
        "source": "synthetic: sections of the four shared/spec/samples/*.json merged "
                  "under one top-level section per sample (built by make_golden.py)",
        "title": merged["title"],
        "items": ref.flatten(merged),
    }
    return corpora


def acceptable_ids(corpus: dict, names: list[str]) -> list[str]:
    want = {n.strip().casefold() for n in names}
    return [it["id"] for it in corpus["items"] if it["name"].casefold() in want]


# ---------------------------------------------------------------------------
# ranking / scoring
# ---------------------------------------------------------------------------
def rank_one(corpus: dict, vectors: dict[str, np.ndarray], kind: str,
             query: np.ndarray) -> dict:
    items = []
    for it in corpus["items"]:
        clone = dict(it)
        clone["vec"] = vectors[it["id"]]  # RANK.md §1: vec on the input item only
        items.append(clone)
    queries = {"text": [], "image": []}
    queries[kind] = [query]
    return ref.rank(items, queries, prev=None)


def top_n(result: dict, n: int = 3) -> list[dict]:
    return [e for e in result["entries"] if not e["done"]][:n]


def score_set(corpora, corpus_vecs, queries, label: str) -> dict:
    rows = []
    for q in queries:
        res = rank_one(corpora[q["list"]], corpus_vecs[q["list"]], q["kind"], q["vector"])
        best = top_n(res, 3)
        top1 = best[0] if best else None
        top2 = best[1] if len(best) > 1 else None
        hit1 = bool(top1 and top1["id"] in q["accept"])
        hit3 = any(e["id"] in q["accept"] for e in best)
        rows.append({
            "id": q["id"], "kind": q["kind"], "list": q["list"],
            "text": q.get("text"), "expect": "hit" if q["accept"] else "nomatch",
            "top1": top1["id"] if top1 else None,
            "top1_raw": top1["raw"] if top1 else None,
            "top2_raw": top2["raw"] if top2 else None,
            "margin": ref.q6((top1["raw"] or 0.0) - (top2["raw"] or 0.0)) if top1 and top2 else None,
            "top3": [e["id"] for e in best],
            "hit1": hit1, "hit3": hit3,
        })
    return {"prefixSet": label, "rows": rows}


def summarise(run: dict) -> dict:
    out: dict[str, dict] = {}
    for kind in ("text", "image"):
        rows = [r for r in run["rows"] if r["kind"] == kind]
        hits = [r for r in rows if r["expect"] == "hit"]
        misses = [r for r in rows if r["expect"] == "nomatch"]
        margins = [r["margin"] for r in hits if r["margin"] is not None]
        out[kind] = {
            "queries": len(rows),
            "hitQueries": len(hits),
            "nomatchQueries": len(misses),
            "top1": sum(r["hit1"] for r in hits) / len(hits) if hits else None,
            "top3": sum(r["hit3"] for r in hits) / len(hits) if hits else None,
            "hitTop1Min": float(min(margins)) if margins else None,
            "hitMarginMedian": float(np.median(margins)) if margins else None,
            "hitMarginMax": float(max(margins)) if margins else None,
            "hitsMarginAtLeast005": sum(1 for m in margins if m >= 0.05) / len(margins) if margins else None,
            "nomatchTop1Max": max((r["top1_raw"] for r in misses), default=None),
            "nomatchTop1Median": float(np.median([r["top1_raw"] for r in misses])) if misses else None,
            "hitTop1MinScore": min((r["top1_raw"] for r in hits), default=None),
            "hitTop1MedianScore": float(np.median([r["top1_raw"] for r in hits])) if hits else None,
        }
    return out


# ---------------------------------------------------------------------------
# serialisation
# ---------------------------------------------------------------------------
VEC = "\u00a7VEC\u00a7"


def squeeze_vectors(obj):
    """Keep 256-float arrays on one line so the file stays diffable."""
    if isinstance(obj, dict):
        return {k: squeeze_vectors(v) for k, v in obj.items()}
    if isinstance(obj, list):
        if obj and all(isinstance(x, float) for x in obj):
            return VEC + json.dumps(obj, separators=(",", ":")) + VEC
        return [squeeze_vectors(x) for x in obj]
    return obj


def dump(obj, path: Path) -> None:
    text = json.dumps(squeeze_vectors(obj), indent=2, ensure_ascii=False)
    text = re.sub(r'"' + VEC + r'(.*?)' + VEC + r'"',
                  lambda m: m.group(1), text, flags=re.S)
    path.write_text(text + "\n")


def load_golden(path: Path) -> dict:
    """Plain JSON read — no model, no numpy needed for consumers that only parse."""
    return json.loads(path.read_text())


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", default=DEFAULT_SNAPSHOT)
    ap.add_argument("--dtype", default="float32", choices=["float32", "bfloat16"])
    ap.add_argument("--threads", type=int, default=int(os.environ.get("SCANLIST_TORCH_THREADS", "8")))
    ap.add_argument("--no-write", action="store_true", help="measure only, write nothing")
    ap.add_argument("--verify", action="store_true",
                    help="model-free: re-rank golden.json and check expectedTop3")
    args = ap.parse_args()

    prompts = load_prompts()
    corpora = build_corpora()
    manifest = json.loads((PHOTOS / "manifest.json").read_text())

    if args.verify:
        return verify(prompts)

    active = prompts["active"]
    sets = prefix_sets(prompts)
    print(f"model {args.model}\ndtype {args.dtype} threads {args.threads}", flush=True)
    print(f"active prefix set (prompts.json): {active}\n", flush=True)

    t0 = time.time()
    enc = Encoder(args.model, dtype=args.dtype, threads=args.threads)
    print(f"loaded in {time.time() - t0:.1f}s", flush=True)

    # item vectors per prefix set
    corpus_vecs: dict[str, dict[str, dict[str, np.ndarray]]] = {}
    for set_name in sets:
        doc_prefix = sets[set_name]["doc"]
        corpus_vecs[set_name] = {}
        for cid, corpus in corpora.items():
            texts = [doc_prefix + ref.doc_text(it) for it in corpus["items"]]
            t1 = time.time()
            vectors = enc.texts(texts)
            corpus_vecs[set_name][cid] = {
                it["id"]: vectors[i] for i, it in enumerate(corpus["items"])
            }
            print(f"  [{set_name}] {cid}: {len(texts)} item docs in {time.time() - t1:.1f}s",
                  flush=True)

    # query vectors
    queries: list[dict] = []
    for qid, list_id, text, targets, note in TEXT_QUERIES:
        queries.append({
            "id": qid, "kind": "text", "list": list_id, "text": text,
            "targetNames": targets, "note": note,
            "accept": acceptable_ids(corpora[list_id], targets),
        })

    image_docs = []
    for entry in manifest:
        path = PHOTOS / entry["file"]
        image_docs.append({
            "id": "i" + entry["slug"],
            "kind": "image",
            "list": PHOTO_CORPUS_ID,
            "file": f"shared/fixtures/photos/{entry['file']}",
            "product": entry.get("product_name"),
            "barcode": entry.get("barcode"),
            "targetNames": entry["target_names"],
            "note": "product photo" if entry["kind"] == "hit" else "not on the list",
            "accept": acceptable_ids(corpora[PHOTO_CORPUS_ID], entry["target_names"]),
        })
    t1 = time.time()
    image_vectors = enc.images([REPO / d["file"] for d in image_docs])
    print(f"  images: {len(image_docs)} in {time.time() - t1:.1f}s", flush=True)
    for i, d in enumerate(image_docs):
        d["vector"] = image_vectors[i]
        queries.append(d)

    for set_name in sets:
        qp = sets[set_name]["query"]
        text_qs = [q for q in queries if q["kind"] == "text"]
        vectors = enc.texts([qp + q["text"].strip() for q in text_qs])
        for i, q in enumerate(text_qs):
            q.setdefault("vectorsBySet", {})[set_name] = vectors[i]

    # ---- A/B over both prefix sets -------------------------------------
    runs = {}
    for set_name in sets:
        qs = []
        for q in queries:
            qs.append({
                **{k: v for k, v in q.items() if k in
                   ("id", "kind", "list", "text", "accept", "targetNames", "note")},
                "vector": q["vectorsBySet"][set_name] if q["kind"] == "text" else q["vector"],
            })
        runs[set_name] = score_set(corpora, corpus_vecs[set_name], qs, set_name)
    stats = {name: summarise(run) for name, run in runs.items()}

    print("\n== A/B (active 256 dims, single tick, no prev) ==")
    print(f"{'set':12} {'kind':6} {'n':>3} {'hit@1':>7} {'hit@3':>7} "
          f"{'margin>=.05':>11} {'nomatchTop1max':>14}")
    for name in sets:
        for kind in ("text", "image"):
            s = stats[name][kind]
            print(f"{name:12} {kind:6} {s['hitQueries']:3} "
                  f"{(s['top1'] or 0):7.3f} {(s['top3'] or 0):7.3f} "
                  f"{(s['hitsMarginAtLeast005'] or 0):11.3f} "
                  f"{(s['nomatchTop1Max'] if s['nomatchTop1Max'] is not None else float('nan')):14.3f}")

    if args.no_write:
        return 0

    # ---- golden.json (active set only) ---------------------------------
    active_run = runs[active]
    expect_by_id = {r["id"]: r for r in active_run["rows"]}
    golden_queries = []
    for q in queries:
        r = expect_by_id[q["id"]]
        entry = {
            "id": q["id"], "kind": q["kind"], "list": q["list"],
            "expect": "hit" if q["accept"] else "nomatch",
            "accept": q["accept"],
            "targetNames": q["targetNames"],
            "note": q["note"],
            "vector": floats(q["vectorsBySet"][active] if q["kind"] == "text" else q["vector"]),
            "expectedTop3": r["top3"],
            "expectedScores": [
                e["raw"] for e in top_n(
                    rank_one(corpora[q["list"]], corpus_vecs[active][q["list"]], q["kind"],
                             q["vectorsBySet"][active] if q["kind"] == "text" else q["vector"]),
                    3)
            ],
            "expectedMargin": r["margin"],
        }
        if q["kind"] == "text":
            entry["text"] = q["text"]
        else:
            entry["file"] = q["file"]
            entry["product"] = q["product"]
            entry["barcode"] = q["barcode"]
        golden_queries.append(entry)

    golden = {
        "version": 1,
        "generated": time.strftime("%Y-%m-%d"),
        "generator": "shared/tools/make_golden.py",
        "model": {
            "id": prompts["model"],
            "hfRepo": "google/embeddinggemma-2",
            "revision": MODEL_REVISION,
            "weightsSha256": WEIGHT_SHA256,
            "dtype": args.dtype,
            "note": "CPU float32; float16 is forbidden by the model card (NaN / silent "
                    "degradation). torch.set_num_threads(%d) for reproducibility."
                    % args.threads,
        },
        "dims": {"native": 768, "active": ref.DIMS_ACTIVE},
        "prompts": {
            "source": "shared/spec/prompts.json",
            "active": active,
            "doc": sets[active]["doc"],
            "query": sets[active]["query"],
            "image": prompts["imagePrefix"],
        },
        "contract": {
            "items": "lists[].items are FLATTENED items exactly as FLATTEN.md §1 defines "
                     "them — they carry NO 'vec' key. Item vectors live in "
                     "lists[].itemVectors keyed by item id.",
            "ranking": "items = clone(lists[i].items); for each item: item['vec'] = "
                       "lists[i].itemVectors[item['id']]; rank(items, {'text': [q['vector']]}, "
                       "None) for kind=='text', {'image': [q['vector']]} for kind=='image'. "
                       "Compare the first three non-done entries with queries[].expectedTop3.",
            "vectors": "256-d, already truncated (first 256 of 768) and L2-normalised in "
                       "float64 per RANK.md §2. They are NOT re-normalised after q6.",
            "modelFree": "no model is needed to consume this file: json + the ranker.",
        },
        "lists": [
            {
                "id": cid,
                "source": corpus["source"],
                "title": corpus["title"],
                "itemCount": len(corpus["items"]),
                "items": corpus["items"],
                "itemVectors": {
                    it["id"]: floats(corpus_vecs[active][cid][it["id"]])
                    for it in corpus["items"]
                },
            }
            for cid, corpus in corpora.items()
        ],
        "queries": golden_queries,
    }
    out = FIXTURES / "golden.json"
    dump(golden, out)
    print(f"\nwrote {out.relative_to(REPO)} ({out.stat().st_size / 1024:.0f} KiB, "
          f"{len(golden_queries)} queries)", flush=True)

    ab = {
        "version": 1,
        "generated": golden["generated"],
        "model": {"id": prompts["model"], "revision": MODEL_REVISION, "dtype": args.dtype},
        "active": active,
        "prefixSets": sets,
        "summary": stats,
        "rows": {name: run["rows"] for name, run in runs.items()},
        "photoSet": [d["file"] for d in image_docs],
    }
    dump(ab, FIXTURES / "ab_stats.json")
    print(f"wrote {(FIXTURES / 'ab_stats.json').relative_to(REPO)}", flush=True)

    # ---- consistency with prompts.json ---------------------------------
    print(f"\nactive set = {active}; golden.json+build agree. "
          f"prefix A/B verdict: "
          f"text top-1 modelcard={stats['modelcard']['text']['top1']:.3f} "
          f"vs mnemothera={stats['mnemothera']['text']['top1']:.3f}", flush=True)
    if prompts["active"] != active:  # unreachable, kept as a guard
        print("WARNING: prompts.json active moved during the run", file=sys.stderr)
    return 0


def verify(prompts: dict) -> int:
    """Model-free check: re-rank golden.json with the S2 oracle, no model loaded."""
    path = FIXTURES / "golden.json"
    golden = load_golden(path)
    assert golden["prompts"]["active"] == prompts["active"], (
        f"golden.json built for '{golden['prompts']['active']}' but prompts.json says "
        f"'{prompts['active']}' — rerun make_golden.py")
    lists = {l["id"]: l for l in golden["lists"]}
    bad = 0
    for q in golden["queries"]:
        lst = lists[q["list"]]
        items = []
        for it in lst["items"]:
            assert "vec" not in it, f"flattened item {it['id']} carries a vec key"
            clone = dict(it)
            clone["vec"] = np.asarray(lst["itemVectors"][it["id"]], dtype=np.float64)
            items.append(clone)
        queries = {"text": [], "image": []}
        queries[q["kind"]] = [np.asarray(q["vector"], dtype=np.float64)]
        result = ref.rank(items, queries, prev=None)
        got = [e["id"] for e in top_n(result, 3)]
        if got != q["expectedTop3"]:
            bad += 1
            print(f"MISMATCH {q['id']}: got {got} want {q['expectedTop3']}")
    print(f"verify: {len(golden['queries']) - bad}/{len(golden['queries'])} queries reproduce "
          f"expectedTop3 from golden.json alone (no model), "
          f"{sum(len(l['items']) for l in golden['lists'])} items, "
          f"{len(golden['lists'])} lists")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
