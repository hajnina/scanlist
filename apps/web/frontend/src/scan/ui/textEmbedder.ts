/**
 * `POST /embed/text` client + the scan screen's embedding port (card C5).
 *
 * The server contract is C1/C3's (`apps/web/server/README.md`):
 *   request  `{ "texts": ["…"], "kind": "doc" | "query" }`  (max 256 texts)
 *   response `{ "embeddings": [[…256 floats…]], "dims", "backend", "model" }`
 *   errors   `{"error": {"code", "message"}}` (C3) or `{"detail": "…"}` (C1)
 *
 * Prefixes are NOT added here: the caller's `resolve*` is handed raw text (item `docText`, OFF
 * product name, one OCR line) and applies the `prompts.json` prefix from `prompts.ts` at the request
 * boundary. Cached vectors are per *raw* text so the rank tick never re-embeds a line that is still
 * in shot.
 *
 * Why a port and not a bare function: a rank tick must stay synchronous. The port answers "what do
 * you have right now" and silently starts the missing batch; the controller ranks with what it has
 * and ticks again when `onSettled` fires. That also gives the tests a synchronous fake (no network,
 * no timers) while the heart of the wiring — pool order, caps, gates — is exercised for real.
 */

import type { FloatVector } from "@scanlist/ts-core";

import { PROMPT_PREFIXES, applyPrefix } from "./prompts";
import type { RetrievalPrefixes } from "./prompts";

export const DEFAULT_TEXT_ENDPOINT = "/embed/text";
export const DEFAULT_TEXT_TIMEOUT_MS = 30_000;
/** Server-side cap (C1 `MAX_TEXTS_PER_REQUEST`); item lists are chunked at this size. */
export const MAX_TEXTS_PER_REQUEST = 256;
/** Retry back-off after a failed batch (a 503 `E_NO_MODEL` is the common one). */
export const FAILED_RETRY_MS = 5000;

export type EmbedKind = "doc" | "query";

export class TextEmbedError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "TextEmbedError";
    this.status = status;
    this.code = code;
  }
}

interface TextEmbedEnvelope {
  embeddings?: unknown;
  dims?: unknown;
  backend?: unknown;
  model?: unknown;
}

async function errorMessage(response: Response): Promise<{ message: string; code?: string }> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      const error = record["error"];
      if (typeof error === "object" && error !== null) {
        const detail = error as Record<string, unknown>;
        const code = typeof detail["code"] === "string" ? detail["code"] : undefined;
        const message = typeof detail["message"] === "string" ? detail["message"] : undefined;
        return { message: message ?? `HTTP ${response.status}`, ...(code === undefined ? {} : { code }) };
      }
      const detail = record["detail"];
      if (typeof detail === "string") return { message: detail };
    }
  } catch {
    // Non-JSON error body: fall through to the status line.
  }
  return { message: `HTTP ${response.status}` };
}

function usableVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((component) => typeof component === "number" && Number.isFinite(component))
  );
}

