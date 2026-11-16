# OFF — barcode → product text (normative)

Status: **normative spec v1**, owned by card S4. Consumers: the barcode scan source of every track
(B5 Kotlin, A5 React Native, C5 web/server). It produces the **raw derived query text** that `RANK.md`
§2.2 embeds and §3.1 boosts; it does **not** embed anything itself and never adds a prefix.

Recorded fixtures live in [`fixtures/`](fixtures/) and are checked by [`check_fixtures.py`](check_fixtures.py).

Keywords MUST / MUST NOT / SHOULD are used in the RFC 2119 sense.

---

## 1. Scope

One job: given a scanned barcode, get a product name from **Open Food Facts (OFF) API v2** and turn it into
one plain text string, or nothing. That string is used for exactly two things:

1. a **text query**: `prompts.json[active].query + trim(text)` (prefix read at runtime — never hard-coded,
   see `shared/spec/prompts.json`),
2. the **barcode exact-match boost** input (`barcodeName` in `RANK.md` §1/§3.1).

If the text is `null`, there is **no barcode text query and no boost**; the raw barcode number is never
embedded (`RANK.md` §8). The camera/OCR/image sources are unaffected.

Out of scope: OCR, embedding, ranking, UI, offline list storage.

## 2. Request contract

```
GET https://world.openfoodfacts.org/api/v2/product/{barcode}.json
      ?fields=code,product_name,brands,generic_name,categories
User-Agent: ScanList/0.1
Accept: application/json
```

- **Host**: `world.openfoodfacts.org` only. It is the global v2 endpoint; country subdomains are not
  needed and MUST NOT be probed as fallbacks. Never use `/cgi/search.pl` or `/api/v2/search` for a barcode
  lookup — search is a different (rate-limited) API and returned HTTP 503 while recording these fixtures.
- **`fields=`**: exactly `code,product_name,brands,generic_name,categories`. Requesting fewer fields
  (e.g. only `product_name`) is **not** conformant: the derivation needs `generic_name` and `brands`, and
  the smaller payload is the whole point of `fields=`. Do not request images, ingredients, nutrition, or
  anything else. `categories` is requested for provenance/debugging only and MUST NOT influence the
  derived text. OFF may include extra keys even with `fields=` (e.g. `ecoscore_tags`); ignore everything
  except the three derivation fields (`product_name`, `generic_name`, `brands`).
- **`User-Agent`**: exactly `ScanList/0.1`. Generic and identical on every device: no device model, no
  OS version, no user id, no e-mail, no list content. This is the only header beyond `Accept`.
- **No secrets**: no API key, no auth header, no cookie, no query parameter carrying user data.
- **Barcode validation**: the scanned value MUST match `^[0-9]{8,14}$` (EAN-8, UPC-A/EAN-13, ITF-14).
  Send the digit string **verbatim**: never strip leading zeros, never re-pad, never add a check digit,
  never convert UPC-A to EAN-13. A value that fails the pattern produces **no request** and **no cache
  entry** (it is a scanner error, not a product miss).
- **Timeout**: 3 s connect / 10 s total. A timeout is a *transient failure* (see §4), never a miss.
- **Redirects**: follow at most 3, HTTPS only, certificate validation on.
- **HTTP status is authoritative.** `status_verbose` is human text and MUST NOT be parsed. A real recorded
  example: `3560070829668` returns **HTTP 404**, `status: 0`, yet `status_verbose` reads
  `"product found with a different product type: petfood"`. That is a **miss**, not a hit.

### 2.1 Outcome table

| HTTP | body | outcome | cache |
|---|---|---|---|
| 200 | `status: 1` and a `product` object | **hit** → derive text (may still be `null`, §3.4) | positive, 30 days |
| 200 | `status: 0` / no `product` | **miss** | negative, 1 day |
| 404 | any JSON body | **miss** | negative, 1 day |
| 429 | any | **transient** | none; honour `Retry-After` |
| 5xx, 3xx beyond the limit, HTML/error page, non-JSON | any | **transient** | none |
| connect/DNS/TLS timeout | — | **transient** | none |

A **hit with no usable name** is still a hit: it is cached positively for 30 days with `text: null`, so
the app does not re-ask OFF on every scan of a badly-filled product.

## 3. Derived query text (normative algorithm)

### 3.1 Field cleaning

`clean(v)` — for one field value:

