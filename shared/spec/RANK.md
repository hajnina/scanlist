# RANK — scoring, smoothing, ordering (normative)

Status: **normative spec v1**, owned by card S1. This is the algorithm every track and the golden fixtures use.
The cadence/smoothing constants — 400 ms, EMA α = 0.5, hysteresis 0.02 — are **v1 defaults, not calibrated
values**; bench card X1 revises them against real devices (kanban/lead-log.md, 2026-11-16). Card S10 added the
HIGHLIGHT gates of §6.2/§6.3 (margin M, no-match floor T, image accept-list guard) on top of S3's measured data
(`fixtures/PREFIX_AB.md`, `fixtures/golden.json`); they are calibrated on that fixture and must be re-fit on
device frames by X1 as well. Ranking order, scores and EMA state are unaffected by the gates — only which item,
if any, is shown as the hero card changes.
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
  topId:   string|null,                             // hero highlight (§6.2/§6.3); null if none
  entries: [{ id: string, raw: float|null, smoothed: float|null, done: boolean }],
  state:   { smoothed: {itemId: float}, topId: string|null }
}
```

- `items` are flattened, each carrying its already-truncated, L2-normalised **item vector** (null = not
  embedded yet, see §8).
- `topId` is the **HIGHLIGHT decision**, not merely "the best score": §6.2/§6.3 return `null` when the evidence
  is not decisive or an image match is unconfirmed, even though the list is still ranked and scored. Consumers
  MUST NOT re-derive a hero from `entries[0]` — read `topId`.
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

The folding MUST be Unicode **full** case folding (`CaseFolding.txt`, the C + S + F mappings — the semantics of
Python's `str.casefold()`, Java/Kotlin `toLowerCase(Locale.ROOT)` is *not* enough): `ß` → `ss`, `İ` → `i̇`, `ẞ` → `ss`.
Locale-sensitive or Turkish-irrational casing would make the three tracks disagree on `BARCODE_MATCH`.

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
- **Hysteresis rule** (§6.1, picks the hero *candidate*): switch iff `q6(best.smoothed - current.smoothed) > 0.02`
  (strictly greater; exactly `0.02` keeps the current top). No epsilon beyond the q6 rounding.
- **Gate comparisons** (§6.2): `q6(top1 - top2) >= M` and `q6(hero.smoothed) >= T`, inclusive at both bounds,
  using the same rounding — exactly `0.05` clears `M_text`, `0.0499` does not.
- Dot products SHOULD accumulate components in ascending index order; this is not required for correctness
  because q6 makes results insensitive to sub-1e-6 differences.
- UI may display scores rounded to 2 dp; display rounding MUST NOT feed back into comparisons or state.

## 6. Ordering, hero highlight, done group

Candidates = unchecked items that were evaluated this tick, sorted by:

1. `smoothed` descending (`q6` values),
2. `order` ascending (flatten order) when tied per §5.

The **highlight** (`topId` / the hero card) is decided in three steps after that sort: hysteresis (§6.1), the
evidence gate (§6.2), and the image guard (§6.3). Ranking, scores and state never depend on the outcome.

```
sorted   = candidates sorted by (smoothed desc, order asc)
hero     = hysteresis(sorted, prev.topId)                  // §6.1
source   = the source that produced hero.base              // §3; tie → "text"
(M, T)   = (0.05, 0.79) if source == "text" else (0.005, 0.68)
decisive = len(sorted) < 2 or q6(sorted[0].smoothed - sorted[1].smoothed) >= M
plausible = q6(hero.smoothed) >= T
confirmed = barcodeMatch(hero)                             // §3.1, may be false

highlight = decisive and plausible and (source != "image" or confirmed)
topId     = hero.id if highlight else null
```

### 6.1 Hysteresis: which candidate is the hero

```
current = prev.topId if prev.topId is still an unchecked, evaluated candidate else None

if current is None:
    hero = sorted[0]                       // first-ever evaluation, untick of the hero, gate was closed
else:
    best = sorted[0]
    hero = best if best.id != current.id and q6(best.smoothed - current.smoothed) > 0.02
           else current