/** One `POST /embed/text` request (already-prefixed strings), validated to one vector per text. */
export async function embedTexts(
  fetchFn: typeof fetch,
  texts: readonly string[],
  options: {
    endpoint?: string;
    kind?: EmbedKind;
    timeoutMs?: number;
  } = {},
): Promise<number[][]> {
  const {
    endpoint = DEFAULT_TEXT_ENDPOINT,
    kind = "query",
    timeoutMs = DEFAULT_TEXT_TIMEOUT_MS,
  } = options;

  if (texts.length === 0) return [];
  if (texts.length > MAX_TEXTS_PER_REQUEST) {
    throw new TextEmbedError(
      `${texts.length} texts exceeds the server cap of ${MAX_TEXTS_PER_REQUEST}`,
      undefined,
      "E_TOO_MANY_TEXTS",
    );
  }

  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts, kind }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new TextEmbedError(
      `text embed failed: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      "E_UPLOAD",
    );
  }

  if (!response.ok) {
    const { message, code } = await errorMessage(response);
    throw new TextEmbedError(message, response.status, code);
  }

  let envelope: TextEmbedEnvelope;
  try {
    envelope = (await response.json()) as TextEmbedEnvelope;
  } catch {
    throw new TextEmbedError("server returned a non-JSON embed response", response.status);
  }

  const vectors = envelope.embeddings;
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new TextEmbedError(
      `embed response has ${Array.isArray(vectors) ? vectors.length : 0} vectors for ${texts.length} texts`,
      response.status,
    );
  }
  if (!vectors.every(usableVector)) {
    throw new TextEmbedError("embed response has a non-numeric vector", response.status);
  }
  return vectors;
}

export interface EmbedResolution {
  /** Vectors available now, keyed by the raw (unprefixed) text that was asked for. */
  vectors: Map<string, FloatVector>;
  /** Texts asked for that are not embedded yet (a batch is in flight or queued). */
  pending: string[];
  /** Texts whose last batch failed (retried after `FAILED_RETRY_MS`). */
  failed: string[];
}

/**
 * Synchronous resolver + background batch launcher. One batch per kind in flight; a second
 * `resolve*` while the first is running returns what is cached and lists the rest as pending.
 */
export interface EmbedPort {
  resolveQueries(texts: readonly string[]): EmbedResolution;
  resolveDocs(texts: readonly string[]): EmbedResolution;
  /** Last transport error, if any (the controller surfaces it; cleared by a successful batch). */
  lastError(): string | null;
  /** Drop caches/in-flight bookkeeping (the controller is single-use, this is for tests/teardown). */
  dispose(): void;
}

export interface HttpEmbedPortOptions {
  fetch: typeof fetch;
  endpoint?: string;
  prefixes?: RetrievalPrefixes;
  timeoutMs?: number;
  retryAfterMs?: number;
  /** Called after each settled batch (success or failure) so the controller can re-tick. */
  onSettled?: () => void;
}

interface CacheEntry {
  vector: FloatVector;
}

export function createHttpEmbedPort({
  fetch,
  endpoint = DEFAULT_TEXT_ENDPOINT,
  prefixes = PROMPT_PREFIXES,
  timeoutMs = DEFAULT_TEXT_TIMEOUT_MS,
  retryAfterMs = FAILED_RETRY_MS,
  onSettled,
}: HttpEmbedPortOptions): EmbedPort {
  const cache = new Map<string, CacheEntry>();
  const failures = new Map<string, number>();
  const inFlight = new Set<EmbedKind>();
  let disposed = false;
  let lastError: string | null = null;

  const keyOf = (kind: EmbedKind, raw: string): string => `${kind}\n${raw}`;
  const prefixOf = (kind: EmbedKind): string => (kind === "doc" ? prefixes.doc : prefixes.query);

  function resolve(
    kind: EmbedKind,
    texts: readonly string[],
  ): EmbedResolution {
    const vectors = new Map<string, FloatVector>();
    const pending: string[] = [];
    const failed: string[] = [];
    const missing: string[] = [];
    const seen = new Set<string>();
    const now = Date.now();

    for (const text of texts) {
      // Duplicates in one tick are one query, not two slots.
      if (seen.has(text)) continue;
      seen.add(text);
      if (text.trim() === "") continue;

      const key = keyOf(kind, text);
      const cached = cache.get(key);
      if (cached !== undefined) {
        vectors.set(text, cached.vector);
        continue;
      }
      const failedAt = failures.get(key);
      if (failedAt !== undefined && now - failedAt < retryAfterMs) {
        failed.push(text);
        continue;
      }
      pending.push(text);
      missing.push(text);
    }

    if (missing.length > 0 && !inFlight.has(kind) && !disposed) {
      void runBatch(kind, missing);
    }
    return { vectors, pending, failed };
  }

  async function runBatch(kind: EmbedKind, rawTexts: readonly string[]): Promise<void> {
    inFlight.add(kind);
    const prefix = prefixOf(kind);
    try {
      for (let start = 0; start < rawTexts.length; start += MAX_TEXTS_PER_REQUEST) {
        const chunk = rawTexts.slice(start, start + MAX_TEXTS_PER_REQUEST);
        const vectors = await embedTexts(
          fetch,
          chunk.map((raw) => applyPrefix(prefix, raw)),
          { endpoint, kind, timeoutMs },
        );
        for (let index = 0; index < chunk.length; index += 1) {
          const raw = chunk[index] as string;
          const vector = vectors[index] as number[];
          cache.set(keyOf(kind, raw), { vector });
          failures.delete(keyOf(kind, raw));
        }
      }
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const now = Date.now();
      // Every text in the failed batch is stamped so the next resolve() waits out the back-off.
      for (const raw of rawTexts) failures.set(keyOf(kind, raw), now);
    } finally {
      inFlight.delete(kind);
      if (!disposed) onSettled?.();
    }
  }

  return {
    resolveQueries: (texts) => resolve("query", texts),
    resolveDocs: (texts) => resolve("doc", texts),
    lastError: () => lastError,
    dispose: () => {
      disposed = true;
      cache.clear();
      failures.clear();
      inFlight.clear();
    },
  };
}
