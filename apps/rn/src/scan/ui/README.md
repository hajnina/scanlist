# Magic scan UI — camera, hero, manual tick (Track A, card A5)

The React Native scan screen: camera preview, the three source chips, a hero card for
`rank()`'s `topId` with a big **tick** button, and the ranked list below. It is the RN twin of the
Kotlin track's B5 screen and follows the same contract:

- **auto-rank, manual tick** — scoring runs while the camera is open, but an item is only checked
  off when the shopper taps the tick. Nothing auto-commits.
- **the hero is `topId`** — `@scanlist/ts-core`'s `decideTop` owns margins, floors, image
  accept-list confirmation and hysteresis. This screen has no gate logic and never derives a hero
  from `entries[0]` (whose order can legitimately differ under hysteresis).
- **the barcode is never the dropped query** — RANK.md §2.2 allows 16 text queries per tick. If a
  barcode arrives after 16 OCR lines it still gets slot 1; OCR keeps 15. That fix lives in
  [`buildTextQueries`](./pool.ts) (card B5's note), not in ts-core.

```
ScanScreen.tsx      camera + layout only (thin, untested — A4 precedent)
useScanSession.ts   sources → engine, 400 ms tick pacing, lifecycle (thin)
HeroCard.tsx        hero / null-hero states, tick button, haptics, springs
SourceChips.tsx     barcode / OCR / image chips
RankedRows.tsx      ranked rows below the hero
tick.ts             ScanTickEngine: signals → OFF → queries → rank  (tested)
pool.ts             SignalPool + buildTextQueries (pool-order fix)  (tested)
off.ts              OFF derivation, client, cache                    (tested)
offAsyncStorage.ts  AsyncStorage adapter for the OFF cache
```

## Mounting (the screen is exported but not wired yet)

Card A5 may only edit `apps/rn/src/scan/ui/`, so `src/App.tsx` / `src/list/ui/*` are untouched. The
lead can wire it in two edits:

1. In `src/list/ui/ListsScreen.tsx` add a `scanning` flag next to `openId`; when a list is open and
   the user taps **Scan**, render the scan screen with the exact props the detail screen already
   gets:

   ```tsx
   import {ScanScreen} from '../../scan/ui';

   if (stored !== null && scanning) {
     return (
       <ScanScreen
         repository={repository}
         stored={stored}
         onBack={() => setScanning(false)}
         onChanged={updated =>
           setLists(current =>
             current === null
               ? current
               : current.map(entry => (entry.id === updated.id ? updated : entry)),
           )
         }
       />
     );
   }
   ```

2. Add the **Scan** button/affordance (e.g. a FAB) in `ListDetailScreen` that calls
   `onScan={() => setScanning(true)}` (new optional prop), or render it from `ListsScreen`'s
   wrapper. No other change is needed: `ScanScreen` creates its own repository-independent OFF
   client, frame feed and engine.

`onChanged` receives the whole `StoredList` after each commit, exactly like `ListDetailScreen`, so
the home screen's progress stays in sync.

## One tick, in order

1. **Signals** arrive from A4 (`../sources`) — one barcode signal, one signal per OCR line, one
   image signal per frame. `useScanSession` coalesces them and runs at most one evaluation every
   400 ms (`MIN_INTERVAL_MS`). `onImage` embeds the JPEG first (`engine.pushImageFrame`).
2. **Barcode → name.** A fresh barcode is looked up in Open Food Facts through the cached
   `OffClient`; its derived name becomes the barcode text query and the `+0.15` boost input.
   A stale barcode is held for 60 s (`DEFAULT_BARCODE_HOLD_MS`, "Barcode Buddy" stickiness) or
   until one commit (`markCommitted`), so the hero does not dissolve while the shopper reads it.
3. **Text queries.** `buildTextQueries(barcodeName, ocrLines)` → barcode first, then OCR in
   detection order, deduplicated, ≤ 16.
4. **Embed.** Item `docText` vectors are embedded once per session; query vectors are cached by
   text. Prefixes (`task: search result | query: …` / `title: …`) are A3's `modules/embed` job.
5. **Rank.** ts-core `rank()` receives the text queries plus the newest ≤ 4 image vectors from the
   last 2000 ms, the persisted `RankState`, the resolved barcode name, and the previous output.
   `README`-level constants live in `shared/spec/RANK.md`; the constants themselves are in
   `shared/ts-core/src/rank.ts`.
6. **Report** `hero` / `no-hero` / `no-signal` / `no-items` / `embed-unavailable`. `heroId` is
   `output.topId` or `null`; `HeroCard`/`NullHeroCard` render that state verbatim.

A tick is single-flight: a second call while one is running (slow OFF/embed) returns the same
promise, so the 400 ms timer cannot interleave two rank passes.

## OFF cache (OFF.md is normative)

```text
AsyncStorage key:  scanlist/off/<barcode>          (sibling of A2's scanlist/list/<id>)
value:            {"text": string | null, "hit": boolean, "fetchedAt": number}
                  fetchedAt = Unix seconds
TTL:              30 days for a hit, 1 day for a miss
cap:              1000 entries; expired/unreadable entries evicted first, then oldest fetchedAt
request:          GET https://world.openfoodfacts.org/api/v2/product/<barcode>.json
                  ?fields=code,product_name,brands,generic_name,categories
                  User-Agent: ScanList/0.1, Accept: application/json
behaviour:        3 s connect / 10 s total timeout, ≤ 3 redirect hops (HTTPS only),
                  per-barcode retry: Retry-After wins, 429 → 60 s, 5xx/timeout → 1/2/4 s
                  (cap 60 s), ≤ 3 transient attempts per barcode per scan session, then
                  cache-only with an honest note; success clears the state,
                  ≥ 100 ms between requests, single-flight per barcode,
                  stale-while-offline (a stale hit is better than no name)
```

The retry/redirect semantics mirror the Kotlin track's `OffResolver`/`OffRedirect`
(`apps/kotlin/.../scan/ui/OffLookup.kt`) rule for rule: per-key retry state so a failing barcode
never delays another barcode's first attempt, and a pure `resolveOffRedirect` (3 hops, HTTPS only,
relative targets resolved).

