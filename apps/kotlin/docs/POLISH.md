# Kotlin polish pass — every screen against STYLE_GUIDE.md + the empty/error state matrix

Card **B7** (`kanban/doing/B7.md`). Source of truth for look: `references/bonsai-ui/STYLE_GUIDE.md`
(§1–§7, Material 3 Expressive built by hand on material3 1.4.0 / compileSdk 35). Source of truth for
behaviour: `docs/ARCHITECTURE.md` "UI" §1–§4 and the card list below.

**How to read this file.** Every line is a checklist row. `- [x]` means the state/rule is implemented
and either JVM-tested or build-verified. `- [~]` marks rows that are implemented and build/test-verified
but **device-gated (B0)**: they could not be *visually or physically* verified on this machine — there
is no phone on adb for this project (card B0 is parked), so they are verified by compile + unit tests +
code review, exactly like B4/B5's camera and ML Kit claims. Nothing in this document claims a
screenshot, a screen recording, or a haptic felt on a device.

Scope of the pass: the whole app shell (`App.kt`), the Lists tab and the List screen (`list/`), the
Scan tab (`scan/ui/`, `scan/sources/CameraScanPreview.kt`) and Settings (`settings/`). Where the guide
and a card's accepted work disagreed, the deviation is listed in §4 with its reason — not silently
"fixed" in someone else's area.

---

## 1. Design-token audit (STYLE_GUIDE §1–§6)

### Colour

- [x] Dynamic colour on Android 12+ (`dynamicLightColorScheme`/`dynamicDarkColorScheme`) and a teal
      seed fallback below 31 — `Theme.kt` → `ScanListTheme`.
- [x] Dark mode is system-driven only, no in-app toggle — `Theme.kt` (`isSystemInDarkTheme`).
- [x] **No hard-coded colours in any screen**: every colour is read from `MaterialTheme.colorScheme`
      roles. Verified by grep for `Color(0x` / `Color.White|Black|Red|Gray` across
      `apps/kotlin/app/src/main/java`: only `Theme.kt`'s pre-12 seed constants match.
- [x] Root background is `colorScheme.surface` on the shell Column — `App.kt` → `ScanListApp`.
- [x] Tonal containers carry meaning: primary state = `primaryContainer` (Lists hero, latency hero),
      success/done = `tertiaryContainer` (all-done hero, hero match, note cards), neutral idle =
      `surfaceContainerHigh`, warning/hot = `errorContainer` (failed self-test, model missing, ranking
      error banner) — `ListsHomeScreen.kt`, `ListDetailScreen.kt`, `scan/ui/ScanScreen.kt`,
      `settings/SettingsScreen.kt`.
- [x] A state change recolours the **same** card, it does not swap cards: done/not-done hero
      (`ListsHomeScreen`, `ListDetailScreen`), item rows (`ItemRow`), source pills (`SourcePill`),
      tab pills (`TabPill`), latency hero (`LatencyCard`), backend switch (`LiveRankingCard`).
- [x] Progress bars use `tertiary`/`primary` with a `0.15f`-alpha on-container track — `ListProgress`
      in `list/ListImportUi.kt`, call sites in both list screens.

### Typography

- [x] One prominent weight only: `Heavy = FontWeight.Black` (`Theme.kt`) on every display/headline/
      numeral/section label.
- [x] Screen title `displayMedium` Black + `titleMedium` subtitle in `onSurfaceVariant` — `Components.kt`
      → `ScreenHeader`, used by Lists, List and Settings.
- [x] Section labels are `labelLarge` Black with 1.5 sp tracking, uppercase literal — `SectionLabel`.
- [x] Big numerals `displayLarge` Black at 56 sp (Lists hero) / 72 sp (List hero) — `ListsHomeScreen`,
      `ListDetailScreen`.
- [x] Machine values (paths, sha256, JSON sample, error codes, scores) are `FontFamily.Monospace`.
- [x] Body copy is `bodyLarge`/`bodyMedium`, secondary lines `bodySmall` in `onSurfaceVariant`.
- [x] Scan tab uses a compact caps `SectionLabel` header once a list exists (`ScanScreen.kt:188`);
      the no-list state still uses `ScreenHeader` like the other screens (`:103`) — deliberate, see §4.2.

### Shape

