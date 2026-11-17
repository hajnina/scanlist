/**
 * The dev screen of card A3, rendered against a mocked native module: it must print backend + dims +
 * latency + vector components, and it must show the missing-model state as a card instead of crashing.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {ScanListThemeProvider} from '../../theme';
import {EmbedSelfTestScreen} from '../EmbedSelfTestScreen';
import {getNativeEmbed} from '../../../modules/embed/NativeEmbed';
import type {NativeEmbedModule} from '../../../modules/embed/NativeEmbed';

jest.mock('../../../modules/embed/NativeEmbed', () => ({
  getNativeEmbed: jest.fn(),
  nativeEmbedConstants: jest.fn(() => null),
  resetNativeEmbedCache: jest.fn(),
}));

const mockedGetNative = getNativeEmbed as jest.MockedFunction<
  typeof getNativeEmbed
>;

/** float32 1.5 and -0.25 as little-endian bytes: 00 00 C0 3F 00 00 80 BE. */
const FLOAT32_1_5_MINUS_0_25 = 'AADAPwAAgL4=';

function screen(): React.ReactElement {
  return (
    <ScanListThemeProvider>
      <EmbedSelfTestScreen onClose={() => {}} />
    </ScanListThemeProvider>
  );
}

async function settle(
  tree: ReactTestRenderer.ReactTestRenderer,
): Promise<string> {
  await ReactTestRenderer.act(async () => {});
  await ReactTestRenderer.act(async () => {});
  return JSON.stringify(tree.toJSON());
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('prints backend, dims, latency and the first vector components', async () => {
  const native: NativeEmbedModule = {
    getConstants: () => ({
      name: 'android-embed',
      modelId: 'embeddinggemma-2-740m',
      dims: 2,
      backend: 'none',
      modelFile: 'embeddinggemma-2-740m.litertlm',
      modelPresent: true,
      supportsImages: false,
      linked: true,
    }),
    embedDocs: jest.fn(async (texts: string[]) => ({
      vectors: texts.map(() => FLOAT32_1_5_MINUS_0_25),
      dims: 2,
      backend: 'cpu',
      latencyMs: 42,
      openMs: 1200,
    })),
    embedQuery: jest.fn(),
    embedImage: jest.fn(),
    status: jest.fn(async () => ({
      backend: 'cpu',
      dims: 2,
      supportsImages: false,
      modelId: 'embeddinggemma-2-740m',
      modelPresent: true,
      modelPath: '/data/user/0/dev.hajnina.scanlist.rn/files/models/m.litertlm',
      modelFile: 'embeddinggemma-2-740m.litertlm',
      open: true,
      hint: 'scripts/model.sh push dev.hajnina.scanlist.rn',
    })),
    close: jest.fn(async () => undefined),
  };
  mockedGetNative.mockReturnValue(native);

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(screen());
  });
  const json = await settle(tree!);

  expect(json).toContain('Backend');
  expect(json).toContain('CPU');
  expect(json).toContain('dims 2');
  expect(json).toContain('42 ms');
  expect(json).toContain('model open 1200 ms');
  expect(json).toContain('1.5000, -0.2500');
  expect(json).toContain('sourdough bread');

  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
});

test('shows the missing-model state as a hint, not a crash', async () => {
  const missing = Object.assign(
    new Error('no embeddinggemma-2-740m.litertlm in /data/user/0/.../files/models'),
    {code: 'E_MODEL_MISSING'},
  );
  const native = {
    getConstants: () => null,
    embedDocs: jest.fn(async () => Promise.reject(missing)),
    embedQuery: jest.fn(),
    embedImage: jest.fn(),
    status: jest.fn(async () => ({
      backend: 'none',
      dims: 256,
      supportsImages: false,
      modelId: 'embeddinggemma-2-740m',
      modelPresent: false,
      modelPath: '/data/user/0/.../files/models/embeddinggemma-2-740m.litertlm',
      modelFile: 'embeddinggemma-2-740m.litertlm',
      open: false,
      hint: 'scripts/model.sh push dev.hajnina.scanlist.rn',
    })),
    close: jest.fn(async () => undefined),
  };
  mockedGetNative.mockReturnValue(native as unknown as NativeEmbedModule);

  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(screen());
  });
  const json = await settle(tree!);

  expect(json).toContain('E_MODEL_MISSING');
  expect(json).toContain('scripts/model.sh push dev.hajnina.scanlist.rn');
  expect(json).toContain('NONE');

  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
});
