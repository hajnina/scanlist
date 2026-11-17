/**
 * The measurement harness: everything the spike page does *after* the model is loaded, driven
 * through the `EmbedSession` seam so it is unit-testable with a fake model.
 *
 * What it measures (all with `performance.now()` unless a clock is injected):
 * 1. token counts per item doc (model tokenizer) and the real batch plan under the 2,700-token
 *    WebGPU budget;
 * 2. text embedding: cold first call, per-batch latency, warm single-input latency (median/p90);
 * 3. image embedding: warm single-image latency and one nested batch of up to 9 images;
 * 4. agreement with `shared/fixtures/golden.json`: cosine of every 256-d vector against the
 *    server's fp32 vector for the same input, plus ts-core `rank()` top-1 vs the golden top-1;
 * 5. the model card's traps: 9-image batches, flat-vs-nested image lists, and the pre-normalisation
 *    length of the 256-d slice.
 *
 * It never invents numbers: a stage that cannot run leaves its field `null` and pushes a note.
 */

import { docText, rank } from "@scanlist/ts-core";
import type { FlattenedItem, RankItem } from "@scanlist/ts-core";

import {
  IMAGE_TOKENS,
  IMAGES_PER_BATCH,
  MAX_BATCH_TOKENS,
  docInput,
  estimateTextTokens,
  planBatches,
  planImageBatches,
  queryInput,
} from "./budget";
import type { Prefixes } from "./budget";
import type {
  AdapterInfo,
  BatchTiming,
  EmbedSession,
  FlatVsNestedTrap,
  ImageHandle,
  LoadMetrics,
  ParitySummary,
  SpikeReport,
  Timing,
} from "./session";
import {
  DIMS_ACTIVE,
  cosine,
  fsum,
  maxAbsDiff,
  mean,
  median,
  percentile,
  truncate,
  truncateAndNormalize,
} from "./vectors";

/** One golden query (text or image) from `shared/fixtures/golden.json`. */
export interface GoldenQuery {
  id: string;
  kind: "text" | "image";
  /** Text input for `kind: "text"` (the golden fixture's `text` field). */
  text?: string;
  /** 256-d server vector for the same input (golden `vector`). */
  vector?: number[];
  /** Golden expected top-3 item ids, used for the end-to-end rank() check. */
  expectedTop3?: string[];
}

/** An image prepared by the caller: decoded handle, optional golden vector. */
export interface ImageInput {
  id: string;
  handle: ImageHandle;
  vector?: number[];
  expectedTop3?: string[];
}

export interface HarnessOptions {
  /** Active dimensions (production: 256). */
  dims?: number;
  /** Warm single-query samples (first is discarded). 5 is enough to see the spread. */
  textRepeats?: number;
  /** Warm single-image samples (first is discarded). */
  imageRepeats?: number;
  maxBatchTokens?: number;
  /** Injected clock; defaults to `performance.now`. */
  now?: () => number;
  /** Facts from the loader/page, copied into the report's environment block. */
  environment?: {
    userAgent?: string;
    device?: string;
    dtype?: string;
    adapter?: AdapterInfo | null;
    webgpu?: boolean;
    load?: LoadMetrics | null;
  };
}

function timingOf(samples: readonly number[]): Timing {
  return {
    samples: [...samples],
    median: median(samples),
    p90: percentile(samples, 0.9),
    min: samples.length > 0 ? Math.min(...samples) : Number.NaN,
    max: samples.length > 0 ? Math.max(...samples) : Number.NaN,
  };
}

