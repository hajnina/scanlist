/**
 * Haptics (card C5, B5 parity) through the web Vibration API.
 *
 * `navigator.vibrate` is the browser's only haptic primitive: it exists on Android Chrome (where C6
 * runs), is absent on iOS/Safari and desktop Firefox, and is *allowed to do nothing* on a page that
 * has not been interacted with. So every call here is best-effort and returns whether a vibration
 * was requested, never throws — the tick must land whether or not the device can buzz.
 *
 * Patterns follow STYLE_GUIDE §4's `LocalHapticFeedback` roles:
 *   Tick   = ToggleOn     — one short tap (commit accepted)
 *   Hero   = Confirm      — a short double pulse (a match locked in)
 *   Reject = Reject       — one tiny tick (a tap that had nothing to commit)
 *   Long   = LongPress    — a single longer pulse (scan session started)
 */

/** What the module needs from `navigator` (structural so tests pass a stub). */
export interface VibrateTarget {
  vibrate?: ((pattern: number | number[]) => boolean) | undefined;
}

/** ToggleOn (`HapticFeedbackType.ToggleOn`): one 18 ms tap. */
export const VIBRATE_TICK: readonly number[] = [18];
/** Confirm: a short double pulse. */
export const VIBRATE_HERO: readonly number[] = [10, 40, 18];
/** Reject: one barely-there tick. */
export const VIBRATE_REJECT: readonly number[] = [8];
/** LongPress: a single longer pulse when the camera starts. */
export const VIBRATE_START: readonly number[] = [30];

/**
 * Request a vibration if the platform has one. Returns `true` only when the API accepted the call
 * (which is not a promise that the device buzzed — Chrome can still ignore it pre-gesture).
 */
export function vibrate(pattern: number | readonly number[], target: VibrateTarget | undefined = globalThis.navigator as VibrateTarget | undefined): boolean {
  if (target === undefined || typeof target.vibrate !== "function") return false;
  try {
    return target.vibrate(typeof pattern === "number" ? pattern : [...pattern]) === true;
  } catch {
    // Some embeddings throw (e.g. a cross-origin iframe without the permission): haptics are optional.
    return false;
  }
}

export const heroHaptic = (target?: VibrateTarget): boolean => vibrate(VIBRATE_HERO, target);
export const tickHaptic = (target?: VibrateTarget): boolean => vibrate(VIBRATE_TICK, target);
export const rejectHaptic = (target?: VibrateTarget): boolean => vibrate(VIBRATE_REJECT, target);
export const startHaptic = (target?: VibrateTarget): boolean => vibrate(VIBRATE_START, target);
