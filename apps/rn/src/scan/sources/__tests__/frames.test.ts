/**
 * Card A4/A6 — frame feed fan-out and the temp-JPEG release lifecycle.
 */
import {DEFAULT_FRAME_RELEASE_GRACE_MS, createFrameFeed} from '../frames';
import type {CameraFrame} from '../types';

const frame: CameraFrame = {
  jpegBase64: 'Zm9v',
  filePath: '/tmp/photo-1.jpg',
  width: 720,
  height: 1280,
  capturedAt: 1000,
};

describe('createFrameFeed', () => {
  test('delivers a frame to every subscriber and counts them', () => {
    const feed = createFrameFeed();
    const a = jest.fn();
    const b = jest.fn();

    const unsubscribeA = feed.subscribe(a);
    feed.subscribe(b);
    expect(feed.listenerCount()).toBe(2);

    feed.push(frame);
    expect(a).toHaveBeenCalledWith(frame);
    expect(b).toHaveBeenCalledWith(frame);

    unsubscribeA();
    unsubscribeA(); // idempotent
    expect(feed.listenerCount()).toBe(1);

    feed.push(frame);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  test('a throwing listener does not break the others', () => {
    const onListenerError = jest.fn();
    const feed = createFrameFeed({onListenerError});
    const good = jest.fn();

    feed.subscribe(() => {
      throw new Error('boom');
    });
    feed.subscribe(good);

    expect(() => feed.push(frame)).not.toThrow();
    expect(good).toHaveBeenCalledWith(frame);
    expect(onListenerError).toHaveBeenCalledWith(
      expect.objectContaining({message: 'boom'}),
    );
  });

  test('unsubscribing during delivery does not skip the next listener', () => {
    const feed = createFrameFeed();
    const second = jest.fn();
    let unsubscribeFirst = () => {};

    unsubscribeFirst = feed.subscribe(() => unsubscribeFirst());
    feed.subscribe(second);

    feed.push(frame);
    expect(second).toHaveBeenCalledWith(frame);
    expect(feed.listenerCount()).toBe(1);
  });
});

describe('temp-file release lifecycle (card A6)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('a frame with release() stays readable for the grace, then deletes exactly once', () => {
    jest.useFakeTimers();
    const feed = createFrameFeed();
    const release = jest.fn();
    feed.subscribe(() => {});

    feed.push({...frame, release});
    expect(feed.pendingReleases()).toBe(1);
    expect(release).not.toHaveBeenCalled();

    jest.advanceTimersByTime(DEFAULT_FRAME_RELEASE_GRACE_MS - 1);
    expect(release).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(feed.pendingReleases()).toBe(0);

    // Nothing re-releases a frame whose grace already elapsed.
    jest.runOnlyPendingTimers();
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('frames without a release hook are never pending', () => {
    jest.useFakeTimers();
    const feed = createFrameFeed();
    feed.push(frame);
    expect(feed.pendingReleases()).toBe(0);
    jest.runOnlyPendingTimers();
  });

  test('releaseAll() deletes everything now and clears the scheduled timers', () => {
    jest.useFakeTimers();
    const feed = createFrameFeed({releaseGraceMs: 60_000});
    const first = jest.fn();
    const second = jest.fn();

    feed.push({...frame, release: first});
    feed.push({...frame, filePath: '/tmp/photo-2.jpg', release: second});
    expect(feed.pendingReleases()).toBe(2);

    feed.releaseAll();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(feed.pendingReleases()).toBe(0);

    // Idempotent: a second call (camera stop after unmount) deletes nothing twice.
    feed.releaseAll();
    jest.runOnlyPendingTimers();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('a release that throws or rejects cannot break the feed or surface a rejection', async () => {
    jest.useFakeTimers();
    const feed = createFrameFeed();

    feed.push({
      ...frame,
      release: () => {
        throw new Error('delete failed');
      },
    });
    feed.push({
      ...frame,
      filePath: '/tmp/photo-2.jpg',
      release: async () => {
        throw new Error('async delete failed');
      },
    });

    expect(() => feed.releaseAll()).not.toThrow();
    await Promise.resolve();
    expect(feed.pendingReleases()).toBe(0);
  });

  test('the grace period is configurable and used for the scheduled delete', () => {
    const setTimer = jest.fn(() => 'handle');
    const clearTimer = jest.fn();
    const feed = createFrameFeed({releaseGraceMs: 1234, setTimer, clearTimer});
    const release = jest.fn();

    feed.push({...frame, release});
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 1234);

    feed.releaseAll();
    expect(clearTimer).toHaveBeenCalledWith('handle');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
