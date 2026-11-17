/**
 * Contract tests for `modules/embed` (card A3). The native side is mocked: what is verified here is the
 * JS wrapper — resolved shapes, base64 → Float32Array decoding, the `Embedder` contract fields, and
 * error propagation by `code`. The Kotlin side is compiled by `assembleDebug` (CI, x86_64 runner).
 */
/* eslint-disable no-bitwise -- the test encoder mirrors EmbedVectors.kt bit for bit. */
import {
  DEFAULT_DIMS,
  DEFAULT_MODEL_ID,
  EMBED_ERROR,
  EmbedError,
  base64ToBytes,
  base64ToFloat32,
  closeEmbed,
  embedDocs,
  embedImage,
  embedQuery,
  embedStatus,
  embedder,
  resetEmbedStateForTests,
} from '../index';
import {getNativeEmbed, nativeEmbedConstants} from '../NativeEmbed';
import type {NativeEmbedModule} from '../NativeEmbed';

jest.mock('../NativeEmbed', () => ({
  getNativeEmbed: jest.fn(),
  nativeEmbedConstants: jest.fn(),
  resetNativeEmbedCache: jest.fn(),
}));

const mockedGetNative = getNativeEmbed as jest.MockedFunction<
  typeof getNativeEmbed
>;
const mockedConstants = nativeEmbedConstants as jest.MockedFunction<
  typeof nativeEmbedConstants
>;

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Test-side encoder: float32 little-endian + standard base64 (what `EmbedVectors.kt` writes). */
function encodeFloats(vector: number[]): string {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => view.setFloat32(index * 4, value, true));
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index];
    const b1 = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const b2 = index + 2 < bytes.length ? bytes[index + 2] : 0;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += index + 1 < bytes.length ? ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += index + 2 < bytes.length ? ALPHABET[b2 & 0x3f] : '=';
  }
  return out;
}

function fakeNative(overrides: Partial<NativeEmbedModule> = {}): NativeEmbedModule {
  return {
    getConstants: () => ({
      name: 'android-embed',
      modelId: DEFAULT_MODEL_ID,
      dims: 4,
      backend: 'none',
      modelFile: 'embeddinggemma-2-740m.litertlm',
      modelPresent: true,
      supportsImages: false,
      linked: true,
    }),
    embedDocs: jest.fn(async (texts: string[]) => ({
      vectors: texts.map(() => encodeFloats([0.5, -0.25, 0.125, 0])),
      dims: 4,
      backend: 'cpu',
      latencyMs: 42,
      openMs: 1200,
    })),
    embedQuery: jest.fn(async () => ({
      vector: encodeFloats([1, 0, 0, 0]),
      dims: 4,
      backend: 'gpu',
      latencyMs: 7,
      openMs: 0,
    })),
    embedImage: jest.fn(async () => ({
      vector: encodeFloats([0, 1, 0, 0]),
      dims: 4,
      backend: 'gpu',
      latencyMs: 11,
      openMs: 0,
    })),
    status: jest.fn(async () => ({
      backend: 'cpu',
      dims: 4,
      supportsImages: false,
      modelId: DEFAULT_MODEL_ID,
      modelPresent: true,
      modelPath: '/data/user/0/dev.hajnina.scanlist.rn/files/models/x.litertlm',
      modelFile: 'embeddinggemma-2-740m.litertlm',
      open: true,
      hint: 'scripts/model.sh push dev.hajnina.scanlist.rn',
    })),
    close: jest.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetEmbedStateForTests();
  mockedConstants.mockReturnValue(null); // not linked unless a test says so
});

describe('base64 vector decoding', () => {
  test('decodes float32 little-endian', () => {
    const vector = base64ToFloat32(encodeFloats([1.5, -0.25, 0, 1024.5]));
    expect(Array.from(vector)).toEqual([1.5, -0.25, 0, 1024.5]);
  });

  test('reads the bytes little-endian (0x3F800000 is 1.0)', () => {
    expect(Array.from(base64ToFloat32('AACAPw=='))).toEqual([1]);
  });

  test('rejects a character outside the alphabet', () => {
    expect(() => base64ToFloat32('AACAPw$=')).toThrow(EmbedError);
    try {
      base64ToBytes('!!!!');
    } catch (error) {
      expect((error as EmbedError).code).toBe(EMBED_ERROR.codec);
    }
  });

  test('rejects a byte length that is not float32', () => {
    // 6 zero bytes: a valid base64 string that is not a whole number of float32s.
    expect(() => base64ToFloat32('AAAAAAAA')).toThrow(/multiple of 4/);
  });
});

