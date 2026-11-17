/**
 * Injectable clock (mirrors `apps/rn/src/scan/sources/clock.ts`, card A4).
 *
 * Every cadence/repeat-window module takes a clock so the tests drive a synthetic timeline
 * instead of sleeping; production passes {@linkcode systemClock}.
 */

export interface Clock {
  /** Milliseconds since the epoch (`Date.now()` semantics). */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};
