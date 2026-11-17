/**
 * Card A4 — barcode normalisation/selection (product codes vs QR).
 */
import {
  barcodeSignal,
  isProductBarcode,
  normalizeBarcodeValue,
  selectBarcode,
  type BarcodeLike,
} from '../barcode';

const ean13: BarcodeLike = {
  rawValue: '4008400409327',
  formatName: 'EAN_13',
  isPotential: false,
};
const qr: BarcodeLike = {
  rawValue: 'https://example.com/milk',
  formatName: 'QR_CODE',
  isPotential: false,
};

describe('normalizeBarcodeValue', () => {
  test('trims whitespace and rejects empty/non-strings', () => {
    expect(normalizeBarcodeValue(' 4008400409327 ')).toBe('4008400409327');
    expect(normalizeBarcodeValue('4008 4004 09327')).toBe('4008400409327');
    expect(normalizeBarcodeValue('   ')).toBeUndefined();
    expect(normalizeBarcodeValue(null)).toBeUndefined();
    expect(normalizeBarcodeValue(42)).toBeUndefined();
  });
});

describe('isProductBarcode', () => {
  test.each([
    ['96385074', true], // EAN-8
    ['036000291452', true], // UPC-A
    ['4008400409327', true], // EAN-13
    ['10012345000017', true], // ITF-14
    ['400840040932', true], // 12 digits = UPC-A
    ['40084004093278', true], // 14 digits = ITF-14
  ])('%s -> %s', (value, expected) => {
    expect(isProductBarcode(value)).toBe(expected);
  });

  test('rejects non-digits and wrong lengths', () => {
    expect(isProductBarcode('40084004O9327')).toBe(false);
    expect(isProductBarcode('12345')).toBe(false);
    expect(isProductBarcode('https://example.com')).toBe(false);
    expect(isProductBarcode('')).toBe(false);
  });
});

describe('selectBarcode', () => {
  test('prefers a product code over a QR code', () => {
    expect(selectBarcode([qr, ean13])).toBe(ean13);
    expect(selectBarcode([ean13, qr])).toBe(ean13);
  });

  test('falls back to a decoded non-product code', () => {
    expect(selectBarcode([qr])).toBe(qr);
  });

  test('ignores potential (undecoded) and empty barcodes', () => {
    expect(
      selectBarcode([
        {...ean13, isPotential: true},
        {...qr, rawValue: null, displayValue: null},
      ]),
    ).toBeUndefined();
    expect(selectBarcode([])).toBeUndefined();
  });

  test('uses displayValue when rawValue is missing', () => {
    const barcode: BarcodeLike = {
      rawValue: null,
      displayValue: '4008400409327',
      formatName: 'EAN_13',
    };
    expect(selectBarcode([barcode])).toBe(barcode);
  });
});

describe('barcodeSignal', () => {
  test('product codes are exact matches (confidence 1, per the A1 contract)', () => {
    expect(barcodeSignal(ean13)).toEqual({
      source: 'barcode',
      text: '4008400409327',
      confidence: 1,
    });
  });

  test('non-product codes are exact but not product lookups', () => {
    expect(barcodeSignal(qr)).toEqual({
      source: 'barcode',
      text: 'https://example.com/milk',
      confidence: 0.85,
    });
  });

  test('returns undefined without a value', () => {
    expect(barcodeSignal({rawValue: null, formatName: 'QR_CODE'})).toBeUndefined();
  });

  test('normalises padded values', () => {
    expect(barcodeSignal({rawValue: ' 4008400409327 ', formatName: 'EAN_13'})).toEqual(
      {source: 'barcode', text: '4008400409327', confidence: 1},
    );
  });
});
