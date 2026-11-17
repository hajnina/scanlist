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
out.topId;                                     // highlighted hero, or null when the gate is closed
out.entries;                                   // hero first (if any), ranked candidates, done group
```

## Behaviour contracts

- **`parseList`** mirrors the Kotlin reference validator (`apps/kotlin/.../ListJson.kt`): unknown
  fields ignored, `amount` union by JSON type (a quoted `"3"` stays text), non-finite numbers
  rejected (`1e999` → Infinity → pointer error), never a partial import.
- **`flatten` / `docText`** are byte-identical to `shared/ref/scanlist_ref.py` on all 44 sample
  items: sha1 ids from `section/path/name#index`, depth-first items-before-sub-sections order,
  alias NFC + full-casefold dedupe (`casefold`, not `toLowerCase`), `name; aliases; path` text.
- **`rank`** is a port of RANK.md §1–§9: 256-d cosine (dot), `q6` rounding, max fusion, barcode
  boost, EMA α = 0.5, done group last, every degraded state. The highlight is decided in exactly
  one place, `decideTop`, in the spec's order: 0.02 hysteresis (§6.1) → per-source evidence gate
  (text 0.05 / 0.79, image 0.005 / 0.68, §6.2) → image accept-list guard (§6.3). `topId` may be
  `null` while `entries` stays the full ranked order; barcode/OFF-name matching uses Unicode full
  case folding (`casefold`, so `ß` → `ss`, `İ` → `i̇`, `ﬁ` → `fi`).

`npm test` replays all 58 queries (5 lists / 88 items) of `shared/fixtures/golden.json` through
this implementation with no model and asserts the oracle's `expectedTop3`, `expectedScores` and
`expectedMargin`, and byte-compares the four sample flattens.

**Known divergence (tracked, intentionally not changed here):** `parseList` trims a non-blank
string `amount` (`"2 packs "` → `"2 packs"`), as the Kotlin importer does, while the Python oracle
keeps the string verbatim (S8's pre-existing divergence). It is outside RANK.md's highlight contract
and awaits a spec ruling; the golden samples contain no non-blank string amount with surrounding
whitespace, so the fixture does not observe it. (`flatten` itself does not trim.)

## Commands

```bash
cd shared/ts-core
npm ci
npm test          # vitest run
npx tsc --noEmit  # type-check
```

TypeScript is a dev dependency only so `npx tsc` resolves the local compiler (the bare `tsc` npm
package is not the compiler). CI's `shared` job already runs `npm test` for this package.
