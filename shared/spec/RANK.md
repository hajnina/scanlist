# RANK — scoring, smoothing, ordering (normative)

Status: **normative spec v1**, owned by card S1. This is the algorithm every track and the golden fixtures use.
Given the same list, vectors and frames, two implementations MUST produce the same `entries` array, including
order, `topId` and the stored `smoothed` values.

Read `LIST.md` (format) and `FLATTEN.md` (order, ids, `docText`) first. Prefix strings live in `prompts.json`
and are **never hard-coded**.

---

## 1. Interface

Pure function, no I/O, no model:

```
rank(
  items:  FlattenedItem[],                         // FLATTEN.md order, each with vec: float[256] (unit) or null
  queries: { text: float[][], image: float[][] },  // 256-d unit vectors; text already prefixed+embedded
  prev:    { smoothed: {itemId: float}, topId: string|null },
  barcodeName: string|null                          // OFF product name, already resolved; null if none
) -> {
  ranked:  boolean,                                 // true iff at least one query/source is present
  topId:   string|null,                             // hysteresis winner; null if no unchecked items
  entries: [{ id: string, raw: float|null, smoothed: float|null, done: boolean }],
  state:   { smoothed: {itemId: float}, topId: string|null }
}
```

- `items` are flattened, each carrying its already-truncated, L2-normalised **item vector** (null = not
  embedded yet, see §8).
- `queries.text` are vectors of text queries (OFF name / OCR lines) embedded **with the query prefix**;
  `queries.image` are raw image vectors (**no prefix**). The ranker itself never prepends a prefix.
- The function is deterministic and stateless apart from `prev`; callers persist `state` between ticks.
- Reference implementation: `shared/ref/scanlist_ref.py` (card S2) MUST implement this document; golden
  fixtures (card S3) carry `expected top-3` computed by it. TS port: `shared/ts-core` (card S8) must match it
  exactly on `golden.json`.

## 2. Vectors: model, truncation, normalisation

- Model: **EmbeddingGemma 2 (740M)**, native **768-d**, one joint text+image space, Matryoshka 512/256/128.
  `prompts.json` names the model id; the cache key below includes it.
- **Active dims = 256.** Truncate by taking the **first 256 components**:
  `v256[i] = v768[i] for i in 0..255`. No averaging of groups, no re-ordering, no scaling.
- **L2 normalise after truncation** (Matryoshka + unit sphere, see `docs/ARCHITECTURE.md`):
  `n = sqrt(sum(v256[i]^2, i=0..255))`; if `n < 1e-12` the result is the all-zero vector, otherwise
  `u[i] = v256[i] / n`.
- **Cosine similarity = dot product** of two unit vectors: `cos(a,b) = sum(a[i]*b[i])`. A zero vector yields
  cosine `0.0` with everything (never NaN).
- All arithmetic in **IEEE-754 float64**. Model output is float32; widen each value to float64 (exact) before
  truncating/normalising/dotting. Vectors are never re-normalised after q6 rounding.
- Truncate **once per vector** at the embedding boundary; cached vectors are stored as 256-d **already
  normalised** (both item docs and queries). Do not normalise twice in a way that changes the value (normalising
  a unit vector is a no-op up to float noise).

### 2.1 Item text and vector cache key

`docText` is exactly `FLATTEN.md` §4. The embedded string is `docPrefix + docText` where `docPrefix` is
`prompts.json[active].doc`. The item vector cache key is the lowercase hex SHA-1 of the UTF-8 bytes of:

```
"scanlist-item-vector/1\n" + modelId + "\n" + str(dims) + "\n" + docPrefix + "\n" + docText
```

- `modelId` = `prompts.json.model` (e.g. `embeddinggemma-2-740m`), `dims` = active dims (`256`), `docPrefix` is
  the exact prefix string including its trailing space.
- Changing the prefix set, model or dims therefore invalidates the cache by construction.
- Item vectors are independent of `done`; ticking an item MUST NOT re-embed it.

### 2.2 Query text and query vectors

- **Barcode source**: the Open Food Facts product name (spec in `shared/off/`, card S4) is a text query:
  `queryPrefix + trim(name)`. Empty/whitespace name → no query.
- **Text/OCR source**: each OCR line is its own text query: `queryPrefix + trim(line)`, where the line is the
  visible words in reading order joined by single spaces. No lowercasing, punctuation stripping or spell
  correction before embedding; the prefix is the only decoration.
- **Image source**: embed the camera frame directly, **no prefix**. The caller may keep up to the **4 most
  recent** image vectors from the last **2000 ms**; older ones are discarded. No other filtering.
