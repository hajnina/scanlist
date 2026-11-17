/**
 * Card C4 cadence amendment: exactly one image POST in flight, newest frame wins.
 *
 * C3 measured 6.4–11.9 s per server-side image embedding, so a 2.5 fps uploader would queue ~20
 * requests and every result would be stale. These tests drive a fake embedder with deferred
 * promises and assert the queue never stacks and always ships the freshest frame.
 */

import { describe, expect, it, vi } from 'vitest';

import { IMAGE_QUERY_MARKER, type CapturedFrame, type ImageEmbedding } from '../types';
import { createFrameUploader, imageSignal } from '../uploader';

function frame(capturedAt: number): CapturedFrame {
  return {
    jpeg: new Blob([new Uint8Array(32)], { type: 'image/jpeg' }),
    width: 384,
    height: 288,
    capturedAt,
  };
}

function embedding(): ImageEmbedding {
  return { vector: [1, 0, 0], dims: 3, embedMs: 7200, backend: 'fake', model: 'fake-256' };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('frame uploader', () => {
  it('sends immediately when idle and reports the frame timestamp with the result', async () => {
    const results: Array<{ frame: CapturedFrame; embedding: ImageEmbedding }> = [];
    const embed = vi.fn(async () => embedding());
    const uploader = createFrameUploader({ embed, onResult: (result) => results.push(result) });

    uploader.submit(frame(1000));
    await uploader.idle();

    expect(embed).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.frame.capturedAt).toBe(1000);
    expect(uploader.stats()).toMatchObject({ submitted: 1, sent: 1, coalesced: 0, failed: 0 });
  });

  it('never stacks: a slow in-flight POST absorbs all newer frames into one pending slot', async () => {
    const first = deferred<ImageEmbedding>();
    const calls: CapturedFrame[] = [];
    const embed = vi.fn(async (submitted: CapturedFrame) => {
      calls.push(submitted);
      return calls.length === 1 ? first.promise : embedding();
    });
    const uploader = createFrameUploader({ embed });

    uploader.submit(frame(1));
    // The first POST is in the air (6–12 s on the real server).
    uploader.submit(frame(2));
    uploader.submit(frame(3));
    uploader.submit(frame(4));

    expect(embed).toHaveBeenCalledTimes(1);
    expect(uploader.stats()).toMatchObject({
      submitted: 4,
      sent: 1,
      coalesced: 2,
      inFlight: true,
      pending: true,
    });

    first.resolve(embedding());
    await uploader.idle();

    // Only the newest pending frame (capturedAt 4) was sent — frames 2 and 3 were dropped.
    expect(embed).toHaveBeenCalledTimes(2);
    expect(calls.map((call) => call.capturedAt)).toEqual([1, 4]);
    expect(uploader.stats()).toMatchObject({ sent: 2, coalesced: 2, inFlight: false, pending: false });
  });

  it('a frame submitted while a pending frame is in flight becomes the next one', async () => {
    const second = deferred<ImageEmbedding>();
    const calls: number[] = [];
    const embed = vi.fn(async (submitted: CapturedFrame) => {
      calls.push(submitted.capturedAt);
      if (calls.length === 2) return second.promise;
      return embedding();
    });
    const uploader = createFrameUploader({ embed });

    uploader.submit(frame(1)); // sent immediately, resolves on a microtask
    uploader.submit(frame(2)); // pending while 1 is in flight
    await vi.waitFor(() => expect(calls).toEqual([1, 2])); // 2 is now the in-flight one
    uploader.submit(frame(3)); // pending while 2 is in flight

    second.resolve(embedding());
    await uploader.idle();

    expect(calls).toEqual([1, 2, 3]);
  });

  it('keeps pumping after a failed upload and reports the error with its frame', async () => {
    const onError = vi.fn();
    const onResult = vi.fn();
    const embed = vi
      .fn<() => Promise<ImageEmbedding>>()
      .mockRejectedValueOnce(new Error('503 E_NO_MODEL'))
      .mockResolvedValue(embedding());
    const uploader = createFrameUploader({ embed, onError, onResult });

    uploader.submit(frame(1));
    uploader.submit(frame(2));
    await uploader.idle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toMatchObject({ capturedAt: 1 });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(uploader.stats()).toMatchObject({ submitted: 2, sent: 2, failed: 1 });
  });

  it('close() stops new sends and discards the pending frame', async () => {
    const first = deferred<ImageEmbedding>();
    const embed = vi.fn(async () => first.promise);
    const uploader = createFrameUploader({ embed });

    uploader.submit(frame(1));
    uploader.submit(frame(2));
    uploader.close();

    first.resolve(embedding());
    await uploader.idle();

    expect(embed).toHaveBeenCalledTimes(1);
    expect(uploader.stats()).toMatchObject({ submitted: 2, sent: 1, pending: false });

    uploader.submit(frame(3)); // ignored after close
    expect(uploader.stats().submitted).toBe(2);
  });

  it('idle() resolves immediately when nothing was submitted', async () => {
    const uploader = createFrameUploader({ embed: vi.fn(async () => embedding()) });
    await expect(uploader.idle()).resolves.toBeUndefined();
  });

  it('imageSignal carries the A1 image marker', () => {
    expect(imageSignal(42)).toEqual({ source: 'image', text: IMAGE_QUERY_MARKER, confidence: 1, at: 42 });
  });
});
