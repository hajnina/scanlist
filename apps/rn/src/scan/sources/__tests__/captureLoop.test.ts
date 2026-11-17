/**
 * Card A4 — the ~2.5 fps capture loop (VisionCamera v5 has no built-in throttle).
 */
import {createCaptureLoop, DEFAULT_FRAME_INTERVAL_MS} from '../captureLoop';
import type {CameraFrame} from '../types';

function makeFrame(capturedAt: number): CameraFrame {
  return {
    jpegBase64: 'Zm9v',
    filePath: `/tmp/photo-${capturedAt}.jpg`,
    width: 720,
    height: 1280,
    capturedAt,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('samples at the configured interval (default 400 ms ≈ 2.5 fps)', async () => {
  const capture = jest.fn(async () => makeFrame(1));
  const onFrame = jest.fn();
  const loop = createCaptureLoop({capture, onFrame});

  expect(DEFAULT_FRAME_INTERVAL_MS).toBe(400);
  loop.start();
  expect(loop.isRunning()).toBe(true);

  await jest.advanceTimersByTimeAsync(0);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(onFrame).toHaveBeenCalledTimes(1);

  await jest.advanceTimersByTimeAsync(399);
  expect(capture).toHaveBeenCalledTimes(1);

  await jest.advanceTimersByTimeAsync(1);
  expect(capture).toHaveBeenCalledTimes(2);

  await jest.advanceTimersByTimeAsync(800);
  expect(capture).toHaveBeenCalledTimes(4);

  loop.stop();
  expect(loop.isRunning()).toBe(false);
});

test('stop() cancels the pending timer', async () => {
  const capture = jest.fn(async () => makeFrame(1));
  const loop = createCaptureLoop({capture, onFrame: jest.fn()});

  loop.start();
  await jest.advanceTimersByTimeAsync(0);
  loop.stop();

  await jest.advanceTimersByTimeAsync(5000);
  expect(capture).toHaveBeenCalledTimes(1);
});

test('start() is idempotent and restartable', async () => {
  const capture = jest.fn(async () => makeFrame(1));
  const loop = createCaptureLoop({capture, onFrame: jest.fn()});

  loop.start();
  loop.start();
  await jest.advanceTimersByTimeAsync(0);
  expect(capture).toHaveBeenCalledTimes(1);

  loop.stop();
  await jest.advanceTimersByTimeAsync(1000);
  loop.start();
  await jest.advanceTimersByTimeAsync(0);
  expect(capture).toHaveBeenCalledTimes(2);
  loop.stop();
});

test('a failed capture is reported and the loop keeps going', async () => {
  const capture = jest
    .fn()
    .mockRejectedValueOnce(new Error('camera busy'))
    .mockResolvedValue(makeFrame(2));
  const onFrame = jest.fn();
  const onError = jest.fn();
  const loop = createCaptureLoop({capture, onFrame, onError});

  loop.start();
  await jest.advanceTimersByTimeAsync(0);
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({message: 'camera busy'}),
  );
  expect(onFrame).not.toHaveBeenCalled();

  await jest.advanceTimersByTimeAsync(400);
  expect(capture).toHaveBeenCalledTimes(2);
  expect(onFrame).toHaveBeenCalledTimes(1);

  loop.stop();
});

test('a throwing onFrame handler is reported, not fatal', async () => {
  const onError = jest.fn();
  const loop = createCaptureLoop({
    capture: async () => makeFrame(1),
    onFrame: () => {
      throw new Error('listener exploded');
    },
    onError,
  });

  loop.start();
  await jest.advanceTimersByTimeAsync(0);
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({message: 'listener exploded'}),
  );

  await jest.advanceTimersByTimeAsync(400);
  expect(onError).toHaveBeenCalledTimes(2);
  loop.stop();
});

test('a slow capture never overlaps and lowers the effective rate', async () => {
  let resolveCapture: ((frame: CameraFrame) => void) | undefined;
  const capture = jest.fn(
    () =>
      new Promise<CameraFrame>(resolve => {
        resolveCapture = resolve;
      }),
  );
  const loop = createCaptureLoop({capture, onFrame: jest.fn()});

  loop.start();
  await jest.advanceTimersByTimeAsync(0);
  expect(capture).toHaveBeenCalledTimes(1);

  // Time passes while the first capture is still in flight — no second capture is started.
  await jest.advanceTimersByTimeAsync(2000);
  expect(capture).toHaveBeenCalledTimes(1);

  resolveCapture?.(makeFrame(3));
  await jest.advanceTimersByTimeAsync(0);
  await jest.advanceTimersByTimeAsync(400);
  expect(capture).toHaveBeenCalledTimes(2);

  loop.stop();
});

test('rejects an invalid interval', () => {
  expect(() =>
    createCaptureLoop({
      capture: async () => makeFrame(1),
      onFrame: jest.fn(),
      intervalMs: -5,
    }),
  ).toThrow(/>= 0/);
});
