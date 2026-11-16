# FLATTEN — traversal, item ids, embedding text (normative)

Status: **normative spec v1**, owned by card S1. Input: a list per `LIST.md`. Output: an ordered array of
`FlattenedItem`. Every track MUST produce the same array — ids and order are compared in the golden tests.

---

## 1. FlattenedItem

```
FlattenedItem = {
  id:        string,            // explicit or derived, unique in the list (§3)
  name:      string,            // item.name, trimmed for display; key uses the verbatim value
  amount:    number | string | null,
  unit:      string | null,
  note:      string | null,
  aliases:   string[],          // non-empty trimmed strings, deduped (§3)
  done:      boolean,
  path:      string[],          // section names root → parent section, [] for a root item
  pathText:  string,            // path.join(" > "), "" for a root item
  index:     number,            // 0-based index of the item in its parent section's `items`
  order:     number             // 0-based index in the flattened output (JSON order)
}
```

`null` above means "field absent or empty/whitespace-only". `amount` keeps its JSON type (never coerce).

## 2. Traversal order (depth-first, items before sub-sections)

Depth-first **pre-order**, visiting a section's own `items` first (in array order), then its `sections`
(in array order), recursing. Top-level sections are visited in `list.sections` order.

```
order := 0
flatten(list):
  out := []
  for s in list.sections:            // JSON order
    walk(s, [s.name])
  return out

walk(section, path):
  for i, item in section.items:      // JSON order
    out.push(flattenItem(item, path, i, order)); order += 1
  for child in section.sections:     // JSON order
    walk(child, path + [child.name])
```

Consequences (all normative):

- A section's own items come **before** any item of its sub-sections.
- Two sibling sections are ordered by their position in `sections`, never alphabetically.
- Empty sections and empty item arrays contribute nothing.
- `order` is the global tie-breaker used by ranking (`RANK.md` §6) and by the "Done" group.

## 3. Item id

### 3.1 Explicit id

If `item.id` exists and is a string whose trimmed value is non-empty, then `id = trim(item.id)`, used
**verbatim** (case and punctuation preserved). Explicit ids SHOULD be unique; see §3.3 for collisions.

### 3.2 Derived id

Otherwise:

```
pathKey  = path.join("/")                      // "" for a root item
key      = (pathKey == "" ? "" : pathKey + "/") + item.name + "#" + str(i)
id       = "sha1:" + lower_hex(sha1(utf8(key)))   // 40 hex chars, no line break
```

- `item.name` and every section name in `path` are the **exact strings as decoded from JSON**:
  no trimming, no case folding, no Unicode normalisation, no slugification. JSON escapes are already resolved.
- `i` is the 0-based index of the item in its parent section's `items` array (**not** the global order).
- The hash is SHA-1 over the UTF-8 bytes of `key`; hex is lowercase; the id is namespaced with `sha1:`
  so a derived id can never silently equal a normal explicit id.
- The `#index` component is what keeps duplicate names in the same section distinct.

Worked values (verified with `sha1sum`; use these as unit-test vectors):

| path | name | index | key | id |
|---|---|---|---|---|
| `[]` | `Milk` | 0 | `Milk#0` | `sha1:2f551506bf4e121abecf1480482d5674359ee397` |
| `["Pantry"]` | `Pasta` | 0 | `Pantry/Pasta#0` | `sha1:19d895a3b978a4e00caccc2f20ce35044c83cd28` |
| `["Fresh","Fruit & veg"]` | `Bananas` | 0 | `Fresh/Fruit & veg/Bananas#0` | `sha1:998e2c1acb80597f39892b85f9dfa8726ead298e` |
| `["Fresh","Fruit & veg"]` | `Tomatoes` | 1 | `Fresh/Fruit & veg/Tomatoes#1` | `sha1:801b3e63df7a42974bc5f11b4a342251f8c04ba3` |
| `["A","B","C","D"]` | `Nutmeg` | 2 | `A/B/C/D/Nutmeg#2` | `sha1:cfc789c216b0dd286fa1f6f40592e8db7aeb7197` |

Stability: a derived id changes if any ancestor section name, the item name, or the item's index changes.
Producers that rename/reorder items MUST set explicit ids first.

### 3.3 Collisions (deterministic renaming)

Ids MUST be unique within a flattened list. Walk the output in `order`; the first item with a candidate id
keeps it. For each later item whose candidate id is already taken:

```
base = candidate; n = 2
while base + "~" + n is taken: n += 1
id = base + "~" + n
```

This applies to explicit ids too (e.g. two items with `id: "milk"` → `milk`, `milk~2`). Producing duplicate
explicit ids is a data bug; the parser SHOULD warn (LIST.md §5) but the flattener MUST still succeed.

## 4. Embedding text (`docText`) — normative