- At most **16 text query vectors** per tick are used (barcode + OCR lines, dropping extra OCR lines in
  detection order). All supplied vectors participate; the ranker takes the max, never an average.
- Text queries from all sources are pooled: there is no per-source weighting (source chips in the UI are
  informational only).

## 3. Per-item raw score

For every **unchecked** item `i` with a vector (all unchecked items are scored):

```
textCos  = max(dot(item.vec, q) for q in queries.text)     // absent if queries.text is empty
imageCos = max(dot(item.vec, q) for q in queries.image)    // absent if queries.image is empty
base     = max over the present values of {textCos, imageCos}   // plain max, not a sum or mean
boost    = 0.15 if barcodeMatch(item) else 0.0
raw      = q6(base + boost)
```

- `textCos`/`imageCos` are each `q6(clamp(dot, -1.0, 1.0))` (clamp absorbs float noise such as 1.0000000000002).
- Fusion is **max**, not weighted: a good image match is not diluted by bad OCR, and vice versa.
- Scores are **not clipped after the boost**: `raw ∈ [-1.0, 1.15]`. Ranking only compares them.

### 3.1 Barcode exact match

```
norm(s) = NFC(s).casefold().strip() with every run of Unicode whitespace replaced by one " "
```

`barcodeMatch(item)` is true iff `barcodeName` is non-null, non-empty after trim, and **either**:

- `norm(item.name) == norm(barcodeName)`, **or**
- `norm(alias) == norm(barcodeName)` for any of the item's (already trimmed, deduped) aliases.

Matching is exact after that normalisation — no substring, no fuzzy, no token matching. `"Oat milk"` does not
match `"Milk"`; `"Leche"` matches alias `"leche"`. The boost is applied to `raw` **before** EMA, so it smooths
like any other evidence and disappears when the barcode leaves the frame.

## 4. EMA smoothing (α = 0.5)

State is per item id: `state.smoothed = {itemId: float}`.

```
prev     = state.smoothed.get(item.id)          // absent → None
smoothed = raw if prev is None else q6(0.5 * raw + 0.5 * prev)
```

- α = **0.5**, applied **once per evaluation tick**, not per millisecond or per frame. No time decay.
- Formula is literally `0.5*raw + 0.5*prev` (arithmetic mean); the result is `q6`-rounded before storing.
- **Only unchecked items have state.** Ticking an item removes its smoothed value from the new state; unticking
  it makes it restart at its current `raw` (prev = None). Removing an item drops its state.
- New state retains only ids present as unchecked candidates in this evaluation.
- Starting a scan session = empty state; every item starts at its first `raw`.
- Items without a vector (not embedded yet, §8) are not evaluated and get no state.

## 5. Rounding and comparisons (canonical)

All scores that are stored or compared go through **q6**, round-half-away-from-zero at 6 decimals:

```
q6(x) = sign(x) * floor(abs(x) * 1e6 + 0.5) / 1e6,   sign(0) = +,   q6(-0.0) = 0.0
```

- `q6` absorbs float32/dot-order noise (numpy vs JS differ ~1e-15) and makes golden comparisons exact.
- **Tie rule**: two smoothed scores are tied iff `q6(a - b) == 0.0` (i.e. equal to 6 dp). Ties are broken by
  `order` ascending (JSON/flatten order).
- **Hysteresis rule**: switch the top iff `q6(best.smoothed - current.smoothed) > 0.02` (strictly greater;
  exactly `0.02` keeps the current top). No epsilon beyond the q6 rounding.
- Dot products SHOULD accumulate components in ascending index order; this is not required for correctness
  because q6 makes results insensitive to sub-1e-6 differences.
- UI may display scores rounded to 2 dp; display rounding MUST NOT feed back into comparisons or state.

## 6. Ordering, top item, done group

Candidates = unchecked items that were evaluated this tick, sorted by:

1. `smoothed` descending (`q6` values),
2. `order` ascending (flatten order) when tied per §5.

Top selection with hysteresis:

```
sorted = candidates sorted by (smoothed desc, order asc)
current = prev.topId if prev.topId is still an unchecked, evaluated candidate else None

if current is None:
    top = sorted[0]                        // includes first-ever evaluation and untick of the top
else:
    best = sorted[0]
    top  = best if best.id != current.id and q6(best.smoothed - current.smoothed) > 0.02
           else current
```

- The current top is **sticky**: it stays highlighted until a challenger is ahead by more than `0.02`
  (no jitter from noise). If the current top is ticked, removed or unscored, the first sorted candidate wins
  immediately (no hysteresis against a ticked item).
