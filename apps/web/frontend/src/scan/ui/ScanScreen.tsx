/**
 * The magic Scan screen (card C5).
 *
 * Camera top, hero card + ranked list below, live source chips, and exactly one way to change the
 * list: a human tick. The rank loop is `controller.ts` → ts-core; this file owns the DOM:
 *
 *  - starts one `createScanSession` (C4) against the `<video>` and feeds its signals/images in;
 *  - runs the 400 ms rank tick (`RANK.md` MIN_INTERVAL_MS — the ranker's own floor);
 *  - FLIPs the ranked rows when the order changes, unless the OS asks for reduced motion;
 *  - haptics through `navigator.vibrate` with a no-vibrate fallback;
 *  - stops the camera and disposes the OCR worker on unmount (a stopped session is single-use).
 *
 * OCR is opt-in at the source level (C4: no engine → no Tesseract download). The screen opts in by
 * default because label text is the point of the magic scan, and offers a toggle that restarts the
 * session without the engine (BarcodeDetector + image embedding still work).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { flatten } from "@scanlist/ts-core";
import type { ScanList, ScanListItem } from "@scanlist/ts-core";

import { FilledButton, OutlinedButton, TextButton } from "../../ui/md";
import { classifyCameraError } from "../sources/camera";
import type { CameraError } from "../sources/camera";
import { createTesseractEngine } from "../sources/ocrEngine";
import { createScanSession } from "../sources/session";
import type { FrameEmbedResult, ScanSignal } from "../sources/types";

import type { ScanUiState } from "./controller";
import { createScanController } from "./controller";
import type { ScanController } from "./controller";
import {
  capturePositions,
  computeFlip,
  playFlip,
  prefersReducedMotion,
  viewportScroll,
} from "./flip";
import { itemById } from "./items";
import { createHttpOffPort } from "./offClient";
import type { OffPort } from "./offClient";
import { createHttpEmbedPort } from "./textEmbedder";
import type { EmbedPort } from "./textEmbedder";
import type { RectLike } from "./types";
import { ScanResults } from "./ScanResults";
import type { ScanRow } from "./ranking";
import { rejectHaptic, startHaptic, tickHaptic } from "./vibrate";
import "./scan.css";

/** Rank cadence: RANK.md §1's MIN_INTERVAL_MS floor, and no point running faster (EMA/hysteresis). */
export const SCAN_TICK_INTERVAL_MS = 400;

type CameraState = "off" | "starting" | "on" | "error";

export interface ScanScreenProps {
  /** The list being scanned; `null` renders the "import a list first" state (no camera access). */
  list: ScanList | null;
  onBack: () => void;
  /** C2's commit path — mutates `item.done` and persists the list document. */
  onToggle: (item: ScanListItem) => void;
  /** Test/manual harness seam; defaults to the page's `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable ports (tests only); built from `fetchImpl` when absent. */
  embed?: EmbedPort;
  off?: OffPort;
}

const CAMERA_HINTS: Record<CameraError["code"], string> = {
  "insecure-context":
    "The camera needs HTTPS (or localhost). On a phone, use C6's HTTPS server — a LAN http:// address has no camera API.",
  unsupported: "This browser does not expose a camera API. Chrome on Android or desktop Chrome works.",
  denied: "Camera permission was denied. Allow it in the address bar, then retry.",
  "not-found": "No camera was found on this device.",
  "in-use": "The camera is already in use by another app or tab.",
  constraint: "The browser rejected the camera settings.",
  unknown: "The camera could not be opened.",
};

function cameraErrorText(error: unknown): string {
  const coded = error as Partial<CameraError>;
  if (typeof coded.code === "string" && coded.code in CAMERA_HINTS) {
    return CAMERA_HINTS[coded.code as CameraError["code"]];
  }
  return CAMERA_HINTS[classifyCameraError(error).code] ?? CAMERA_HINTS.unknown;
}