- [x] Hero 44 dp uniform, asymmetric leaf 16/52/16/52 and its mirror, checkerboard tile 36/12/36/12 —
      `Theme.kt` → `Shapes`, used by every card.
- [x] Press/corner morph on state change: section headers 18↔28 dp (`SectionBlock`), item rows 44↔28 dp
      (`ItemRow`), tab pills 18↔30 dp (`TabPill`), settings switch 28↔64 dp (`LiveRankingCard`).
- [x] Camera preview is clipped to the hero radius (`CameraScanPreview`) so the scan screen keeps the
      card language instead of showing a raw rectangle.

### Motion

- [x] Expressive springs copied from material3 1.4.0 (`Motion.spatial/fastSpatial/slowSpatial/effects/
      fastEffects/slowEffects`) — `Theme.kt`.
- [x] Spatial springs for movement/shape, effects springs for colour/alpha/numbers — all
      `animateDpAsState`/`animateColorAsState`/`animateFloatAsState` call sites, `Pressable`, `TabPill`.
- [x] Staggered entrance (`Modifier.springIn(i)`, 80 ms) on the first handful of cards per screen.
- [x] Ranked list reorder uses `Modifier.animateItem(placementSpec = Motion.spatial())` — the Compose
      analogue of the RN twin's Reanimated layout transition.
- [x] Hero appearance pops 1.08x→1 with the spatial spring (`HeroCard`), the ZenMeter number bump
      applied to the card.
- [x] Section expand/collapse uses explicit spatial (size) + effects (fade) springs — **B7 fix**:
      `ListDetailScreen.SectionBlock` previously used `AnimatedVisibility`'s linear defaults.

### Haptics (guide §4: "on every action")

- [x] Tab change `ToggleOn`; list open/import success/save success `Confirm`; tick/untick
      `Confirm`/`ToggleOff`; delete `ToggleOff`; section toggle `ToggleOn`/`ToggleOff`; export
      share/save/copy `ToggleOn`/`Confirm`; the List screen's top `‹ LISTS` (both states) and its
      `BACK TO LISTS` card button `ToggleOff` — the system `BackHandler` path is silent; scan tick
      `Confirm`; new hero `ToggleOn`; list picker chip `ToggleOn`; settings backend chip / test-again /
      live switch `ToggleOn`/`ToggleOff`; banner action `ToggleOn`.
- [x] Note-card dismiss now fires `ToggleOff` — **B7 fix** (`ListImportUi.NoteCard` was silent).

### Layout, insets, icons

- [x] 16 dp horizontal / 12 dp vertical screen padding; 12 dp between cards on Lists/List/Settings;
      28 dp hero inner, 24 dp leaf inner, 18/16 dp tiles; header indented 8 dp — `App.kt` + every
      screen. The scan tab is denser by design: 8 dp between ranked rows and the banner
      (`ScanScreen.kt:520`) and a 24/20 dp hero inner (`:431`), because the camera owns 45 % of the
      height.
- [x] Edge-to-edge: `enableEdgeToEdge()` in `MainActivity`, root `windowInsetsPadding(WindowInsets.safeDrawing)`.
- [x] No icon library, no image assets: glyphs are Unicode (`✓ ○ ● ▾ ▸ ‹ ✕`) — matches §6.
- [x] No `Scaffold`/`TopAppBar`/`NavigationBar`/FAB: the shell is a Column + three expressive pills
      (`TabBar`), the guide's "root background + insets" recipe.

---

## 2. State matrix (every screen × the card's named states)

### 2.1 Shell — `App.kt` (`ScanListApp`), `Components.kt` (`TabBar`/`TabPill`)

- [x] Three tabs, one pill bar, selected pill recolours and morphs corners, haptic on select.
- [x] The List screen is pushed **on top of** the current tab; selecting any tab clears it.
- [x] **Back behaviour** (was a real bug: back on the List screen exited the app): the shell's state
      is `(tab, openListId)`, and `ui/BackPolicy.backTarget(tab, openList)` maps it to exactly one of
      `CLOSE_LIST` (a list is open), `LISTS_TAB` (no list, not on Lists) or `EXIT` (Lists root).
      `BackHandler` in `App.kt` only applies that answer; the rule is pure and JVM-tested
      (`ui/BackPolicyTest`, 4 tests).
- [x] Back on Scan/Settings returns to Lists instead of leaving the app; only the Lists root exits.