`deriveProductText` follows OFF.md §3 exactly (status gate, `product_name` → `generic_name` →
cleaned `brands`, NFC, whitespace collapse, 160-code-point truncation). `off.test.ts` replays every
recorded fixture in `shared/off/fixtures/`, so the app cannot drift from `check_fixtures.py`.

## Deviations from the card (for the reviewer)

- **Motion:** RN's built-in `Animated` springs (`SpringIn`) plus `LayoutAnimation` for row reorder,
  not Reanimated. Reanimated is not a dependency of this app and A1/A2 already ship the token
  springs; the style guide asks for expressive motion, not a specific library.
- **No render test:** the camera/ML Kit/embedder glue (`ScanScreen`, `useScanSession`,
  `HeroCard`, `SourceChips`, `RankedRows`) is thin and untested, matching A4's precedent. The
  logic that can go wrong is in `tick.ts` / `pool.ts` / `off.ts` and is covered by 74 tests.
- **RN fetch limits on OFF.md §2:** RN's whatwg-fetch/XHR polyfill exposes no native connect
  timeout and ignores `redirect: 'manual'` (XHR follows redirects itself). The 3 s connect budget
  is an AbortController approximation; hop control runs whenever the runtime hands redirects back
  (the tests' fake fetch, or a runtime that honours `'manual'`), and the HTTPS-only rule is always
  enforced on the final `Response.url`, so a silent downgrade is refused. Documented at the top of
  `off.ts`.
- **Not mounted:** see "Mounting" above. The barrel is exported so the lead's wiring is two edits.

## Tests

```sh
cd apps/rn
npm run typecheck                  # tsc --noEmit
npm test                           # 21 suites / 237 tests
npx eslint .                       # 0 errors / 0 warnings
npx react-native bundle --platform android --dev false \
  --entry-file index.js --bundle-output /tmp/a5-index.jsbundle
# and the screen itself compiles into a bundle:
npx react-native bundle --platform android --dev false \
  --entry-file src/scan/ui/index.ts --bundle-output /tmp/a5-scan.jsbundle
```

`__tests__/off.test.ts` (32) replays the OFF fixtures, the cache/client contract, the per-barcode
backoff/Retry-After ladder, the redirect policy and the in-flight/timeout rules;
`__tests__/pool.test.ts` (18) pins the 16-query pool order, sticky barcode, OCR batches and the
2000 ms / 4-frame image window; `__tests__/tick.test.ts` (24) covers barcode→OFF→query wiring,
the item/query caches, all five tick reasons, the image accept-list guard, the text/image gate
boundaries (0.04 / 0.70 / 0.001 / 0.65) and the hysteresis dead band.

## Manual test on a phone (screenshots are device-gated)

Prereqs: the screen is wired (above), an Android phone on this machine (`adb devices`), Metro
running (`npm start`), and the embedder model installed per `modules/embed` (the debug self-test
screen reports `E_MODEL_MISSING` if not).

1. Open a list → **Scan**. The system camera dialog appears; deny it → the permission card shows
   the "blocked" copy, allow from Settings and return → preview appears without a restart.
2. Point at a shelf: the **Barcode** chip lights with digits, **OCR** reports one line per query
   (≤ 16), **Image** reports 1–4 frames ("4 newest / 2 s").
3. Point at a product whose name is on the list and whose barcode resolves in OFF: the hero shows
   that item, the list below is ranked, and the barcode chip shows the OFF name.
4. **Tick** the hero once: the item moves to done, the next candidate becomes the hero, and the
   barcode hold ends after that one commit (the hero does not keep re-highlighting the ticked item).
5. Hold the same barcode in frame but move the phone away: the hero stays for up to 60 s, then
   dissolves to `no-hero`/`no-signal` rather than flickering.
6. Point at a product **not** on the list: the ranked list may reorder but the hero card says there
   is no confident match (margin/floor gate inside ts-core), never a wrong hero.
7. Turn off Wi-Fi and point at an uncached barcode: chips keep working, the barcode chip says OFF
   has no name, OCR/image still rank, no crash. Re-enable Wi-Fi: the next scan resolves.
8. Rotate/leave the screen: captures stop, no temp JPEGs accumulate; returning resets rank state
   (no stale hero from the previous scan).
9. Compare against the Kotlin B5 screen side by side: same hero/none copy, same manual tick, same
   chip semantics.

**Screenshot gap:** this card cannot produce screenshots. This laptop has no `adb`/device (card B0
is device-gated), and CI builds the APK on an x86_64 runner with no camera or emulator. The PR body
and card Notes record this as a known gap, matching A4's precedent; steps 1–9 are the script for
whoever runs it on hardware.
