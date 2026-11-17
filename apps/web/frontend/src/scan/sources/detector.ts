/**
 * BarcodeDetector selection: native where it works, zxing-wasm everywhere else (card C4).
 *
 * Research digest (lead note, `web-rn-runtime-prior-art.md`): `BarcodeDetector` is stable in Chrome
 * Android since v83 but needs Google Play Services, is absent from Firefox and desktop-Linux
 * Chrome, and is flag-gated in Safari. So the detector is **feature-detected at runtime**:
 *
 *  1. `globalThis.BarcodeDetector` exists **and** `getSupportedFormats()` lists at least one
 *     product symbology → native (Chrome on Android: no wasm download, hardware-accelerated);
 *  2. otherwise → zxing-wasm `reader` (~1.04 MiB wasm, MIT) behind the same `detect()` interface.
 *
 * The zxing import is dynamic on purpose: the wasm stays out of the main bundle and is fetched only
 * when the fallback is actually selected. Both paths receive `Blob | ImageData` (what
 * `BarcodeDetector.detect` and `readBarcodes` accept), so callers never branch on the backend.
 */

import { DETECTOR_PRODUCT_FORMATS, type BarcodeLike } from './barcode';

/** What both backends can read: the 384 px canvas as a Blob, or its ImageData. */
export type BarcodeSource = Blob | ImageData;

export interface BarcodeDetectorLike {
  detect(source: BarcodeSource): Promise<readonly BarcodeLike[]>;
}

/** The slice of the DOM `BarcodeDetector` constructor we use (not in TypeScript's DOM lib). */
export interface BarcodeDetectorCtor {
  new (options?: { formats?: readonly string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<readonly string[]>;
}

/** Minimal zxing-wasm `reader` module shape; the real module is wider. */
export interface ZxingReadResultLike {
  text: string;
  format: string;
  isValid: boolean;
}

export interface ZxingModuleLike {
  readBarcodes(
    input: Blob | ImageData,
    options?: { formats?: readonly string[]; tryHarder?: boolean },
  ): Promise<readonly ZxingReadResultLike[]>;
}

export interface DetectorEnvironment {
  BarcodeDetector?: BarcodeDetectorCtor;
  /** Injectable for tests and for bundlers that want a custom wasm URL. */
  loadZxing?: () => Promise<ZxingModuleLike>;
}

/** QR is requested too: its text is still a legitimate text query (see barcode.ts). */
export const QR_FORMAT = 'qr_code';
export const DESIRED_FORMATS: readonly string[] = [...DETECTOR_PRODUCT_FORMATS, QR_FORMAT];

/** zxing's names for the same symbologies (zxing has no underscore/case variants). */
export const ZXING_FORMATS: readonly string[] = ['EAN13', 'EAN8', 'UPCA', 'UPCE', 'QRCode'];

export interface DetectorSelection {
  /** Which backend `detect()` talks to — surfaced in the UI/debug chip. */
  kind: 'native' | 'zxing';
  /** Formats requested from the backend, in the backend's own spelling. */
  formats: readonly string[];
  detect(source: BarcodeSource): Promise<readonly BarcodeLike[]>;
}

export class BarcodeDetectorUnavailableError extends Error {
  readonly code = 'barcode_detector_unavailable' as const;
  constructor(message: string) {
    super(message);
    this.name = 'BarcodeDetectorUnavailableError';
  }
}

async function nativeFormats(detector: BarcodeDetectorCtor): Promise<readonly string[]> {
  if (typeof detector.getSupportedFormats !== 'function') return [];
  const supported = await detector.getSupportedFormats();
  return DESIRED_FORMATS.filter((format) => supported.includes(format));
}

async function createZxingSelection(loadZxing: () => Promise<ZxingModuleLike>): Promise<DetectorSelection> {
  const reader = await loadZxing();
  return {
    kind: 'zxing',
    formats: ZXING_FORMATS,
    async detect(source: BarcodeSource): Promise<readonly BarcodeLike[]> {
      const results = await reader.readBarcodes(source, {
        formats: ZXING_FORMATS,
        // 150 ms copy cadence: tryHarder would multiply the wasm cost per frame for no gain on a
        // hand-held product (the next frame is 150 ms away).
        tryHarder: false,
      });
      return results.map((result) => ({
        rawValue: result.text,
        format: result.format,
        isPotential: !result.isValid,
      }));
    },
  };
}

function defaultEnvironment(): DetectorEnvironment {
  const globalObject = globalThis as { BarcodeDetector?: BarcodeDetectorCtor };
  return {
    BarcodeDetector: globalObject.BarcodeDetector,
    loadZxing: defaultLoadZxing,
  };
}

/**
 * zxing-wasm `reader` plus its wasm, both as separate Vite chunks/assets.
 *
 * The library defaults `locateFile` to the jsDelivr CDN; a self-hosted copy is better here (the app
 * is an installable PWA and C6 runs it over HTTPS on a phone), so the wasm is emitted as an asset by
 * `?url` and pointed at explicitly. Neither the 49 kB JS wrapper nor the ~1.04 MiB wasm is in the
 * main bundle: both are fetched only when the native BarcodeDetector is unusable.
 */
async function defaultLoadZxing(): Promise<ZxingModuleLike> {
  const [reader, wasm] = await Promise.all([
    import('zxing-wasm/reader'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  reader.prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) =>
        path.endsWith('.wasm') ? wasm.default : `${prefix}${path}`,
    },
  });
  return reader as unknown as ZxingModuleLike;
}

/**
 * Pick a barcode detector for this browser. Never rejects for "no native detector" — that is the
 * documented zxing path; it only rejects when **both** are unavailable (no native detector and the
 * zxing import failed, e.g. an offline PWA on first load).
 */
export async function selectBarcodeDetector(
  env: DetectorEnvironment = defaultEnvironment(),
): Promise<DetectorSelection> {
  const NativeDetector = env.BarcodeDetector;

  if (NativeDetector !== undefined) {
    let formats: readonly string[] = [];
    try {
      formats = await nativeFormats(NativeDetector);
    } catch {
      formats = [];
    }
    const hasProductFormat = formats.some((format) =>
      (DETECTOR_PRODUCT_FORMATS as readonly string[]).includes(format),
    );
    if (hasProductFormat) {
      try {
        const detector = new NativeDetector({ formats });
        return {
          kind: 'native',
          formats,
          detect: (source) => detector.detect(source),
        };
      } catch {
        // Construction can throw on a browser that exposes the name but not the backend
        // (e.g. Play Services missing on some Android WebViews): fall through to zxing.
      }
    }
  }

  const loadZxing = env.loadZxing ?? defaultLoadZxing;
  try {
    return await createZxingSelection(loadZxing);
  } catch (error) {
    throw new BarcodeDetectorUnavailableError(
      `no usable barcode detector: native BarcodeDetector ${
        NativeDetector === undefined ? 'absent' : 'lacks product formats'
      } and the zxing-wasm fallback failed to load (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
}