- An item with a missing vector or a checked item can never be `top`.

Output order (`entries`):

1. `top` first,
2. then the remaining candidates in sorted order (`smoothed` desc, `order` asc),
3. then **all checked items** (`done == true`) in `order` ascending — the collapsed "Done" group. Checked items
   are never scored, their `raw`/`smoothed` are `null`, and they never enter EMA state.
4. `topId` = `top.id`; if there are no unchecked items, `topId = null` and `entries` contains only the done group.

Consequences: the top item is always first in the rendered list (it is also rendered as the hero card); the
rest keep their relative order until the next tick; ticking the hero promotes the next candidate with no
hysteresis delay. In ranked mode all three tracks render this **flat** order, each row using its item's
`pathText` as the section chip (see `FLATTEN.md`); the nested section view is only for unranked mode.

## 7. Cadence and lifecycle

- **MIN_INTERVAL = 400 ms.** The ranking is recomputed at most once per 400 ms. Signals arriving in between
  replace the pending query set (latest frame wins; no queue, no accumulation except the §2.2 image window).
- **Immediate tick** (allowed to violate the 400 ms interval, and it resets the clock) when:
  - an item is ticked or unticked (that item's state is dropped; others keep theirs),
  - the list content changes (add/remove/rename/amount edit): all vectors for changed doc texts are recomputed,
    the whole `state` is cleared, `topId = null`,
  - a scan starts: empty state, immediate tick once a vector/query is ready,
  - a scan stops: clear `state`, `ranked = false`, output = flatten order (§8).
- Falling back when there is no signal is the UI's "original JSON order, sections intact" mode: `ranked = false`,
  scores null, no highlight.
- One evaluation processes **all** unchecked items with vectors; there is no incremental/partial scoring.

## 8. Degraded states

| state | behaviour |
|---|---|
| no text and no image query (no signal) | `ranked=false`, `state={smoothed:{},topId:null}`, entries = flatten order (`done` flags kept), no scores |
| scan stopped / camera closed | same as above; the UI restores the nested list (sections intact) |
| some item vectors missing (still embedding) | do **not** evaluate: keep the previous output/order for this tick (first tick: flatten order); no state change; retry on next tick |
| all items checked | `ranked` stays true, `topId=null`, entries = done group only; UI shows the progress-complete state |
| zero items | `entries=[]`, `topId=null`, `ranked` per signal |
| query vector is zero / NaN | an all-zero query gives cosine `0.0`; a NaN/Inf query vector MUST be dropped before ranking (it must never propagate into scores) |
| barcode without OFF hit | no barcode text query and no boost (the raw barcode number is never embedded) |
| duplicate ids after flatten | impossible (`FLATTEN.md` §3.3 renames); ranking keys on the final id |
| item vector wrong dims | treat it as missing: log an error, do not crash, do not score this tick (same as missing vector) |

## 9. Normative pseudocode

```python
def q6(x):
    s = -1.0 if x < 0 else 1.0
    return 0.0 if x == 0 else s * math.floor(abs(x) * 1e6 + 0.5) / 1e6

def rank(items, queries, prev, barcode_name):
    has_signal = bool(queries.text or queries.image)
    if not has_signal:
        return unranked(items)                       # §8 row 1, state cleared

    evaluated = [it for it in items if not it.done and it.vec is not None]
    unchecked = [it for it in items if not it.done]
    if len(evaluated) != len(unchecked):
        return previous_output                          # §8 "vectors missing"

    scored = []
    for it in evaluated:
        cs = [q6(max(-1.0, min(1.0, dot(it.vec, q)))) for q in queries.text]
        ci = [q6(max(-1.0, min(1.0, dot(it.vec, q)))) for q in queries.image]
        base = max(cs + ci)
        if barcode_name and (norm(it.name) == norm(barcode_name)
                             or any(norm(a) == norm(barcode_name) for a in it.aliases)):
            raw = q6(base + 0.15)
        else:
            raw = q6(base)
        prev_s = prev.smoothed.get(it.id)
        smoothed = raw if prev_s is None else q6(0.5 * raw + 0.5 * prev_s)
        scored.append({"id": it.id, "raw": raw, "smoothed": smoothed,
                       "done": False, "order": it.order})

    scored.sort(key=lambda e: (-e["smoothed"], e["order"]))
    current = next((e for e in scored if e["id"] == prev.topId), None)
    if current is None:
        top = scored[0] if scored else None
    else:
        best = scored[0]
        top = best if best["id"] != current["id"] and q6(best["smoothed"] - current["smoothed"]) > 0.02 else current

    rest = [e for e in scored if top is not None and e["id"] != top["id"]]
    done = [{"id": it.id, "raw": None, "smoothed": None, "done": True}
            for it in items if it.done]                  # already in order
    entries = ([top] if top else []) + rest + done
    state = {"smoothed": {e["id"]: e["smoothed"] for e in scored}, "topId": top["id"] if top else None}
    return {"ranked": True, "topId": state["topId"], "entries": entries, "state": state}
```

`dot` sums components 0..255 in ascending order; `norm` is §3.1; `items` are in flatten order; `done` completion
order is `order`.

Two helpers referenced above are intentionally trivial:

- `unranked(items)` returns `{"ranked": False, "topId": None, "entries": [{id, raw: null, smoothed: null,
  done} in flatten order], "state": {"smoothed": {}, "topId": null}}` (§8 row 1).
- `previous_output` means "return exactly what the previous tick returned and leave `state` untouched" (the
  caller caches the last output; §8 "vectors missing"). On the very first tick that is `unranked(items)`.

## 10. Worked example (exact numbers)

Toy setup: 4-d unit vectors used **as if** the active dims were 4 (truncation to 4 and normalisation are no-ops);
every other rule (q6, α=0.5, max-fusion, 0.02 hysteresis) applies unchanged. Items in flatten order:

| order | id | name | vector |
|---|---|---|---|
| 0 | `a` | Milk | `[1, 0, 0, 0]` |
| 1 | `b` | Oat milk | `[0.6, 0.8, 0, 0]` |
| 2 | `c` | Bread | `[0, 0, 1, 0]` |

Tick 1, text query `q1 = [1,0,0,0]`: dots a=1.0, b=0.6, c=0.0; no prev → smoothed = raw.
State `{a:1.0, b:0.6, c:0.0}`, top `a`. Entries: `a, b, c`.

Tick 2, `q2 = [0.8,0.6,0,0]`: raw a=0.8, b=0.96, c=0.0;
smoothed a = (0.8+1.0)/2 = 0.9, b = (0.96+0.6)/2 = 0.78, c = 0.0.
Sorted `a 0.9, b 0.78, c 0`; best `a`, top stays `a`.

Tick 3, same `q2`: raw a=0.8, b=0.96; smoothed a = (0.8+0.9)/2 = **0.85**, b = (0.96+0.78)/2 = **0.87**,
c = 0.0. Sorted `b 0.87, a 0.85, c 0`. `q6(0.87-0.85)=0.02`, **not > 0.02** → top stays **`a`**; entries
still begin with `a` (b is second).

Tick 4, same `q2`: smoothed a = (0.8+0.85)/2 = **0.825**, b = (0.96+0.87)/2 = **0.915**, c = 0.0.
`q6(0.915-0.825)=0.09 > 0.02` → top becomes **`b`**. Entries: `b, a, c`.

Tick 5, tick `a` in the UI (done), same `q2` applied immediately: `a` leaves the candidates and its state;
`c`'s state stays 0; entries = `b, c` then done group `a` (raw/smoothed null); top `b`. Untick `a` later:
`a` re-enters with prev=None → smoothed = its next raw (no memory of 0.825).

Barcode boost example: with barcode name `"milk"` and text query `q = [0.6,0.8,0,0]`, item `a` ("Milk")
scores `dot = 0.6`, matches exactly (`norm("Milk") == "milk"`) → `raw = q6(0.6 + 0.15) = 0.75`; item `b`
("Oat milk") scores `dot = 0.6*0.6 + 0.8*0.8 = 1.0` → `raw = 1.0` (no match: `"oat milk" ≠ "milk"`). The boost
is part of `raw`, hence smoothed afterwards. Without a query vector the boost alone never ranks
(`has_signal` is false).

## 11. Conformance checklist

1. Truncation takes dims 0..255; normalisation happens after truncation; cosine is a dot product.
2. Max over text queries, max over image queries, then max of the two present values — never a mean.
3. Barcode exact match on normalised name/alias adds 0.15 to `raw` before EMA; no clipping.
4. EMA is `0.5*raw + 0.5*prev`, once per tick; first observation equals `raw`; checked items have no state.
5. Comparisons use q6 at 6 dp; ties broken by flatten order.
6. Hysteresis keeps the current top unless a challenger is ahead by **strictly more than 0.02**.
7. Output = top, then sorted candidates, then done items in flatten order; done items are unscored.
8. Ticks are at most every 400 ms; tick/untick/list changes re-evaluate immediately; no signal = unranked
   JSON order with state cleared.
