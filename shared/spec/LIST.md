# ScanList list format (normative)

Status: **normative spec v1**, owned by card S1. All three tracks (Kotlin, React Native, Web) MUST parse and
export exactly this shape. Machine-readable schema: [`list.schema.json`](list.schema.json) (a byte copy of
`docs/list.schema.json`; that copy is the source of truth for validation).

Keywords MUST / MUST NOT / SHOULD are used in the RFC 2119 sense.

---

## 1. Encoding and top level

A list is a single **UTF-8 JSON object** (no BOM, no comments, no trailing commas, standard JSON escapes).

| field | type | required | default | meaning |
|---|---|---|---|---|
| `title` | string, non-empty after trim | **yes** | — | human title, shown in the lists screen |
| `version` | integer | no | `1` | format version; readers MUST accept `1`. A version they do not know is parsed best-effort |
| `sections` | array of *section* | **yes** | — | top level sections; MAY be empty |

Unknown top-level fields are allowed by the schema. Readers MUST ignore them without error; they are **not**
required to survive an export (see §7).

A list with `"sections": []` is valid and renders as an empty list ("nothing to buy").

## 2. Sections (nested, any depth)

| field | type | required | default | meaning |
|---|---|---|---|---|
| `name` | string, non-empty after trim | **yes** | — | section heading, also part of every descendant's embedding text |
| `items` | array of *item* | no | `[]` | items directly in this section |
| `sections` | array of *section* | no | `[]` | sub-sections, **recursive, any depth** |

- Both `items` and `sections` may be present in the same section and both may be empty. Omitted means empty;
  `null` is invalid (schema type is array).
- There is no hard depth limit in the format. Implementations SHOULD render at least 8 levels and MUST NOT
  crash on deeper input (flattening is iterative or recursion-limited only by the input).
- Sibling sections may share a name. Names are **not** identifiers; positions + names + item indexes are
  (see `FLATTEN.md`).
- Section order in `sections` is the display and tie-break order.

## 3. Items

| field | type | required | default | meaning |
|---|---|---|---|---|
| `id` | string | no | derived (see `FLATTEN.md`) | stable identity; survives rename/reorder. SHOULD match `^[^\s#]{1,128}$` |
| `name` | string, non-empty after trim | **yes** | — | what to buy; first part of the embedding text |
| `amount` | number **or** string | no | absent | `2`, `0.5`, `500` or free text like `"2 packs"`, `"a handful"` |
| `unit` | string | no | absent | `"kg"`, `"l"`, `"g"`, `"pack"`; rendered after the amount |
| `note` | string | no | absent | free note for the human. **Never embedded** (see `FLATTEN.md` §4) |
| `aliases` | array of string | no | `[]` | extra words embedded with the item: brand, other language, synonyms |
| `done` | boolean | no | `false` | ticked off; checked items sink to the "Done" group |

Rules:

- **`amount` is a union on purpose.** A number is a quantity (`6`, `1`, `0.5`, `500`); a string is used
  verbatim (`"2 packs"`, `"1/2"`, `"a handful"`, `"500 g bag"`). Readers MUST accept both and MUST NOT
  coerce a string to a number or vice versa. An empty/whitespace-only string is treated as absent.
- `unit` only has meaning together with an amount. An empty/whitespace-only `unit` is treated as absent.
- `aliases` entries MUST be strings. Entries that are empty/whitespace-only are ignored (as if absent);
  duplicates are harmless (see the dedupe rule in `FLATTEN.md` §5). Aliases are case-sensitive data —
  do not lowercase them in storage.
- `done` is the only mutable per-item state. Ticking an item sets `true`; unticking sets `false`. Never
  remove a ticked item from storage.
- `id`, when present and not empty/whitespace-only, is used **verbatim** (leading/trailing whitespace is
  trimmed). Empty/whitespace-only ids are treated as absent and an id is derived. Explicit ids make an item
  stable across renames/reorderings and SHOULD be set by any producer that edits lists programmatically.
