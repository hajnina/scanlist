# POLISH — Track A (React Native) scan + settings

Card A6 checklist, mirroring the Kotlin track's B7 pass. Each line says **what was actually
verified**, not whether `App.tsx` already mounts the screen:

Legend:
- **✅ in code + test** — implemented and covered by a Jest test (a render test counts).
- **⏳ implemented + tested where noted, not reachable in the running app yet** — the component and
  its tests (where the line names them) exist, but `App.tsx` mounts only `ListsScreen`; the
  app-level wiring for the list detail, scan and settings screens is the known follow-up under
  *Back behaviour*. Do not read ⏳ as "untested" or "not implemented".
- **📱 device-gated** — needs a phone/emulator with a camera and the model bundle; see
  `apps/rn/BUILD.md` and the B0 provisioning note.
- **♻️ existing from an earlier card (verified, not edited here)**.

How this file was verified:

```bash
cd apps/rn
npm run typecheck      # clean
npm test               # see the count in the card Notes / PR body
npx eslint .           # clean
```

## Empty list

- [x] ✅ **No lists yet** — `ListsScreen` renders an `ExpressiveCard` with a one-list JSON example
  when the repository is empty and loading has finished. ♻️ `src/list/ui/ListsScreen.tsx:221`,
  existing A2 code (verified by reading; no empty-state render test exists and A6 does not own the
  list screens).
- [x] ✅ **Nothing to buy** — an imported list whose `sections` are empty says so instead of showing
  a blank screen. ♻️ `src/list/ui/ListDetailScreen.tsx:150`, existing A2 code (same caveat: A6 only
  verified the branch, it did not add a render test outside its `owns`).
- [x] ✅ Import/parse failures keep the previous list and show the error card, never an empty list
  disguised as success. ♻️ A2 error path, `src/list/__tests__/*`.

## No camera permission

- [x] ⏳ The scan screen renders a permission panel instead of a dead preview: title + one-line
  reason, and an **Allow camera** button only while the OS can still show the dialog
  (`ScanScreen.tsx` permission panel; the copy is `scanGuidance` below). Scan screen not mounted
  yet.
- [x] ✅ Denied-for-good copy points at Android Settings and does not silently re-prompt
  (`scanGuidance({hasPermission:false, canRequestPermission:false})`), so a blocked permission is
  not mistaken for a broken camera.
- [x] ✅ Both copies come from one tested decision, so the panel and the `GuidanceNote` can never
  disagree: `src/settings/polish.ts` `scanGuidance`, `__tests__/polish.test.ts`
  (`no permission … allow copy`, `denied for good … open-Settings copy`, priority test).
- [x] ✅ The request is issued from `ScanCamera`/`ScanScreen` only while `active`, and the preview is
  not rendered before the grant (`camera.test.tsx` — *permission denied: renders no preview…*).
- [ ] 📱 First-launch dialog → deny → panel; grant from Settings → return → preview appears without
  an app restart (`useCameraPermission` re-reads on AppState). Device step, not reproducible in Jest.

## Model missing

- [x] ⏳ Settings' model card probes the file the pipeline actually opens and reports
  **`E_NO_MODEL` · no bundle at `<path>`** with the exact `scripts/model.sh push <package>` hint —
  never a fake size or a green check. `src/settings/modelStatus.ts` `modelStatusFromFacts` /
  `modelStatusLine` / `pushHint`; `__tests__/modelStatus.test.ts` (missing, directory, unreadable,
  empty, present) and `__tests__/settingsScreen.test.tsx` (renders `E_NO_MODEL` + push hint).
  Settings screen not mounted yet.
- [x] ⏳ A present-but-wrong bundle is called out: pinned size comparison
  (`matches the pinned bundle size` vs `wrong or truncated bundle`), and the sha is labelled
  **EXPECTED … · not recomputed here** rather than implying a live 484 MB hash. Same module/tests.
- [x] ⏳ The self-test short-circuits with `E_NO_MODEL` and never opens the engine when the bundle is
  absent; a throwing model check is the same code, not an embedder crash.
  `src/settings/latency.ts` + `__tests__/latency.test.ts`. Settings screen not mounted yet.
