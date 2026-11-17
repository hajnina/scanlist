/**
 * Card C4: the OCR source never stacks recognitions, grabs the freshest frame and emits one signal
 * per line with the shared repeat window (RANK.md §2.2).
 *
 * Tesseract is 0.5–2 s/frame, so the important behaviour is the skip-while-busy tick, not the timer.
 */

import { describe, expect, it, vi } from 'vitest';

import type { OcrResultLike } from '../ocr';
import type { OcrEngine } from '../ocrEngine';
import { createOcrSource } from '../ocrSource';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function page(...texts: string[]): OcrResultLike {
  return { blocks: [{ lines: texts.map((text) => ({ text, confidence: 0.8 })) }] };
}

function engineReturning(result: OcrResultLike): { engine: OcrEngine; recognize: ReturnType<typeof vi.fn> } {
  const recognize = vi.fn(async () => result);
  return { engine: { recognize, dispose: async () => undefined }, recognize };
}

const jpeg = new Blob([new Uint8Array(16)], { type: 'image/jpeg' });

describe('createOcrSource', () => {
  it('emits one signal per OCR line and passes the grabbed frame to the engine', async () => {
    const { engine, recognize } = engineReturning(page('Oat milk', 'Whole milk'));
    const onSignals = vi.fn();
    const source = createOcrSource({
      engine,
      grab: async () => jpeg,
      onSignals,
      clock: { now: () => 500 },
    });

    const signals = await source.tick(500);

    expect(recognize).toHaveBeenCalledWith(jpeg);
    expect(signals.map((signal) => signal.text)).toEqual(['Oat milk', 'Whole milk']);
    expect(onSignals).toHaveBeenCalledWith(signals);
    expect(signals[0]).toMatchObject({ source: 'ocr', confidence: 0.8, at: 500 });
  });

  it('skips ticks while a recognition is in flight (never stacks)', async () => {
    const pending = deferred<OcrResultLike>();
    const recognize = vi.fn(() => pending.promise);
    const source = createOcrSource({
      engine: { recognize, dispose: async () => undefined },
      grab: async () => jpeg,
      onSignals: () => undefined,
      clock: { now: () => 0 },
    });

    const first = source.tick(0);
    expect(source.isBusy()).toBe(true);
    // Two more ticks while Tesseract is still working: both return immediately, no second call.
    await expect(source.tick(1000)).resolves.toEqual([]);
    await expect(source.tick(2000)).resolves.toEqual([]);
    expect(recognize).toHaveBeenCalledTimes(1);

    pending.resolve(page('Oat milk'));
    await expect(first).resolves.toHaveLength(1);
    expect(source.isBusy()).toBe(false);
    // After it settles the next tick runs again.
    const next = source.tick(3000);
    expect(source.isBusy()).toBe(true);
    pending.resolve(page('Oat milk'));
    await next;
  });

  it('does nothing when there is no frame to grab', async () => {
    const { engine, recognize } = engineReturning(page('Oat milk'));
    const source = createOcrSource({
      engine,
      grab: async () => undefined,
      onSignals: () => undefined,
      clock: { now: () => 0 },
    });
    await expect(source.tick(0)).resolves.toEqual([]);
    expect(recognize).not.toHaveBeenCalled();
  });

  it('reports engine failures through onError and stays usable', async () => {
    const onError = vi.fn();
    const recognize = vi
      .fn<() => Promise<OcrResultLike>>()
      .mockRejectedValueOnce(new Error('traineddata failed to load'))
      .mockResolvedValue(page('Oat milk'));
    const source = createOcrSource({
      engine: { recognize, dispose: async () => undefined },
      grab: async () => jpeg,
      onSignals: () => undefined,
      onError,
      clock: { now: () => 0 },
    });

    await expect(source.tick(0)).resolves.toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    await expect(source.tick(1000)).resolves.toHaveLength(1);
  });

  it('applies the 2 s repeat window across ticks', async () => {
    const { engine } = engineReturning(page('Oat milk'));
    const onSignals = vi.fn();
    const source = createOcrSource({
      engine,
      grab: async () => jpeg,
      onSignals,
      clock: { now: () => 0 },
    });

    await expect(source.tick(0)).resolves.toHaveLength(1);
    await expect(source.tick(1000)).resolves.toEqual([]);
    await expect(source.tick(2000)).resolves.toHaveLength(1);
    expect(onSignals).toHaveBeenCalledTimes(2);
  });

  it('honours minChars/maxLines from the shared per-line shaping', async () => {
    const { engine } = engineReturning(page('I', 'Oat milk', 'Whole milk', 'Eggs'));
    const source = createOcrSource({
      engine,
      grab: async () => jpeg,
      onSignals: () => undefined,
      maxLines: 2,
      clock: { now: () => 0 },
    });
    const signals = await source.tick(0);
    expect(signals.map((signal) => signal.text)).toEqual(['Oat milk', 'Whole milk']);
  });

  it('rejects a non-positive interval', () => {
    expect(() =>
      createOcrSource({
        engine: { recognize: async () => page('x'), dispose: async () => undefined },
        grab: async () => jpeg,
        onSignals: () => undefined,
        intervalMs: 0,
      }),
    ).toThrow(/interval/);
  });
});