### 2.2 Lists tab — `list/ListsHomeScreen.kt`

- [x] **Empty (no list imported)**: hero reads "NOTHING IMPORTED", big `0`, "Pick a .json file or
      paste one to start.", progress bar at 0; the list section and format note stay hidden so the
      import buttons are the only actions. No fake cards for zero lists.
- [x] Import success: note card + `Confirm` haptic, and the new list auto-opens
      (`lastImported` → `onOpen`) — same as a notes app after a file pick.
- [x] Import failure: modal `ErrorDialog` ("Not a valid list") listing the parser's JSON-pointer
      errors verbatim, scrollable, never truncated (`ListImportUi.ErrorDialog`).
- [x] All items ticked: the same hero card recolours `primaryContainer` → `tertiaryContainer` and the
      label becomes "ALL DONE" (colour, not a new card).
- [x] N lists: one alternating leaf/mirror card each, per-list progress, item counts, delete action.
- [x] Empty list stored (0 items): its card says "empty list" and draws no zero progress bar.
- [x] Per-list progress recomputes on tick via `ListState.refresh()`; screen is scrollable, safe with
      many lists.
- [x] No network, no camera, no model on this screen: it works fully offline and without the bundle
      (import/export are local files/SAF; ranking warm-up is skipped).
- [x] Back on this screen with nothing open → system exit (`BackTarget.EXIT`).

### 2.3 List screen — `list/ListDetailScreen.kt`

- [x] **Missing/deleted list** (id no longer resolves): header "List gone" + leaf card "Nothing to
      show" with an explicit `BACK TO LISTS` button — **B7**: the previous state already had the top
      `‹ LISTS` escape; the card now explains the state and puts the action inside the card, matching
      the other empty states.
- [x] **Empty list** (`"sections": []`): hero "DONE" 0 + leaf card "Nothing to buy" explaining that an
      empty sections array is valid; export is still offered.
- [x] Nested sections at any depth: collapsible header with haptic, checkerboard children, indentation
      per depth; open state survives rotation (`rememberSaveable` per path).
- [x] Ticked items: line-through, colour sinks to `surfaceContainerHigh`/`onSurfaceVariant`, corner
      morphs 44→28 dp, reverse haptic on untick.
- [x] Hero always shows items left + progress; "0 ITEMS LEFT" and `tertiaryContainer` when complete.
- [x] Export: SHARE / SAVE / COPY all haptic; empty export refused with the "Nothing to export" note;
      save failure surfaces the exception message in a note card; SAF cancel is a no-op.
- [x] Back: on-screen `‹ LISTS` button **and** system back both return to Lists (B7 `BackPolicy`) —
      the on-screen button keeps working for mouse/TV-style navigation.
