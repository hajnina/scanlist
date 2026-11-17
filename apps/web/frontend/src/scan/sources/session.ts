/**
 * Scan session (card C4): wires the sources for the scan screen (card C5 owns the UI).
 *
 * One video element, one canvas, three signals:
 *
 *   every 150 ms    drawImage → BarcodeDetector.detect(ImageData) → barcode signal (debounced)
 *   every 400 ms    JPEG capture budget (2.5 fps; on the 150 ms grid the second tick is at ~450 ms)
 *                   → 384 px JPEG → single-flight uploader → image signal + embedding (on result)
 *   every 1 s       canvas → JPEG → lazy Tesseract → one OCR signal per line (repeat-suppressed)
 *
 * The cadence gate, barcode/OCR shaping and uploader are unit-tested; this file is the thin DOM
 * glue (camera stream, canvas, timers). It is exercised by the manual webcam script in `README.md`
 * and by C6 on Chrome/Android over HTTPS.
 */

import { createBarcodeScanner } from './barcodeSource';
import { createCanvasFrameGrabber, type FrameGrabber } from './capture';
import { type CameraEnvironment, openRearCamera, stopStream } from './camera';
import { type Clock, systemClock } from './clock';
import type { BarcodeDetectorLike } from './detector';
import { selectBarcodeDetector } from './detector';
import { createServerImageEmbedder } from './embedder';
import { type ByteCounter, createByteCounter, frameUploadProblem } from './jpeg';
import { createOcrSource, type OcrSource } from './ocrSource';
import type { OcrEngine } from './ocrEngine';
import { FRAME_COPY_INTERVAL_MS, createFrameCadence, type FrameCadence } from './sampler';
import type { CapturedFrame, FrameEmbedResult, ScanSignal } from './types';
import { createFrameUploader, imageSignal, type FrameUploader, type FrameUploaderStats } from './uploader';