Item vectors are built from this exact string (see `RANK.md` §2 for embedding, prefixes in `prompts.json`):

```
name'    = trim(item.name)
aliases' = [trim(a) for a in aliases if trim(a) != ""]   // drop empties; dedupe (§5)
path'    = [trim(s) for s in path]                        // section names for the text
docText  = name'
           + (aliases' non-empty ? "; " + aliases'.join(", ") : "")
           + (path' non-empty    ? "; " + path'.join(" > ")  : "")
```

- Order is fixed: **name, then aliases, then section path** (matches `docs/ARCHITECTURE.md`).
- Separator is `"; "` (semicolon + one space). Alias separator is `", "`. Path separator is `" > "`.
- The whole string is trimmed once at the end. Nothing else is added — no amount, no unit, no note,
  no trailing period, no prefix (the embedder adds the prefix from `prompts.json`).
- `note` is deliberately excluded: notes are human instructions ("the barista one"), not product words.
- How many sections: **all** ancestor section names, root first.
- An item always has a non-empty `docText` (its `name` is required non-empty).

Worked examples (from `samples/van-weekly.json`):

| item | docText |
|---|---|
| Bananas (`Fresh > Fruit & veg`, no aliases) | `Bananas; Fresh > Fruit & veg` |
| Tomatoes (`Fresh > Fruit & veg`, aliases `["tomates"]`) | `Tomatoes; tomates; Fresh > Fruit & veg` |
| Oat milk (`Fresh > Dairy`, aliases `["bebida de avena"]`) | `Oat milk; bebida de avena; Fresh > Dairy` |
| Milk (root item, no aliases) | `Milk` |

## 5. Alias normalisation

- Trim each alias; drop empty/whitespace-only entries.
- Deduplicate **case-insensitively after NFC normalisation + case folding**, keeping the first occurrence's
  original spelling and order: `["Leche", "leche", "Leche "]` → `["Leche"]`.
  Rationale: duplicates add no signal and only cost tokens; equality for the barcode boost is defined in
  `RANK.md` §3.1 (NFC + casefold + whitespace collapse).
- Aliases are never merged into `name`; `name` keeps priority in the text.

## 6. Reference implementation (canonical behaviour)

Python, no deps; S2 (`shared/ref/scanlist_ref.py`) MUST match this and may call it as the oracle:

```python
import hashlib, unicodedata

def flatten(list_obj):
    out = []
    used = set()

    def walk(sec, path):
        for i, it in enumerate(sec.get("items") or []):
            cand = it.get("id")
            cand = cand.strip() if isinstance(cand, str) and cand.strip() else None
            if cand is None:
                key = ("/".join(path) + "/" if path else "") + it["name"] + "#" + str(i)
                base = "sha1:" + hashlib.sha1(key.encode("utf-8")).hexdigest()
            else:
                base = cand
            item_id, n = base, 2
            while item_id in used:
                item_id = f"{base}~{n}"; n += 1
            used.add(item_id)
            aliases, seen_norm = [], set()
            for a in it.get("aliases") or []:
                a = a.strip() if isinstance(a, str) else ""
                norm = unicodedata.normalize("NFC", a).casefold()
                if a and norm not in seen_norm:
                    seen_norm.add(norm); aliases.append(a)
            amount = it.get("amount")
            if isinstance(amount, str) and not amount.strip():
                amount = None
            out.append({
                "id": item_id, "name": it["name"].strip(),
                "amount": amount, "unit": (it.get("unit") or "").strip() or None,
                "note": (it.get("note") or "").strip() or None, "aliases": aliases,
                "done": bool(it.get("done", False)),
                "path": list(path), "pathText": " > ".join(path),
                "index": i, "order": len(out),
            })
        for child in sec.get("sections") or []:
            walk(child, path + [child["name"]])

    for s in list_obj["sections"]:
        walk(s, [s["name"]])
    return out

def doc_text(item):
    parts = [item["name"]]
    if item["aliases"]:
        parts.append(", ".join(item["aliases"]))
    if item["path"]:
        parts.append(" > ".join(item["path"]))
    return "; ".join(parts).strip()
```

(Real parsers validate first; this snippet assumes a schema-valid list. `it["name"]` is used verbatim in the
key and trimmed only for output/embedding text.)

## 7. Edge cases

| input | result |
|---|---|
| root section with items only | items have `path=[name]`, ids include the section name |
| empty section | nothing emitted |
| duplicate `name` in one section | distinct ids via `#index` |
| duplicate explicit id twice | second becomes `id~2` |
| item name with trailing spaces | id key keeps the spaces (verbatim); `name`/`docText` are trimmed |
| 4-level nesting | one flat entry per item, `path` has 4 entries |
| 5000 items | allowed; flattening is O(n) and MUST NOT recurse deeper than the JSON nesting |
