/**
 * Prefix + token-budget rules for the browser-side embedding spike (card C7).
 *
 * The numbers here are the model card's (onnx-community/embeddinggemma-2-ONNX) and the server's
 * `embedder_gemma.py`; the spike re-uses them instead of inventing new ones:
 *
 * - text is embedded as `prefix + trim(text)`, prefix read from `shared/spec/prompts.json`
 *   (`prompts.rules.apply`), hard-capped at 2048 code points per input (server `DEFAULT_MAX_CHARS`);
 * - images are embedded with NO prefix (`prompts.json.imagePrefix` is `""`);
 * - on WebGPU a single batch must stay under ~2,700 tokens in total (model card "Context Limits":
 *   above that, some ONNX Runtime WebGPU kernels exceed a GPU dispatch limit);
 * - an image costs 280 tokens at the default vision budget, so 9 images ≈ 2,520 tokens per batch;
 * - several images batched as `[[a], [b]]` are two inputs; a flat list `[a, b]` is ONE blended
 *   input (model card "Multimodal Input"). The planner therefore never emits flat image batches.
 *
 * Everything in this module is pure so vitest can pin the rules without a model.
 */

/** Model card: keep a WebGPU batch under this many tokens in total. */
export const MAX_BATCH_TOKENS = 2700;

/** Model card: default vision soft-token budget per image. */
export const IMAGE_TOKENS = 280;

/** Model card: images per batch at the default budget (`floor(2700 / 280)`). */
export const IMAGES_PER_BATCH = Math.floor(MAX_BATCH_TOKENS / IMAGE_TOKENS); // 9

/** `embedder_gemma.py` `DEFAULT_MAX_CHARS`: the server hard-caps text before embedding. */
export const MAX_TEXT_CHARS = 2048;

/** The four strings `prompts.json` defines for the active prefix set. */
export interface Prefixes {
  /** Name of the prefix set that won S3's A/B (`mnemothera` today). */
  active: string;
  /** Prefix for item documents (list side). */
  doc: string;
  /** Prefix for queries (OCR line / product name). */
  query: string;
  /** Prefix for images — always `""` for this model. */
  image: string;
}

interface PromptsSpec {
  active?: unknown;
  imagePrefix?: unknown;
  rules?: unknown;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the active prefix set out of `shared/spec/prompts.json` — exactly what
 * `embedder_gemma.load_prefixes()` does. Consumers must NOT hard-code the prefixes
 * (`prompts.json.decision`), so this is the only way the spike gets them.
 */
export function prefixesFromSpec(spec: unknown): Prefixes {
  if (!isRecord(spec)) throw new TypeError("prompts.json: expected a JSON object");
  const active = spec["active"];
  if (typeof active !== "string" || active === "") {
    throw new Error("prompts.json has no 'active' prefix set name");
  }
  const sets = spec as PromptsSpec;
  const chosen = sets[active];
  if (!isRecord(chosen)) {
    throw new Error(`prompts.json active=${JSON.stringify(active)} has no matching prefix set`);
  }
  const doc = chosen["doc"];
  const query = chosen["query"];
  if (typeof doc !== "string" || typeof query !== "string") {
    throw new Error(`prompts.json set ${JSON.stringify(active)} needs string 'doc' and 'query' prefixes`);
  }
  const image = spec["imagePrefix"] ?? "";
  if (typeof image !== "string") {
    throw new Error("prompts.json imagePrefix must be a string");
  }
  return { active, doc, query, image };
}

/** Trim Unicode whitespace, then hard-cap the code points (server `cap_text`, `DEFAULT_MAX_CHARS`). */
export function capText(text: string, maxChars: number = MAX_TEXT_CHARS): string {
  const trimmed = text.trim();
  if (maxChars > 0 && trimmed.length > maxChars) return trimmed.slice(0, maxChars);
  return trimmed;
}

/** `prefix + trim(text)` (server `apply_prefix` and `prompts.json.rules.apply`). */
export function applyPrefix(prefix: string, text: string, maxChars: number = MAX_TEXT_CHARS): string {
  return prefix + capText(text, maxChars);
}

/** One list item: `prefix.doc + FLATTEN.md docText`. */
export function docInput(prefixes: Prefixes, docText: string): string {
  return applyPrefix(prefixes.doc, docText);
}

/** One query (OCR line / product name): `prefix.query + text`. */
export function queryInput(prefixes: Prefixes, query: string): string {
  return applyPrefix(prefixes.query, query);
}

/**
 * An image input: no prefix, ever (`prompts.json.rules.image`, `imagePrefix: ""`). Returns the
 * prefix so the caller passes it through `embedImages`, where the length is asserted to be 0.
 */
export function imageInput(prefixes: Prefixes): string {
  return prefixes.image;
}

export type InputKind = "text" | "image";

/** One planned embedding input, with its token cost and modality. */
export interface PlannedInput {
  kind: InputKind;
  tokens: number;
}

/** Greedy bin packing into batches that stay at or under `maxTokens` total tokens. */
export function planBatches(
  inputs: readonly PlannedInput[],
  maxTokens: number = MAX_BATCH_TOKENS,
): number[][] {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new RangeError(`maxTokens must be a positive number, got ${String(maxTokens)}`);
  }
  const batches: number[][] = [];
  let current: number[] = [];
  let used = 0;
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index] as PlannedInput;
    if (!Number.isFinite(input.tokens) || input.tokens < 0) {
      throw new RangeError(`input ${index} has invalid token count ${String(input.tokens)}`);
    }
    // A single oversized input still gets its own batch (the caller must split it), because
    // silently dropping it would hide the failure. The batch is marked by exceeding maxTokens.
    if (current.length > 0 && used + input.tokens > maxTokens) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(index);
    used += input.tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Batch plan for image inputs: every batch is a nested list in the processor call, i.e. `[[a],[b]]`.
 * The planner is only about counts here — `IMAGE_TOKENS` is fixed, so the batch size is
 * `IMAGES_PER_BATCH` unless the caller lowers the vision budget.
 */
export function planImageBatches(
  count: number,
  tokensPerImage: number = IMAGE_TOKENS,
  maxTokens: number = MAX_BATCH_TOKENS,
): number[][] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`count must be a non-negative integer, got ${String(count)}`);
  }
  const inputs: PlannedInput[] = Array.from({ length: count }, () => ({
    kind: "image" as const,
    tokens: tokensPerImage,
  }));
  return planBatches(inputs, maxTokens);
}

/**
 * Conservative fallback token estimate for text when no tokenizer is available.
 * The real spike counts tokens with the model's tokenizer; this is only the guard used by the
 * UI spinner/budget preview and by tests. ~4 characters per subword token is the usual heuristic,
 * rounded up, plus the prefix, and it deliberately over-estimates.
 */
export function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