describe('embedDocs', () => {
  test('resolves vectors + backend + dims + latency', async () => {
    mockedGetNative.mockReturnValue(fakeNative());

    const result = await embedDocs(['milk', 'bread']);

    expect(result.backend).toBe('cpu');
    expect(result.dims).toBe(4);
    expect(result.latencyMs).toBe(42);
    expect(result.openMs).toBe(1200);
    expect(result.vectors).toEqual([
      [0.5, -0.25, 0.125, 0],
      [0.5, -0.25, 0.125, 0],
    ]);
  });

  test('rejects with the native code (missing model is the expected state)', async () => {
    const failure = Object.assign(new Error('no embeddinggemma-2-740m.litertlm'), {
      code: EMBED_ERROR.modelMissing,
    });
    mockedGetNative.mockReturnValue(
      fakeNative({embedDocs: jest.fn(async () => Promise.reject(failure))}),
    );

    await expect(embedDocs(['milk'])).rejects.toMatchObject({
      name: 'EmbedError',
      code: 'E_MODEL_MISSING',
      message: 'no embeddinggemma-2-740m.litertlm',
    });
  });

  test('rejects with E_NO_MODULE when the native module is not linked', async () => {
    mockedGetNative.mockReturnValue(null);

    await expect(embedDocs(['milk'])).rejects.toMatchObject({
      code: EMBED_ERROR.noModule,
    });
  });
});

describe('embedQuery / embedImage', () => {
  test('embedQuery resolves one vector', async () => {
    const native = fakeNative();
    mockedGetNative.mockReturnValue(native);

    const result = await embedQuery('oat milk');

    expect(native.embedQuery).toHaveBeenCalledWith('oat milk');
    expect(result.vector).toEqual([1, 0, 0, 0]);
    expect(result.backend).toBe('gpu');
  });

  test('embedImage passes {base64} and {uri} to the right native argument', async () => {
    const native = fakeNative();
    mockedGetNative.mockReturnValue(native);

    await embedImage({base64: 'AAECAw=='});
    expect(native.embedImage).toHaveBeenLastCalledWith('AAECAw==', null);

    await embedImage({uri: 'file:///tmp/frame.jpg'});
    expect(native.embedImage).toHaveBeenLastCalledWith(
      null,
      'file:///tmp/frame.jpg',
    );
  });

  test('embedImage rejects inputs with neither or both', async () => {
    mockedGetNative.mockReturnValue(fakeNative());

    await expect(embedImage({} as {base64: string})).rejects.toMatchObject({
      code: EMBED_ERROR.input,
    });
    await expect(
      embedImage({base64: 'AA==', uri: 'file:///x.jpg'}),
    ).rejects.toMatchObject({code: EMBED_ERROR.input});
  });
});

describe('status', () => {
  test('reports the native state', async () => {
    mockedGetNative.mockReturnValue(fakeNative());

    const status = await embedStatus();

    expect(status).toMatchObject({
      linked: true,
      backend: 'cpu',
      dims: 4,
      modelPresent: true,
      open: true,
    });
  });

  test('is graceful without the native module', async () => {
    mockedGetNative.mockReturnValue(null);

    const status = await embedStatus();

    expect(status.linked).toBe(false);
    expect(status.backend).toBe('none');
    expect(status.dims).toBe(DEFAULT_DIMS);
    expect(status.modelPresent).toBe(false);
  });

  test('closeEmbed calls the native close', async () => {
    const native = fakeNative();
    mockedGetNative.mockReturnValue(native);

    await closeEmbed();

    expect(native.close).toHaveBeenCalledTimes(1);
  });
});

describe('the Embedder contract (docs/ARCHITECTURE.md)', () => {
  test('name/backend/dims and the three embed methods', async () => {
    mockedGetNative.mockReturnValue(fakeNative());

    expect(embedder.name).toBe('android-embed');
    expect(embedder.backend).toBe('none'); // before any call
    expect(embedder.dims).toBe(DEFAULT_DIMS); // no constants, no call yet

    const vectors = await embedder.embedDocs(['milk', 'bread']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual([0.5, -0.25, 0.125, 0]);
    // the first successful call updates the sync fields
    expect(embedder.backend).toBe('cpu');
    expect(embedder.dims).toBe(4);

    await expect(embedder.embedQuery('oat milk')).resolves.toEqual([
      1, 0, 0, 0,
    ]);
    await expect(embedder.embedImage({uri: 'file:///x.jpg'})).resolves.toEqual([
      0, 1, 0, 0,
    ]);
  });
});
