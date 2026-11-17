/**
 * Native bindings for the scan sources (card A4) — NOT imported by the barrel or by tests.
 *
 * Everything here needs the VisionCamera/ML Kit native modules, so it is imported only by the
 * camera view (./camera). The behaviour lives in the tested modules; this is the thin glue:
 *  - `createFrameCapturer` (./frameCapturer): VisionCamera v5 `CameraPhotoOutput` → `CameraFrame`
 *    (JPEG bytes for the embedder + a file path for ML Kit's static-image APIs);
 *  - `createMlKitReaders`: `react-native-vision-camera-mlkit` static-image OCR + barcode.
 *
 * Why a photo capture and not a frame processor? VisionCamera v5 moved frame processing to Nitro
 * worklets and dropped `frameProcessInterval`; ML Kit v2 also exposes plain-async
 * `processImageBarcodeScanning` / `processImageTextRecognition` for local files. Sampling one photo
 * every 400 ms keeps the whole pipeline on the JS thread (no worklets Babel plugin, no
 * `frame.dispose()` lifetime hazards) and gives us the JPEG needed for image embedding for free.
 */
import {
  processImageBarcodeScanning,
  processImageTextRecognition,
} from 'react-native-vision-camera-mlkit';
import type {
  BarcodeFormat,
  BarcodeScanningResult,
  TextRecognitionLanguage,
  TextRecognitionResult,
} from 'react-native-vision-camera-mlkit';

import {PRODUCT_BARCODE_FORMATS} from './barcode';
import type {BarcodeReadResult} from './barcodeSource';
import type {OcrResultLike} from './ocr';
import type {ScanReaders} from './readers';
import type {CameraFrame} from './types';

export {
  createFrameCapturer,
  type FrameCapturerOptions,
  type PhotoLike,
  type PhotoOutputLike,
} from './frameCapturer';

/** Product symbologies only — QR codes do not resolve to an Open Food Facts product. */
export const MLKIT_PRODUCT_FORMATS: readonly BarcodeFormat[] =
  PRODUCT_BARCODE_FORMATS as readonly BarcodeFormat[];

export interface MlKitReaderOptions {
  formats?: readonly BarcodeFormat[];
  language?: TextRecognitionLanguage;
}

export function createMlKitReaders({
  formats = MLKIT_PRODUCT_FORMATS,
  language = 'LATIN',
}: MlKitReaderOptions = {}): ScanReaders {
  return {
    async readBarcodes(frame: CameraFrame): Promise<BarcodeReadResult> {
      const result: BarcodeScanningResult =
        // No orientation override (A4 review): the plugin falls back to the EXIF rotation
        // VisionCamera writes (setTargetRotation), then PORTRAIT — a hardcoded 'portrait'
        // overrode EXIF and would 90°-rotate frames to ML Kit.
        await processImageBarcodeScanning(frame.filePath, {formats: [...formats]});
      return {barcodes: result.barcodes};
    },
    async readText(frame: CameraFrame): Promise<OcrResultLike> {
      const result: TextRecognitionResult =
        // No orientation override — see the barcode path comment above.
        await processImageTextRecognition(frame.filePath, {language});
      return result;
    },
  };
}
