/**
 * Card C5 — FLIP reorder animation maths (and the reduced-motion decision).
 *
 * Pure: rects in, deltas out. The DOM/Web-Animations side (`playFlip`) is only asked to return 0 in
 * the two degenerate cases (reduced motion, no animate), because a browser that cannot animate must
 * still render the reordered list instantly.
 */

import { describe, expect, it, vi } from "vitest";

import {
  FLIP_DURATION_MS,
  FLIP_EASING,
  capturePositions,
  computeFlip,
  flipTransform,
  playFlip,
  prefersReducedMotion,
  shouldAnimateFlip,
} from "../flip";
import type { RectLike } from "../types";

function rect(top: number, left = 0, width = 300, height = 48): RectLike {
  return { top, left, width, height };
}

function measurable(id: string, value: RectLike) {
  return { id, getBoundingClientRect: () => value };
}

describe("capturePositions + computeFlip", () => {
  it("measures rows by id", () => {
    const positions = capturePositions([measurable("a", rect(10)), measurable("b", rect(58))]);
    expect([...positions.keys()]).toEqual(["a", "b"]);
    expect(positions.get("b")).toEqual(rect(58));
  });

  it("inverts a reorder: the row that moved down gets a negative dy", () => {
    const previous = new Map([
      ["a", rect(0)],
      ["b", rect(48)],
      ["c", rect(96)],
    ]);
    const next = new Map([
      ["b", rect(0)],
      ["c", rect(48)],
      ["a", rect(96)],
    ]);
    const moves = computeFlip(previous, next);
    expect(moves).toEqual([
      { id: "b", dx: 0, dy: 48 },
      { id: "c", dx: 0, dy: 48 },
      { id: "a", dx: 0, dy: -96 },
    ]);
    expect(flipTransform(moves[2]!)).toBe("translate3d(0.00px, -96.00px, 0)");
  });

  it("ignores new rows, removed rows and sub-pixel noise", () => {
    const previous = new Map([
      ["a", rect(0)],
      ["gone", rect(48)],
      ["still", rect(96)],
    ]);
    const next = new Map([
      ["a", rect(0.2)], // 0.2 px layout rounding
      ["still", rect(96.2)],
      ["new", rect(144)],
    ]);
    expect(computeFlip(previous, next)).toEqual([]);
    expect(
      computeFlip(previous, next, { minimumDeltaPx: 0 }).filter((move) => move.id !== "new"),
    ).toHaveLength(2);
  });

  it("never animates under prefers-reduced-motion", () => {
    const move = { id: "a", dx: 0, dy: 20 };
    expect(shouldAnimateFlip([move], true)).toBe(false);
    expect(shouldAnimateFlip([move], false)).toBe(true);
    expect(shouldAnimateFlip([], false)).toBe(false);
  });

  it("reads the media preference with a safe fallback", () => {
    expect(prefersReducedMotion((query) => ({ matches: query.includes("reduce") }))).toBe(true);
    expect(prefersReducedMotion(() => ({ matches: false }))).toBe(false);
    expect(prefersReducedMotion(undefined)).toBe(false);
    expect(
      prefersReducedMotion(() => {
        throw new Error("no matchMedia");
      }),
    ).toBe(false);
  });
});

describe("playFlip", () => {
  function fakeContainer(elements: Record<string, { animate?: unknown }>) {
    const list = Object.entries(elements).map(([id, value]) => ({ dataset: { flipId: id }, ...value }));
    return { querySelectorAll: () => list } as unknown as ParentNode;
  }

  it("animates each moved row from its old offset to identity", () => {
    const animate = vi.fn();
    const container = fakeContainer({ a: { animate }, b: {} });
    const played = playFlip(container, [{ id: "a", dx: 0, dy: 24 }], { reducedMotion: false });

    expect(played).toBe(1);
    expect(animate).toHaveBeenCalledWith(
      [{ transform: "translate3d(0.00px, 24.00px, 0)" }, { transform: "translate3d(0, 0, 0)" }],
      { duration: FLIP_DURATION_MS, easing: FLIP_EASING, fill: "both" },
    );
    // Row b never moved, so its (missing) animate is not touched.
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("plays nothing for reduced motion or without the Web Animations API", () => {
    const animate = vi.fn();
    expect(
      playFlip(fakeContainer({ a: { animate } }), [{ id: "a", dx: 0, dy: 10 }], { reducedMotion: true }),
    ).toBe(0);
    expect(
      playFlip(fakeContainer({ a: {} }), [{ id: "a", dx: 0, dy: 10 }], { reducedMotion: false }),
    ).toBe(0);
    expect(animate).not.toHaveBeenCalled();
  });

  it("keeps going when one row refuses to animate", () => {
    const ok = vi.fn();
    const container = fakeContainer({
      bad: {
        animate: () => {
          throw new Error("not composited");
        },
      },
      good: { animate: ok },
    });
    expect(playFlip(container, [{ id: "bad", dx: 0, dy: 1 }, { id: "good", dx: 0, dy: 1 }], { reducedMotion: false })).toBe(1);
  });
});
