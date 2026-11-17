# `@scanlist/ts-core`

Platform-neutral TypeScript core for the ScanList tracks: **validate**, **flatten** and **rank**.
No React, no I/O, no native modules, **zero runtime dependencies** — React Native and the web app
import the same ESM source. Types mirror `apps/rn/src/list/types.ts` (card A1) and
`shared/spec/list.schema.json`.

```ts
import { parseList, flatten, docText, rank } from "@scanlist/ts-core";

const parsed = parseList(jsonText);
if (!parsed.ok) throw new Error(parsed.errors.join("\n")); // RFC 6901 pointer errors

const items = flatten(parsed.list);           // FLATTEN.md §1 shape, no `vec`
const texts = items.map(docText);             // "Name; aliases; section > path"

// `vec` lives on the input copy (RANK.md §1), never in flatten output.
const input = items.map((item) => ({ ...item, vec: vectorFor(item.id) }));
const out = rank(
  input,
  { text: [prefixedQueryVector], image: [rawFrameVector] },
  previousState,                               // persist out.state between ticks
  barcodeProductName,                          // OFF name or null; adds the 0.15 boost
);
out.topId;                                     // hysteresis winner
out.entries;                                   // top, candidates, then done group
```

## Behaviour contracts

- **`parseList`** mirrors the Kotlin reference validator (`apps/kotlin/.../ListJson.kt`): unknown
  fields ignored, `amount` union by JSON type (a quoted `"3"` stays text), non-finite numbers
  rejected (`1e999` → Infinity → pointer error), never a partial import.
- **`flatten` / `docText`** are byte-identical to `shared/ref/scanlist_ref.py` on all 44 sample
  items: sha1 ids from `section/path/name#index`, depth-first items-before-sub-sections order,
  alias NFC+lowercase dedupe, `name; aliases; path` text.
- **`rank`** is a port of RANK.md §1–§9: 256-d cosine (dot), `q6` rounding, max fusion, barcode
  boost, EMA α = 0.5, 0.02 hysteresis, done group last, every degraded state. `decideTop` is the
  only highlight decision point — card S10 will add the margin/threshold rule there.

`npm test` replays all 58 queries (5 lists / 88 items) of `shared/fixtures/golden.json` through
this implementation with no model and asserts the oracle's `expectedTop3`, `expectedScores` and
`expectedMargin`, and byte-compares the four sample flattens.

## Commands

```bash
cd shared/ts-core
npm ci
npm test          # vitest run
npx tsc --noEmit  # type-check
```

TypeScript is a dev dependency only so `npx tsc` resolves the local compiler (the bare `tsc` npm
package is not the compiler). CI's `shared` job already runs `npm test` for this package.
