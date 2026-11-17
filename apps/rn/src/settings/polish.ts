/**
 * Polish copy that is pure logic (card A6 / POLISH.md): what the scan screen should say when it has
 * no camera permission, no model, or nothing has been found for a while.
 *
 * Kept out of `ScanScreen.tsx` so the copy and its priority order are unit-tested — the screen then
 * only lays the text out (A4/A5's thin-UI precedent). Values are literal here because they are the
 * product's words, not shared prefixes; no prefix string is hard-coded anywhere in `src/settings`.
 */

/** How long the scanner must be quiet before "nothing found" advice replaces silence. */
export const QUIET_GUIDANCE_MS = 6_000;

/** The three reasons the scanner stops explaining itself. */
export type GuidanceKind = 'camera' | 'model' | 'light';

export interface ScanGuidance {
  kind: GuidanceKind;
  title: string;
  detail: string;
}

/** When each source last produced a signal (ms since epoch, 0 = never). */
export interface SourceActivity {
  barcode: number;
  ocr: number;
  image: number;
}

/**
 * What the quiet clock needs: the raw source stamps plus the two facts the sources cannot express.
 *
 * `activity.image` is the newest image-source **marker** — the source emits one for every sampled
 * frame (~2.5 fps), so it proves the camera is delivering, but it is not a useful result. A live
 * but dim shelf keeps emitting those markers while finding nothing, which is exactly the case the
 * low-light advice exists for. Treating a frame marker as activity was the review blocker this
 * type exists to fix: it refreshed the clock every ~400 ms and the advice could never appear.
 */
export interface ScanProgress extends SourceActivity {
  /** The first frame of this scan (0 = the camera has not delivered yet). Starts the clock. */
  firstFrameAt: number;
  /** The newest tick whose `topId` was non-null (0 = no hero yet). A hero is a useful result. */
  heroAt: number;
}

/**
 * Milliseconds since the scan last yielded something useful — a barcode, an OCR line or a ranked
 * hero — or `null` when no frame has arrived yet (a starting camera is not "nothing found") or the
 * clock disagrees with a stamp.
 *
 * Frames deliberately do **not** reset this clock (see {@linkcode ScanProgress}): with a live
 * camera they arrive every ~400 ms, so counting them would pin the quiet time near zero forever.
 */
export function quietFor(progress: ScanProgress, now: number): number | null {
  if (!(progress.image > 0) || !(progress.firstFrameAt > 0)) {
    return null;
  }
  const lastUseful = Math.max(
    progress.barcode,
    progress.ocr,
    progress.heroAt,
  );
  const since = Math.max(progress.firstFrameAt, lastUseful);
  if (!(since > 0) || !(now >= since)) {
    return null;
  }
  return now - since;
}

export interface GuidanceInput {
  hasPermission: boolean;
  /** Whether the OS can still show the permission dialog (vs denied-for-good). */
  canRequestPermission?: boolean;
  /** Result of {@linkcode quietFor}; `null`/absent means no quiet-time hint. */
  quietMs?: number | null;
  /** The bundle is missing/not ready (the settings probe already reports `E_NO_MODEL`). */
  modelMissing?: boolean;
}

/**
 * The one hint to show, in priority order: permission (the scanner cannot start) → missing model
 * (it cannot rank) → quiet long enough (the user may be pointing at something unhelpful) → nothing.
 * Never nags while signals are flowing.
 */
export function scanGuidance({
  hasPermission,
  canRequestPermission = false,
  quietMs = null,
  modelMissing = false,
}: GuidanceInput): ScanGuidance | null {
  if (!hasPermission) {
    return canRequestPermission
      ? {
          kind: 'camera',
          title: 'The magic scan needs the camera',
          detail:
            'Barcode, OCR and frame embedding all read the same preview. Allow the camera to start scanning.',
        }
      : {
          kind: 'camera',
          title: 'Camera permission is blocked',
          detail: 'Allow the camera in Android Settings, then return here.',
        };
  }
  if (modelMissing) {
    return {
      kind: 'model',
      title: 'No embedding model on this phone',
      detail:
        'Barcode and OCR still work, but ranking needs the bundle. Push it with scripts/model.sh push <package>.',
    };
  }
  if (quietMs !== null && quietMs >= QUIET_GUIDANCE_MS) {
    return {
      kind: 'light',
      title: 'Nothing in frame yet',
      detail:
        'Point at an item and hold steady for a second. In low light or with glare, turn on the torch — dim frames give the embedder little to work with.',
    };
  }
  return null;
}
