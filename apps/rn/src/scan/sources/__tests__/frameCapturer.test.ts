/**
 * Card A4 — VisionCamera Photo → CameraFrame (injected fake output; no native modules).
 */
import {createFrameCapturer, type PhotoLike, type PhotoOutputLike} from '../frameCapturer';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb]).buffer;

function fakePhoto(overrides: Partial<PhotoLike> = {}): PhotoLike {
  return {
    width: 720,
    height: 1280,
    timestamp: 12.5,
    getFileDataAsync: async () => JPEG,
    saveToTemporaryFileAsync: async () => '/data/user/0/dev.hajnina.scanlist.rn/cache/photo-1.jpg',
    dispose: jest.fn(),
    ...overrides,
  };
}

function fakeOutput(photo: PhotoLike): PhotoOutputLike & {capturePhoto: jest.Mock} {
  return {capturePhoto: jest.fn(async () => photo)};
}

describe('createFrameCapturer', () => {
  test('captures one JPEG frame with bytes, path, size and timestamp', async () => {
    const photo = fakePhoto();
    const output = fakeOutput(photo);
    const capture = createFrameCapturer(output);

    const frame = await capture();

    expect(output.capturePhoto).toHaveBeenCalledWith(
      {flashMode: 'off', enableShutterSound: false},
      {},
    );
    expect(frame).toEqual({
      jpegBase64: '/9j/2w==',
      filePath: '/data/user/0/dev.hajnina.scanlist.rn/cache/photo-1.jpg',
      width: 720,
      height: 1280,
      capturedAt: 12500,
    });
    expect(photo.dispose).toHaveBeenCalledTimes(1);
  });

  test('disposes the photo even when reading the bytes fails', async () => {
    const photo = fakePhoto({
      getFileDataAsync: async () => {
        throw new Error('photo already closed');
      },
    });
    const capture = createFrameCapturer(fakeOutput(photo));

    await expect(capture()).rejects.toThrow('photo already closed');
    expect(photo.dispose).toHaveBeenCalledTimes(1);
  });

  test('falls back to now() when the native timestamp is missing', async () => {
    const photo = fakePhoto({timestamp: 0});
    const capture = createFrameCapturer(fakeOutput(photo), {now: () => 4242});

    expect((await capture()).capturedAt).toBe(4242);
  });
});
