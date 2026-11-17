/**
 * Vector maths shared by the spike page and its unit tests.
 *
 * The important part is `truncateAndNormalize`: RANK.md §2 / the server's
 * `embedder_gemma.truncate_and_normalize` slice to 256 **first** and only then L2-normalise (a
 * sliced unit vector is no longer unit length — the model card warns about exactly this), in
 * float64, with an exact-ish sum. Same order here, so the spike's vectors are comparable with
 * `shared/fixtures/golden.json`.
 */

export const DIMS_NATIVE = 768;
export const DIMS_ACTIVE = 256;

/**
 * Compensated (Neumaier) sum. Python's `math.fsum` is correctly rounded; this is not bit-identical
 * for pathological inputs but is exact to the last bit for any realistic embedding slice, which is
 * why parity is reported as cosine/|Δ| rather than claimed bit-identical.
 */
export function fsum(values: Iterable<number>): number {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const t = sum + value;
    if (Math.abs(sum) >= Math.abs(value)) {
      compensation += sum - t + value;
    } else {
      compensation += value - t + sum;
    }
    sum = t;
  }
  return sum + compensation;
}

function isFiniteVector(vec: ArrayLike<number>): boolean {
  for (let i = 0; i < vec.length; i += 1) {
    if (!Number.isFinite(vec[i])) return false;
  }
  return true;
}

/** First `dims` components, widened to float64 (the oracle's `[float(x) for x in vec][:dims]`). */
export function truncate(vec: ArrayLike<number>, dims: number = DIMS_ACTIVE): number[] {
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new RangeError(`dims must be a positive integer, got ${String(dims)}`);
  }
  if (vec.length < dims) {
    throw new RangeError(`vector has ${vec.length} dims, need at least ${dims}`);
  }
  const out = new Array<number>(dims);
  for (let i = 0; i < dims; i += 1) {
    const value = vec[i] as number;
    if (!Number.isFinite(value)) throw new TypeError("vector contains NaN/Inf");
    out[i] = value;
  }
  return out;
}

/**
 * RANK.md §2: truncate to `dims`, then L2-normalise. A norm below 1e-12 returns the all-zero
 * vector so cosine is 0 rather than NaN — exactly the server's behaviour.
 */
export function truncateAndNormalize(
  vec: ArrayLike<number>,
  dims: number = DIMS_ACTIVE,
): number[] {
  const truncated = truncate(vec, dims);
  if (!isFiniteVector(truncated)) throw new TypeError("vector contains NaN/Inf");
  const norm = Math.sqrt(fsum(truncated.map((x) => x * x)));
  if (norm < 1e-12) return new Array<number>(dims).fill(0);
  return truncated.map((x) => x / norm);
}

/** Dot product, ascending index order (RANK.md §2: for unit vectors this IS the cosine). */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>, dims?: number): number {
  const n = dims ?? Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

/** Cosine similarity of two vectors of equal length (dots unit-normalised inputs). */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  const normA = Math.sqrt(fsum(Array.from({ length: n }, (_, i) => (a[i] as number) ** 2)));
  const normB = Math.sqrt(fsum(Array.from({ length: n }, (_, i) => (b[i] as number) ** 2)));
  if (normA < 1e-12 || normB < 1e-12) return 0;
  return dot(a, b, n) / (normA * normB);
}

/** Largest absolute component difference (reported next to cosine in parity checks). */
export function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let max = 0;
  for (let i = 0; i < n; i += 1) {
    const diff = Math.abs((a[i] as number) - (b[i] as number));
    if (diff > max) max = diff;
  }
  return max;
}

/** Sorted copy, ascending. */
export function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** Median of a non-empty list (mean of the two middle values for even counts). */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = sorted(values);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Nearest-rank percentile (`p` in 0..1), clamped to the available samples. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const s = sorted(values);
  const rank = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[rank] as number;
}

/** Arithmetic mean of a non-empty list. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return fsum(values) / values.length;
}
