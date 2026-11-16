# shared/ref — reference ranker (Python)

Executable oracle for [`../spec/RANK.md`](../spec/RANK.md) and
[`../spec/FLATTEN.md`](../spec/FLATTEN.md). Every other track (Kotlin, React
Native, Web/TS) is compared against this module via
`shared/fixtures/golden.json` (card S3/S8), so **change it only when the spec
changes**.

Pure function, no model, no network. Dependencies: `numpy` (+ `pytest` for the
tests). Python 3.10+.

## Run the tests

```sh
python3 -m venv .venv && .venv/bin/pip install -r shared/ref/requirements.txt
.venv/bin/python -m pytest shared/ref
```

## API (`scanlist_ref.py`)

| function | spec | purpose |
|---|---|---|
| `load_list(source)` | LIST.md | JSON from a path / open file / JSON string / dict |
| `flatten(list_obj)` | FLATTEN.md §2–§5 | depth-first `FlattenedItem[]`, derived ids, deduped aliases, `order` |
| `doc_text(item)` / `doc_texts(items)` | FLATTEN.md §4 | `name; aliases; section > path` (notes excluded) |
| `item_vector_cache_key(doc_text, model_id=…, doc_prefix=…, dims=256)` | RANK.md §2.1 | SHA-1 cache key, prefix/model/dims included |
| `truncate_and_normalize(vec768)` | RANK.md §2 | first 256 components, widened to float64, L2-normalised |
| `q6(x)` | RANK.md §5 | round half away from zero at 6 dp (all stored/compared scores) |
| `barcode_match(item, name)` / `norm_barcode_text(s)` | RANK.md §3.1 | exact NFC + casefold + whitespace-collapsed match |
| `rank(items, queries, prev, barcode_name, *, prev_output=None, dims=256)` | RANK.md §1/§9 | one evaluation tick → `{ranked, topId, entries, state}` |
| `RankTicker` | RANK.md §7 | 400 ms cadence: `submit`, `tick`, `tick_now`, `list_changed`, `scan_started`, `scan_stopped` |
| `decide_top(candidates, current_top_id)` | RANK.md §6 | **the only** highlight decision point (see below) |

Typical tick:

```python
import sys
sys.path.insert(0, "shared/ref")
import scanlist_ref as ref

items = ref.flatten(ref.load_list("shared/spec/samples/van-weekly.json"))
for item, vec768 in zip(items, model_outputs):      # embedder/cache step, card S3/S5
    item["vec"] = ref.truncate_and_normalize(vec768)

out = ref.rank(
    items,
    {"text": [text_query_vec], "image": [image_query_vec]},
    {"smoothed": {}, "topId": None},
    barcode_name="Oat milk",
)
out["topId"], out["entries"][0]["id"], out["state"]
```

`prev` accepts a previous `state`, a whole previous `rank()` output, or a bare
`{itemId: smoothed}` map. `entries` is exactly `{id, raw, smoothed, done}`;
scores are `None` for checked items. `items` are mutated only by the caller
(vectors are read, never written); `rank` is otherwise stateless apart from
`prev`.

## Degraded states (RANK.md §8)

* No text and no image query → `ranked=false`, entries in flatten order, state cleared.
* Some unchecked item has no vector / wrong dims / NaN → the tick does not run:
  `rank` returns `prev_output` (pass your cached last output) with state untouched;
  on the first tick that is the unranked output. Wrong-dim and NaN vectors are
  logged at ERROR and never scored.
* NaN/Inf or wrong-dim **query** vectors are dropped; zero queries stay and give cosine 0.0.
* All items checked → `ranked=true`, `topId=null`, entries = done group only.

## For card S10 (margin rule + no-match threshold)

The highlight is decided **only** in `decide_top()`. S10 changes that one
function (return `None` when `top1 - top2 < M` or `top1 < T`); ranking order,
scores and `state` must not change, and `rank()` already renders the sorted
order with `topId = None` when `decide_top` returns `None`.
