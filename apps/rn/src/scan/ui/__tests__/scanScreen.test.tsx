/**
 * Card A6 review fix — the scan screen's guidance wiring, not just the pure copy:
 *  - `modelMissing` must be derived from the bridge and passed to `scanGuidance` (the note renders
 *    only when the bundle is actually missing), and
 *  - the quiet clock must be live (covered in `src/settings/__tests__/polish.test.ts`).
 *
 * VisionCamera, ML Kit and the embed bridge are mocked; the screen and both hooks are real.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {ScanListThemeProvider} from '../../../theme';
import {ListRepository, MemoryKeyValueStore} from '../../../list/store';
import {ScanScreen} from '../ScanScreen';
import {embedStatus} from '../../../../modules/embed';

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
    usePhotoOutput: () => ({capturePhoto: jest.fn()}),
  };
});

jest.mock('../../sources/native', () => ({
  createMlKitReaders: () => ({
    readBarcodes: async () => ({barcodes: []}),
    readText: async () => ({blocks: []}),
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

describe('ScanScreen guidance wiring', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('a missing bundle renders the model note on the scan screen', async () => {
    (embedStatus as jest.Mock).mockResolvedValue({
      modelPresent: false,
      modelPath: '/data/user/0/dev.hajnina.scanlist.rn/files/models/x.litertlm',
      modelBytes: 0,
      modelReadable: false,
      modelSha256: 'e7a8a2204b',
    });

    const tree = await mount();
    expect(JSON.stringify(tree.toJSON())).toContain(
      'No embedding model on this phone',
    );

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
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
    expect(JSON.stringify(tree.toJSON())).not.toContain(
      'No embedding model on this phone',
    );

    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  });
});
