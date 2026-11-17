/**
 * Card A6 review fix — the scan screen's guidance wiring, not just the pure copy:
 *  - `modelMissing` is derived from the bridge and passed to `scanGuidance` (the note renders only
 *    when the bundle is actually missing);
 *  - the quiet clock is driven by the **live** pipeline: the real camera hook, frame feed, sources
 *    and rank engine run over a fake VisionCamera/ML Kit/embedder, so the tests can see that frames
 *    (one marker every 400 ms) do not count as "something found" while barcode/OCR/hero do.
 *
 * VisionCamera, ML Kit and the embed bridge are mocked; the screen, hooks, capture loop, sources,
 * pool and ranker are the real code.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {ScanListThemeProvider} from '../../../theme';
import {ListRepository, MemoryKeyValueStore} from '../../../list/store';
import {ScanScreen} from '../ScanScreen';
import {embedStatus, embedder} from '../../../../modules/embed';

let mockReadBarcodes: jest.Mock;
let mockReadText: jest.Mock;
let mockPhotoOutput: {capturePhoto: jest.Mock; currentResolution?: unknown};

jest.mock('react-native-vision-camera', () => {
  const ReactModule = require('react');
  return {
    Camera: (props: Record<string, unknown>) =>
      ReactModule.createElement('Camera', props),
    CommonResolutions: {HD_16_9: {width: 1280, height: 720}},
    useCameraPermission: () => ({
      hasPermission: true,
      canRequestPermission: false,
      status: 'granted',
      requestPermission: jest.fn(async () => true),
    }),
    usePhotoOutput: () => mockPhotoOutput,
  };
});

jest.mock('../../sources/native', () => ({
  createMlKitReaders: () => ({
    readBarcodes: (...args: unknown[]) => mockReadBarcodes(...args),
    readText: (...args: unknown[]) => mockReadText(...args),
  }),
}));

jest.mock('../../../../modules/embed', () => ({
  embedder: {
    name: 'android-embed',
    backend: 'cpu',
    dims: 256,
    embedDocs: jest.fn(async () => []),
    embedQuery: jest.fn(async () => []),
    embedImage: jest.fn(async () => []),
  },
  embedStatus: jest.fn(),
  deleteTempFile: jest.fn(async () => ({deleted: true})),
}));

const DIMS = 256;
/** A 256-d unit vector; vectors on different axes are orthogonal, i.e. similarity 0. */
function unitVector(axis: number): number[] {
  const vector = new Array<number>(DIMS).fill(0);
  vector[axis] = 1;
  return vector;
}

async function storedList() {
  const repository = new ListRepository(new MemoryKeyValueStore(), () => 1);
  const result = await repository.importText(
    JSON.stringify({
      title: 'Corner shop',
      sections: [{name: 'Tonight', items: [{name: 'Milk'}]}],
    }),
  );
  if (!result.ok) {
    throw new Error(result.errors.join('; '));
  }
  return {repository, stored: result.stored};
}

async function mount() {
  const {repository, stored} = await storedList();
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <ScanListThemeProvider>
        <ScanScreen
          repository={repository}
          stored={stored}
          onBack={() => undefined}
          onChanged={() => undefined}
        />
      </ScanListThemeProvider>,
    );
  });
  // The model probe and the async pipeline start settle off the first render.
  await ReactTestRenderer.act(async () => {});
  await ReactTestRenderer.act(async () => {});
  return tree!;
}

async function unmount(tree: ReactTestRenderer.ReactTestRenderer) {
  await ReactTestRenderer.act(async () => {
    tree.unmount();
  });
}

/** Let the capture → feed → ML Kit → embed → tick promise chain settle. */
async function flush() {
  for (let index = 0; index < 50; index += 1) {
    await Promise.resolve();
  }
}

/** One camera interval: fire timers, then let the async pipeline settle. */
async function step(ms = 400) {
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(ms);
    await flush();
  });
}

const textOf = (tree: ReactTestRenderer.ReactTestRenderer) =>
  JSON.stringify(tree.toJSON());

