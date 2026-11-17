/**
 * Card A4 — frame feed fan-out.
 */
import {createFrameFeed} from '../frames';
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
