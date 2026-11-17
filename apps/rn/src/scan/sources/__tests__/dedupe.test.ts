/**
 * Card A4 — barcode debounce (same code within N seconds fires once).
 */
import {createBarcodeDeduper} from '../dedupe';

describe('createBarcodeDeduper', () => {
  test('emits a value once and suppresses repeats inside the hold window', () => {
    const deduper = createBarcodeDeduper(4000);

    expect(deduper.accept('4008400409327', 0)).toBe(true);
    expect(deduper.current()).toBe('4008400409327');

    expect(deduper.accept('4008400409327', 400)).toBe(false);
    expect(deduper.accept('4008400409327', 2000)).toBe(false);
    expect(deduper.accept('4008400409327', 3999)).toBe(false);
    expect(deduper.accept('4008400409327', 4000)).toBe(true); // re-fires after the hold
  });

  test('a different barcode fires immediately and becomes current', () => {
    const deduper = createBarcodeDeduper(4000);

    expect(deduper.accept('11111111', 0)).toBe(true);
    expect(deduper.accept('22222222', 50)).toBe(true);
    expect(deduper.current()).toBe('22222222');
    // The old value is no longer "current", so going back to it fires again.
    expect(deduper.accept('11111111', 100)).toBe(true);
  });

  test('rejected frames do not extend the hold window', () => {
    let now = 0;
    const deduper = createBarcodeDeduper(1000, {now: () => now});

    expect(deduper.accept('x')).toBe(true);
    now = 900;
    expect(deduper.accept('x')).toBe(false);
    now = 1000;
    expect(deduper.accept('x')).toBe(true);
  });

  test('trims whitespace and ignores empty values', () => {
    const deduper = createBarcodeDeduper(4000);

    expect(deduper.accept('  4008400409327\n', 0)).toBe(true);
    expect(deduper.accept('4008400409327', 10)).toBe(false); // same value, padded
    expect(deduper.accept('   ', 20)).toBe(false);
  });

  test('reset() clears the current value', () => {
    const deduper = createBarcodeDeduper(4000);
    expect(deduper.accept('11111111', 0)).toBe(true);
    deduper.reset();
    expect(deduper.current()).toBeUndefined();
    expect(deduper.accept('11111111', 10)).toBe(true);
  });

  test('rejects invalid holds', () => {
    expect(() => createBarcodeDeduper(-1)).toThrow(/>= 0/);
    expect(() => createBarcodeDeduper(Number.POSITIVE_INFINITY)).toThrow(
      /finite/,
    );
  });
});