- `name` is the only field guaranteed to exist for every item. Two items may have the same name in the same
  section (e.g. two "Milk" entries in different sub-sections); ids disambiguate them.

## 4. Amount / unit rendering (normative, for all UIs)

`amountText` and `displayText` are:

```
amountText = amount missing            -> ""
             amount is string          -> amount as stored (trimmed)
             amount is number          -> shortest round-trip decimal, JSON style:
                                          no "+", no exponent for |x| in [1e-6, 1e15),
                                          "6" not "6.0", "0.5", "-2" (negative is allowed but weird)
displayText = trim(amountText + (" " + unit if unit present and amountText present else ""))
```

Notes render in their own row (or as a subtitle), never inside `amountText`/`displayText`.

Examples: `{amount: 6}` → `"6"`; `{amount: 1, unit: "kg"}` → `"1 kg"`; `{amount: "2 packs"}` → `"2 packs"`;
`{unit: "kg"}` (no amount) → `""`; `{amount: 0.5, unit: "l"}` → `"0.5 l"`.

## 5. Validation results

A parser MUST produce one of:

```
Ok(list)                  // schema-valid
Error(errors: [string])   // each error names a JSON pointer, e.g. "/sections/0/items/1/name"
```

Schema validation alone is enough to say "valid". Recommended extra **warnings** (do not reject):

- explicit item id repeated within one list (the flattener renames later duplicates, breaking references);
- unknown keys inside an item/section (allowed, ignored);
- `unit` without `amount`;
- item `name` with leading/trailing whitespace.

## 6. Import rules

- File, paste or URL import MUST accept exactly this JSON shape.
- Empty file, non-object root, missing `title`/`sections`, non-array `sections` → `Error`, no partial import.
- Unknown top-level/section/item fields MUST NOT block import.
- A list may be imported any number of times; the app does not deduplicate imports.

## 7. Persistence and export ("round trip")

- Persist the parsed list locally plus `done` flags. The app MAY persist derived ids; if it does not, ids are
  re-derived on load with the algorithm in `FLATTEN.md` (same JSON ⇒ same ids).
- Export MUST produce the **same JSON shape**: `{title, version, sections:[{name, items:[...], sections:[...]}]}`
  with every item carrying at least `name` and, when non-default, `amount`, `unit`, `note`, `aliases`, `done`
  (export `done` on ticked items as `"done": true`; exporting `"done": false` is also allowed).
- Export MUST preserve item order (JSON order is the ranking tie-breaker), section nesting, section order,
  free-text amounts and aliases. Unknown fields MAY be dropped; `id` MAY be exported when explicit.
- `done` flags are the else-unmodified copy: import → tick things → export must round-trip to an equal list
  apart from `done` and formatting.

## 8. Examples

Minimal valid list:

```json
{"title": "Corner shop", "sections": [{"name": "Tonight", "items": [{"name": "Bread"}]}]}
```

Nested with every field:

```json
{
  "title": "Van weekly shop",
  "version": 1,
  "sections": [
    {"name": "Fresh", "sections": [
      {"name": "Fruit & veg", "items": [
        {"id": "bananas", "name": "Bananas", "amount": 6},
        {"name": "Tomatoes", "amount": 1, "unit": "kg", "aliases": ["tomates"], "done": true}
      ]},
      {"name": "Dairy", "items": [
        {"name": "Oat milk", "amount": "2 cartons", "unit": "l", "note": "the barista one",
         "aliases": ["bebida de avena"]}
      ]}
    ]}
  ]
}
```

Invalid (each line is a separate example): missing `title`; `"sections": {}`; `{"name": 3}` in a section;
item without `name`; `"amount": null`; `"aliases": "milk"`; `"done": "yes"`.

## 9. Field ownership summary

| concern | spec |
|---|---|
| shape, fields, amount union, defaults | this file + `list.schema.json` |
| traversal order, item ids, embedding text | `FLATTEN.md` |
| vectors, scoring, smoothing, ordering, cadence | `RANK.md` |
| prefix strings and which set is active | `prompts.json` |
| executability | `validate.py` |
