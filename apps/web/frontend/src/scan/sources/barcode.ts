/**
 * Barcode selection + signal shaping (card C4).
 *
 * Port of Track A's merged `apps/rn/src/scan/sources/barcode.ts` (card A4) with the browser's
 * format names instead of ML Kit's:
 *
 *  - `BarcodeDetector` reports lowercase underscore formats (`ean_13`, `upc_a`, `qr_code`, …);
 *  - zxing-wasm reports `EAN13`, `UPCA`, `QRCode`, …;
 *  - ML Kit used `EAN_13`.
 *
 * {@linkcode canonicalBarcodeFormat} collapses all three spellings, so the filtering/priority rules
 * are literally A4's: only product symbologies (EAN-13, EAN-8, UPC-A, UPC-E — what Open Food Facts
 * resolves) are useful; a product code wins over a QR code when both are in shot; a QR code is
 * still forwarded (its text is a legitimate text query) with slightly lower confidence.
 */

import type { ScanSignal } from './types';

/** Digits of a GTIN that Open Food Facts (and every shop shelf) uses. */
export const PRODUCT_BARCODE_LENGTHS: readonly number[] = [8, 12, 13, 14];

/** Canonical names of the four product symbologies, in A4's order. */
export type ProductBarcodeFormat = 'EAN-13' | 'EAN-8' | 'UPC-A' | 'UPC-E';

export const PRODUCT_BARCODE_FORMATS: readonly ProductBarcodeFormat[] = [
  'EAN-13',
  'EAN-8',
  'UPC-A',
  'UPC-E',
];

/**
 * Format strings `BarcodeDetector` accepts; requested from `getSupportedFormats()` before the
 * detector is constructed (Chrome on Android supports all of them, desktop-Linux Chrome none).
 */
export const DETECTOR_PRODUCT_FORMATS: readonly string[] = [
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
];

/** The subset of a `BarcodeDetector`/zxing result this module needs. */
export interface BarcodeLike {
  rawValue?: string | null;
  displayValue?: string | null;
  /** `BarcodeDetector` names the property `format`, ML Kit `formatName`; both are accepted. */
  format?: string | null;
  formatName?: string | null;
  /** ML Kit "located but not decoded"; zxing maps `!isValid` here. */
  isPotential?: boolean;
}

/** Every spelling of the four product symbologies, plus QR for the non-product fallback. */
const FORMAT_ALIASES: Readonly<Record<string, string>> = {
  ean13: 'EAN-13',
  ean_13: 'EAN-13',
  'ean-13': 'EAN-13',
  ean8: 'EAN-8',
  ean_8: 'EAN-8',
  'ean-8': 'EAN-8',
  upca: 'UPC-A',
  upc_a: 'UPC-A',
  'upc-a': 'UPC-A',
  upce: 'UPC-E',
  upc_e: 'UPC-E',
  'upc-e': 'UPC-E',
  qrcode: 'QR',
  qr_code: 'QR',
  'qr-code': 'QR',
  qr: 'QR',
};

/** `'ean_13' | 'EAN13' | 'EAN_13' | 'EAN-13'` → `'EAN-13'`; `undefined` for unknown formats. */
export function canonicalBarcodeFormat(format: string | null | undefined): string | undefined {
  if (typeof format !== 'string') return undefined;
  const key = format.trim().toLowerCase();
  if (key.length === 0) return undefined;
  return FORMAT_ALIASES[key] ?? FORMAT_ALIASES[key.replace(/[^a-z0-9]/g, '')] ?? undefined;
}

/** True for a product symbology (EAN-13 / EAN-8 / UPC-A / UPC-E), regardless of spelling. */
export function isProductBarcodeFormat(format: string | null | undefined): boolean {
  const canonical = canonicalBarcodeFormat(format);
  return canonical !== undefined && (PRODUCT_BARCODE_FORMATS as readonly string[]).includes(canonical);
}

/** Trim, drop surrounding whitespace and any embedded spaces (some symbologies pad). */
export function normalizeBarcodeValue(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.replace(/\s+/g, '').trim();
  return value.length > 0 ? value : undefined;
}

/**
 * True for a GTIN product barcode: only ASCII digits, one of the four standard lengths.
 *
 * Deliberately identical to A4's `isProductBarcode`, check digit included: the spec layer resolves
 * `code` → OFF and A4 does not require a valid check digit either, so adding one here would make
 * the tracks disagree on the `BARCODE_MATCH` fixture set. {@linkcode gtinCheckDigitValid} is
 * exported for callers that want the stricter gate (e.g. before an OFF lookup).
 */
export function isProductBarcode(value: string): boolean {
  return /^[0-9]+$/.test(value) && PRODUCT_BARCODE_LENGTHS.includes(value.length);
}

/** GS1 mod-10 check digit (GTIN-8/12/13/14). Exposed for stricter callers; not part of A4 parity. */
export function gtinCheckDigitValid(value: string): boolean {
  if (!/^[0-9]+$/.test(value) || value.length < 2) return false;
  const digits = [...value].map(Number);
  const check = digits.pop() as number;
  let sum = 0;
  // Weights alternate 3,1 from the digit immediately left of the check digit.
  for (let i = digits.length - 1, weight = 3; i >= 0; i -= 1, weight = 4 - weight) {
    sum += (digits[i] as number) * weight;
  }
  return (10 - (sum % 10)) % 10 === check;
}

function formatOf(barcode: BarcodeLike): string | undefined {
  return barcode.format ?? barcode.formatName ?? undefined;
}

/**
 * Pick the barcode a scan should act on: decoded (not "potential"), non-empty, product symbology
 * first, otherwise the first decoded code (a QR code still carries useful text).
 */
export function selectBarcode(barcodes: readonly BarcodeLike[]): BarcodeLike | undefined {
  const decoded = barcodes.filter(
    (barcode) =>
      barcode.isPotential !== true &&
      normalizeBarcodeValue(barcode.rawValue ?? barcode.displayValue) !== undefined,
  );
  return decoded.find((barcode) => isProductBarcodeFormat(formatOf(barcode))) ?? decoded[0];
}

/**
 * Shape a decoded barcode into a {@linkcode ScanSignal}.
 *
 * A1's contract says exact barcode matches report confidence 1 — product codes do (they feed the
 * "exact name match" +0.15 boost in the ranker); a non-product code (QR/URL/text) is still exact
 * but is not a product lookup, so it is reported a little lower.
 */
export function barcodeSignal(barcode: BarcodeLike, at?: number): ScanSignal | undefined {
  const value = normalizeBarcodeValue(barcode.rawValue ?? barcode.displayValue);
  if (value === undefined) return undefined;
  return {
    source: 'barcode',
    text: value,
    confidence: isProductBarcode(value) ? 1 : 0.85,
    ...(at === undefined ? {} : { at }),
  };
}
