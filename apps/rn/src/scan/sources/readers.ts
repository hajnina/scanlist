/**
 * Reader contracts (card A4).
 *
 * The three sources never talk to ML Kit directly: they take these two functions. The app injects
 * the ML Kit implementations from ./native (which needs the native module and therefore cannot run
 * under Jest); tests inject plain fakes.
 */
import type {BarcodeReadResult} from './barcodeSource';
import type {OcrResultLike} from './ocr';
import type {CameraFrame} from './types';

export interface ScanReaders {
  /** Barcode symbols in the frame (ML Kit barcode scanning). */
  readBarcodes: (frame: CameraFrame) => Promise<BarcodeReadResult>;
  /** Visible text in the frame (ML Kit text recognition). */
  readText: (frame: CameraFrame) => Promise<OcrResultLike>;
}
