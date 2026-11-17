# POLISH — Track A (React Native) scan + settings

Card A6 checklist, mirroring the Kotlin track's B7 pass. Each line is ticked only when the state is
reachable in the app **and** either covered by a Jest test or explicitly marked **device-gated**
(needs a phone/emulator with a camera and the model bundle; see `apps/rn/BUILD.md` and the
B0 provisioning note).

How this file was verified:

```bash
cd apps/rn
npm run typecheck      # clean
npm test               # see the count in the card Notes / PR body
npx eslint .           # clean
```

Legend: **✅ in code + test** · **📱 device-gated** · **♻️ existing from an earlier card (verified,
not edited here)**.

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

- [x] ✅ The scan screen renders a permission panel instead of a dead preview: title + one-line
  reason, and an **Allow camera** button only while the OS can still show the dialog.
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

- [x] ✅ Settings' model card probes the file the pipeline actually opens and reports
  **`E_NO_MODEL` · no bundle at `<path>`** with the exact `scripts/model.sh push <package>` hint —
  never a fake size or a green check. `src/settings/modelStatus.ts` `modelStatusFromFacts` /
  `modelStatusLine` / `pushHint`; `__tests__/modelStatus.test.ts` (missing, directory, unreadable,
  empty, present).
- [x] ✅ A present-but-wrong bundle is called out: pinned size comparison
  (`matches the pinned bundle size` vs `wrong or truncated bundle`), and the sha is labelled
  **EXPECTED … · not recomputed here** rather than implying a live 484 MB hash. Same module/tests.
- [x] ✅ The self-test short-circuits with `E_NO_MODEL` and never opens the engine when the bundle is
  absent; a throwing model check is the same code, not an embedder crash.
  `src/settings/latency.ts` + `__tests__/latency.test.ts`.
- [x] ✅ The scan screen has a model-missing note (`No embedding model on this phone`, barcode/OCR
  still work, push hint) in the same priority ladder as permission/quiet: `scanGuidance`'s `model`
  branch, `__tests__/polish.test.ts`. The settings card is the authority for *why*; the note only
  explains what still works.
- [ ] 📱 Push the bundle (`scripts/model.sh push <package> --dest internal`), re-open Settings: the
  card flips from `E_NO_MODEL` to `present · 484,622,336 B · 462.2 MiB · matches the pinned bundle
  size`; run the self-test and see the measured backend. Device step.

## Low light / nothing found

- [x] ✅ Guidance appears only after **6 s with no new signal from any source** (`QUIET_GUIDANCE_MS`,
  `quietFor`), measured from the newest of barcode/OCR/image. A starting camera or flowing signals
  never nag. `src/settings/polish.ts` + `__tests__/polish.test.ts`.
- [x] ✅ The quiet copy names the two actionable causes — *point at an item and hold steady* and
  *in low light or with glare, turn on the torch* — and explains the consequence (dim frames give
  the embedder little to work with), instead of a generic "try again".
- [x] ✅ Permission outranks model, which outranks quiet time; only one note is shown at a time
  (`scanGuidance` priority test).