- [x] ⏳ The scan screen derives `modelMissing` from the bridge (`embedStatus()` → `modelStatus.ts`
  facts → `modelStatusFromFacts`, via `useModelStatus` in `src/settings/useScanGuidance.ts`) and
  passes it into the guidance ladder, so a genuinely missing bundle renders the note (`No embedding
  model on this phone`, barcode/OCR still work, push hint). A present-but-unreadable bundle is
  reported as `unreadable`, not missing, and a **linked** old bridge that omits the new byte/readable
  fields is not called unreadable. One qualification: a binary with **no embed module at all**
  resolves `linked:false, modelPresent:false` (`modules/embed/index.ts:362-381`), which
  `factsFromNativeStatus` maps to `missing` — so "the bridge cannot report" is only safe for an old
  *linked* bridge; a fully absent module really is reported missing. Tests:
  `src/scan/ui/__tests__/scanScreen.test.tsx` (missing renders / present does not) and
  `src/settings/__tests__/polish.test.ts` (hook branch). Scan screen not mounted yet.
- [ ] 📱 Push the bundle (`scripts/model.sh push <package> --dest internal`), re-open Settings: the
  card flips from `E_NO_MODEL` to `present · 484,622,336 B · 462.2 MiB · matches the pinned bundle
  size`; run the self-test and see the measured backend. Device step.

## Low light / nothing found

- [x] ⏳ Guidance appears after **6 s in which the camera is delivering frames but the scene yields
  nothing useful** — no barcode, no OCR line and no ranked hero (`topId`). The image source emits
  one marker per sampled frame (~2.5 fps), so a live camera always re-renders; those markers prove
  frames are flowing and deliberately **do not** reset the clock. `quietFor` starts at the first
  frame and measures from the newest barcode/OCR/hero result, so a starting camera (no frame yet)
  is not "nothing found" and a live dim shelf can go quiet. `useScanGuidance` keeps the cleaned-up
  1 s interval so the threshold is crossed on time. Tests: `polish.test.ts` (frames-only 8 s shows
  the advice; barcode/OCR and hero keep it away; one hero resets the stretch; interval cleared) and
  `scanScreen.test.tsx` (real feed + fake embedder: 8 s of frames alone shows the advice; a real OCR
  line + hero keeps it away). Scan screen not mounted yet.
- [x] ✅ The quiet copy names the two actionable causes — *point at an item and hold steady* and
  *in low light or with glare, turn on the torch* — and explains the consequence (dim frames give
  the embedder little to work with), instead of a generic "try again".
- [x] ✅ Permission outranks model, which outranks quiet time, and only one note is shown at a time
  (`polish.test.ts`: permission-vs-quiet, model-vs-permission priority, and model-note-wins-over
  quiet).
