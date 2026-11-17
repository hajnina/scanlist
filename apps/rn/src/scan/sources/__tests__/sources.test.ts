/**
 * Card A4 — the three scan sources over a shared frame feed, plus the pipeline helper.
 *
 * The camera and ML Kit are faked here (they cannot run under Jest); everything that decides
 * *when* and *what* a source emits is the real code.
 */
import {createBarcodeSource} from '../barcodeSource';
import {createFrameFeed} from '../frames';
import {createImageSource, IMAGE_QUERY_MARKER} from '../imageSource';
import {createOcrSource} from '../ocrSource';
import {createScanPipeline, createScanSources} from '../index';
import type {CameraFrame} from '../types';

function frame(capturedAt: number): CameraFrame {
  return {
    jpegBase64: 'Zm9v',
    filePath: `/tmp/photo-${capturedAt}.jpg`,
    width: 720,
    height: 1280,
    capturedAt,
  };
}

/** Let the source's promise chain (read → emit) run. */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function mutableClock(start = 0) {
  let now = start;
  return {
    clock: {now: () => now},
    advance(ms: number) {
      now += ms;
    },
  };
}

const ean = (value: string) => ({
  read: async () => ({
    barcodes: [{rawValue: value, formatName: 'EAN_13', isPotential: false}],
  }),
});

describe('barcodeSource', () => {
  test('emits a product barcode once and debounces the same code', async () => {
    const feed = createFrameFeed();
    const {clock, advance} = mutableClock();
    const onSignal = jest.fn();
    const source = createBarcodeSource(feed, {...ean('4008400409327'), clock});

    await source.start(onSignal);

    feed.push(frame(0));
    await flush();
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal).toHaveBeenCalledWith({
      source: 'barcode',
      text: '4008400409327',
      confidence: 1,
    });

    advance(400);
    feed.push(frame(400));
    await flush();
    expect(onSignal).toHaveBeenCalledTimes(1); // same code, inside the 4 s hold

    advance(4000);
    feed.push(frame(4400));
    await flush();
    expect(onSignal).toHaveBeenCalledTimes(2); // re-fires after the hold

    await source.stop();
  });

  test('a different code fires immediately', async () => {
    const feed = createFrameFeed();
    const {clock} = mutableClock();
    const onSignal = jest.fn();
    let next = '11111111';
    const source = createBarcodeSource(feed, {
      read: async () => ({
        barcodes: [{rawValue: next, formatName: 'EAN_8'}],
      }),
      clock,
    });
    await source.start(onSignal);

    feed.push(frame(0));
    await flush();
    next = '22222222';
    feed.push(frame(1));
    await flush();

    expect(onSignal.mock.calls.map(([signal]) => signal.text)).toEqual([
      '11111111',
      '22222222',
    ]);
    await source.stop();
  });

  test('frames without a barcode emit nothing', async () => {
    const feed = createFrameFeed();
    const onSignal = jest.fn();
    const source = createBarcodeSource(feed, {
      read: async () => ({barcodes: []}),
    });
    await source.start(onSignal);

    feed.push(frame(0));
    await flush();
    expect(onSignal).not.toHaveBeenCalled();
    await source.stop();
  });

  test('single-flight: frames during a slow read are dropped, not queued', async () => {
    const feed = createFrameFeed();
    let resolveRead: (() => void) | undefined;
    const read = jest.fn(
      () =>
        new Promise<{barcodes: {rawValue: string; formatName: string}[]}>(
          resolve => {
            resolveRead = () =>
              resolve({
                barcodes: [{rawValue: '4008400409327', formatName: 'EAN_13'}],
              });
          },
        ),
    );
    const onSignal = jest.fn();
    const source = createBarcodeSource(feed, {read});
    await source.start(onSignal);

    feed.push(frame(0));
    feed.push(frame(400));
    feed.push(frame(800));
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(source.droppedWhileBusy()).toBe(2);

    resolveRead?.();
    await flush();
    expect(onSignal).toHaveBeenCalledTimes(1);

    feed.push(frame(1200));
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    await source.stop();
  });

  test('a failing read is reported and the source keeps working', async () => {
    const feed = createFrameFeed();
    const onError = jest.fn();
    const read = jest
      .fn()
      .mockRejectedValueOnce(new Error('ml kit unavailable'))
      .mockResolvedValue({
        barcodes: [{rawValue: '4008400409327', formatName: 'EAN_13'}],
      });
    const onSignal = jest.fn();
    const source = createBarcodeSource(feed, {read, onError});
    await source.start(onSignal);

    feed.push(frame(0));
    await flush();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({message: 'ml kit unavailable'}),
    );

    feed.push(frame(400));
    await flush();
    expect(onSignal).toHaveBeenCalledTimes(1);
    await source.stop();
  });

  test('stop() detaches and swallows late results', async () => {
    const feed = createFrameFeed();
    let resolveRead: (() => void) | undefined;
    const read = () =>
      new Promise<{barcodes: {rawValue: string; formatName: string}[]}>(
        resolve => {
          resolveRead = () =>
            resolve({
              barcodes: [{rawValue: '4008400409327', formatName: 'EAN_13'}],
            });
        },
      );
    const onSignal = jest.fn();
    const source = createBarcodeSource(feed, {read});
    await source.start(onSignal);

    feed.push(frame(0));
    await source.stop();
    resolveRead?.();
    await flush();

    expect(onSignal).not.toHaveBeenCalled();
    expect(feed.listenerCount()).toBe(0);
  });
});