- [x] ✅ `GuidanceNote` renders the three kinds with the M3 Expressive surface tokens
  (`src/ui/components/GuidanceNote.tsx`), used from `ScanScreen` (A5's layout).
- [ ] 📱 Dim a shelf, cover the light: the torch hint appears after ~6 s; turn the torch on and a
  readable label makes OCR/barcode light the chips again. Camera/torch behaviour is device-only.

## Degraded / offline

- [x] ✅ The scan path is offline by construction: barcode/OCR run in ML Kit on device, the image
  query runs in the local embedder; no network client is imported by `src/scan`.
- [x] ✅ Without the model, barcode and OCR still emit and the scan screen stays usable; only the
  image/ranking path degrades, and the model note says exactly that.
- [x] ✅ One failing source cannot take down the others: source errors are reported through
  `onError` and the frame still reaches the remaining sources (frame-feed isolation test), and a
  failed embed keeps the barcode/OCR chips alive (`sources.test.ts` — *a failing embedder is
  reported and the chip still lights*).
- [x] ✅ A failed settings self-test renders its stable code/message (and ladder reasons) instead of
  a stale latency number; an unavailable prefix set says **prefix set unavailable** rather than
  inventing prefixes. `__tests__/latency.test.ts`, `__tests__/settingsScreen.test.tsx`.
- [x] ✅ Cache pressure from the scan itself is bounded: temp JPEGs are deleted 10 s after capture
  (`DEFAULT_FRAME_RELEASE_GRACE_MS`) and immediately when the camera stops/unmounts
  (`releaseAll`), so a long scan cannot fill the cache (`frames.test.ts`, `camera.test.tsx`).
- [x] ✅ `__DEV__` scan footer exposes listeners / dropped / skipped / pending releases, so a
  degraded device can be diagnosed from the screen (`useScanSession.diagnostics`,
  `ScanScreen.tsx`); production builds do not render it.

## Back behaviour

- [x] ✅ Android hardware back on the scan screen returns to the list, and the on-screen
  **‹ Lists** button does the same (single `onBack`, no double navigation).
  ♻️ `src/scan/ui/ScanScreen.tsx:120` (`BackHandler`) + header button; A5 behaviour, verified by
  code review here (no screen-level back test existed and A6 does not own `src/scan/ui`).
- [x] ✅ Leaving the screen stops capture and deletes pending temp JPEGs (`camera.test.tsx` —
  *unmount releases every temp JPEG…*), so returning starts a clean session rather than stacking
  timers.
- [x] ✅ A restart cannot leak stale ML Kit answers into the new session
  (`feedSource.ts` epoch; `sources.test.ts` — *a stale in-flight answer is dropped…*).
- [x] ✅ Settings is a pushed screen with the same back contract (`onBack`, `SettingsScreen`), and
  no screen adds an `Animated` or timer that outlives unmount without cleanup (the render test
  unmounts and clears timers).

## Haptics on / off

- [x] ✅ The **Haptics** switch persists through the same `SettingsStore` as the backend choice and
  is applied at controller start-up (`setHapticsEnabled`), so the very first tap already respects
  the saved value (`__tests__/state.test.ts`, `__tests__/store.test.ts`,
  `__tests__/settingsScreen.test.tsx`).
- [x] ✅ Every `haptic()` call site obeys the flag in one place (`src/ui/haptics.ts`), with no
  per-screen copy; off means silence, not a shorter buzz.
- [x] ✅ Patterns still lead with an off-beat on Android (confirm / toggle / reject / long-press),
  so "haptics on" actually vibrates on the target platform (`src/ui/haptics.ts` comment + PR #8
  review).
- [ ] 📱 Toggle off, tick an item, import a list, deny a bad file: no vibration anywhere. Toggle on:
  Confirm on tick, ToggleOn on import, Reject on a bad file. Device step (vibration is not
  observable in Jest).

## M3 Expressive pass (scoped to A6's files)

- [x] ✅ New UI uses the shared tokens (`HEAVY`, `Spacing`, `Motion`, `Shapes`), Paper `Chip`/
  `Switch`/`Button` surfaces and the scanlist theme colours — no ad-hoc hex values in the settings
  screen or new components.
- [x] ✅ Selected chips use the tonal fill and `showSelectedCheck={false}`: the check glyph needs a
  vector icon font this app does not ship, and its entrance animation leaked a timer into tests.
- [x] ✅ Entrance motion is the existing `SpringIn` stagger (`index 0…3`); the render test unmounts
  the tree so the native spring is stopped by its effect cleanup, not left scheduled.
- [x] ✅ Experimental NPU is labelled **NPU · experimental** in the chip text, while the accessible
  name stays `NPU` (screen readers and tests address the same option).