- [x] ✅ `GuidanceNote` renders the three kinds with the M3 Expressive surface tokens
  (`src/ui/components/GuidanceNote.tsx`), used from `ScanScreen` (A5's layout) and rendered with the
  real low-light copy in `scanScreen.test.tsx`.
- [ ] 📱 Dim a shelf, cover the light: the torch hint appears after ~6 s; turn the torch on and a
  readable label makes OCR/barcode light the chips again. Camera/torch behaviour is device-only.

## Degraded / offline

- [x] ✅ No frame, OCR text or model data leaves the device: barcode/OCR run in ML Kit on device and
  the image query runs in the local embedder. The scan path's only network call is the explicit
  barcode → product-name lookup (`src/scan/ui/off.ts`, world.openfoodfacts.org, barcode digits only,
  cached and failure-tolerant); nothing in `src/scan` downloads model weights.
- [x] ✅ Without the model, barcode and OCR still emit and the scan screen stays usable; only the
  image/ranking path degrades, and the model note says exactly that.
- [x] ✅ One failing source cannot take down the others: source errors are reported through
  `onError` and the frame still reaches the remaining sources (frame-feed isolation test), and a
  failed embed keeps the barcode/OCR chips alive (`sources.test.ts` — *a failing embedder is
  reported and the chip still lights*).
- [x] ✅ A failed settings self-test renders its stable code/message (and ladder reasons) instead of
  a stale latency number; an unavailable prefix set says **prefix set unavailable** rather than
  inventing prefixes. `__tests__/latency.test.ts`, `__tests__/settingsScreen.test.tsx`
  (*a failed self-test renders its code, message and ladder reasons*; also asserts no stale
  `12.3 ms`).
- [x] ✅ Cache pressure from the scan itself is bounded: temp JPEGs are deleted 10 s after capture
  (`DEFAULT_FRAME_RELEASE_GRACE_MS`) and immediately when the **screen unmounts or the feed is
  replaced** (`releaseAll`, wired at `camera.tsx`'s unmount/feed-change effect). Setting
  `active=false` only stops the capture loop; the files already captured stay until the 10 s grace.
  Tests: `frames.test.ts` (grace + `releaseAll`) and `camera.test.tsx` (unmount releases every temp
  JPEG).
- [x] ✅ `__DEV__` scan footer exposes listeners / dropped / skipped / pending releases, so a
  degraded device can be diagnosed from the screen (`useScanSession.diagnostics`,
  `ScanScreen.tsx`); production builds do not render it. `scanScreen.test.tsx` asserts the footer
  renders *3 feed listeners* and the temp-file counter under Jest's `__DEV__`.

## Back behaviour

- [x] ⏳ Android hardware back on the scan screen returns to the list, and the on-screen
  **‹ Lists** button does the same (single `onBack`, no double navigation).
  ♻️ `src/scan/ui/ScanScreen.tsx:120` (`BackHandler`) + header button; A5 behaviour, verified by
  code review here (no screen-level back test existed and A6 does not own `src/scan/ui`). The scan
  screen is not mounted yet (see the known follow-up below).
- [x] ✅ Leaving the screen stops capture and deletes pending temp JPEGs (`camera.test.tsx` —
  *unmount releases every temp JPEG…*), so returning starts a clean session rather than stacking
  timers.
- [x] ✅ A restart cannot leak stale ML Kit answers into the new session
  (`feedSource.ts` epoch; `sources.test.ts` — *a stale in-flight answer is dropped…*).
- [x] ✅ `SettingsScreen` has the same back contract (`onBack`) and its render test unmounts the
  tree and clears timers, so no `Animated` spring or probe is left running. The scan screen's quiet
  interval is likewise cleared on unmount (`polish.test.ts`).
- [ ] ⏳ **Known follow-up (not done here):** nothing mounts `SettingsScreen` yet — `App.tsx` renders
  `ListsScreen` (and the scan screen is composed by the same later wiring pass), so Settings is not
  reachable from the running app in this round. The two-line mount recipe is documented in
  `src/settings/index.ts`; the app-level navigation/startup wiring is outside A6's `owns:` and the
  lead will run it separately. This is why the settings/scan-screen lines above are marked ⏳.

## Haptics on / off

- [x] ⏳ The **Haptics** switch persists through the same `SettingsStore` as the backend choice and
  is applied at controller start-up (`setHapticsEnabled`), so the very first tap already respects
  the saved value (`__tests__/state.test.ts`, `__tests__/store.test.ts`,
  `__tests__/settingsScreen.test.tsx`). Settings screen not mounted yet.
- [x] ✅ Every `haptic()` call site obeys the flag in one place (`src/ui/haptics.ts`), with no
  per-screen copy; off means silence, not a shorter buzz (`src/ui/__tests__/haptics.test.ts`).
- [x] ✅ Patterns still lead with an off beat on Android (confirm / toggle / reject / long-press),
  so "haptics on" actually vibrates on the target platform (the same test asserts every waveform
  starts with an off duration and has a positive first vibration).
- [ ] 📱 Toggle off, tick an item, import a list, deny a bad file: no vibration anywhere. Toggle on:
  Confirm on tick, ToggleOn on import, Reject on a bad file. Device step (vibration is not
  observable in Jest).

## M3 Expressive pass (scoped to A6's files)

- [x] ✅ New UI uses the shared tokens (`HEAVY`, `Spacing`, `Motion`, `Shapes`), Paper `Chip`/
  `Switch`/`Button` surfaces and the scanlist theme colours — no ad-hoc hex values in the settings
  screen or new components.
- [x] ✅ Selected chips use the tonal fill and `showSelectedCheck={false}`: the check glyph needs a
  vector icon font this app does not ship, and its entrance animation leaked a timer into tests.
- [x] ✅ Entrance motion is the existing `SpringIn` stagger (`index 0…6` in `SettingsScreen.tsx`
  at lines 104, 129, 159, 169, 218, 260 and 286); the render test unmounts the tree so the native
  spring is stopped by its effect cleanup, not left scheduled.
- [x] ✅ Experimental NPU is labelled **NPU · experimental** in the chip text, while the accessible
  name stays `NPU` (screen readers and tests address the same option).
