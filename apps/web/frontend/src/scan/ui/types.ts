/**
 * Shared structural types for the scan UI (card C5).
 *
 * Only shapes that cross module boundaries live here: the DOM measurement rectangle FLIP needs
 * (structural so the FLIP maths is testable without a layout engine) and the small runtime seams the
 * screen accepts so a test/manual harness can replace the network and timers.
 */

/** The subset of `DOMRect` used by FLIP (no `toJSON`, no bottom/right). */
export interface RectLike {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Where the rank pipeline is in its lifecycle (the camera has its own state in the component). */
export type ScanPhase = "preparing" | "ready";
