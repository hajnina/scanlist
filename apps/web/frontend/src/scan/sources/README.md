# Web scan sources (card C4)

`getUserMedia` rear camera → 384 px JPEG frames → barcode, OCR and image signals for the ranker.
This folder is the whole card; C5 wires it into the disabled "Scan" nav entry and owns the UI.

```
types.ts        ScanSignal (A1-shaped), CapturedFrame (Blob), FrameEmbedder seam
clock.ts        injectable Clock (fake timelines in tests)
geometry.ts     384 px short-side math — port of B4's FrameGeometry.kt
sampler.ts      150 ms copy / 400 ms embed cadence gate
camera.ts       rear-camera constraints + getUserMedia error taxonomy
barcode.ts      symbology filtering, GTIN shape, product-over-QR priority (port of A4)
dedupe.ts       per-value barcode hold (4 s, port of A4)
detector.ts     BarcodeDetector feature-detect → zxing-wasm reader fallback
ocr.ts          per-line OCR queries, per-line confidence, repeat window before the 16-line cap
ocrEngine.ts    lazy Tesseract.js engine (dynamic import, one worker)
embedder.ts     POST /embed/image client (raw JPEG, envelope + x-embed-ms)
uploader.ts     single in-flight, newest-frame-wins image upload
jpeg.ts         frame size accounting + local upload guards
barcodeSource.ts / ocrSource.ts   one frame/page → signals
capture.ts      canvas grabber (DOM: <video> → 384 px pixels/JPEG)
session.ts      camera + cadence + sources + uploader wiring (DOM: video element, timers)
index.ts        public surface for C5 (18 modules, 9 vitest files in __tests__/)
```

## Cadence (amended 2026-11-17, C3 latency)

The card originally said "send to `/embed/image` every 400 ms". C3 measured the real server path
(`apps/web/server/PERF.md`): **6.4–11.9 s per image** on fp32 CPU. Uploading per frame would stack
~20 requests during one embedding and every result would be stale on arrival. So:

| What | Rate | Where |
|---|---|---|
| copy video → canvas + barcode detect | every 150 ms (`FRAME_COPY_INTERVAL_MS`) | `sampler.ts` |
| 384 px JPEG capture budget | 400 ms (`EMBED_FRAME_INTERVAL_MS`, 2.5 fps) | `sampler.ts` |
| actual `POST /embed/image` | **one in flight**, newest pending frame wins | `uploader.ts` |
| OCR pass (opt-in) | 1 s, never overlapping | `ocrSource.ts` |

The embed gate is a 400 ms budget on a 150 ms copy grid, so the first embed is at t=0 and the next
lands at ~450 ms; the effective JPEG/capture rate is therefore ~2.2 fps, never more than 2.5 fps.

The uploader never queues: `submit()` while a request is in flight replaces the pending frame
(`coalesced` counter), and when the request settles only the latest frame is sent. Every result
carries `frame.capturedAt`, so the ranker can apply RANK.md §2.2's "4 most recent image vectors from
the last 2000 ms" window and drop stale evidence. The **image signal is emitted only when a result
lands**, never at submit time: a frame replaced while the POST was in flight emits no marker at all,
so C5 can never see an image query without its vector (A4 parity). C7's in-browser embedder
implements `FrameEmbedder` and plugs into the same uploader — the policy is unchanged, only the
latency is.

## Signal shapes

Identical field names to `apps/rn/src/scan/sources/types.ts` (A1) and Kotlin's `ScanSignal`:

```ts
{ source: 'barcode' | 'ocr' | 'image', text: string, confidence: number, at?: number }
```

- `barcode`: `text` = digits (spaces stripped), `confidence` 1 for a GTIN product code
  (8/12/13/14 digits), 0.85 for a non-product code (QR/URL). Product symbologies win over QR when
  both are in shot; `isPotential` (undecoded) results are ignored.
- `ocr`: **one signal per line**, `text` = the line's visible words single-spaced, `confidence` =
  that line's own value → mean of that line's element confidences → 0.6 neutral. Never a
  cross-line average. ≤ 16 lines per tick, in detection order, cap applied **after** normalising,
  min-length filtering, per-batch dedupe and the cross-tick repeat window (A4-sync order), so a
  suppressed line never consumes a slot. The combined barcode+OCR pool cap (also 16) stays in the
  ranker (C5/S8).
- `image`: `text` = `'image:frame'` marker, `confidence` 1, emitted when the upload result arrives;
  the vector travels separately as an `ImageEmbedding` tagged with `capturedAt`.

`at` (ms, `Date.now()`) is the one addition to A1's shape — the web has no companion frame object
on the signal, and the image window needs a timestamp. `CapturedFrame.jpeg` is a `Blob` (the browser
posts bytes); `width`/`height`/`capturedAt` keep A1's names.

## BarcodeDetector → zxing-wasm

