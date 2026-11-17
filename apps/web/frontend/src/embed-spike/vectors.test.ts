import { describe, expect, it } from "vitest";

import {
  DIMS_ACTIVE,
  cosine,
  dot,
  fsum,
  maxAbsDiff,
  mean,
  median,
  percentile,
  truncate,
  truncateAndNormalize,
} from "./vectors";

function unit(length: number, value: number): number[] {
  return new Array<number>(length).fill(value);
}

describe("truncateAndNormalize (RANK.md §2, server embedder_gemma.py:198-216)", () => {
  it("truncates FIRST and normalises afterwards — the model card's matryoshka rule", () => {
    // Full-length unit vector of [1,1,1,1,10]: slicing before normalising keeps 0.5s.
    const raw = [1, 1, 1, 1, 10];
    const out = truncateAndNormalize(raw, 4);
    expect(out).toEqual([0.5, 0.5, 0.5, 0.5]);
    // Doing it the other way round (normalise, then slice) would give ~0.098 per component.
    expect(out[0]).not.toBeCloseTo(1 / Math.sqrt(104), 6);
  });

  it("unit length after the slice, even though the 256-slice of a unit 768 vector is short", () => {
    const raw = unit(768, 1 / Math.sqrt(768));
    expect(Math.sqrt(fsum(raw.map((x) => x * x)))).toBeCloseTo(1, 12);
    const slice = truncate(raw, DIMS_ACTIVE);
    expect(Math.sqrt(fsum(slice.map((x) => x * x)))).toBeCloseTo(1 / Math.sqrt(3), 12); // ≈0.5774
    const out = truncateAndNormalize(raw, DIMS_ACTIVE);
    expect(out).toHaveLength(DIMS_ACTIVE);
    expect(Math.sqrt(fsum(out.map((x) => x * x)))).toBeCloseTo(1, 12);
  });

  it("is idempotent on an already-normalised 256-d vector (golden.json's contract)", () => {
    const golden = [0.6, 0.8, ...unit(254, 0)];
    const out = truncateAndNormalize(golden, DIMS_ACTIVE);
    expect(maxAbsDiff(out, golden)).toBeLessThan(1e-15);
  });

  it("returns the all-zero vector for a degenerate norm instead of NaN (pattern), and rejects bad input", () => {
    expect(truncateAndNormalize(unit(8, 0), 4)).toEqual([0, 0, 0, 0]);
    expect(() => truncateAndNormalize([1, Number.NaN, 3], 2)).toThrow(/NaN/);
    expect(() => truncateAndNormalize([1, 2], 4)).toThrow(/need at least 4/);
    expect(() => truncateAndNormalize([1, 2], 0)).toThrow(RangeError);
  });
});

describe("cosine / dot / maxAbsDiff", () => {
  it("dot of two unit vectors is their cosine; cosine normalises non-unit input", () => {
    const a = [1, 0, 0];
    const b = [1, 1, 0];
    expect(dot(a, b)).toBe(1);
    expect(cosine(a, b)).toBeCloseTo(1 / Math.sqrt(2), 12);
    expect(cosine(a, a)).toBeCloseTo(1, 12);
  });

  it("identical vectors score exactly 1 and orthogonal ones 0", () => {
    const a = unit(256, 0.0625);
    expect(cosine(a, a)).toBeCloseTo(1, 12);
    const x = [...unit(255, 0), 1];
    const y = [1, ...unit(255, 0)];
    expect(cosine(x, y)).toBe(0);
  });

  it("a zero vector scores 0 rather than NaN", () => {
    expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("maxAbsDiff reports the worst component, not the sum", () => {
    expect(maxAbsDiff([1, 2, 3], [1, 2.5, 3])).toBe(0.5);
  });
});

describe("summary statistics", () => {
  it("median / percentile / mean match the usual definitions", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([1], 0.9)).toBe(1);
    expect(mean([1, 2, 3])).toBe(2);
    expect(Number.isNaN(median([]))).toBe(true);
  });

  it("fsum is compensated, not naive left-to-right", () => {
    // Naive summation of 1e16 and 1s loses every 1; fsum keeps them.
    expect(fsum([1e16, 1, 1, 1, 1])).toBe(1e16 + 4);
  });
});