1. if `v` is not a string (absent, `null`, number, array) → `""`;
2. `s = NFC(v)` (Unicode NFC only; **not** NFD/NFKC/NFKD);
3. replace **every maximal run of Unicode `White_Space` characters** with one U+0020 SPACE. This includes
   U+0009–U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000.
   U+200B (zero-width space) and U+FEFF (BOM) are **not** whitespace and are kept;
4. strip leading/trailing U+0020 (after step 3 the only remaining whitespace characters are already
   U+0020, so stripping spaces suffices).

No case folding, no punctuation stripping, no accent removal, no HTML-entity decoding, no trimming of
commas, no removal of size/quantity suffixes, no transliteration. `"Spaghetti Nº5"` stays
`"Spaghetti Nº5"`; `"Coca-Cola Original"` keeps its hyphen; `"muesli raisin,datte,figue"` keeps its
tight commas.

`clean_brands(v)` — the brands field is a comma-separated list:

1. `s = clean(v)`; if `s == ""` → `""`;
2. split `s` on `,` (comma only — no `;`, no `/`);
3. `clean` each piece and drop empty pieces;
4. de-duplicate by `NFC(piece).casefold()` keeping the **first** spelling;
5. join the survivors with `", "` (comma + one space).

Example (synthetic): `"Ferrero,  Nutella , FERRERO"` → `"Ferrero, Nutella"`.

### 3.2 Which field wins

Priority is **strictly one field, never a concatenation of name + generic name + brands**:

| # | source | condition |
|---|---|---|
| 1 | `product_name` | `clean(product_name) != ""` |
| 2 | `generic_name` | else, `clean(generic_name) != ""` |
| 3 | `brands` | else, `clean_brands(brands) != ""` |
| — | none | else → **no query text (`null`)**, no boost |

- `product_name` wins whenever present, even if `generic_name` is longer/more descriptive and even if
  `brands` is present. OFF's `product_name` is what is printed on the pack, i.e. what the shopper wrote on
  the list; `generic_name` is a verbose category description and `brands` is not a product name.
- `generic_name` is the fallback only when `product_name` is empty/whitespace.
- `brands` is the **last** fallback; all brands are concatenated per `clean_brands` so that a list item
  named after any one brand can still match. Brand fallback text is almost never an exact match for the
  +0.15 boost (§7) — that is expected.
- An empty result is not an error: `null` text means "no barcode signal" (`RANK.md` §8).

### 3.3 Long names

After the winner is selected, truncate to **160 Unicode code points** (scalar values, not UTF-16 units,
not bytes, not grapheme clusters):

```
text = text[:160]
text = text.rstrip(" ")
```

- Cut **hard**, mid-word: no word-boundary search, no ellipsis, no suffix.
- Counting is by **code point**, so a surrogate pair is never split; a grapheme cluster (e.g. an emoji
  followed by U+FE0F) may be split between code points — that is allowed and deterministic. Every
  implementation must count code points (`Array.from(s)` in JS, `codePoints()` in Kotlin/Java,
  Python slicing), never UTF-16 units or bytes. Code-point counting is what makes the three tracks agree.
- Trailing spaces introduced by the cut are removed; leading spaces cannot exist after §3.1.
- Rationale: the barcode text is one of at most 16 text queries per tick (`RANK.md` §2.2); keeping it
  short bounds embedding cost. In the recorded fixture set the longest real name is 91 code points
  (`3560070813704`), so truncation is only exercised by unit tests (synthetic example in §3.5).

### 3.4 Empty names

- `product_name: ""`, `"   "`, `null` or absent → treated as absent, fall through to `generic_name`.
- The same for `generic_name`; then `brands`.
- If all three clean to `""` → `text = null`. The barcode yields no text query and no boost, but it is
  still a **positive cache hit** (30 days), because the API answered successfully.
- An empty/whitespace-only `text` MUST never be embedded (`prompts.json` prefix alone is not a query) and
  MUST never be used for matching: `norm("")` would equal a hypothetical empty item name.

### 3.5 Worked examples

All except the last two rows are **real recorded responses** in `fixtures/` (raw API body, unabridged;
`check_fixtures.py` asserts these exact outputs). `null` = no query text.