function summarize(pairs: readonly { id: string; actual: number[]; expected: number[] }[]): ParitySummary {
  if (pairs.length === 0) {
    return { n: 0, minCosine: Number.NaN, medianCosine: Number.NaN, maxAbsDiff: Number.NaN, worstId: null };
  }
  const cosines = pairs.map((pair) => cosine(pair.actual, pair.expected));
  const diffs = pairs.map((pair) => maxAbsDiff(pair.actual, pair.expected));
  let worst = 0;
  for (let i = 1; i < cosines.length; i += 1) {
    if ((cosines[i] as number) < (cosines[worst] as number)) worst = i;
  }
  return {
    n: pairs.length,
    minCosine: Math.min(...cosines),
    medianCosine: median(cosines),
    maxAbsDiff: Math.max(...diffs),
    worstId: (pairs[worst] as { id: string }).id,
  };
}

function preNormLength(vector: ArrayLike<number>, dims: number): number {
  const slice = truncate(vector, dims);
  return Math.sqrt(fsum(slice.map((x) => x * x)));
}

/**
 * Run the whole measurement suite. Pure with respect to everything except the injected session
 * and clock; the returned object is JSON-serialisable so the page can dump it into the doc.
 */
export async function runMeasurement(
  input: {
    session: EmbedSession;
    prompts: Prefixes;
    items: readonly FlattenedItem[];
    itemVectors: Record<string, number[]>;
    textQueries: readonly GoldenQuery[];
    images: readonly ImageInput[];
  },
  options: HarnessOptions = {},
): Promise<SpikeReport> {
  const { session, prompts, items, itemVectors, textQueries, images } = input;
  const dims = options.dims ?? DIMS_ACTIVE;
  const now = options.now ?? (() => performance.now());
  const maxBatchTokens = options.maxBatchTokens ?? MAX_BATCH_TOKENS;
  const textRepeats = Math.max(1, options.textRepeats ?? 5);
  const imageRepeats = Math.max(1, options.imageRepeats ?? 3);
  const notes: string[] = [];
  const env = options.environment ?? {};

  // --- 1. token budget ---------------------------------------------------------------------
  const docTexts = items.map((item) => docInput(prompts, docText(item)));
  const queryTexts = textQueries
    .filter((query) => query.kind === "text" && typeof query.text === "string")
    .map((query) => queryInput(prompts, query.text as string));

  let docTokens: number[];
  if (session.countTokens) {
    docTokens = await session.countTokens(docTexts);
    notes.push(`Token counts from the model tokenizer (${session.device}).`);
  } else {
    docTokens = docTexts.map(estimateTextTokens);
    notes.push("Token counts are the ~4 chars/token estimate (session has no tokenizer).");
  }
  const docBatches = planBatches(
    docTokens.map((tokens) => ({ kind: "text" as const, tokens })),
    maxBatchTokens,
  );
  const docBatchTokens = docBatches.map((batch) =>
    batch.reduce((sum, index) => sum + (docTokens[index] as number), 0),
  );

  // --- 2. text: cold first call, batched docs, warm single query -----------------------------
  const tCold = now();
  const first = await session.embedTexts([docTexts[0] as string]);
  const coldFirstMs = now() - tCold;
  const rawDocVectors: Float32Array[] = [first[0] as Float32Array];

  const batches: BatchTiming[] = [];
  let docTotalMs = 0;
  for (let b = 0; b < docBatches.length; b += 1) {
    const batch = docBatches[b] as number[];
    if (b === 0) {
      // Item 0 was the cold call; batch 0 continues with the rest (or is empty for a 1-item list).
      const rest = batch.slice(1);
      if (rest.length === 0) continue;
      const started = now();
      const vectors = await session.embedTexts(rest.map((index) => docTexts[index] as string));
      const ms = now() - started;
      docTotalMs += ms;
      for (let i = 0; i < rest.length; i += 1) rawDocVectors[rest[i] as number] = vectors[i] as Float32Array;
      batches.push({ size: rest.length, tokens: docBatchTokens[b] ?? 0, ms, perItemMs: ms / rest.length });
      continue;
    }
    const started = now();
    const vectors = await session.embedTexts(batch.map((index) => docTexts[index] as string));
    const ms = now() - started;
    docTotalMs += ms;
    for (let i = 0; i < batch.length; i += 1) rawDocVectors[batch[i] as number] = vectors[i] as Float32Array;
    batches.push({ size: batch.length, tokens: docBatchTokens[b] ?? 0, ms, perItemMs: ms / batch.length });
  }
  docTotalMs += coldFirstMs;

  const docVectors = rawDocVectors.map((vector) => truncateAndNormalize(vector, dims));

  let singleQuery: Timing | null = null;
  if (queryTexts.length > 0) {
    const samples: number[] = [];
    for (let i = 0; i < textRepeats; i += 1) {
      const started = now();
      await session.embedTexts([queryTexts[0] as string]);
      samples.push(now() - started);
    }
    // The first sample pays the kernel warm-up; report it but exclude it from median/p90.
    singleQuery = timingOf(samples.slice(1));
    notes.push(`Single-query timing: ${samples.length} samples, first discarded as warm-up.`);
  }

  // --- 3. text query vectors (batched, one pass) ---------------------------------------------
  const queryVectors: number[][] = [];
  for (let start = 0; start < queryTexts.length; start += 4) {
    const slice = queryTexts.slice(start, start + 4);
    const vectors = await session.embedTexts(slice);
    for (const vector of vectors) queryVectors.push(truncateAndNormalize(vector, dims));
  }

  // --- 4. images: warm single, then one nested batch ------------------------------------------
  let imageSingle: Timing | null = null;
  let imageBatch: BatchTiming | null = null;
  const imageVectors = new Map<string, number[]>();
  let sliceNormSum = 0;
  let sliceNormCount = 0;

  if (images.length > 0) {
    const singleSamples: number[] = [];
    const repeats = Math.min(imageRepeats, Math.max(1, images.length));
    for (let i = 0; i < repeats; i += 1) {
      const image = images[i % images.length] as ImageInput;
      const started = now();
      await session.embedImages([[image.handle]]);
      singleSamples.push(now() - started);
    }
    imageSingle = timingOf(singleSamples.length > 1 ? singleSamples.slice(1) : singleSamples);

    const plans = planImageBatches(images.length, IMAGE_TOKENS, maxBatchTokens);
    const firstBatch = plans[0] ?? [];
    if (firstBatch.length > 0) {
      const started = now();
      const vectors = await session.embedImages(
        firstBatch.map((index) => [(images[index] as ImageInput).handle]),
      );
      const ms = now() - started;
      imageBatch = {
        size: firstBatch.length,
        tokens: firstBatch.length * IMAGE_TOKENS,
        ms,
        perItemMs: ms / firstBatch.length,
      };
      for (let i = 0; i < firstBatch.length; i += 1) {
        const image = images[firstBatch[i] as number] as ImageInput;
        const raw = vectors[i] as Float32Array;
        imageVectors.set(image.id, truncateAndNormalize(raw, dims));
        sliceNormSum += preNormLength(raw, dims);
        sliceNormCount += 1;
      }
    }
  } else {
    notes.push("No images supplied: image latency and image parity were not measured.");
  }

  // --- 5. traps ------------------------------------------------------------------------------
  let flatVsNested: FlatVsNestedTrap | null = null;
  if (images.length >= 2 && session.embedImagesFlat) {
    const firstImage = images[0] as ImageInput;
    const secondImage = images[1] as ImageInput;
    const nested = await session.embedImages([[firstImage.handle], [secondImage.handle]]);
    const flat = await session.embedImagesFlat([firstImage.handle, secondImage.handle]);
    const flatVector = truncateAndNormalize(flat, dims);
    const nestedVectors = nested.map((vector) => truncateAndNormalize(vector, dims));
    const flatCosineVsNested = nestedVectors.map((vector) => cosine(flatVector, vector));
    flatVsNested = {
      flatCosineVsNested,
      differs: flatCosineVsNested.every((value) => value < 0.995),
    };
    notes.push(
      flatVsNested.differs
        ? "Flat image list is measurably different from the nested batch: the trap is real on this runtime."
        : "Flat and nested image lists produced near-identical vectors — investigate before trusting batching.",
    );
  }

  // --- 6. parity against the server's golden vectors ------------------------------------------
  const docPairs = items
    .map((item, index) => ({
      id: item.id,
      actual: docVectors[index] as number[],
      expected: itemVectors[item.id],
    }))
    .filter((pair): pair is { id: string; actual: number[]; expected: number[] } =>
      Array.isArray(pair.expected),
    );

  const queryPairs = textQueries
    .map((query, index) => ({
      id: query.id,
      actual: queryVectors[index] as number[] | undefined,
      expected: query.vector,
    }))
    .filter(
      (pair): pair is { id: string; actual: number[]; expected: number[] } =>
        Array.isArray(pair.actual) && Array.isArray(pair.expected),
    );

  const imagePairs = images
    .map((image) => ({ id: image.id, actual: imageVectors.get(image.id), expected: image.vector }))
    .filter(
      (pair): pair is { id: string; actual: number[]; expected: number[] } =>
        Array.isArray(pair.actual) && Array.isArray(pair.expected),
    );

  // End-to-end: the REAL ranker over browser vectors vs the golden top-1 (RANK.md §3/§6).
  const rankItems: RankItem[] = items.map((item, index) => ({
    ...item,
    vec: docVectors[index] as number[],
  }));
  let hits = 0;
  let total = 0;
  const misses: string[] = [];
  textQueries.forEach((query, index) => {
    const expectedTop1 = query.expectedTop3?.[0];
    const vector = queryVectors[index];
    if (expectedTop1 === undefined || vector === undefined) return;
    const output = rank(rankItems, { text: [vector] }, null, null, { dims });
    const actualTop1 = output.entries.find((entry) => !entry.done)?.id ?? null;
    total += 1;
    if (actualTop1 === expectedTop1) hits += 1;
    else misses.push(`${query.id}: ${String(actualTop1)} != ${expectedTop1}`);
  });

  // `navigator.gpu` is only in @webgpu/types; the spike avoids a dependency and probes structurally.
  const webgpu =
    env.webgpu ??
    (typeof navigator !== "undefined" &&
      (navigator as unknown as { gpu?: unknown }).gpu !== undefined);
  return {
    generatedAt: new Date().toISOString(),
    environment: {
      userAgent: env.userAgent ?? (typeof navigator === "undefined" ? "unknown" : navigator.userAgent),
      device: env.device ?? session.device,
      dtype: env.dtype ?? session.dtype,
      adapter: env.adapter ?? null,
      webgpu,
    },
    load: env.load ?? null,
    budgets: {
      maxBatchTokens,
      imagesPerBatch: IMAGES_PER_BATCH,
      docTokens: items.map((item, index) => ({ id: item.id, tokens: docTokens[index] as number })),
      docBatches,
      docBatchTokens,
    },
    text: {
      docCount: items.length,
      docTotalMs,
      batches,
      coldFirstMs,
      singleQuery,
    },
    image: {
      single: imageSingle,
      batch: imageBatch,
      sliceNormMean: sliceNormCount > 0 ? sliceNormSum / sliceNormCount : Number.NaN,
    },
    parity: {
      docs: summarize(docPairs),
      queries: summarize(queryPairs),
      images: summarize(imagePairs),
      top1: { hits, total, misses },
    },
    traps: {
      imagesPerBatchAtMost: Math.min(IMAGES_PER_BATCH, planImageBatches(images.length, IMAGE_TOKENS, maxBatchTokens)[0]?.length ?? IMAGES_PER_BATCH),
      flatVsNested,
    },
    notes,
  };
}

/** Mean helper re-exported for the page's summary line (avoids importing vectors there). */
export { mean };
