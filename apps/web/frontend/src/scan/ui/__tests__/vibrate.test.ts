/**
 * Card C5 — haptics through `navigator.vibrate` with the graceful no-vibrate path.
 * iOS/Safari and desktop Firefox have no Vibration API; a page that has not been tapped can also be
 * asked to buzz and silently refused. Neither may throw into a tick handler.
 */

import { describe, expect, it, vi } from "vitest";

import {
  VIBRATE_HERO,
  VIBRATE_REJECT,
  VIBRATE_START,
  VIBRATE_TICK,
  vibrate,
} from "../vibrate";

describe("vibrate", () => {
  it("forwards a pattern and reports acceptance", () => {
    const target = { vibrate: vi.fn(() => true) };
    expect(vibrate([10, 40, 18], target)).toBe(true);
    expect(target.vibrate).toHaveBeenCalledWith([10, 40, 18]);
    // readonly patterns are copied for the API's mutable signature.
    expect(vibrate(VIBRATE_TICK, target)).toBe(true);
    expect(target.vibrate).toHaveBeenLastCalledWith([...VIBRATE_TICK]);
  });

  it("is a no-op (false) where the API is absent, refused or throws", () => {
    expect(vibrate(10, undefined)).toBe(false);
    expect(vibrate(10, {})).toBe(false);
    expect(vibrate(10, { vibrate: undefined })).toBe(false);
    expect(vibrate(10, { vibrate: () => false })).toBe(false);
    expect(
      vibrate(10, {
        vibrate: () => {
          throw new Error("cross-origin iframe");
        },
      }),
    ).toBe(false);
  });

  it("has one pattern per STYLE_GUIDE haptic role", () => {
    expect(VIBRATE_TICK).toEqual([18]); // ToggleOn
    expect(VIBRATE_HERO.length).toBe(3); // Confirm: double pulse
    expect(VIBRATE_REJECT).toEqual([8]); // Reject
    expect(VIBRATE_START).toEqual([30]); // LongPress
  });
});