| fixture | field values that matter | derived text | why |
|---|---|---|---|
| `3017620422003.json` | `product_name: "Nutella"`, `generic_name: "Hazelnut And Cocoa Spread"`, `brands: "Ferrero, Nutella"` | `Nutella` | `product_name` wins; generic name and brands are **not** appended |
| `3017620425035.json` | `product_name: "Nutella"`, `generic_name: "Pâte à tartiner aux noisettes"` | `Nutella` | same; the accented generic name is ignored |
| `3229820129488.json` | `product_name: "muesli raisin,datte,figue"` | `muesli raisin,datte,figue` | verbatim: lowercase, tight commas and all |
| `7640112099009.json` | `product_name: "Dulce   de leche"` (three spaces) | `Dulce de leche` | whitespace run → one space |
| `8593807234713.json` | `product_name: "Mléko polotučné s obsahem  1,5% tuku"` | `Mléko polotučné s obsahem 1,5% tuku` | whitespace run collapsed; accents, `%` and comma kept |
| `8076800195057.json` | `product_name: "Spaghetti Nº5"` | `Spaghetti Nº5` | masculine ordinal `º` is punctuation and is kept |
| `2000000000005.json` | `product_name: "Bas Armagnac, Hors d'âge, 20 ans d'âge"` | `Bas Armagnac, Hors d'âge, 20 ans d'âge` | commas and accents kept; no normalisation beyond NFC |
| `3560071011956.json` | no `product_name`, no `generic_name`, `brands: "Carrefour"` | `Carrefour` | brands fallback |
| `0202075011817.json` | `product_name: ""`, `generic_name: ""`, `brands: "Carrefour"` | `Carrefour` | empty strings are absent; brands fallback; leading-zero barcode kept as-is |
| `3560070813704.json` | `product_name: "Truite fumée … (5 tranches) - 100 g"` (91 code points) | the same string | under the 160 limit, parentheses kept |
| `3245390098214.json` | HTTP 404, `status: 0` | `null` | product not found → negative cache |
| `3560070829668.json` | HTTP 404, `status: 0`, `status_verbose` claims "product found with a different product type: petfood" | `null` | `status`/HTTP win, never `status_verbose` |
| *(synthetic)* | `product_name: ""`, `generic_name: "Désodorisant pour litière"` | `Désodorisant pour litière` | generic-name fallback; no recorded fixture exhibits it |
| *(synthetic)* | name of 170 code points ending in `" g"` at position 169–170 | first 160 code points, trailing space trimmed | hard code-point cut, no ellipsis |

### 3.6 Pseudocode

```python
WS = re.compile("[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+")

def clean(v):
    if not isinstance(v, str):
        return ""
    s = unicodedata.normalize("NFC", v)
    s = WS.sub(" ", s)
    return s.strip(" ")

def clean_brands(v):
    s = clean(v)
    if not s:
        return ""
    out, seen = [], set()
    for part in s.split(","):
        part = clean(part)
        if not part:
            continue
        key = part.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(part)
    return ", ".join(out)

def derive(body, barcode):
    if body.get("status") != 1:
        return None
    product = body.get("product") or {}
    for candidate in (clean(product.get("product_name")),
                      clean(product.get("generic_name")),
                      clean_brands(product.get("brands"))):
        if candidate:
            return candidate[:160].rstrip(" ")
    return None
```

`barcode` is not used by `derive`; the text depends only on the returned fields. Do not parse
`status_verbose`, do not read `categories`.

## 4. Cache and refresh rules

Local, on-device, per app install. No server-side cache, no sharing between users.

**Key**: the barcode digit string exactly as scanned (same string as the request path; no zero-stripping).

**Entry** (only these three fields; do not persist the raw OFF payload):

```json
{ "text": "Nutella", "hit": true, "fetchedAt": 1794857704 }
```

`text` is the **raw derived text** from §3 (never prefixed — the prefix can change via `prompts.json`;
see §8), or `null` for a hit without a usable name. `hit` distinguishes positive from negative entries.
`fetchedAt` is the wall-clock Unix time in **seconds** at the moment the HTTP response was received.

| outcome | `hit` | TTL |
|---|---|---|
| HTTP 200 + `status: 1` (even with `text: null`) | `true` | **30 days** = 2,592,000 s |
| HTTP 200 `status: 0`, or HTTP 404 | `false` | **1 day** = 86,400 s |

**Validity**: an entry is fresh iff `0 <= now - fetchedAt < TTL`. Exactly at `TTL` it is expired. If the
wall clock moved backwards (`now < fetchedAt`), treat the entry as fresh (age clamped to 0).

Behaviour:

1. Fresh entry → use it, **no network request**.
2. Expired or absent entry → request OFF. On hit/miss, overwrite the entry with the new outcome and
   `fetchedAt = now`.
3. **Transient failure** (table in §2.1) → write **nothing**. If an expired entry exists, its `text` MUST
   still be used for this tick (**stale-while-revalidate**) but `fetchedAt` is **not** extended; the next
   scan retries. A failed first lookup simply yields `null` for that tick.
