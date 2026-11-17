/**
 * Card C4: barcode format filtering, GTIN shape, product-over-QR priority and the per-value hold.
 *
 * Mirrors Track A's merged `barcode.ts` + `dedupe.ts` (card A4), with the browser's format
 * spellings (`ean_13` from BarcodeDetector, `EAN13` from zxing, `EAN_13` from ML Kit).
 */

import { describe, expect, it } from 'vitest';

import {
  PRODUCT_BARCODE_LENGTHS,
  barcodeSignal,
  canonicalBarcodeFormat,
  gtinCheckDigitValid,
  isProductBarcode,
  isProductBarcodeFormat,
  normalizeBarcodeValue,
  selectBarcode,
} from '../barcode';
import { DEFAULT_BARCODE_HOLD_MS, createBarcodeDeduper } from '../dedupe';

describe('barcode format canonicalisation', () => {
  it('collapses BarcodeDetector, zxing and ML Kit spellings', () => {
    for (const spelling of ['ean_13', 'EAN13', 'EAN_13', 'EAN-13', ' ean-13 ']) {
      expect(canonicalBarcodeFormat(spelling)).toBe('EAN-13');
    }
    expect(canonicalBarcodeFormat('upc_a')).toBe('UPC-A');
    expect(canonicalBarcodeFormat('UPCA')).toBe('UPC-A');
    expect(canonicalBarcodeFormat('upc_e')).toBe('UPC-E');
    expect(canonicalBarcodeFormat('EAN8')).toBe('EAN-8');
    expect(canonicalBarcodeFormat('qr_code')).toBe('QR');
    expect(canonicalBarcodeFormat('QRCode')).toBe('QR');
    expect(canonicalBarcodeFormat('code_128')).toBeUndefined();
    expect(canonicalBarcodeFormat('')).toBeUndefined();
    expect(canonicalBarcodeFormat(null)).toBeUndefined();
  });

  it('treats only the four product symbologies as product formats', () => {
    expect(PRODUCT_BARCODE_LENGTHS).toEqual([8, 12, 13, 14]);
    expect(isProductBarcodeFormat('ean_13')).toBe(true);
    expect(isProductBarcodeFormat('EAN8')).toBe(true);
    expect(isProductBarcodeFormat('upc_a')).toBe(true);
    expect(isProductBarcodeFormat('UPC-E')).toBe(true);
    expect(isProductBarcodeFormat('qr_code')).toBe(false);
    expect(isProductBarcodeFormat('itf')).toBe(false);
    expect(isProductBarcodeFormat(undefined)).toBe(false);
  });
});

describe('GTIN values', () => {
  it('accepts exactly the four standard digit lengths (A4 parity)', () => {
    expect(isProductBarcode('4006381333931')).toBe(true); // EAN-13
    expect(isProductBarcode('96385074')).toBe(true); // EAN-8
    expect(isProductBarcode('036000291452')).toBe(true); // UPC-A
    expect(isProductBarcode('10012345678902')).toBe(true); // GTIN-14
    expect(isProductBarcode('12345')).toBe(false);
    expect(isProductBarcode('123456789012345')).toBe(false);
    expect(isProductBarcode('40063813339AB')).toBe(false);
    expect(isProductBarcode('')).toBe(false);
  });

  it('strips whitespace but keeps the digits', () => {
    expect(normalizeBarcodeValue(' 400 6381 333931 ')).toBe('4006381333931');
    expect(normalizeBarcodeValue('')).toBeUndefined();
    expect(normalizeBarcodeValue(42)).toBeUndefined();
  });

  it('computes the GS1 check digit (available for stricter callers, not A4 parity)', () => {
    expect(gtinCheckDigitValid('4006381333931')).toBe(true);
    expect(gtinCheckDigitValid('96385074')).toBe(true);
    expect(gtinCheckDigitValid('036000291452')).toBe(true);
    expect(gtinCheckDigitValid('4006381333932')).toBe(false);
    expect(gtinCheckDigitValid('12345678')).toBe(false);
    expect(gtinCheckDigitValid('abc')).toBe(false);
  });
});

describe('barcode selection', () => {
  it('prefers a product code over a QR code when both are decoded', () => {
    const selected = selectBarcode([
      { rawValue: 'https://example.com', format: 'qr_code' },
      { rawValue: '4006381333931', format: 'ean_13' },
    ]);
    expect(selected?.rawValue).toBe('4006381333931');
  });

  it('accepts the ML Kit property name (formatName) too', () => {
    const selected = selectBarcode([
      { rawValue: 'https://example.com', formatName: 'QR_CODE' },
      { rawValue: '96385074', formatName: 'EAN_8' },
    ]);
    expect(selected?.rawValue).toBe('96385074');
  });

  it('falls back to the first decoded non-product code (QR text is still a query)', () => {
    const selected = selectBarcode([{ rawValue: 'https://example.com', format: 'qr_code' }]);
    expect(selected?.rawValue).toBe('https://example.com');
  });

  it('ignores undecoded ("potential") and empty results', () => {
    expect(
      selectBarcode([
        { rawValue: '4006381333931', format: 'ean_13', isPotential: true },
        { rawValue: '   ', format: 'ean_13' },
      ]),
    ).toBeUndefined();
    expect(selectBarcode([])).toBeUndefined();
  });

  it('uses displayValue when rawValue is absent', () => {
    const selected = selectBarcode([{ displayValue: '036000291452', format: 'upc_a' }]);
    expect(selected?.displayValue).toBe('036000291452');
  });
});

describe('barcode signals', () => {
  it('reports confidence 1 for a product GTIN and 0.85 for other codes', () => {
    expect(barcodeSignal({ rawValue: '4006381333931', format: 'ean_13' }, 1234)).toEqual({
      source: 'barcode',
      text: '4006381333931',
      confidence: 1,
      at: 1234,
    });
    expect(barcodeSignal({ rawValue: 'https://example.com', format: 'qr_code' })?.confidence).toBe(0.85);
  });

  it('returns undefined for an empty value', () => {
    expect(barcodeSignal({ rawValue: '  ', format: 'ean_13' })).toBeUndefined();
  });
});

describe('barcode hold (one chip per product, not per 150 ms tick)', () => {
  it('defaults to 4 s like A4/B4', () => {
    expect(DEFAULT_BARCODE_HOLD_MS).toBe(4000);
  });

  it('emits a new value immediately and re-emits the same value after the hold', () => {
    const deduper = createBarcodeDeduper();
    expect(deduper.accept('4006381333931', 0)).toBe(true);
    expect(deduper.accept('4006381333931', 150)).toBe(false);
    expect(deduper.accept('4006381333931', 3999)).toBe(false);
    expect(deduper.accept('4006381333931', 4000)).toBe(true);
    expect(deduper.current()).toBe('4006381333931');
    expect(deduper.accept('96385074', 4100)).toBe(true);
    expect(deduper.current()).toBe('96385074');
  });

  it('ignores blank values and can be reset', () => {
    const deduper = createBarcodeDeduper(1000);
    expect(deduper.accept('   ', 0)).toBe(false);
    expect(deduper.accept('96385074', 0)).toBe(true);
    deduper.reset();
    expect(deduper.current()).toBeUndefined();
    expect(deduper.accept('96385074', 1)).toBe(true);
  });

  it('rejects a negative hold', () => {
    expect(() => createBarcodeDeduper(-1)).toThrow(/hold/);
  });
});
