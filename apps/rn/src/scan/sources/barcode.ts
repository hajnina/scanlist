/**
 * Barcode selection + signal shaping (card A4).
 *
 * ML Kit's `processImageBarcodeScanning` returns every symbology it saw in the frame, including
 * "potential" codes that were located but not decoded. For the shopping-list use case only product
 * barcodes (EAN-8, UPC-A, EAN-13, ITF-14) are useful — they are what Open Food Facts resolves to a
 * product name — so a product code wins over a QR code when both are in shot.
 */
import type {ScanSignal} from './types';

/** Digits of a GTIN that Open Food Facts (and every shop shelf) uses. */
export const PRODUCT_BARCODE_LENGTHS: readonly number[] = [8, 12, 13, 14];

export const PRODUCT_BARCODE_FORMATS: readonly string[] = [
  'EAN_13',
  'EAN_8',
  'UPC_A',
  'UPC_E',
];

/** The subset of ML Kit's barcode shape this module needs. */
export interface BarcodeLike {
  rawValue?: string | null;
  displayValue?: string | null;
  formatName: string;
  isPotential?: boolean;
}

/** Trim, drop surrounding whitespace and any embedded spaces (some symbologies pad). */
export function normalizeBarcodeValue(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const value = raw.replace(/\s+/g, '').trim();
  return value.length > 0 ? value : undefined;
}

/** True for a GTIN product barcode: only ASCII digits, one of the four standard lengths. */
export function isProductBarcode(value: string): boolean {
  return (
    /^[0-9]+$/.test(value) && PRODUCT_BARCODE_LENGTHS.includes(value.length)
  );
}

function formatOf(barcode: BarcodeLike): string {
  return barcode.formatName ?? 'UNKNOWN';
}

/**
 * Pick the barcode a scan should act on: decoded (not "potential"), non-empty, product symbology
 * first, otherwise the first decoded code (a QR code still carries useful text).
 */
export function selectBarcode(
  barcodes: readonly BarcodeLike[],
): BarcodeLike | undefined {
  const decoded = barcodes.filter(
    barcode =>
      barcode.isPotential !== true &&
      normalizeBarcodeValue(barcode.rawValue ?? barcode.displayValue) !==
        undefined,
  );
  return (
    decoded.find(barcode =>
      PRODUCT_BARCODE_FORMATS.includes(formatOf(barcode)),
    ) ?? decoded[0]
  );
}

/**
 * Shape a decoded barcode into a {@linkcode ScanSignal}.
 *
 * The A1 contract says exact barcode matches report confidence 1 — product codes do (they feed the
 * "exact name match" +0.15 boost in the ranker); a non-product code (QR/URL/text) is still exact
 * but is not a product lookup, so it is reported a little lower.
 */
export function barcodeSignal(barcode: BarcodeLike): ScanSignal | undefined {
  const value = normalizeBarcodeValue(
    barcode.rawValue ?? barcode.displayValue,
  );
  if (value === undefined) {
    return undefined;
  }
  return {
    source: 'barcode',
    text: value,
    confidence: isProductBarcode(value) ? 1 : 0.85,
  };
}