4. **429**: wait at least `Retry-After` (seconds or HTTP-date; if absent, 60 s) before the next attempt at
   that barcode. **5xx/timeout**: exponential backoff 1 s, 2 s, 4 s … capped at 60 s, at most 3 attempts
   per scan session. Never retry a 404 during its 1-day negative TTL.
5. **Single-flight**: at most one in-flight request per barcode; concurrent scan ticks share the same
   result.
6. **Eviction**: SHOULD cap the cache at 1,000 entries, evicting expired entries first, then least
   recently used. Eviction MUST NOT delete a fresh entry while a scan for it is in flight.
7. Persistence: MUST survive app restarts (SharedPreferences / AsyncStorage / IndexedDB / file). Cache
   data is not exported with lists and never leaves the device.

Consequences: a product scanned repeatedly costs one request per month; an unknown barcode costs one
request per day; the raw barcode is never embedded, so a 404 is a silent no-signal state, not an error UI.

## 5. Etiquette and licensing

OFF is a volunteer-run, donation-funded service. The lookup MUST be a single product GET per cache miss.

- **Rate limit**: never more than **100 product requests per minute** per app instance (OFF's published
  product-API guidance), and no bursts: space requests at least 100 ms apart. Normal app traffic is far
  below this thanks to §4.
- **No bulk/prefetch**: never crawl, never resolve a whole list in the background, never download dumps or
  search pages from the app. Images/nutrition are not fetched at all.
- **Backoff**: honour `Retry-After`, exponential backoff as in §4; a 5xx page from OFF is expected
  occasionally (while recording these fixtures the search endpoints returned HTTP 503 HTML pages;
  product lookups kept working).
- **Identity**: the fixed `User-Agent: ScanList/0.1`; no personal data, no device identifiers, no
  analytics headers. Do not put the barcode or anything user-specific in a query parameter.
- **Licence/attribution**: data © Open Food Facts contributors, **ODbL 1.0**. The scan screen or the
  About screen SHOULD show “Product data: Open Food Facts (ODbL)”. Product data must not be relicensed or
  presented as ours.
- **Failure is normal**: OFF being down MUST degrade to "no barcode signal", never block the camera or
  the ranking loop. The cached text (even stale) is always preferable to a spinner.

## 6. Boost contract (interoperates with `RANK.md` §3.1)

`RANK.md` owns the algorithm; this section pins **which string** is compared and restates the
normalisation so B5/A5/C5 cannot drift.

- `barcodeName` = the **derived text from §3** (the very same string used as the text query), or `null`.
  There is no second lookup, no `product_name`-only variant, no brand splitting for the boost.
- `barcodeName` participates in the boost only if it is non-`null` and non-empty after normalisation.
- `norm(s)` (identical to `RANK.md` §3.1):

  ```
  norm(s) = NFC(s).casefold()
            with every run of Unicode White_Space replaced by one U+0020, then leading/trailing U+0020 removed
  ```

  - **NFC** composition first: `"Café"` (U+00E9) and `"Cafe\u0301"` (e + U+0301) are the same string.
  - **`casefold()`**, not `lower()`: `"Weißbier"` → `"weissbier"`, so it matches `"WEISSBIER"`.
    Consequence: `"İçecek".casefold()` is `"i\u0307çecek"`, which does **not** equal `"içecek"` — that is
    correct, do not "fix" it with locale-specific lowercasing.
    Portability (lead note 2026-11-16): Kotlin and JS/TS have no `casefold()` — implementations MUST do
    Unicode full case folding (per CaseFolding.txt, C+S+F mappings), e.g. TS: `s.normalize('NFC').toUpperCase()
    .toLowerCase()` per char is NOT sufficient; use a full-fold helper (or a tiny generated mapping table).
    RANK.md §3.1 carries the same requirement (card S10 adds the explicit sentence there).
  - **Whitespace**: runs collapse to one space, so `"Dulce   de leche"` matches `"Dulce de leche"`.
    U+200B and U+FEFF are not whitespace (same set as §3.1).
  - **Everything else is significant**: punctuation, hyphens, apostrophes, accents, digits, `º`/`№`,
    HTML entities. No diacritic folding, no transliteration, no punctuation stripping.
- **Match rule**: boost `+0.15` iff
  `norm(item.name) == norm(barcodeName)` **or** `norm(alias) == norm(barcodeName)` for any of the item's
  aliases (aliases are already trimmed/deduped per `RANK.md` §3.1; normalise again here, it is
  idempotent). Exact equality only: **no** substring, prefix, token, or fuzzy matching.
