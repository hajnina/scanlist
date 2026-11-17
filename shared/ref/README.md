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
| `decide_top(candidates, current_top_id=None, *, barcode_confirmed_ids=frozenset())` | RANK.md §6.1–§6.3 | **the only** highlight decision point (see below) |

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
* **No hero** (RANK.md §6.2/§6.3) → `ranked=true`, normal scores and state, `topId=null`, entries = the ranked
  order. This is a normal state, not an error: the evidence was not decisive, or an image match was unconfirmed.

## Highlight gates (card S10)

`decide_top()` is the only place the hero is decided. It applies, in order: hysteresis (§6.1), the evidence gate
(§6.2), and the image accept-list guard (§6.3).

| constant | value | meaning |
|---|---|---|
| `MARGIN_TEXT` | 0.05 | text-driven: `q6(top1 − top2) >= 0.05` |
| `NO_MATCH_TEXT` | 0.79 | text-driven: `q6(hero) >= 0.79` — no hero below it |
| `MARGIN_IMAGE` | 0.005 | image-driven margin (image margins are structurally tiny) |
| `NO_MATCH_IMAGE` | 0.68 | image-driven floor |

The winner's **driving source** picks the pair (a text/image tie counts as text); fewer than two candidates makes
the margin vacuously true; both bounds are inclusive and compared through `q6`. An image-driven hero must also be
`barcodeMatch`ed (§3.1) — the accept-list guard that removes the measured `cheese.jpg → Greek yoghurt` false
highlight, which no threshold on the image score can separate. Ranking order, scores and `state.smoothed` never
depend on the outcome; a closed gate only removes the hero (`topId = null`).

Golden check (no model needed, uses `shared/fixtures/golden.json`): 12/12 text distractors and 13/13 unconfirmed
image ticks produce `topId = null`, all 58 `expectedTop3` orders and scores are unchanged, and 30/31 text hits
keep their hero (`t20` fails the margin and fails safe). The gate data and the option comparison live in
RANK.md §6.2/§6.3.