describe('ocrSource', () => {
  test('emits one signal per OCR line, in detection order, with per-line confidence', async () => {
    const feed = createFrameFeed();
    const onSignal = jest.fn();
    const source = createOcrSource(feed, {
      read: async () => ({
        blocks: [
          {
            lines: [
              {text: 'Vollmilch', confidence: 0.9},
              {text: '1 l', confidence: 0.7},
            ],
          },
        ],
      }),
    });
    await source.start(onSignal);

    feed.push(frame(0));
    await flush();

    expect(onSignal.mock.calls.map(([signal]) => signal)).toEqual([
      {source: 'ocr', text: 'Vollmilch', confidence: 0.9},
      {source: 'ocr', text: '1 l', confidence: 0.7},
    ]);
    await source.stop();
  });

  test('samples slower than the camera (800 ms default)', async () => {
    const feed = createFrameFeed();
    const {clock, advance} = mutableClock();
    const read = jest.fn(async () => ({text: 'Hafermilch'}));
    const onSignal = jest.fn();
    const source = createOcrSource(feed, {read, clock});
    await source.start(onSignal);

    feed.push(frame(0));
    await flush();
    advance(400);
    feed.push(frame(400));
    await flush();
    advance(400);
    feed.push(frame(800));
    await flush();

    expect(read).toHaveBeenCalledTimes(2);
    expect(source.skippedByGate()).toBe(1);
    // 800 ms apart is inside the 4 s line repeat window, so the second read emits nothing.
    expect(onSignal).toHaveBeenCalledTimes(1);
    await source.stop();
  });

  test('per-line repeat window: same words suppressed, changed line fires', async () => {
    const feed = createFrameFeed();
    const {clock, advance} = mutableClock();
    let lines = ['Vollmilch', '1 l'];
    const onSignal = jest.fn();
    const source = createOcrSource(feed, {
      read: async () => ({blocks: [{lines: lines.map(text => ({text}))}]}),
      clock,
    });
    await source.start(onSignal);

    feed.push(frame(0));
    await flush();
    expect(onSignal.mock.calls.map(([signal]) => signal.text)).toEqual([
      'Vollmilch',
      '1 l',
    ]);

    advance(800);
    feed.push(frame(800));
    await flush();
    expect(onSignal).toHaveBeenCalledTimes(2); // both lines repeat inside the window

    advance(800);
    lines = ['Vollmilch', '2 l'];
    feed.push(frame(1600));
    await flush();
    expect(onSignal.mock.calls.map(([signal]) => signal.text)).toEqual([
      'Vollmilch',
      '1 l',
      '2 l',
    ]);

    advance(2400); // 4000 ms after the first batch
    lines = ['Vollmilch', '1 l'];
    feed.push(frame(4000));
    await flush();
    expect(onSignal).toHaveBeenCalledTimes(5); // the full pair is re-emitted
    await source.stop();
  });

  test('caps a noisy frame at 16 line signals (RANK.md pool cap)', async () => {
    const feed = createFrameFeed();
    const onSignal = jest.fn();
    const source = createOcrSource(feed, {
      read: async () => ({
        blocks: [
          {
            lines: Array.from({length: 20}, (_, index) => ({
              text: `label ${index + 1}`,
            })),
          },
        ],
      }),
      clock: mutableClock().clock,
    });
    await source.start(onSignal);

    feed.push(frame(0));
    await flush();

    expect(onSignal).toHaveBeenCalledTimes(16);
    expect(onSignal.mock.calls[15][0].text).toBe('label 16');
    await source.stop();
  });

  test('short lines do not emit', async () => {
    const feed = createFrameFeed();
    const onSignal = jest.fn();
    const source = createOcrSource(feed, {read: async () => ({text: 'l'})});
    await source.start(onSignal);

    feed.push(frame(0));
    await flush();
    expect(onSignal).not.toHaveBeenCalled();
    await source.stop();
  });

  test('single-flight: frames during a slow read are dropped, not queued', async () => {
    const feed = createFrameFeed();
    let releaseRead: (() => void) | undefined;
    const read = jest.fn(
      () =>
        new Promise<{blocks: {lines: {text: string}[]}[]}>(resolve => {
          releaseRead = () =>
            resolve({blocks: [{lines: [{text: 'Vollmilch'}]}]});
        }),
    );
    const onSignal = jest.fn();
    const source = createOcrSource(feed, {
      read,
      clock: mutableClock().clock,
      minIntervalMs: 0,
    });
    await source.start(onSignal);

    feed.push(frame(0));
    feed.push(frame(400));
    feed.push(frame(800));
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(source.droppedWhileBusy()).toBe(2);

    releaseRead?.();
    await flush();
    expect(onSignal).toHaveBeenCalledTimes(1);
    await source.stop();
  });
});