- Where: `raw = q6(max(textCos, imageCos) + 0.15)` before EMA; never clipped. The boost only ever adds on
  top of an existing base score from a text or image query; a barcode with no derived text contributes
  nothing, and with no query at all `RANK.md` §8 row 1 makes the output unranked. It is applied to the
  item only, not to every item sharing the brand.

Executable cases live in `fixtures/cases.json` → `boostCases` (checked by `check_fixtures.py`):

| barcodeName (from fixture) | item name / alias | match | why |
|---|---|---|---|
| `Nutella` | name `Nutella` | yes | exact |
| `Nutella` | name `nutella` | yes | casefold only |
| `Nutella` | name `Oat milk`, alias `Nutella` | yes | alias |
| `Nutella` | name `Nutella Biscuits` | no | no substring matching |
| `Coca-Cola Original` | name `coca-cola   original` | yes | whitespace run + case |
| `Spaghetti Nº5` | name `Spaghetti No5` | no | `º` ≠ `o`, punctuation is significant |
| `Dulce de leche` | name `Dulce  de leche` | yes | whitespace run |
| `Carrefour` (brands fallback) | name `Carrefour` | yes | brand-only product can still boost |
| `Mléko polotučné s obsahem 1,5% tuku` | name with decomposed `e`+U+0301 | yes | NFC |

## 7. Prefix and embedding boundary

- Fixtures store **raw derived text** only. The embedder adds the prefix:
  `prompts.json[active].query + trim(text)`, with `active` read at runtime (`prompts.json` §rules).
  `RANK.md` §2.2 already says the ranker never prepends a prefix; the same holds here.
- Do **not** cache prefixed strings in the OFF cache: a prefix change (`S3` A/B, `mnemothera` vs
  `modelcard`) must not require refetching OFF. Prefix is not part of the OFF cache key.
- If a track also caches query vectors, its key must include model id, dims, **prefix** and the raw text
  (`prompts.json` sets `prefixIsPartOfCacheKey: true`); that cache is per-track, not part of this spec.
- Nothing in this spec changes `RANK.md`; S4 only pins the input string.

## 8. Fixtures and how to check them

```
shared/off/
  OFF.md                     this document
  check_fixtures.py          dependency-free verifier (exit 0 = all good)
  fixtures/
    cases.json               request metadata + expected derived text + boost cases
    <barcode>.json           raw OFF API v2 response, exactly as received (compact JSON)
```

- 19 fixtures recorded **2026-11-16** against `https://world.openfoodfacts.org/api/v2/product/...`:
  17 hits (EU products, FR/IT/BE/DE/CZ/ES brands etc.) and 2 real misses
  (`3245390098214` plain 404, `3560070829668` 404 `status: 0` with a misleading `status_verbose`).
- Responses are stored verbatim (no pretty-printing, no field pruning, no added wrapper) so the fixture
  round-trips through any JSON parser byte-for-byte in meaning. Provenance (URL, HTTP status, fetch time)
  lives in `cases.json`, not injected into the response files.
- `cases.json` `expectedQueryText` was written **by hand from this spec**, then asserted against the
  fixtures — it is not generated by the checker.

```sh
python3 shared/off/check_fixtures.py          # exit 0, prints each derived query text
```

## 9. Conformance checklist

1. Request uses `world.openfoodfacts.org`, API v2 product path, exactly the five `fields` values above, and
   `User-Agent: ScanList/0.1`; no other data leaves the device.
2. Barcode is `^[0-9]{8,14}$`, sent verbatim; invalid input makes no request.
3. Hit/miss is decided by HTTP status and `status`, never by `status_verbose`.
4. Derivation is `product_name` → `generic_name` → `clean_brands(brands)` → `null`; never concatenated
   across name fields; `clean` = NFC + whitespace-run collapse + strip; no case/punctuation changes.
5. Brands fallback splits on comma, cleans each, dedupes casefolded, joins with `", "`.
6. Text is capped at 160 code points, trailing spaces removed; `null` when everything is empty.
7. Cache: hit 30 days (`text` may be `null`), miss 1 day, transient failures uncached, stale-while-
   revalidate without extending `fetchedAt`, single-flight per barcode.
8. Barcode boost compares `norm(derived text)` against `norm(item.name)`/`norm(aliases)` exactly, +0.15 on
   `raw` before EMA; no substring/fuzzy matching.
9. Fixtures store raw text, never prefixed. `python3 shared/off/check_fixtures.py` exits 0.
