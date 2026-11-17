/**
 * Canvas frame grabber (card C4): `<video>` → 384 px pixels + JPEG.
 *
 * This is the only file in the scan sources that touches the DOM. The decisions around it are all
 * elsewhere and unit-tested: cadence (`sampler.ts`), target size (`geometry.ts`), size accounting
 * (`jpeg.ts`), barcode/OCR shaping, upload coalescing. Real pixels need a real browser —
 * `README.md` in this folder documents the manual webcam script, and C6 is the Chrome-on-Android
 * over-HTTPS run.
 *
 * Notes from the lead's research digest:
 *  - copy the video frame to a canvas (`getContext('2d', {willReadFrequently: true})`) every
 *    ~150 ms rather than streaming 30 fps frames;
 *  - keep the JPEG at a 384 px short side (same pixels as Track B) and let `toBlob` do the encode.
 *
 * The copy and the JPEG encode are separate calls on purpose: barcode detection runs on the
 * 150 ms copy tick and only needs pixels (`snapshot()`), while the 400 ms embed tick is the only
 * one that pays for JPEG encoding (`encode()`).
 */

import { EMBED_SHORT_SIDE, JPEG_QUALITY, targetSize } from './geometry';
import type { CapturedFrame, FrameSize } from './types';

export interface FrameGrabberOptions {
  shortSide?: number;
  quality?: number;
  /** Injectable for tests/embedders that want a different canvas (default `document.createElement`). */
  createCanvas?: (size: FrameSize) => HTMLCanvasElement;
  /** Injectable clock so `capturedAt` matches the cadence tick. */
  now?: () => number;
}

export interface FrameGrabber {
  /** Draw the current video frame at the target size. `false` while the video has no pixels. */
  copy(): boolean;
  /** Current canvas pixels (barcode detection input), `undefined` before the first copy. */
  snapshot(): ImageData | undefined;
  /** Encode the current canvas as JPEG; `undefined` before the first copy. */
  encode(): Promise<CapturedFrame | undefined>;
  /** Size the next copy produces (debug chip / upload budget). */
  targetSize(): FrameSize | undefined;
  /** Release the canvas backing store. */
  dispose(): void;
}

function defaultCanvas(size: FrameSize): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  return canvas;
}

function toJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new Error('canvas.toBlob returned null (canvas has no pixels)'));
          return;
        }
        resolve(blob);
      },
      'image/jpeg',
      quality,
    );
  });
}

export function createCanvasFrameGrabber(
  video: HTMLVideoElement,
  {
    shortSide = EMBED_SHORT_SIDE,
    quality = JPEG_QUALITY,
    createCanvas = defaultCanvas,
    now = Date.now,
  }: FrameGrabberOptions = {},
): FrameGrabber {
  let canvas: HTMLCanvasElement | undefined;
  let context: CanvasRenderingContext2D | undefined;
  let size: FrameSize | undefined;

  function context2d(): CanvasRenderingContext2D | undefined {
    if (context !== undefined) return context;
    if (canvas === undefined) return undefined;
    const created = canvas.getContext('2d', { willReadFrequently: true });
    if (created === null) return undefined;
    context = created;
    return context;
  }

  return {
    targetSize(): FrameSize | undefined {
      if (video.videoWidth <= 0 || video.videoHeight <= 0) return undefined;
      return targetSize(video.videoWidth, video.videoHeight, shortSide);
    },

    copy(): boolean {
      if (video.videoWidth <= 0 || video.videoHeight <= 0) return false;
      size = targetSize(video.videoWidth, video.videoHeight, shortSide);
      if (canvas === undefined) {
        canvas = createCanvas(size);
        context = undefined;
      }
      if (canvas.width !== size.width) canvas.width = size.width;
      if (canvas.height !== size.height) canvas.height = size.height;
      const ctx = context2d();
      if (ctx === undefined) throw new Error('2d canvas context unavailable: cannot sample the camera frame');
      ctx.drawImage(video, 0, 0, size.width, size.height);
      return true;
    },

    snapshot(): ImageData | undefined {
      if (size === undefined) return undefined;
      const ctx = context2d();
      if (ctx === undefined) return undefined;
      return ctx.getImageData(0, 0, size.width, size.height);
    },

    async encode(): Promise<CapturedFrame | undefined> {
      if (canvas === undefined || size === undefined) return undefined;
      const jpeg = await toJpegBlob(canvas, quality);
      return { jpeg, width: size.width, height: size.height, capturedAt: now() };
    },

    dispose(): void {
      if (canvas !== undefined) {
        canvas.width = 0;
        canvas.height = 0;
      }
      canvas = undefined;
      context = undefined;
      size = undefined;
    },
  };
}
