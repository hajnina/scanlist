/**
 * Card C4: BarcodeDetector feature detection → zxing-wasm fallback.
 *
 * The wasm itself is only exercised in the manual browser script; here both backends are fakes, so
 * the *selection* rules are pinned: native only when it advertises a product symbology, zxing
 * otherwise (absent, flag-gated, no product formats, constructor throws, load fails).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  BarcodeDetectorUnavailableError,
  DESIRED_FORMATS,
  ZXING_FORMATS,
  selectBarcodeDetector,
  type BarcodeDetectorCtor,
  type ZxingModuleLike,
} from '../detector';
import type { BarcodeLike } from '../barcode';

interface NativeOptions {
  formats: readonly string[];
  results?: readonly BarcodeLike[];
  getSupportedFormats?: () => Promise<readonly string[]>;
  throwOnConstruct?: boolean;
}

function fakeNative({
  formats,
  results = [],
  getSupportedFormats,
  throwOnConstruct = false,
}: NativeOptions): BarcodeDetectorCtor {
  return class FakeBarcodeDetector {
    static async getSupportedFormats(): Promise<readonly string[]> {
      return getSupportedFormats === undefined ? formats : getSupportedFormats();
    }
    constructor(options?: { formats?: readonly string[] }) {
      if (throwOnConstruct) throw new Error('Play Services unavailable');
      void options;
    }
    async detect(): Promise<readonly BarcodeLike[]> {
      return results;
    }
  };
}

function fakeZxing(
  results: Array<{ text: string; format: string; isValid: boolean }> = [],
): { module: ZxingModuleLike; readBarcodes: ReturnType<typeof vi.fn> } {
  const readBarcodes = vi.fn(async () => results);
  return { module: { readBarcodes }, readBarcodes };
}

describe('selectBarcodeDetector', () => {
  it('uses the native detector when it supports a product symbology', async () => {
    const detector = fakeNative({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code'],
      results: [{ rawValue: '4006381333931', format: 'ean_13' }],
    });
    const loadZxing = vi.fn(async () => fakeZxing().module);

    const selection = await selectBarcodeDetector({ BarcodeDetector: detector, loadZxing });

    expect(selection.kind).toBe('native');
    expect(selection.formats).toEqual(DESIRED_FORMATS);
    expect(loadZxing).not.toHaveBeenCalled();
    await expect(selection.detect(new Blob([]))).resolves.toEqual([
      { rawValue: '4006381333931', format: 'ean_13' },
    ]);
  });

  it('requests only the formats the browser advertises', async () => {
    const selection = await selectBarcodeDetector({
      BarcodeDetector: fakeNative({ formats: ['ean_13'] }),
      loadZxing: async () => fakeZxing().module,
    });
    expect(selection.kind).toBe('native');
    expect(selection.formats).toEqual(['ean_13']);
  });

  it('falls back to zxing when the native detector has no product format', async () => {
    const zxing = fakeZxing([{ text: '96385074', format: 'EAN8', isValid: true }]);
    const selection = await selectBarcodeDetector({
      BarcodeDetector: fakeNative({ formats: ['qr_code'] }),
      loadZxing: async () => zxing.module,
    });

    expect(selection.kind).toBe('zxing');
    expect(selection.formats).toEqual(ZXING_FORMATS);
    await expect(selection.detect(new Blob([]))).resolves.toEqual([
      { rawValue: '96385074', format: 'EAN8', isPotential: false },
    ]);
    expect(zxing.readBarcodes).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.objectContaining({ formats: ZXING_FORMATS, tryHarder: false }),
    );
  });

  it('falls back when getSupportedFormats throws (flag-gated / broken backend)', async () => {
    const selection = await selectBarcodeDetector({
      BarcodeDetector: fakeNative({
        formats: [],
        getSupportedFormats: async () => {
          throw new Error('not supported');
        },
      }),
      loadZxing: async () => fakeZxing().module,
    });
    expect(selection.kind).toBe('zxing');
  });

  it('falls back when the native constructor throws (Play Services missing)', async () => {
    const selection = await selectBarcodeDetector({
      BarcodeDetector: fakeNative({ formats: ['ean_13'], throwOnConstruct: true }),
      loadZxing: async () => fakeZxing().module,
    });
    expect(selection.kind).toBe('zxing');
  });

  it('falls back when there is no BarcodeDetector at all (Firefox, desktop-Linux Chrome)', async () => {
    const selection = await selectBarcodeDetector({
      loadZxing: async () => fakeZxing().module,
    });
    expect(selection.kind).toBe('zxing');
  });

  it('marks invalid zxing reads as "potential" so selection ignores them', async () => {
    const selection = await selectBarcodeDetector({
      loadZxing: async () =>
        fakeZxing([
          { text: '4006381333931', format: 'EAN13', isValid: true },
          { text: 'garbage', format: 'QRCode', isValid: false },
        ]).module,
    });
    await expect(selection.detect(new Blob([]))).resolves.toEqual([
      { rawValue: '4006381333931', format: 'EAN13', isPotential: false },
      { rawValue: 'garbage', format: 'QRCode', isPotential: true },
    ]);
  });

  it('rejects with a coded error when neither backend is usable', async () => {
    await expect(
      selectBarcodeDetector({
        loadZxing: async () => {
          throw new Error('offline');
        },
      }),
    ).rejects.toMatchObject({
      name: 'BarcodeDetectorUnavailableError',
      code: 'barcode_detector_unavailable',
    });
    await expect(
      selectBarcodeDetector({ loadZxing: async () => Promise.reject(new Error('offline')) }),
    ).rejects.toBeInstanceOf(BarcodeDetectorUnavailableError);
  });
});
