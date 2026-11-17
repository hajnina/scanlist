# Scan sources — camera, barcode, OCR, image (Track A, card A4)

The A1 contract (`./types`) says a source is something that, once started, emits
`{source, text, confidence}` signals. This directory implements the three real sources behind the
"magic scan" plus the camera plumbing that feeds them.

```
     <ScanCamera> (./camera.tsx)                 pure + unit-tested (./*.ts)
 ┌──────────────────────────────┐         ┌─────────────────────────────────────────┐
 │ VisionCamera v5 photo output │ 400 ms  │ createFrameFeed() ──► barcode source     │
 │ Photo.getFileDataAsync()  ───┼────────►│                   ──► ocr source        │
 │ Photo.saveToTemporaryFile()  │ 1 JPEG  │                   ──► image source      │
 └──────────────────────────────┘         └─────────────────────────────────────────┘
       │ ML Kit static-image readers (./native.ts)        │
       └──────────────► react-native-vision-camera-mlkit ─┘
```

## Why a photo every 400 ms (and not a frame processor)

VisionCamera v5 moved frame processors to Nitro worklets and **removed** `frameProcessInterval`
(deprecated, no-op). The lead's research note lists the sanctioned frame→JPEG routes; this card
takes `Photo.getFileDataAsync()` from a `CameraPhotoOutput`, and the same sweep of the photo
(`saveToTemporaryFileAsync`) is what ML Kit's **static-image** APIs read. That means:

- one capture (~2.5 fps) feeds all three chips — barcode, OCR and image embedding see the same
  picture, which matters for score fusion;
- no Reanimated/worklets Babel plugin, no `frame.dispose()` lifetime bugs in app code;
- the JPEG needed for image embedding comes for free.

Cost: the preview can hitch while a capture runs, and every sampled frame leaves a JPEG in the app
cache (Android clears it; the scan screen is only open while scanning).

## API (what card A5 uses)

```tsx
import {createFrameFeed} from './sources';
import {createScanSources, createScanPipeline} from './sources';
import {createMlKitReaders} from './sources/native';
import {ScanCamera} from './sources/camera';

// once per scan screen
const feed = useMemo(() => createFrameFeed(), []);                    // the screen owns the feed
const readers = useMemo(() => createMlKitReaders(), []);              // ML Kit OCR + barcode
const {sources} = useMemo(
  () => createScanSources(feed, {
    readers,
    onImage: frame => embedder.embedImage(frame.jpegBase64),          // raw image query
  }),
  [feed, readers, embedder],
);
const pipeline = useMemo(() => createScanPipeline(sources), [sources]);

useEffect(() => {
  pipeline.start(signal => {
    // signal.source: 'barcode' | 'ocr' | 'image'
    // signal.text:     EAN digits / OCR words / IMAGE_QUERY_MARKER
    // signal.confidence: 1 for exact product barcodes
  });
  return () => {
    pipeline.stop();
  };
}, [pipeline]);

// the camera pushes every ~2.5 fps capture into the same feed
<ScanCamera feed={feed} active style={{flex: 1}} />;
```

`useScanCamera({feed, …})` returns the same wiring without rendering (`cameraProps`, permission
state) for a UI that owns its own `<Camera>`; `<ScanCamera>` renders the preview and requests the
camera permission on first mount. Frames always travel through the feed (never a second
`onFrame` callback), so a frame is processed exactly once.

Per-source knobs: `barcodeDedupeMs` (default 4000), `barcodeIntervalMs` (0 = every frame),
`ocrIntervalMs` (800), `ocrMinChars` (3), `imageIntervalMs` (0). Each source runs single-flight:
while a read is in progress new frames are dropped, never queued.

## Behaviour that is unit-tested

| Concern | Module | Tests |
|---|---|---|
| ~2.5 fps gate (no overlap, stop/restart, slow capture) | `captureLoop.ts` | `__tests__/captureLoop.test.ts` |
| rate gate primitive | `gate.ts` | `__tests__/gate.test.ts` |
| same-barcode debounce inside N seconds | `dedupe.ts` | `__tests__/dedupe.test.ts` |
| product vs QR selection, confidence | `barcode.ts` | `__tests__/barcode.test.ts` |
| OCR lines → query text + confidence | `ocr.ts` | `__tests__/ocr.test.ts` |
| frame fan-out, listener isolation | `frames.ts` | `__tests__/frames.test.ts` |
| source gating / single-flight / stop | `feedSource.ts`, `*Source.ts` | `__tests__/sources.test.ts` |
| Photo → JPEG base64 frame (+ dispose) | `frameCapturer.ts` | `__tests__/frameCapturer.test.ts` |
| base64 of JPEG bytes | `base64.ts` | `__tests__/base64.test.ts` |

Not testable here: the camera itself and ML Kit (they need a device). `./camera.tsx` and the
`processImage*` calls in `./native.ts` are thin glue over the vendor APIs.

## Manual test on a phone

Prereqs: `apps/rn` built (`apps/rn/build.sh`), phone on the same machine (`adb devices`), Metro
running (`npm start`).

1. `adb install -r apps/rn/android/app/build/outputs/apk/debug/app-debug.apk`
2. **Permission flow** — first launch of the scan screen shows the system camera dialog. Deny:
   no preview, `useScanCamera().permissionStatus === 'denied'`. Grant from Settings and return:
   the preview appears without restarting the app (`useCameraPermission` re-reads on AppState).
3. **Preview + sample rate** — point at a shelf; the preview must stay smooth-ish and
   `adb logcat` must not show a capture every frame. Expected: ~2.5 captures/s.
4. **Barcode** — point at a product EAN: the barcode chip lights once with the digits and stays
   quiet for 4 s while the code stays in frame; move to another product → new digits immediately.
   `adb shell` a QR code → the same chip lights with the URL text.
5. **OCR** — point at a label with readable words: the OCR chip lights with the visible words
   (max ~1.25/s because of the 800 ms OCR gate). A blank wall emits nothing.
6. **Image** — the image chip lights on every sampled frame; log the base64 length in `onImage`
   (expected ~100–200 KB for a 720p JPEG at quality 0.7).
7. **Lifecycle** — leave the scan screen: captures stop (`feed.listenerCount() === 0`, no more
   temp JPEGs in `adb shell ls $TMPDIR`), return: they resume.
8. **Failure isolation** — airplane mode / an embedder that throws: the image chip reports the
   error through `onError` while barcode and OCR keep working.

## Dependencies (pinned in `apps/rn/package.json`)

| Package | Version | Why |
|---|---|---|
| `react-native-vision-camera` | 5.2.4 | camera v5 (Nitro), `CameraPhotoOutput` |
| `react-native-vision-camera-mlkit` | 2.0.1 | ML Kit OCR + barcode, MIT, static-image APIs |
| `react-native-nitro-modules` | 0.37.2 | peer of both |
| `react-native-nitro-image` | 0.15.2 | peer of VisionCamera v5 |

Not used, on purpose: `react-native-vision-camera-worklets` / `react-native-worklets` (only needed
for frame-processor hooks), `@shopify/react-native-skia` (no JPEG encoder needed on this route), and
the separate `react-native-vision-camera-barcode-scanner` package (the ML Kit plugin already covers
barcode + OCR with one capture).

Android: `android.permission.CAMERA` is already declared in
`apps/rn/android/app/src/main/AndroidManifest.xml` (since card A1); no manifest change was needed.
VisionCamera/ML Kit autolink through the RN Gradle plugin; ML Kit's selective-install
`ext["react-native-vision-camera-mlkit"]` block is optional (defaults enable OCR LATIN + barcode).
