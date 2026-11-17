# Prefix A/B — EmbeddingGemma 2 on the golden set (card S3)

**Verdict: `mnemothera` wins.** `shared/spec/prompts.json` now has `"active": "mnemothera"`.
Text retrieval is a tie at the ceiling (31/31 top-1 for both sets); images break the tie
(12/13 vs 10/13 top-1, 13/13 vs 12/13 top-3) and every margin/score statistic favours
`mnemothera`. `golden.json` is built with the winner.

> **Margin rule (short version).** Highlight only if `top1 − top2 ≥ 0.05` on the text path.
> On the image path **0.05 is wrong** — it would reject 10 of 13 correct image matches —
> use `top1 ≥ 0.68 AND top1 − top2 ≥ 0.005`. Details and evidence in §4.

Everything below is measured, not assumed. Machine-readable rows: `ab_stats.json`
(every query, both sets). Regenerate: `shared/tools/make_golden.py`.

---

## 1. What was measured

| | |
|---|---|
| Model | `google/embeddinggemma-2`, HF revision `f9972ac22e696a105c482202646979e33e4b5a1e`, weights sha256 `197a3296…553d79`, 1,488,915,288 B |
| Runtime | CPU, **float32** via sentence-transformers 6.3.0 / torch 2.15.0+cpu (the model card forbids float16) |
| Vectors | 768 → **256 active dims**, truncated first then L2-normalised in float64 (RANK.md §2) by the reference `truncate_and_normalize()`, not by the library |
| Ranker | `shared/ref/scanlist_ref.py` (the S2 oracle), one tick, `prev=None` → `smoothed == raw`, `q6` scores |
| Corpora | the four `shared/spec/samples/*.json` lists (44 items); photos ranked against `photo-corpus`, all four merged (44 items, `done` cleared) |
| Text queries | **31 hits + 12 "not on the list" distractors** — plain names, OCR-like labels (uppercase, digits, units), Spanish and Czech |
| Image queries | **13 product photos + 2 distractors**, Open Food Facts front-of-pack, no prefix (model card: images take none) |
| Prefix sets | `modelcard`: doc `title: none \| text: `, query `task: search result \| query: ` · `mnemothera`: doc `task: search result \| text: `, query `task: search query \| text: ` |

Failure paths excluded up front: `done` items cannot rank (RANK.md §3) — e.g. "Ice cream" is
ticked in `string-amounts` and one "Tomatoes" in `aliases-es-cz`, so neither is a text target.

## 2. A/B numbers

Single tick, active 256 dims, no barcode boost, no EMA history.

| prefix set | modality | hit queries | **top-1** | **top-3** | hits with margin ≥ 0.05 |
|---|---|---|---|---|---|
| modelcard | text | 31 | **1.000** (31/31) | **1.000** (31/31) | 30/31 = 0.968 |
| mnemothera | text | 31 | **1.000** (31/31) | **1.000** (31/31) | 30/31 = 0.968 |
| modelcard | image | 13 | **0.769** (10/13) | **0.923** (12/13) | 2/13 = 0.154 |
| mnemothera | image | 13 | **0.923** (12/13) | **1.000** (13/13) | 3/13 = 0.231 |

**The card's hard bar (TEXT top-1 ≥ 0.80) is met with room: 1.000 for both sets.** Read that
number with the caveat in §5 — most text queries contain the item name or one of its aliases,
so 31/31 says "the pipeline is wired correctly", not "text matching is solved". The query set
cannot separate the two prefix sets on text (both at ceiling); that is exactly why images
decide the A/B.

Absolute score levels differ between the sets, which matters in §4:

| | hit top-1 min | hit top-1 median | distractor top-1 max | distractor top-1 median |
|---|---|---|---|---|
| modelcard text | 0.738 | 0.815 | 0.731 | 0.703 |
| mnemothera text | **0.799** | 0.866 | 0.788 | 0.750 |
| modelcard image | 0.695 | 0.733 | 0.678 | 0.675 |
| mnemothera image | 0.687 | 0.732 | 0.666 | 0.660 |

Why `mnemothera`:

- text: tie (31/31, 31/31) — no cost to switching.
- image: +2 top-1, +1 top-3, higher hit margins (median 0.0281 vs 0.0242), wider
  hit-vs-distractor score gap on images (0.021 vs 0.017).
- `mnemothera`'s doc prefix is the retrieval-task framing ("task: search result | text:"), which
  fits `docText` = `name; aliases; section > path` better than the model card's
  `title: none | text:` — our items are not titled documents.

## 3. Failure analysis (mnemothera, the active set)

Text — 31/31, so only the near-misses are interesting:

| query | top-1 | top1 | margin | comment |
|---|---|---|---|---|
| `hovězí maso 500 g` | Beef | 0.799 | **0.040** | the only true hit below the 0.05 margin gate |
| `mléko` (modelcard) | Milk | 0.827 | 0.056 | best text hit overall |

Image — 12/13:

| photo | top-1 | top1 | margin | comment |
|---|---|---|---|---|
| `cheese.jpg` | **Greek yoghurt** | 0.699 | 0.025 | the only miss; a white dairy tub, genuinely confusable — Cheese was top-2 |
| `ice-cream.jpg` | Ice cream | 0.687 | 0.043 | lowest correct top-1 |
| `bananas.jpg` | Bananas | 0.808 | 0.067 | best image hit |
| `nutella.jpg` (distractor) | Red lentils | 0.666 | 0.000 | margin ≈ 0 → the model spreads similarity evenly when nothing matches |
| `coca-cola.jpg` (distractor) | Apples | 0.654 | 0.001 | idem |

