/**
 * FLIP reorder animation (card C5, B5 parity: "measure first/last positions").
 *
 * The ranker reorders the list on every tick. Re-rendering a reordered `<ul>` snaps rows to their new
 * positions, which reads as chaos. FLIP fixes it in the only way that is cheap and exact:
 *
 *   1. **First** — measure every row's rect before the state change (`capturePositions`).
 *   2. **Last**  — measure again after Preact has rendered (`computeFlip`).
 *   3. **Invert + Play** — translate each moved row back by its delta and animate the transform to
 *      none (`playFlip`), so the row appears to glide from where it was.
 *
 * The maths is pure and unit-tested; only `playFlip` touches the DOM/Web Animations API. Rows keep a
 * fixed height (the CSS list does not resize on reorder), so translate-only is enough — no scale, no
 * layout thrash. `prefers-reduced-motion: reduce` disables playback entirely (the reorder still
 * happens, it just lands instantly), and a missing `Element.animate` degrades to the same instant
 * landing — one shared "nothing to animate" path.
 *
 * Scroll (C5 review fix): the two measurements happen at different moments, and the page can be
 * scrolled in between — the rank tick fires every 400 ms while the user flicks the ranked rows.
 * `getBoundingClientRect()` is viewport-relative, so a scroll between "first" and "last" would be
 * baked into the delta as a translate (measured: ~300 px error at scrollY 300). The fix is the
 * symmetric one: `capturePositions` adds the viewport scroll offset at *each* measurement, putting
 * both maps in document space. A reorder still changes a row's document position (the delta we
 * want); scrolling changes only the viewport, so it cancels exactly. The scroll container is the
 * document (scan.css has no inner scroller), hence `window.scrollX/Y` is the right origin.
 */

import type { RectLike } from "./types";

/** Below this the move is sub-pixel noise from layout rounding; do not animate it. */
export const FLIP_MIN_DELTA_PX = 0.5;
/** Expressive spatial duration (STYLE_GUIDE §3 slowSpatial ≈ spring(0.8, 200) settling ~380 ms). */
export const FLIP_DURATION_MS = 380;
/** Spatial overshoot curve from STYLE_GUIDE §3 (`spring(0.8, 380f)` approximation). */
export const FLIP_EASING = "cubic-bezier(0.2, 0.85, 0.25, 1.12)";

export interface FlipMove {
  id: string;
  dx: number;
  dy: number;
}

export interface FlipOptions {
  minimumDeltaPx?: number;
}

/** The minimum of `getBoundingClientRect()` that FLIP needs (kept structural for tests). */
export interface Measurable {
  id: string;
  getBoundingClientRect(): RectLike;
}

/** Viewport scroll at one measurement; added to viewport rects to get scroll-invariant positions. */
export interface ScrollOffset {
  x: number;
  y: number;
}

/** The page scroll now. The scan screen scrolls the document, so the window is the container. */
export function viewportScroll(): ScrollOffset {
  return {
    x: typeof globalThis.scrollX === "number" ? globalThis.scrollX : 0,
    y: typeof globalThis.scrollY === "number" ? globalThis.scrollY : 0,
  };
}

/**
 * Measure rows by their stable id, in document space (viewport rect + `scroll` at this instant).
 * Rows without an id are skipped (no way to match them later). Because both captures carry their
 * own scroll offset, a scroll between them cancels out of `computeFlip`'s deltas.
 */
export function capturePositions(
  elements: Iterable<Measurable>,
  scroll: ScrollOffset = { x: 0, y: 0 },
): Map<string, RectLike> {
  const positions = new Map<string, RectLike>();
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    positions.set(element.id, {
      top: rect.top + scroll.y,
      left: rect.left + scroll.x,
      width: rect.width,
      height: rect.height,
    });
  }
  return positions;
}

/**
 * Deltas that invert the change: a row that ended `dy` lower gets `-dy` and animates back to zero.
 * Only rows present in **both** measurements move; new rows are left to the entrance animation, and
 * removed rows simply disappear. Both maps must be in the same coordinate space — `capturePositions`
 * stores document space, so scroll-only movement contributes nothing here.
 */
export function computeFlip(
  previous: ReadonlyMap<string, RectLike>,
  next: ReadonlyMap<string, RectLike>,
  options: FlipOptions = {},
): FlipMove[] {
  const minimum = options.minimumDeltaPx ?? FLIP_MIN_DELTA_PX;
  const moves: FlipMove[] = [];

  for (const [id, last] of next) {
    const first = previous.get(id);
    if (first === undefined) continue;
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (Math.abs(dx) < minimum && Math.abs(dy) < minimum) continue;
    moves.push({ id, dx, dy });
  }

  return moves;
}

/** CSS transform for the "invert" frame (3d keeps it on the compositor). */
export function flipTransform(move: FlipMove): string {
  return `translate3d(${move.dx.toFixed(2)}px, ${move.dy.toFixed(2)}px, 0)`;
}

/** Playback decision: reduced motion or no moves never animates. */
export function shouldAnimateFlip(moves: readonly FlipMove[], reducedMotion: boolean): boolean {
  return !reducedMotion && moves.length > 0;
}

/** `matchMedia` reader with the happy-dom/no-matchMedia fallback (no preference → animate). */
export function prefersReducedMotion(
  matchMedia: ((query: string) => { matches: boolean }) | undefined = typeof globalThis.matchMedia === "function"
    ? (query) => globalThis.matchMedia(query)
    : undefined,
): boolean {
  try {
    return matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

/**
 * Play the measured moves. Elements are looked up by `data-flip-id`; each one is translated to its
 * first-frame position and animated to identity. Returns the number of rows actually animated (0
 * for reduced motion, empty moves, or an environment without `Element.animate`).
 */
export function playFlip(
  container: ParentNode,
  moves: readonly FlipMove[],
  options: { reducedMotion?: boolean; durationMs?: number; easing?: string } = {},
): number {
  const reducedMotion = options.reducedMotion ?? prefersReducedMotion();
  if (!shouldAnimateFlip(moves, reducedMotion)) return 0;

  const duration = options.durationMs ?? FLIP_DURATION_MS;
  const easing = options.easing ?? FLIP_EASING;
  const elements = new Map<string, HTMLElement>();
  for (const element of container.querySelectorAll<HTMLElement>("[data-flip-id]")) {
    const id = element.dataset.flipId;
    if (id !== undefined && id !== "") elements.set(id, element);
  }

  let played = 0;
  for (const move of moves) {
    const element = elements.get(move.id);
    if (element === undefined || typeof element.animate !== "function") continue;
    try {
      element.animate(
        [{ transform: flipTransform(move) }, { transform: "translate3d(0, 0, 0)" }],
        { duration, easing, fill: "both" },
      );
      played += 1;
    } catch {
      // A browser that refuses the animation must not break the render: the row is simply in place.
    }
  }

  return played;
}
