/**
 * Camera wiring for the magic scan (card A4) — the only file in this directory that touches the
 * native camera module, imported by the scan UI (card A5) and never by tests.
 *
 * VisionCamera v5 model (v1/v4 differed a lot):
 *  - `<Camera device="back" isActive outputs={[photoOutput]} />` with the preview added internally;
 *  - a `CameraPhotoOutput` captures in-memory `Photo`s or files (`capturePhotoToFile`);
 *  - frame processors are Nitro worklets and `frameProcessInterval` no longer throttles, so the
 *    ~2.5 fps budget is our own loop (./captureLoop).
 *
 * The screen owns one {@linkcode FrameFeed}; the camera pushes every sampled frame into it and the
 * barcode / OCR / image sources subscribe to it. One 400 ms photo therefore feeds all three chips
 * (and gives the embedder its JPEG) without any double delivery.
 *
 * Android permission: `android.permission.CAMERA` is declared in
 * `android/app/src/main/AndroidManifest.xml` (already present since card A1); VisionCamera's
 * `useCameraPermission` drives the runtime request and `<ScanCamera>` asks on first mount.
 */
import React, {useEffect, useMemo, useRef} from 'react';
import {StyleSheet, type StyleProp, type ViewStyle} from 'react-native';
import {
  Camera,
  CommonResolutions,
  type CameraViewProps,
  type PermissionStatus,
  type TargetCameraPosition,
  useCameraPermission,
  usePhotoOutput,
} from 'react-native-vision-camera';

import {
  createCaptureLoop,
  DEFAULT_FRAME_INTERVAL_MS,
} from './captureLoop';
import {type Clock, systemClock} from './clock';
import {createFrameCapturer} from './frameCapturer';
import type {FrameFeedSink} from './frames';

/** 720p-ish is plenty for barcode/OCR and cheap to encode for the image embedder. */
export const SCAN_PHOTO_RESOLUTION = CommonResolutions.HD_16_9;
/** JPEG quality for the embedding frame — 0.7 keeps a 720p frame around 100–200 KB. */
export const SCAN_PHOTO_QUALITY = 0.7;

export interface ScanCameraOptions {
  /** The feed the scan sources attach to; the camera pushes every sampled frame into it. */
  feed: FrameFeedSink;
  /** Mount/unmount with the scan screen. Permission is only requested while active. */
  active?: boolean;
  /** Shopping-list scan uses the back camera. */
  position?: TargetCameraPosition;
  /** Capture interval. Default 400 ms ≈ 2.5 fps (the "magic scan" budget). */
  intervalMs?: number;
  onError?: (error: unknown) => void;
  clock?: Clock;
}

export interface ScanCameraState {
  hasPermission: boolean;
  canRequestPermission: boolean;
  permissionStatus: PermissionStatus;
  requestPermission: () => Promise<boolean>;
  /** Spread onto `<Camera {...cameraProps} />` (the component below does it for you). */
  cameraProps: Omit<CameraViewProps, 'style'>;
  start: () => void;
  stop: () => void;
}

/**
 * Wire a VisionCamera photo output + capture loop onto a frame feed, without rendering anything.
 * Use this when the scan UI owns its own `<Camera>` element.
 */
export function useScanCamera({
  feed,
  active = true,
  position = 'back',
  intervalMs = DEFAULT_FRAME_INTERVAL_MS,
  onError,
  clock = systemClock,
}: ScanCameraOptions): ScanCameraState {
  const permission = useCameraPermission();
  const photoOutput = usePhotoOutput({
    targetResolution: SCAN_PHOTO_RESOLUTION,
    containerFormat: 'jpeg',
    quality: SCAN_PHOTO_QUALITY,
    qualityPrioritization: 'balanced',
  });

  // Keep the latest error callback without rebuilding the loop (which would restart the camera).
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const loop = useMemo(
    () =>
      createCaptureLoop({
        capture: createFrameCapturer(photoOutput),
        intervalMs,
        clock,
        onFrame: frame => feed.push(frame),
        onError: error => onErrorRef.current?.(error),
      }),
    [photoOutput, intervalMs, clock, feed],
  );

  // The loop must not outlive the component (a capture keeps the native output alive otherwise).
  useEffect(() => () => loop.stop(), [loop]);

  const {hasPermission, canRequestPermission, requestPermission, status} =
    permission;

  const cameraProps = useMemo<Omit<CameraViewProps, 'style'>>(
    () => ({
      device: position,
      isActive: active && hasPermission,
      outputs: [photoOutput],
      onStarted: () => loop.start(),
      onStopped: () => loop.stop(),
      onError: (error: Error) => onErrorRef.current?.(error),
    }),
    [position, active, hasPermission, photoOutput, loop],
  );

  return {
    hasPermission,
    canRequestPermission,
    permissionStatus: status,
    requestPermission,
    cameraProps,
    start: () => loop.start(),
    stop: () => loop.stop(),
  };
}

export interface ScanCameraProps extends ScanCameraOptions {
  style?: StyleProp<ViewStyle>;
}

/**
 * Camera preview + sampling for the scan screen. Renders nothing until the camera permission is
 * granted; requests it on first mount when the OS still allows asking. If the user denied it for
 * good, `permissionStatus` (from `useScanCamera`) is `'denied' | 'restricted'` — the caller shows
 * the "open settings" copy (the scan UI's job, not this source's).
 */
export function ScanCamera({
  style,
  ...options
}: ScanCameraProps): React.ReactElement | null {
  const {hasPermission, canRequestPermission, requestPermission, cameraProps} =
    useScanCamera(options);
  const active = options.active ?? true;

  useEffect(() => {
    if (active && !hasPermission && canRequestPermission) {
      requestPermission().catch(() => {
        // Denied/blocked; the caller renders the rationale via `permissionStatus`.
      });
    }
  }, [active, hasPermission, canRequestPermission, requestPermission]);

  if (!hasPermission) {
    return null;
  }

  return <Camera {...cameraProps} style={style ?? StyleSheet.absoluteFill} />;
}