export interface ScanSessionOptions {
  video: HTMLVideoElement;
  fetch: typeof fetch;
  /** Every shaped signal: barcode (debounced), one per OCR line, image marker. */
  onSignal: (signal: ScanSignal) => void;
  /** The image vector, tagged with its frame's `capturedAt` (RANK.md §2.2 window). */
  onImageEmbedding?: (result: FrameEmbedResult) => void;
  onError?: (error: unknown, source: 'camera' | 'barcode' | 'ocr' | 'image') => void;
  /** Pre-selected detector (tests/demos); otherwise feature-detected at `start()`. */
  detector?: Pick<BarcodeDetectorLike, 'detect'>;
  /**
   * OCR is opt-in: no engine, no Tesseract download. The session takes ownership of the engine and
   * terminates its worker in `stop()` (a stopped session is single-use).
   */
  ocr?: { engine: OcrEngine; intervalMs?: number };
  endpoint?: string;
  camera?: CameraEnvironment;
  clock?: Clock;
  cadence?: FrameCadence;
  grabber?: FrameGrabber;
  setTimeoutFn?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface ScanSessionStats {
  detector: 'native' | 'zxing' | 'injected' | undefined;
  upload: FrameUploaderStats;
  bytes: ReturnType<ByteCounter['snapshot']>;
}

export interface ScanSession {
  start(): Promise<void>;
  stop(): void;
  stats(): ScanSessionStats;
}

export function createScanSession(options: ScanSessionOptions): ScanSession {
  const {
    video,
    fetch,
    onSignal,
    onImageEmbedding,
    onError,
    detector: injectedDetector,
    ocr,
    endpoint,
    camera = {},
    clock = systemClock,
    cadence = createFrameCadence({ clock }),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;

  const grabber = options.grabber ?? createCanvasFrameGrabber(video, { now: () => clock.now() });
  const bytes = createByteCounter();
  const uploader: FrameUploader = createFrameUploader({
    embed: createServerImageEmbedder({ fetch, ...(endpoint === undefined ? {} : { endpoint }) }).embed,
    onResult: (result) => {
      // Emit the image signal only when the vector actually lands (A4 parity): a frame that was
      // replaced by a newer one while the upload was in flight never produces a signal, so the
      // ranker cannot be handed an image marker with no accompanying embedding. `capturedAt` is
      // the frame's own timestamp, not "now".
      if (!running) return;
      onSignal(imageSignal(result.frame.capturedAt));
      onImageEmbedding?.(result);
    },
    onError: (error) => onError?.(error, 'image'),
  });

  let detectorKind: ScanSessionStats['detector'];
  let barcodeScanner: ReturnType<typeof createBarcodeScanner> | undefined;
  let ocrSource: OcrSource | undefined;
  let stream: MediaStream | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let encoding = false;

  function schedule(): void {
    if (!running) return;
    timer = setTimeoutFn(() => {
      timer = undefined;
      void tick();
    }, cadence.copyIntervalMs || FRAME_COPY_INTERVAL_MS);
  }

  async function tick(): Promise<void> {
    if (!running) return;
    const now = clock.now();
    const decision = cadence.next(now);
    if (decision.copy) {
      let copied = false;
      try {
        copied = grabber.copy();
      } catch (error) {
        onError?.(error, 'camera');
      }
      const pixels = copied ? grabber.snapshot() : undefined;
      if (pixels !== undefined && barcodeScanner !== undefined) {
        try {
          for (const signal of await barcodeScanner.scan(pixels, now)) onSignal(signal);
        } catch (error) {
          onError?.(error, 'barcode');
        }
      }
      if (decision.embed && copied && !encoding) {
        encoding = true;
        void grabber
          .encode()
          .then((frame) => submitFrame(frame))
          .catch((error: unknown) => onError?.(error, 'image'))
          .finally(() => {
            encoding = false;
          });
      }
    }
    schedule();
  }

  function submitFrame(frame: CapturedFrame | undefined): void {
    if (frame === undefined || !running) return;
    const problem = frameUploadProblem(frame);
    if (problem !== undefined) {
      onError?.(new Error(problem), 'image');
      return;
    }
    bytes.record(frame);
    uploader.submit(frame);
  }

  return {
    async start(): Promise<void> {
      if (running) return;
      if (injectedDetector !== undefined) {
        barcodeScanner = createBarcodeScanner({
          detector: injectedDetector,
          onError: (error) => onError?.(error, 'barcode'),
        });
        detectorKind = 'injected';
      } else {
        const selection = await selectBarcodeDetector();
        detectorKind = selection.kind;
        barcodeScanner = createBarcodeScanner({
          detector: selection,
          onError: (error) => onError?.(error, 'barcode'),
        });
      }

      stream = await openRearCamera(camera);
      video.srcObject = stream;
      video.playsInline = true;
      video.muted = true;
      try {
        await video.play();
      } catch (error) {
        // A rejected play() (autoplay policy, device switched away) must not leave the camera LED
        // on: release the tracks before surfacing the error.
        stopStream(stream);
        stream = undefined;
        video.srcObject = null;
        throw error;
      }

      if (ocr !== undefined) {
        ocrSource = createOcrSource({
          engine: ocr.engine,
          intervalMs: ocr.intervalMs,
          grab: async () => (await grabber.encode())?.jpeg,
          onSignals: (signals) => {
            for (const signal of signals) onSignal(signal);
          },
          onError: (error) => onError?.(error, 'ocr'),
          clock,
          setTimeoutFn,
          clearTimeoutFn,
        });
        ocrSource.start();
      }

      running = true;
      schedule();
    },

    stop(): void {
      running = false;
      if (timer !== undefined) {
        clearTimeoutFn(timer);
        timer = undefined;
      }
      ocrSource?.stop();
      ocrSource = undefined;
      if (ocr !== undefined) {
        // The Tesseract worker is a real thread + wasm instance: it must be terminated, not left to
        // the page's lifetime. The session owns the engine it was handed (single-use: a stopped
        // session is not restartable with the same engine).
        void ocr.engine.dispose().catch(() => {
          // A worker that never started (OCR unused) has nothing to terminate.
        });
      }
      uploader.close();
      grabber.dispose();
      stopStream(stream);
      stream = undefined;
      video.srcObject = null;
    },

    stats(): ScanSessionStats {
      return { detector: detectorKind, upload: uploader.stats(), bytes: bytes.snapshot() };
    },
  };
}