```

- The current hero is **sticky**: it stays the hero until a challenger is ahead by more than `0.02`
  (no jitter from noise). If the current hero is ticked, removed or unscored, the first sorted candidate wins
  immediately (no hysteresis against a ticked item).
- An item with a missing vector or a checked item can never be the hero.
- With `M_text = 0.05 > 0.02` the sticky rule can never *survive* on the text path: whenever hysteresis would
  keep a non-top-1 hero, the margin is at most `0.02` and §6.2 closes the gate — the hero is hidden for that tick
  rather than flickering. `M_image = 0.005 < 0.02`, so on the image path both rules can apply at once (see §10).
- A closed gate sets `state.topId = null`; the next tick therefore starts from the sorted order (§6.4).

### 6.2 Evidence gate: margin M and no-match floor T

An item is only worth a hero if it is **decisive against the runner-up** (margin) *and* **plausibly similar to
something on the list** (floor). Decisive is what §6.1 makes it: the hero is the candidate that *retains the
hysteresis crown* — the sorted top-1, or the previous hero while it is within `0.02` of the top-1 — so the margin is
checked on the sorted top pair, not "must be clearly ahead" (a hero inside the `0.02` band can be slightly *behind*
and still be highlighted; §10's image tick shows `x` 0.850 behind `y` 0.855 with a hero). A plain absolute threshold
is not enough (EmbeddingGemma 2's cosine floor between unrelated grocery concepts is 0.65–0.79,
`fixtures/PREFIX_AB.md` §5.5) and a plain margin is not enough either (a list of near-identical items can produce a
decisive winner for a query that matches nothing).

`M` and `T` depend on which source drove the winner — a text query (`textCos`) or a camera frame (`imageCos`),
per §3. Two gates exist because image margins are structurally much smaller than text margins:

| driving source | M | T | why |
|---|---|---|---|
| text (OFF name, OCR line, typed query) | **0.05** | **0.79** | 12/12 text distractors sit below a 0.05 margin (max 0.042981); 30/31 hits above it |
| image (camera frame) | **0.005** | **0.68** | image margins median 0.028 / only 3/13 hits reach 0.05; distractors at 0.00031 and 0.000942 |

- **Comparisons use §5 rounding**: `q6(top1 − top2) >= M` and `q6(hero.smoothed) >= T`. Exactly `0.05` clears;
  `0.0499` does not. Both bounds are inclusive.
- The margin is measured on the **two highest smoothed scores** (that is the evidence in the list); the floor is
  measured on the **hero** itself.
- With fewer than two candidates the margin is vacuously true (nothing to beat); the floor still applies.
- "Driving source" = the source that produced the winner's `base` (§3). A tie between the two sources counts as
  **text**, i.e. the stricter gate (fail-safe).
- **A single global margin would break the camera path**: applying 0.05 to images would reject 10 of the 13
  measured correct image matches (`fixtures/PREFIX_AB.md` §4). Hence per-source gates, chosen from the winner.

**Where the numbers come from** (`fixtures/golden.json`, one tick, `prev = null`, active prefix set
`mnemothera`; ids are `queries[].id`):

- Text, 12 "not on the list" distractors: max margin **0.042981** (`d12` washing powder), max top-1
  **0.787691** (`d09` shampoo on `van-weekly`; `PREFIX_AB.md` §2 rounds it to 0.788). `M_text = 0.05` rejects all
  12 on the margin alone; `T_text` is the second line of defence for a high-but-flat distractor.
- Text, 31 hits: 30 clear both conditions, i.e. everything that clears the margin also clears the floor.
  `t20` ("hovězí maso 500 g" → Beef, top-1 0.79906, margin 0.039765) fails the margin and fails safe.
- **`T_text = 0.79` is picked from the distractor distribution, not from a round "0.8 means match"**: any value in
  `(0.787691, 0.804082]` keeps all 12 distractors out and all 30 passing hits in (`0.804082` is `t17`,
  the weakest passing hit, "MLÉKO POLOTUČNÉ 1,5% TUKU" → Milk). 0.79 sits 0.0023 above the worst distractor and
  0.0141 below the weakest passing hit.
- `T_text` is only valid for the **active prefix set**: absolute scores are set-dependent (hit top-1 min 0.799 vs
  0.738 and distractor top-1 max 0.788 vs 0.731 between `mnemothera` and `modelcard`). Changing
  `prompts.json.active`, the model or the dims requires re-fitting `T` (and re-checking `M`).
- Image, 13 hits + 2 distractors: `T_image = 0.68` sits between the weakest hit (0.68744, ice-cream) and the
  strongest distractor (0.666327, nutella); `M_image = 0.005` sits above both distractor margins
  (0.00031 / 0.000942) and below every hit except eggs (0.003758) and bread (0.003876), which are suppressed —
  fail-safe, that is the required behaviour for a near-tie.
- 11/13 image hits clear this gate, 0/2 distractors do — **but the gate alone is not sufficient**: see §6.3.

### 6.3 Image guard: accept-list confirmation (v1)

`cheese.jpg` → **Greek yoghurt** (top-1 0.699416, margin 0.025021 over the runner-up 0.674395) passes the image
gate and is a genuine, unfixable-by-tuning false highlight: Cheese itself is only third (0.670091), and the winner
beats Butter (0.007383) in both dimensions (`fixtures/PREFIX_AB.md` §4, corrected in PR #13). Nothing computed
from the image score can separate it, so v1 adds a guard that brings in **independent evidence**:

> **An image-driven hero requires accept-list confirmation**: `barcodeMatch(hero)` must be true (§3.1 — the OFF
> name resolved from the barcode, exact after NFC + full case folding). Unconfirmed image winners are rendered in
> ranked order with **no hero** (`topId = null`).

This reuses the predicate that already grants the +0.15 barcode boost (§3), so a resolved OFF name both confirms
and promotes the item: `honey.jpg` ranks Honey at 0.752869 (no hero); with its confirmed OFF name `"Honey"` it
becomes 0.902869 and is highlighted. **Fixture fact:** of the 13 image queries in `fixtures/golden.json` only
`honey.jpg` recorded an OFF name that exactly matches an item name/alias (`"Honey"`); the other 12 recorded a
name that does not (e.g. `imilk` recorded `"Mléko polotučné s obsahem  1,5% tuku"` against item `"Milk"`), because
`barcodeMatch` is exact after NFC + full case folding — so **expect no hero on image-only ticks unless the OFF name
exactly matches an item's name or alias**. (Hypothetically, `cheese.jpg` with an OFF name of `"Cheese"` would
highlight Cheese at 0.820091 instead of Greek yoghurt at 0.699416; the fixture records
`"Fromage Blanc Nature"`, which matches nothing, so that is a property of the rule, not a measured pass.)

**Why this option (evaluated against the three candidates in card S10):**

- **(a) accept-list stage — CHOSEN.** It is the only option whose evidence is *independent of the confusable
  image neighbourhood*: the failure is stable (the same white dairy tub wins every crop/frame/cosine comparison),
  so it cannot be out-voted by more of the same evidence. It needs no extra model call (OFF name is already a
  `rank()` parameter, RANK §1/§2.2, resolved by `shared/off/`, card S4) and it is fully exercisable by the oracle:
  every fixture image query carries a barcode + OFF name, and the negative cases (cheese / eggs / bread) and the
  positive override are covered in `shared/ref/test_scanlist_ref.py`.
- **(b) second-stage re-embed (best crop / N frames must agree) — REJECTED for v1.** Agreement is satisfied by a
  *confident* mistake: four frames of the same white tub agree on Greek yoghurt, so it would not remove the one
  measured false highlight. It also doubles embedding work per tick on device and, because `golden.json` stores one
  vector per image query, it would ship without a fixture exercising it.
- **(c) fusion-aware gating (winner must also beat the best text score) — REJECTED as the v1 guard.** The measured
  false highlight happens on an **image-only** tick, where there is no text source, so the condition is inert
  exactly where it is needed. What (c) contributes is already covered: on a mixed tick the winner's driving source
  decides the gate (§6.2), so a text-backed winner must clear the strict text gate, and barcode/OFF text evidence
  is covered by the confirmation above.

**Trade-off, stated plainly:** an image-only tick with no OFF name now shows ranked order and no hero. That is
deliberate fail-safe. Image top-1 is 0.923 on clean front-of-pack shots and the prior for real shelf frames is
R@1 ≈ 35–44 % (arXiv 2603.17186, `fixtures/PREFIX_AB.md` §5.1); a hero on the *wrong* item is the one failure the
user physically acts on (they tick it). X1 must re-fit this on device frames — and if device evidence improves,
relax the guard here, never by lowering `M`/`T` to "make the camera work".

### 6.4 Output order (`entries`)

1. the `hero` first, if (and only if) it is highlighted,
2. then the remaining candidates in sorted order (`smoothed` desc, `order` asc),
3. then **all checked items** (`done == true`) in `order` ascending — the collapsed "Done" group. Checked items
   are never scored, their `raw`/`smoothed` are `null`, and they never enter EMA state.
4. `topId` = the hero's id when highlighted, else `null`; `state.topId` mirrors it. If there are no unchecked
   items, `topId = null` and `entries` contains only the done group.

Consequences: with a highlight, the hero is always first in the rendered list (it is also rendered as the hero
card); with a closed gate the entries are exactly the ranked order and the UI shows the plain list, no hero. The
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
| barcode without OFF hit | no barcode text query and no boost (the raw barcode number is never embedded); such a tick cannot confirm an image winner (§6.3) |
| evidence gate closed (§6.2), or image winner unconfirmed (§6.3) | `ranked` stays true, scores and `state.smoothed` are normal, `topId=null`, `entries` = ranked order; the UI shows the list with **no hero**. This is a normal state, not an error |
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
        text_cos = max(cs) if cs else None
        image_cos = max(ci) if ci else None
        base = max(v for v in (text_cos, image_cos) if v is not None)
        confirmed = bool(barcode_name and (norm(it.name) == norm(barcode_name)
                                          or any(norm(a) == norm(barcode_name) for a in it.aliases)))
        raw = q6(base + (0.15 if confirmed else 0.0))
        prev_s = prev.smoothed.get(it.id)
        smoothed = raw if prev_s is None else q6(0.5 * raw + 0.5 * prev_s)
        source = "image" if image_cos is not None and (text_cos is None or image_cos > text_cos) else "text"
        scored.append({"id": it.id, "raw": raw, "smoothed": smoothed, "done": False,
                       "order": it.order, "source": source, "confirmed": confirmed})

    scored.sort(key=lambda e: (-e["smoothed"], e["order"]))

    # §6.1 hysteresis
    current = next((e for e in scored if e["id"] == prev.topId), None)
    if current is None:
        hero = scored[0] if scored else None
    else:
        best = scored[0]
        hero = best if best["id"] != current["id"] and q6(best["smoothed"] - current["smoothed"]) > 0.02 else current

    # §6.2 evidence gate + §6.3 image guard
    highlight = False
    if hero is not None:
        M, T = (0.005, 0.68) if hero["source"] == "image" else (0.05, 0.79)
        margin_ok = len(scored) < 2 or q6(scored[0]["smoothed"] - scored[1]["smoothed"]) >= M
        highlight = margin_ok and q6(hero["smoothed"]) >= T
        if hero["source"] == "image" and not hero["confirmed"]:
            highlight = False                       # accept-list guard (§6.3)

    top = hero if highlight else None
    rest = [e for e in scored if top is None or e["id"] != top["id"]]   # no hero ⇒ full ranked order
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
every other rule (q6, α=0.5, max-fusion, 0.02 hysteresis, the §6.2 gates) applies unchanged. Items in flatten
order:

| order | id | name | vector |
|---|---|---|---|
| 0 | `a` | Milk | `[1, 0, 0, 0]` |
| 1 | `b` | Oat milk | `[0.6, 0.8, 0, 0]` |
| 2 | `c` | Bread | `[0, 0, 1, 0]` |

Tick 1, text query `q1 = [1,0,0,0]`: dots a=1.0, b=0.6, c=0.0; no prev → smoothed = raw.
State `{a:1.0, b:0.6, c:0.0}`; margin `q6(1.0-0.6)=0.4 >= 0.05` and `1.0 >= 0.79` → hero `a`. Entries: `a, b, c`.

Tick 2, `q2 = [0.8,0.6,0,0]`: raw a=0.8, b=0.96, c=0.0;
smoothed a = (0.8+1.0)/2 = 0.9, b = (0.96+0.6)/2 = 0.78, c = 0.0.
Sorted `a 0.9, b 0.78, c 0`; margin `0.12` → hero stays `a`.

Tick 3, same `q2`: raw a=0.8, b=0.96; smoothed a = (0.8+0.9)/2 = **0.85**, b = (0.96+0.78)/2 = **0.87**,
c = 0.0. Sorted `b 0.87, a 0.85, c 0`. §6.1 hysteresis would keep `a` (`q6(0.87-0.85)=0.02`, **not > 0.02**),
but §6.2 needs a `0.05` margin and `0.02 < 0.05` → **no hero this tick**: `topId = null`, state `topId = null`,
entries in ranked order `b, a, c`. Inside the hysteresis band the hero is hidden rather than flickering.

Tick 4, same `q2`: smoothed a = (0.8+0.85)/2 = **0.825**, b = (0.96+0.87)/2 = **0.915**, c = 0.0.
`q6(0.915-0.825)=0.09 >= 0.05` → hero **`b`** (the challenger is also ahead by `0.09 > 0.02`, so hysteresis agrees).
Entries: `b, a, c`.

Tick 5, tick `a` in the UI (done), same `q2` applied immediately: `a` leaves the candidates and its state;
`c`'s state stays 0; entries = `b, c` then done group `a` (raw/smoothed null); b is alone → margin vacuous,
`0.9375 >= 0.79` → hero `b`. Untick `a` later: `a` re-enters with prev=None → smoothed = its next raw
(no memory of 0.825).

Image-path tick (hysteresis and the §6.3 guard together, because `M_image = 0.005 < 0.02`): items `x`
(name "Milk", vector `[0.700,0,0,0]`) and `y` (name "Oats", **alias** "milk", vector `[0.705,0,0,0]`), one image
query `[1,0,0,0]`, OFF name `"milk"` (so §3.1 confirms both — x by name, y by alias — and both get the +0.15
boost) and `prev = {smoothed: {x: 0.850, y: 0.855}, topId: "x"}`. Raw and smoothed are x = **0.850**,
y = **0.855** (0.700 / 0.705 + 0.15): y leads by exactly `0.005`, so the §6.2 margin gate is open (`>= 0.005`)
while §6.1 hysteresis keeps **`x`** (challenger ahead by `0.005 <= 0.02`; x's floor `0.850 >= 0.68`) → hero `x`,
entries `x, y`. On the same tick with no OFF name neither item is confirmed, so there is **no hero** (§6.3) while
`x` and `y` stay ranked. (With a single confirmed item the boost normally puts it first, which is why hysteresis
so rarely shows on this path.)

Barcode boost example: with barcode name `"milk"` and text query `q = [0.6,0.8,0,0]`, item `a` ("Milk")
scores `dot = 0.6`, matches exactly (`norm("Milk") == "milk"`) → `raw = q6(0.6 + 0.15) = 0.75`; item `b`
("Oat milk") scores `dot = 0.6*0.6 + 0.8*0.8 = 1.0` → `raw = 1.0` (no match: `"oat milk" ≠ "milk"`). The boost
is part of `raw`, hence smoothed afterwards. Without a query vector the boost alone never ranks
(`has_signal` is false).

## 11. Conformance checklist

1. Truncation takes dims 0..255; normalisation happens after truncation; cosine is a dot product.
2. Max over text queries, max over image queries, then max of the two present values — never a mean.
3. Barcode exact match on normalised name/alias (NFC + **full** Unicode case folding, §3.1) adds 0.15 to `raw`
   before EMA; no clipping.
4. EMA is `0.5*raw + 0.5*prev`, once per tick; first observation equals `raw`; checked items have no state.
5. Comparisons use q6 at 6 dp; ties broken by flatten order.
6. Hysteresis keeps the current hero unless a challenger is ahead by **strictly more than 0.02**.
7. Hero gates (§6.2): text `q6(top1-top2) >= 0.05` and `q6(hero) >= 0.79`; image `>= 0.005` and `>= 0.68`;
   both bounds inclusive; the winner's driving source picks the pair, a tie counts as text; fewer than two
   candidates makes the margin vacuous. Closed gate ⇒ `topId = null`.
8. An image-driven hero additionally requires `barcodeMatch(hero)` (§6.3); otherwise no hero.
9. Output = hero (only when highlighted), then ranked candidates, then done items in flatten order; done items are
   unscored. `topId` is the hero or `null` — a list ranked with no hero is a normal state, not an error.
10. Ticks are at most every 400 ms; tick/untick/list changes re-evaluate immediately; no signal = unranked
    JSON order with state cleared.