export function ScanScreen(props: ScanScreenProps) {
  const { list, onBack, onToggle, fetchImpl, embed, off } = props;
  const hasList = list !== null;

  const [state, setState] = useState<ScanUiState | null>(null);
  const [camera, setCamera] = useState<CameraState>("off");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [ocrOn, setOcrOn] = useState(true);
  const [streaming, setStreaming] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [lastTick, setLastTick] = useState<string | null>(null);

  const controllerRef = useRef<ScanController | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const positions = useRef(new Map<string, RectLike>());

  const fetchFn = useMemo<typeof fetch>(() => {
    if (fetchImpl !== undefined) return fetchImpl;
    return (input, init) => globalThis.fetch(input, init);
  }, [fetchImpl]);

  const remaining = useMemo(() => {
    if (list === null) return 0;
    return flatten(list).filter((item) => !item.done).length;
  }, [list]);

  const originals = useMemo(() => (list === null ? new Map<string, ScanListItem>() : itemById(list)), [list]);

  // --- rank controller (one per mounted screen; the list is re-fed after every tick) -----------
  useEffect(() => {
    if (!hasList) return;
    const activeList = props.list;
    if (activeList === null) return;

    const embedPort =
      embed ??
      createHttpEmbedPort({
        fetch: fetchFn,
        onSettled: () => controllerRef.current?.tick(),
      });
    const offPort =
      off ??
      createHttpOffPort({
        fetch: fetchFn,
        onResolved: () => controllerRef.current?.tick(),
      });

    const controller = createScanController({
      list: activeList,
      embed: embedPort,
      off: offPort,
      onChange: setState,
    });
    controllerRef.current = controller;
    setState(controller.state());
    controller.tick();

    const timer = setInterval(() => controller.tick(), SCAN_TICK_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      controller.dispose();
      controllerRef.current = null;
    };
    // One controller per mounted screen: the list *contents* are re-fed by the effect below, so a
    // tick (which replaces the list object) must not tear down the camera or the evidence windows.
  }, [hasList, fetchFn]);

  // A tick mutates `item.done` and app.tsx hands us a new root object: keep the ranker in sync.
  useEffect(() => {
    if (list === null) return;
    controllerRef.current?.setList(list);
    controllerRef.current?.tick();
  }, [list]);

  // --- camera session (C4) --------------------------------------------------------------------
  useEffect(() => {
    if (!hasList || !streaming) {
      setCamera("off");
      return;
    }
    const video = videoRef.current;
    if (video === null) return;

    let cancelled = false;
    const controller = controllerRef.current;
    if (controller === null) return;

    const engine = ocrOn ? createTesseractEngine({ langs: "eng" }) : undefined;
    const session = createScanSession({
      video,
      fetch: fetchFn,
      onSignal: (signal: ScanSignal) => controller.ingestSignal(signal),
      onImageEmbedding: (result: FrameEmbedResult) => {
        // C4 emits this marker only when the vector landed (replaced frames emit nothing).
        controller.ingestImage(result);
        controller.tick();
      },
      onError: (error, source) => {
        if (source === "camera") setCameraError(cameraErrorText(error));
        // Barcode/OCR/image errors are transient per-frame failures: the loop keeps going.
      },
      ...(engine === undefined ? {} : { ocr: { engine } }),
    });

    setCamera("starting");
    setCameraError(null);
    session
      .start()
      .then(() => {
        if (cancelled) {
          session.stop();
          return;
        }
        setCamera("on");
        startHaptic();
      })
      .catch((error: unknown) => {
        session.stop();
        if (cancelled) return;
        setCamera("error");
        setCameraError(cameraErrorText(error));
      });

    return () => {
      cancelled = true;
      session.stop();
    };
    // Restart only when the camera/OCR mode changes — not when the list object is replaced by a tick.
  }, [hasList, streaming, ocrOn, attempt, fetchFn]);

  // Short confirmation clears itself (toast-like, but inside the hero card).
  useEffect(() => {
    if (lastTick === null) return;
    const timer = setTimeout(() => setLastTick(null), 4000);
    return () => clearTimeout(timer);
  }, [lastTick]);

  // --- FLIP: measure before the reorder render, play after it ---------------------------------
  const rowsKey = state === null ? "" : state.rows.map((row) => row.id).join("|");
  useLayoutEffect(() => {
    const container = listRef.current;
    if (container === null) return;
    const elements = Array.from(
      container.querySelectorAll<HTMLElement>("[data-flip-id]"),
    ).flatMap((element) => {
      const id = element.dataset.flipId;
      if (id === undefined || id === "") return [];
      return [{ id, getBoundingClientRect: () => element.getBoundingClientRect() }];
    });

    // Document-space positions: the page may have scrolled since the previous capture, and a
    // viewport-only delta would animate that scroll (C5 review bug 2).
    const next = capturePositions(elements, viewportScroll());
    const moves = computeFlip(positions.current, next);
    positions.current = next;
    playFlip(container, moves, { reducedMotion: prefersReducedMotion() });
  }, [rowsKey]);

  function commit(row: ScanRow): void {
    if (list === null) {
      rejectHaptic();
      return;
    }
    const item = originals.get(row.id);
    if (item === undefined) {
      rejectHaptic();
      return;
    }
    tickHaptic();
    onToggle(item);
    setLastTick(row.name);
    controllerRef.current?.tick();
  }

  function retryCamera(): void {
    setAttempt((value) => value + 1);
  }

  if (list === null) {
    return (
      <div class="screen scan-screen">
        <header class="app-header scan-header">
          <button type="button" class="back-button" onClick={onBack}>
            <span aria-hidden="true">←</span> Lists
          </button>
          <h1 class="display">Scan</h1>
        </header>
        <main class="stack">
          <section class="card hero-card scan-empty spring-in">
            <h2 class="section-label">NO LIST OPEN</h2>
            <p class="hero-meta">
              Import or open a list first — scanning ranks the items already on your list, it never
              creates new ones.
            </p>
            <FilledButton label="Back to lists" onClick={onBack} />
          </section>
        </main>
      </div>
    );
  }

  const hero = state?.hero ?? null;
  const cameraStatus =
    camera === "on"
      ? "CAMERA LIVE"
      : camera === "starting"
        ? "STARTING CAMERA…"
        : camera === "error"
          ? "CAMERA UNAVAILABLE"
          : "CAMERA OFF";

  return (
    <div class="screen scan-screen">
      <header class="app-header scan-header">
        <button type="button" class="back-button" onClick={onBack}>
          <span aria-hidden="true">←</span> Lists
        </button>
        <p class="eyebrow">MAGIC SCAN</p>
        <h1 class="display">{list.title}</h1>
        <p class="subtitle">
          {remaining === 0 ? "everything is ticked" : `${remaining} left`} · auto-ranks, never
          auto-ticks
        </p>
      </header>

      <main class="stack">
        <section class="scan-stage" aria-label="Camera preview">
          <video ref={videoRef} class="scan-video" muted playsInline aria-hidden="true" />
          <div class="scan-stage-overlay">
            <p class="scan-stage-status">{cameraStatus}</p>
            {camera === "error" && (
              <span class="scan-stage-retry">
                <OutlinedButton label="Retry camera" onClick={retryCamera} />
              </span>
            )}
          </div>
        </section>

        {cameraError !== null && (
          <p class="scan-error" role="alert">
            {cameraError}
          </p>
        )}
        {state?.error != null && (
          <p class="scan-error" role="status">
            {state.error}
          </p>
        )}

        {state === null ? (
          <p class="empty-state">Waking the ranker…</p>
        ) : (
          <ScanResults state={state} onTick={commit} listRef={listRef} lastTick={lastTick} />
        )}

        <p class="hint">
          {ocrOn
            ? "OCR on: label text is read locally when a frame is legible. A failed read is skipped and ranking continues (barcode + image still count); the text model downloads once on the first pass."
            : "OCR off: barcode + image similarity only."}
        </p>
      </main>

      <div class="scan-actions">
        <div class="scan-actions-primary">
          <button
            type="button"
            class="scan-tick"
            disabled={hero === null}
            aria-label={hero === null ? "No match to tick yet" : `Tick ${hero.name}`}
            onClick={() => {
              if (hero !== null) commit(hero);
            }}
          >
            {hero === null ? "Waiting for a confident match" : `✓ Tick ${hero.name}`}
          </button>
        </div>
        <div class="scan-actions-toggles">
          <TextButton
            label={streaming && camera !== "off" ? "Stop camera" : "Start camera"}
            onClick={() => setStreaming((value) => !value)}
          />
          <TextButton
            label={ocrOn ? "Read labels: on" : "Read labels: off"}
            onClick={() => setOcrOn((value) => !value)}
          />
        </div>
      </div>
    </div>
  );
}