`selectBarcodeDetector()` asks the native detector for `getSupportedFormats()` and only uses it when
it lists a product symbology (`ean_13`/`ean_8`/`upc_a`/`upc_e`; `qr_code` is requested too when
supported). Chrome Android ≥ 83 with Play Services: native. Firefox, Safari (flag-gated) and
desktop-Linux Chrome: zxing-wasm `reader` (~1.04 MiB wasm, MIT) behind the same `detect()` method.
The zxing import is dynamic, so the wasm is a separate chunk fetched only when the fallback is
selected. Both accept `Blob | ImageData`.

## OCR is opt-in and lazy

`createTesseractEngine()` dynamic-imports `tesseract.js` on the first `recognize()`; the main bundle
stays free of it (Vite emits a separate chunk) and the `eng` traineddata is fetched from the
Tesseract CDN on first use. No engine configured → no OCR, no download. `createOcrSource` skips ticks
while a recognition is in flight and grabs the freshest canvas when it starts. The session takes
ownership of the engine it is given: `stop()` terminates the worker (a stopped session is
single-use), and a rejected `video.play()` releases the camera tracks instead of leaving the LED on.

## Constants (web picks, documented)

| Constant | Value | Why |
|---|---|---|
| `FRAME_COPY_INTERVAL_MS` | 150 | lead research digest; barcode detect is cheap |
| `EMBED_FRAME_INTERVAL_MS` | 400 | B4's 2.5 fps capture budget |
| `EMBED_SHORT_SIDE` / `JPEG_QUALITY` | 384 / 0.8 | same pixels as Kotlin B4 (~20–40 kB) |
| `MAX_OCR_LINES_PER_TICK` | 16 | RANK.md §2.2 |
| `DEFAULT_OCR_LINE_REPEAT_MS` | 2000 | web OCR ticks ~1 s; RN uses 4 s at 2.5 fps, Kotlin 1.5 s |
| `DEFAULT_OCR_MIN_CHARS` | 3 | same as A4 |
| `DEFAULT_BARCODE_HOLD_MS` | 4000 | same as A4/B4 |
| `NEUTRAL_OCR_CONFIDENCE` | 0.6 | same as A4 |

## Tests

```bash
cd apps/web/frontend
npm test            # vitest run
npm run build       # tsc --noEmit && vite build
```

`__tests__/` covers the pure logic: cadence, 384 px scaling, JPEG accounting, barcode format
filtering/GTIN shape/priority, detector selection (fake native detector + fake zxing module), per-line
OCR extraction/confidence and cap ordering (blank, duplicate and repeat-suppressed lines all consume
no slot — each guarded by a mutation-verified test), the uploader's single-flight newest-frame-wins
behaviour and result-time image-signal emission, the OCR source's no-stacking tick, and the
`/embed/image` client envelope/error handling. happy-dom has no camera, so `capture.ts`/`session.ts`
are not unit-tested (the manual script below exercises them).

## Manual browser check (desktop webcam)

Real pixels need a real browser; the card accepts a documented desktop-webcam run.

```bash
cd apps/web/server
.venv/bin/uvicorn app.main:app --port 8000          # fake embedder is fine: SCANLIST_EMBEDDER unset
cd ../frontend && npm run dev                        # http://localhost:5173 (serves /src/... on demand)
```

Then, in the devtools console on `http://localhost:5173` (localhost is a secure context; the dev
server must be the one serving `/src/...`, `npm run preview` only serves the built bundle):

```js
const mod = await import('/src/scan/sources/index.ts');   // Vite dev server only
// 1. camera: should log {videoWidth, videoHeight} and show the preview
// 2. selectBarcodeDetector(): kind 'native' on Chrome desktop, 'zxing' on desktop-Linux Chrome
//    without BarcodeDetector — point it at any EAN-13 (a real product)
// 3. frame grabber + cadence: the session stats() upload counter should show
//    sent ≈ 1 per 6–12 s (server image embed), coalesced climbing, never more than one in flight,
//    and an image signal only after its result (replaced frames emit none)
// 4. OCR (opt-in): createTesseractEngine({langs: 'eng'}), point at a label; the console should
//    print one signal per line with distinct confidences, ≤ 16 per tick
```

Expected results: barcode chip fires once per product (4 s hold), OCR lines are separate queries,
image uploads never stack and results carry the frame timestamp. **C6** repeats this on Chrome for
Android over HTTPS — `navigator.mediaDevices` is undefined on `http://<lan-ip>:port`, and the
`CameraError` code is `insecure-context` (see `camera.ts`).

## Dependencies added (disclosed)

`package.json` / `package-lock.json` gained `zxing-wasm@^3.1.7` (MIT, barcode fallback) and
`tesseract.js@^7.0.0` (Apache-2.0, opt-in lazy OCR). Both are dynamically imported where they are
heavy; neither is in the main bundle. No other package files were touched.