const embed = embedder as unknown as {
  embedDocs: jest.Mock;
  embedQuery: jest.Mock;
  embedImage: jest.Mock;
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(20_000);
  (embedStatus as jest.Mock).mockReset().mockResolvedValue({
    modelPresent: true,
    modelPath: '/data/user/0/dev.hajnina.scanlist.rn/files/models/x.litertlm',
    modelBytes: 484_622_336,
    modelReadable: true,
    modelSha256: 'e7a8a2204b',
  });

  mockReadBarcodes = jest.fn(async () => ({barcodes: []}));
  mockReadText = jest.fn(async () => ({blocks: []}));

  let photo = 0;
  mockPhotoOutput = {
    capturePhoto: jest.fn(async () => {
      photo += 1;
      return {
        width: 1280,
        height: 720,
        timestamp: Date.now() / 1000,
        getFileDataAsync: async () =>
          new Uint8Array([0xff, 0xd8, 0xff, 0xdb]).buffer,
        saveToTemporaryFileAsync: async () => `/cache/photo-${photo}.jpg`,
        dispose: jest.fn(),
      };
    }),
  };

  // Item text on axis 0; image frames on axis 1 (similarity 0, so frames alone never make a hero).
  embed.embedDocs
    .mockReset()
    .mockImplementation(async (texts: string[]) => texts.map(() => unitVector(0)));
  embed.embedQuery.mockReset().mockImplementation(async () => unitVector(0));
  embed.embedImage.mockReset().mockImplementation(async () => unitVector(1));
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('ScanScreen guidance wiring', () => {
  test('a missing bundle renders the model note on the scan screen', async () => {
    (embedStatus as jest.Mock).mockResolvedValue({
      modelPresent: false,
      modelPath: '/data/user/0/dev.hajnina.scanlist.rn/files/models/x.litertlm',
      modelBytes: 0,
      modelReadable: false,
      modelSha256: 'e7a8a2204b',
    });

    const tree = await mount();
    expect(textOf(tree)).toContain('No embedding model on this phone');

    await unmount(tree);
  });

  test('a present bundle does not show the model note', async () => {
    (embedStatus as jest.Mock).mockResolvedValue({
      modelPresent: true,
      modelPath: '/data/user/0/dev.hajnina.scanlist.rn/files/models/x.litertlm',
      modelBytes: 484_622_336,
      modelReadable: true,
      modelSha256: 'e7a8a2204b',
    });

    const tree = await mount();
    expect(textOf(tree)).not.toContain('No embedding model on this phone');

    await unmount(tree);
  });

  test('a live feed with no useful result shows the low-light advice after 6 s', async () => {
    const tree = await mount();
    expect(textOf(tree)).not.toContain('Nothing in frame yet');

    // ~8 s of real 2.5 fps frames with empty barcode/OCR and an orthogonal image vector:
    // the camera is delivering, but nothing useful is found.
    for (let index = 0; index < 20; index += 1) {
      await step();
    }

    expect(textOf(tree)).toContain('Nothing in frame yet');

    await unmount(tree);
  });

  test('a detected OCR line (and its hero) keeps the advice away while frames flow', async () => {
    mockReadText.mockImplementation(async () => ({
      blocks: [{lines: [{text: 'Milk', confidence: 0.95}]}],
    }));

    const tree = await mount();

    // Run past the threshold; the OCR source re-emits the line every 4 s, and each tick while a
    // query is present ranks the item as hero — either way, the scene is yielding something useful.
    let sawOcrLine = false;
    for (let index = 0; index < 20; index += 1) {
      await step();
      if (textOf(tree).includes('1 line')) {
        sawOcrLine = true;
      }
      if (index >= 14) {
        expect(textOf(tree)).not.toContain('Nothing in frame yet');
      }
    }
    // The negative assertion above is only meaningful if OCR actually reached the pool.
    expect(sawOcrLine).toBe(true);

    await unmount(tree);
  });

  test('the __DEV__ diagnostics footer is rendered (card A6 nit h)', async () => {
    const tree = await mount();
    await step();

    expect(textOf(tree)).toContain('3 feed listeners');
    expect(textOf(tree)).toContain('temp files');

    await unmount(tree);
  });
});