describe('imageSource', () => {
  test('hands every frame to onImage and emits the image marker', async () => {
    const feed = createFrameFeed();
    const onImage = jest.fn();
    const onSignal = jest.fn();
    const source = createImageSource(feed, {onImage});
    await source.start(onSignal);

    const captured = frame(0);
    feed.push(captured);
    await flush();

    expect(onImage).toHaveBeenCalledWith(captured);
    expect(onSignal).toHaveBeenCalledWith({
      source: 'image',
      text: IMAGE_QUERY_MARKER,
      confidence: 1,
    });
    await source.stop();
  });

  test('awaits an async onImage (embedder) before emitting', async () => {
    const feed = createFrameFeed();
    const order: string[] = [];
    const source = createImageSource(feed, {
      onImage: async () => {
        await Promise.resolve();
        order.push('embedded');
      },
    });
    await source.start(signal => {
      order.push(signal.text);
    });

    feed.push(frame(0));
    await flush();
    expect(order).toEqual(['embedded', IMAGE_QUERY_MARKER]);
    await source.stop();
  });

  test('a failing embedder is reported and the chip still lights', async () => {
    const feed = createFrameFeed();
    const onError = jest.fn();
    const onSignal = jest.fn();
    const source = createImageSource(feed, {
      onImage: () => {
        throw new Error('no model');
      },
      onError,
    });
    await source.start(onSignal);

    feed.push(frame(0));
    await flush();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({message: 'no model'}),
    );
    expect(onSignal).not.toHaveBeenCalled();
    await source.stop();
  });
});

describe('createScanSources + pipeline', () => {
  test('one frame feeds barcode, OCR and image', async () => {
    const feed = createFrameFeed();
    const onImage = jest.fn();
    const {sources} = createScanSources(feed, {
      readers: {
        readBarcodes: async () => ({
          barcodes: [{rawValue: '4008400409327', formatName: 'EAN_13'}],
        }),
        readText: async () => ({text: 'Vollmilch 1 l'}),
      },
      onImage,
    });
    const pipeline = createScanPipeline(sources);
    const signals: string[] = [];

    await pipeline.start(signal => signals.push(signal.source));
    expect(pipeline.isRunning()).toBe(true);

    feed.push(frame(0));
    await flush();

    expect(signals.sort()).toEqual(['barcode', 'image', 'ocr']);
    expect(onImage).toHaveBeenCalledTimes(1);

    await pipeline.stop();
    expect(pipeline.isRunning()).toBe(false);
    expect(feed.listenerCount()).toBe(0);
  });

  test('createScanSources defaults to console.warn for reader errors', async () => {
    const feed = createFrameFeed();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const {sources} = createScanSources(feed, {
      readers: {
        readBarcodes: async () => {
          throw new Error('barcode reader broke');
        },
        readText: async () => ({text: 'ok'}),
      },
    });
    const pipeline = createScanPipeline(sources);
    await pipeline.start(() => {});

    feed.push(frame(0));
    await flush();

    expect(warn).toHaveBeenCalledWith(
      '[scan] source error',
      expect.objectContaining({message: 'barcode reader broke'}),
    );
    warn.mockRestore();
    await pipeline.stop();
  });
});