The two image misses under `modelcard` (`milk`, `cheese`) both landed on **another dairy item**;
`butter` also missed. That cluster is where the doc prefix hurts image→item retrieval.

Text distractors land on semantically near items — `shampoo → Dish soap` (0.788, margin 0.032),
`washing powder → Dish soap` (0.778, 0.043), `cat food → Pasta` (0.772, 0.000), `beer → Cheese`,
`Oreo biscuits → Sourdough loaf`. **None of the 12 reaches a 0.05 margin**; most sit at
0.00–0.03, i.e. the list has no clear winner when nothing matches. That is the signal the rule
below uses.

## 4. Margin / threshold rule (the deliverable)

Margins are `q6(top1 raw) − q6(top2 raw)` from one tick, so they are comparable across prefix
sets (absolute scores are not: hit top-1 min is 0.799 vs 0.738 between sets).

**TEXT path (barcode name, OCR line, typed query) — recommended rule:**

```
highlight top-1  iff  top1 − top2 ≥ 0.05
otherwise       →  no highlight ("nothing on the list"), keep scanning
```

Evidence: 12/12 distractors are below it (max distractor margin **0.043**), 30/31 true hits are
above it. The one rejected true hit (`hovězí maso 500 g`, margin 0.040) fails safe — no
highlight instead of a wrong one. An absolute floor is *not* recommended on its own: it would
have to sit at ~0.79 with a 0.011 gap to the worst distractor, and it does not transfer between
prefix sets. The margin alone separates perfectly here, and 0.05 matches the only prior art we
have (Smart-Fridge accept ≥0.66 **and** top1/top2 ≥ 0.05).

**IMAGE path (camera frame) — 0.05 does not work, use a floor plus a slack margin:**

```
highlight top-1  iff  top1 ≥ 0.68  AND  top1 − top2 ≥ 0.005
otherwise       →  no highlight
```

Evidence: image margins are structurally tiny — median 0.028, max 0.068, only **3/13** correct
matches reach 0.05. Applying the text rule to images would throw away 10 of 13 correct matches.
The two image distractors have margins 0.000 / 0.001, so a 0.005 slack is enough to drop them
while keeping 11/13 hits; combined with the 0.68 floor (hit min 0.687, distractor max 0.666) the
rule makes **0 false highlights on 15 photos and keeps 11/13 correct ones**.

**Mixed tick (text + image together).** The ranker already takes the max across sources
(RANK.md §3), so treat the rule as a property of the winning entry, not of the source: a
text-driven winner must clear 0.05, an image-driven winner the 0.68 + 0.005 gate. A single
global 0.05 margin would silently disable the camera path — that is the main trap in this data.

These constants belong to card S10/X1 (threshold calibration); they are calibrated on 43 text +
15 image queries and must be re-fit on device frames before shipping.

## 5. Caveats (read before quoting these numbers)

1. **Photos are front-of-pack shots on white** — no shelf, no angle, no hands, no glare. Real
   camera frames are much harder, so 0.923 image top-1 is an **upper bound**, not a prediction.
   The card's external reference (instance-level image retrieval R@1 ≈ 35–44 % for general
   embeddings, arXiv 2603.17186) is the better prior for a real shelf.
2. **Small samples**: 13 image hits, 2 image distractors, 12 text distractors. One query moves
   image top-1 by 7.7 points; the image gap between prefix sets is 2 queries. Directional.
3. **Text is easy**: many queries contain the item name or an alias verbatim, so 1.000 top-1
   mostly proves the wiring (flatten → prefix → truncate → rank → ids). The hard text cases are
   the OCR-like labels and the cross-lingual ones (all passed except the single margin case).
4. **One tick, no smoothing**: `prev=None`, so EMA/hysteresis (RANK.md §4/§5) play no role here.
   On device, 4 frames × 2 s and EMA α = 0.5 will change margins; the rule above is for a single
   evaluation.
5. **Distractor top-1 scores are high** (0.65–0.79 absolute). EmbeddingGemma 2's cosine floor
   between unrelated shopping concepts is high, so **absolute thresholds are dangerous** and a
   margin gate is mandatory — the data supports the card's instinct, not a "0.7 means match" rule.
6. Two image distractors is weak evidence for the 0.005 image margin; S10 should collect more
   "not on the list" frames from the phone.

## 6. Reproduce

```bash
cd <worktree>
HF_HOME=~/models/scanlist/hf-cache OMP_NUM_THREADS=8 \
  shared/tools/.venv/bin/python shared/tools/make_golden.py           # A/B + golden.json
shared/tools/.venv/bin/python shared/tools/make_golden.py --verify   # model-free check
```

`--verify` reloads `golden.json`, re-ranks every query with the S2 oracle and compares
`expectedTop3`; it also asserts that no flattened item carries a `vec` key and that
`golden.json`'s prefix set matches `prompts.json`. Determinism: two runs with
`torch.set_num_threads(8)` on the same machine produced identical A/B numbers; the 256-d
vectors in `golden.json` are the committed artefact, so nothing downstream depends on that.