- [x] Model/embedding missing: the screen renders the full tree; the rank warm-up is fire-and-forget
      and failure is non-fatal (rank/**), so no "loading" lie and no crash.

### 2.4 Import surfaces — `list/ListImportUi.kt`

- [x] Paste dialog: monospace JSON sample, min 6 lines / 160 dp, IMPORT disabled while blank, CANCEL.
- [x] SAF `OpenDocument` cancel → no state change, no error.
- [x] Unreadable file → note card "Could not read that file: …".
- [x] Error dialog dismiss clears `errors` (`ListState.clearErrors`), so the dialog cannot re-open on
      recomposition.
- [x] Progress bar: 14 dp height, round caps, `gapSize = 0.dp`, no stop indicator (directly from §3).
- [x] Note dismiss now haptic (B7); note is tonal `tertiaryContainer` leaf-mirror, dismissable.

### 2.5 Scan tab — `scan/ui/ScanScreen.kt`, `scan/sources/CameraScanPreview.kt`

Every state below is derived by B5's `ScanSession`/`RankTicker`/`decideTop`; the screen only renders
it. The environmental states (permission, model, light, network) are the **new** B7 banner.

- [x] **No list imported**: leaf card "No list to scan" + "Import a list on the Lists tab first…".
      The camera is deliberately not opened in this state, so no permission prompt appears for a scan
      that could not rank anything anyway.
- [x] **List complete** (`LIST_EMPTY`): "List complete" / "This list has nothing left to buy." — the
      ranked rows render as done, no fake hero.
- [x] **Item vectors missing / model not ready** (`NO_VECTORS`): "Ranking off" card, flatten order
      shown with no scores, `Embedding items… n/total` line while the cache warms, embedder error line
      in monospace.
- [x] **Model bundle missing**: the B7 banner leads with `E_NO_MODEL · RANKING OFF` and prints
      `ModelProbe.PUSH_HINT` (the exact `scripts/model.sh push …` command — never a paraphrase).
      The filesystem probe is `ModelProbe.status(defaultModelFile(context))`, i.e. the file the
      pipeline actually opens.
- [x] **No signal yet** (`NO_SIGNAL`): "Scanning" + "Point the camera at a product; the list re-sorts
      as it recognises it." — chips show "READY" until a source fires.
- [x] **Ranked, no confident match** (`NO_HERO`): "No confident match" + the honest next step
      ("get closer… or scan its barcode"), barcode-aware copy when OCR/OFF text is known. The UI never
      invents a top match (`topId` nullable → no hero).
- [x] **Hero**: `tertiaryContainer` hero card, "TOP MATCH · 0.xx" score label, name + amount/path,
      full-width 60 dp TICK ITEM button, `Confirm` haptic on tick, 1.08x pop spring on appearance.
- [x] **Ticked** (`TICKED`): "Ticked. Point at the next product."; chips clear; the ticked item moves
      to the Done group with `animateItem`; one product per pass (`armed` in `ScanSession`).
- [x] **No camera permission**: `CameraScanPreview` shows an in-slot CAMERA OFF card (caps label,
      Black title, body, `ALLOW CAMERA` button, "enable in system settings" hint) so the layout does
      not jump; the scan screen shows the CAMERA banner whose action opens the app's system settings
      page. Permission is re-checked on every resume (B4 nit) and the ALLOW button re-arms the launcher
      (B7), so returning from the system settings page starts the preview.
- [x] **Low light**: `Luma.mean` (stride-correct Y-plane mean) → `LowLightDetector` (hysteresis 40/60,
      5 dark / 10 bright frames) → LOW LIGHT banner advising light, explicitly not blocking: barcode
      and OCR still read, ranking still runs. `LowLightSession` resets the detector when the selected
      list changes, so a DIM reading never survives a list switch. 18 JVM tests (`ui/LowLightTest`).
- [x] **Offline (OCR + image only)**: barcode lookups degrade through the OFF states
      `LOOKING_UP / FOUND / NO_TEXT / MISS / OFFLINE / INVALID` (cached text still shown); the B7
      OFFLINE banner says names come from cache while text and image matching still rank. Ranking
      needs no network at all (B5's tests rank from TEXT/IMAGE with no resolver).
- [x] **Embedder failure at runtime**: `RANKING ERROR` banner with the embedder's text verbatim
      (`QueryEmbedder.error`), plus the NO_VECTORS card; one bad frame cannot crash the scan loop.
- [x] **Banner priority** is pure and tested (`ui/ScanBannerTest`, 11 tests):
      CAMERA → MODEL → EMBED → LOW_LIGHT → OFFLINE; exactly one banner, `null` inputs (not yet known)
      never produce one.
- [x] **Banner placement**: first item of the scrollable ranked list, so the fixed camera 45 % /
      content 55 % split is never squeezed into overlapping cards on small screens.
- [x] Sources strip: three pill chips (BARCODE / TEXT / IMAGE) light to `primaryContainer` with a ●
      glyph and an effects-spring colour/alpha crossfade; "READY" when none; barcode line shows digits
      + OFF state.
- [x] List picker: single list → its title; several → horizontal `FilterChip` row with haptic.
- [x] Leaving the tab stops the camera and the session (`DisposableEffect` → `controller.stop()`),
      nothing keeps analysing behind another tab.
- [x] Back from Scan → Lists (B7), leaving the camera bound only for the tab's lifetime.

### 2.6 Settings — `settings/SettingsScreen.kt`

- [x] Backend picker Auto / GPU / CPU / NPU-`experimental` chips, persisted (`SettingsStore`), with the
      selected ladder explained and the NPU warning spelled out.
- [x] Latency hero states: opening (`CircularProgressIndicator` + "Opening …"), OK (mean in
      monospace display type, per-sample rows, engine load, warm-up note), failed (`errorContainer`,
      `E_NO_BACKEND`/`E_NO_MODEL`/`E_EMBEDDER` code + message + reasons), and "No measurement yet —
      pick a backend above."
- [x] Model card: path of the file the pipeline opens, present/size-vs-pinned line, pinned sha256,
      `E_NO_MODEL` + `PUSH_HINT` when missing. **B7**: the card recolours to `errorContainer` whenever
      the bundle is not ready (missing, unreadable, wrong size) instead of leaving a neutral card with
      red text.
- [x] Prefix set: loading ("Reading prompts.json…"), OK (doc/query/image prefixes, monospace summary),
      `E_PROMPTS` error with the reason — no hard-coded prefixes.
- [x] Live-ranking card kept from the B1 stub, but its copy is now honest (**B7**): it is a preview
      control and the scan tab always ranks live; the old "Paused: list stays in JSON order" claimed a
      wiring that rank/** does not have yet.
- [x] `TEST AGAIN` is a real `TextButton` (**B7**) — ripple, 48 dp touch target, button semantics —
      instead of a clickable `Text`.
- [x] Back from Settings → Lists (B7); the tab never traps the user.
- [x] Everything on this screen is device-storage/local only; no network state to represent.

---

## 3. What B7 added to the code (logic is pure, screens stay thin)

| Piece | Where | Tests |
|---|---|---|
| `Luma.mean(frame, step)` — stride/pixel-stride-correct Y-plane mean | `scan/sources/Yuv420Frame.kt` | `ui/LowLightTest` (6 luma cases) |
| `LowLightState` + `LowLightDetector` (hysteresis + debounce + `reset`) + `LowLightSession` (reset per selected list) | `ui/LowLight.kt` | `ui/LowLightTest` (12 detector/session cases) |
| `ScanBanner`/`ScanBannerState`/`ScanBannerKind`/`scanBanner()` — one banner, fixed priority | `ui/ScanBanner.kt` | `ui/ScanBannerTest` (11) |
| `BackTarget` + `backTarget()` + `handledLocally` | `ui/BackPolicy.kt` | `ui/BackPolicyTest` (4) |
| `onLuma` frame hook (2.5 fps gate, failure-isolated) | `scan/sources/CameraScanAnalyzer.kt` | build-verified (Android glue) |
| `onPermission`/`onLuma` params + actionable CAMERA OFF card | `scan/sources/CameraScanPreview.kt` | build-verified (Android glue) |
| Banner state wiring + settings intent + banner card | `scan/ui/ScanScreen.kt` | `ScanBannerTest` for the decision |
| `BackHandler` applying `backTarget` | `App.kt` | `BackPolicyTest` |
| Model card error recolour, TextButton, honest live-ranking copy | `settings/SettingsScreen.kt` | build-verified (Compose) |
| List-gone card + button, section springs, note haptic | `list/ListDetailScreen.kt`, `list/ListImportUi.kt` | build-verified (Compose) |

Compose composables are intentionally not unit-tested (B4/B5 precedent: no Robolectric/Compose test
infrastructure in this project); the decisions they render are the pure pieces above.

---

## 4. Deliberate deviations from STYLE_GUIDE.md (and why)

1. **Modal `AlertDialog` + `OutlinedTextField`** for paste-JSON and import errors. The guide's source
   apps use no dialogs at all (§4 "NOT used"), but a paste box and a JSON-pointer error list are
   modal by nature; a custom tonal card would either hide the list or block the screen anyway. Styled
   with Black headline + monospace body so it still reads as this app.
2. **Scan tab header is `SectionLabel("Magic scan")`, not `displayMedium` + subtitle.** The scan screen
   must give the camera ~45 % of the height (§7 recipe, ARCHITECTURE "UI" §3); a 64 sp title plus
   subtitle costs ~72 dp and pushes the ranked list under the fold on a 6" phone. The tab bar already
   names the tab, and the hero card carries the state.
3. **`CircularProgressIndicator`** in the settings latency hero. The guide's inventory has linear
   progress only, and material3 1.4.0 has no Expressive `LoadingIndicator` (§8); an 18 dp spinner is
   the honest "engine is opening" affordance next to the text.
4. **`Modifier.animateItem`** for the ranked list instead of hand-rolled `animate*AsState` offsets.
   It is Compose's layout-animation primitive and takes the same `Motion.spatial()` spring.
5. **`44.dp` literal in `CameraScanPreview`** (sources layer) rather than `Shapes.hero` (root UI
   package): keeps the camera source self-contained; the value and a §3 comment match the token.
6. **Live-ranking switch on Settings is a preview control**, not wired to `rank/**` (B6 kept it from
   the B1 stub). Copy made honest instead of removing B6's surface (§2.6).
7. **Delete has no confirmation dialog**: import is one file pick away, and the guide's apps have no
   destructive confirm either; the haptic + immediate disappearance is the feedback.

---

## 5. Device-gated rows (B0 — no phone on adb)

These are implemented and build/test-verified but **not** visually or physically verified. No
screenshots or recordings are claimed anywhere in this card.

- [~] **device-gated** — Camera permission flows on a real device: first ask at app entry to Scan,
      "deny", "deny twice" (no dialog → banner's APP SETTINGS path), grant from system settings and
      return (resume re-check starts the preview). Code paths exist in `CameraScanPreview` +
      `ScanBanner`; only the dialog rendering/OS behaviour is unseen. Compensated by the pure banner
      test and the compile-verified launcher/resume wiring.
- [~] **device-gated** — Low-light thresholds (enter < 40, exit > 60, 5/10 frames). They are a
      documented heuristic; CameraX auto-exposure behaviour per room must be calibrated on the SM8750
      device. The detector's *behaviour* is unit-tested; only the numbers are uncalibrated. Tuning
      constants are the three constructor arguments, one place.
- [~] **device-gated** — Mean-luma sampling cost on the analysis thread (14k pixels per analysed
      frame, 2.5 fps). Build-verified only; if it ever shows up in profiling it is a one-parameter
      `step` change.
- [~] **device-gated** — Real CameraX frames, bundled ML Kit barcode/OCR artifacts and the bundled
      embedder (the B4/B5 inheritance). Verified by the x86_64 CI APK build, not on the phone.
- [~] **device-gated** — Dynamic colour / dark-mode appearance, font scale (Accessibility), landscape
      rotation, TalkBack labels for the new banner/buttons. Compose layout is inset- and
      scroll-correct by construction; the visual result is unseen.
- [~] **device-gated** — Haptic *feel* (Confirm/ToggleOn/ToggleOff/Reject) and the spring timing on
      60/120 Hz. Tokens match the guide's constants exactly; the sensation is device-only.
- [~] **device-gated** — Battery/thermal behaviour of the camera + 2.5 fps embed loop during a long
      scan. Unchanged from B5 except the luma mean (cheap, sampled).
- [~] **device-gated** — Empty/error states on very small screens where the scan split (45/55) is
      tight: the banner was moved into the scrollable list specifically to avoid overflow, but the
      real measurement needs a device.

How to close them: with a phone on adb, install the debug APK, walk §2 screen by screen (the card's
states), and replace each line above with a screenshot reference — that row then becomes `- [x]` and
loses the `device-gated` marker.

---

## 6. Evidence (real output, worktree root `/home/martin/projects/scanlist-wt/B7`)

```
$ source scripts/android-env.sh && ./gradlew :scanlistKotlin:testDebugUnitTest
> Task :scanlistKotlin:compileDebugKotlin
> Task :scanlistKotlin:compileDebugUnitTestKotlin
> Task :scanlistKotlin:testDebugUnitTest
BUILD SUCCESSFUL in 18s
36 actionable tasks: 6 executed, 30 up-to-date
```

Test XML totals (`apps/kotlin/app/build/test-results/testDebugUnitTest/*.xml`):

```
39 test classes · 329 tests · 0 failures · 0 errors · 0 skipped
```

Baseline on merged main was 296 tests / 36 classes (B5's merge), so B7 adds **33 tests in 3 classes**:

```
dev.hajnina.scanlist.kotlin.ui.LowLightTest     18
dev.hajnina.scanlist.kotlin.ui.ScanBannerTest   11
dev.hajnina.scanlist.kotlin.ui.BackPolicyTest    4
```

APK: `apps/kotlin/app/build/outputs/apk/debug/scanlistKotlin-debug.apk` (149,582,110 B, bundled ML Kit
ABIs — packaging is B4/B0's decision, untouched).

CI: the `kotlin` job on the B7 PR is the x86_64 verification (build + unit suite), per PR #32's CI
change; local aarch64 runs cannot execute the native prebuilts, so the PR check is the gate.
