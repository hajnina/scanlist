/**
 * Test helpers for the scan UI suites. Not a test file (vitest only collects `*.test.ts`).
 */

/**
 * A 256-d vector with the given components (everything else 0). Unit length where the caller makes
 * it so; `rank()` only needs the active dims to line up, cosine = dot product.
 */
export function vec(components: Record<number, number>): number[] {
  const out = new Array<number>(256).fill(0);
  for (const [index, value] of Object.entries(components)) out[Number(index)] = value;
  return out;
}
