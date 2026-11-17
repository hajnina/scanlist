# shared/fixtures — golden retrieval fixture (card S3)

`golden.json` is the **reference retrieval fixture** for every track: the real
EmbeddingGemma 2 embeddings of the sample lists and of a fixed query set, plus the
expected ranking computed by the S2 oracle (`shared/ref/scanlist_ref.py`). It is
**model-free to consume** — a TS, Kotlin or Python test only needs JSON and its own
ranker.

```
fixtures/
├── golden.json          # vectors + expected top-3, active prefix set (from prompts.json)
├── ab_stats.json        # both prefix sets: per-query rows + accuracy/margin summary
├── PREFIX_AB.md         # the A/B verdict, numbers and the margin/threshold rule (card S3)
└── photos/              # 15 Open Food Facts photos (CC-BY-SA) + manifest.json + SOURCES.md
```

## Consuming `golden.json` without a model

```python
import json
golden = json.load(open("shared/fixtures/golden.json"))
lists  = {l["id"]: l for l in golden["lists"]}

for q in golden["queries"]:
    lst = lists[q["list"]]
    items = []
    for it in lst["items"]:              # FLATTEN.md §1 item — no "vec" key
        item = dict(it)
        item["vec"] = lst["itemVectors"][it["id"]]   # RANK.md §1: vec on the input copy
        items.append(item)
    queries = {"text": [], "image": []}
    queries[q["kind"]] = [q["vector"]]   # text: prefixed; image: unprefixed
    result = rank(items, queries, prev=None)
    got = [e["id"] for e in result["entries"] if not e["done"]][:3]
    assert got == q["expectedTop3"], q["id"]
```

Why this shape:

- **No `vec` on flattened items.** FLATTEN.md §1 is exact and cross-track equality
  compares the arrays byte for byte, so the item vectors live in the side table
  `lists[].itemVectors` and are attached by the consumer (RANK.md §1 puts `vec` on the
  *input* items, never on `flatten()` output).
- **Vectors are final.** 256-d, already truncated from 768 and L2-normalised in float64
  (RANK.md §2). Do not re-normalise, do not re-truncate. Numbers are serialised as
  shortest round-trip float64, so parsing them reproduces the exact doubles the oracle
  used.
- **`expectedTop3` is the oracle's answer**, produced by `rank()` with `prev=None`
  (single tick, no smoothing history) — i.e. `smoothed == raw` for every item.
- **`accept`** lists every item id that would be a correct answer (e.g. the milk photo
  matches both "Milk" entries in the merged corpus). Empty `accept` = `expect: nomatch`,
  a "not on the list" distractor where nothing may be highlighted.
- `queries[].expectedMargin` is `top1 - top2` on q6 scores, i.e. the value the
  accept/reject rule in `PREFIX_AB.md` tests.

## Contents

- **Lists.** The four `shared/spec/samples/*.json` lists (44 flattened items) each form
  their own corpus, exactly as the app would rank one list. A fifth synthetic list,
  `photo-corpus`, merges all four under one section per sample (44 items, `done` cleared)
  so the product photos are ranked against a realistic 44-item shopping list instead of a
  10-item toy.
- **Text queries.** 43 queries: 31 hits (plain names, OCR-like uppercase/amounts labels,
  Spanish and Czech) and 12 "not on the list" distractors.
- **Image queries.** 15 Open Food Facts front-of-pack photos: 13 hits, 2 distractors.
  See `photos/SOURCES.md` — front-of-pack shots are the *easy* case; treat image numbers
  as an upper bound for a real camera frame.

## Regenerating

```bash
# one-off venv (gitignored): torch CPU, sentence-transformers, torchvision (ST loads the
# video processor even though we never embed video), numpy==2.5.5 / pytest==9.2.0 as S2 pins
python -m venv shared/tools/.venv
shared/tools/.venv/bin/pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
shared/tools/.venv/bin/pip install -r shared/ref/requirements.txt sentence-transformers

# weights: google/embeddinggemma-2 @ f9972ac2…, ~/models/scanlist/hf-cache (1.49 GB, bf16 on disk)
HF_HOME=~/models/scanlist/hf-cache shared/tools/.venv/bin/python shared/tools/make_golden.py

# model-free check that golden.json still reproduces its own expectedTop3
shared/tools/.venv/bin/python shared/tools/make_golden.py --verify
```

`make_golden.py` embeds with `truncate_dim=None, normalize_embeddings=False` and then calls
the reference `truncate_and_normalize()`, so the vectors follow RANK.md §2 literally
(truncate → normalise, float64) instead of relying on the library's own ordering.

Not committed: model weights, the venv (both gitignored), and any download logs.
