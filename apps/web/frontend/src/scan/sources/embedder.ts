/**
 * `POST /embed/image` client (card C4).
 *
 * Contract from C1/C3 (`apps/web/server/app/main.py` + README):
 *  - body: **raw JPEG bytes**, `Content-Type: image/jpeg` (no multipart, no base64);
 *  - response: `{ embeddings: [[…256 floats…]], dims, backend, model }` (same envelope as text);
 *  - `x-embed-ms` header: the server's own embed time, ms (C3's latency metric);
 *  - 400 empty/non-JPEG body, 413 > 12 MB, 415 non-image content type, 501 no image modality,
 *    503 `E_NO_MODEL` when the weights are missing.
 *
 * The vector is returned with the frame's `capturedAt`, never with "now": the uploader may sit on a
 * frame for seconds (6.4–11.9 s per image on the fp32 server), and the ranker must know how old the
 * evidence is (RANK.md §2.2).
 */

import type { CapturedFrame, FrameEmbedder, ImageEmbedding } from './types';

/** Server-side cap (C1 `MAX_IMAGE_BYTES`); a 384 px JPEG is ~20–40 kB, so this is a bug guard. */
export const MAX_IMAGE_UPLOAD_BYTES = 12 * 1024 * 1024;

export const DEFAULT_IMAGE_ENDPOINT = '/embed/image';
export const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000;

export interface ServerImageEmbedderOptions {
  fetch: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  /** Extra headers (auth in front of the server, e.g. C6's HTTPS proxy). */
  headers?: Record<string, string>;
}

interface EmbedEnvelope {
  embeddings?: unknown;
  dims?: unknown;
  backend?: unknown;
  model?: unknown;
}

export class ImageEmbedError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'ImageEmbedError';
    this.status = status;
    this.code = code;
  }
}

function parseEmbedMs(header: string | null): number | null {
  if (header === null) return null;
  const value = Number.parseFloat(header);
  return Number.isFinite(value) ? value : null;
}

/** Pull `{"error": {"code": …}}` / `{"detail": …}` out of a failed response, best effort. */
async function errorMessage(response: Response): Promise<{ message: string; code?: string }> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      const record = body as Record<string, unknown>;
      const error = record['error'];
      if (typeof error === 'object' && error !== null) {
        const detail = error as Record<string, unknown>;
        const code = typeof detail['code'] === 'string' ? detail['code'] : undefined;
        const message = typeof detail['message'] === 'string' ? detail['message'] : undefined;
        return { message: message ?? `HTTP ${response.status}`, ...(code === undefined ? {} : { code }) };
      }
      const detail = record['detail'];
      if (typeof detail === 'string') return { message: detail };
    }
  } catch {
    // Non-JSON error body: fall through to the status line.
  }
  return { message: `HTTP ${response.status}` };
}

export function createServerImageEmbedder({
  fetch,
  endpoint = DEFAULT_IMAGE_ENDPOINT,
  timeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS,
  headers = {},
}: ServerImageEmbedderOptions): FrameEmbedder {
  return {
    async embed(frame: CapturedFrame): Promise<ImageEmbedding> {
      if (frame.jpeg.size === 0) {
        throw new ImageEmbedError('empty JPEG frame', undefined, 'E_EMPTY_FRAME');
      }
      if (frame.jpeg.size > MAX_IMAGE_UPLOAD_BYTES) {
        throw new ImageEmbedError(
          `frame is ${frame.jpeg.size} B, server cap is ${MAX_IMAGE_UPLOAD_BYTES} B`,
          undefined,
          'E_FRAME_TOO_LARGE',
        );
      }

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'image/jpeg', ...headers },
          body: frame.jpeg,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new ImageEmbedError(
          `image upload failed: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          'E_UPLOAD',
        );
      }

      if (!response.ok) {
        const { message, code } = await errorMessage(response);
        throw new ImageEmbedError(message, response.status, code);
      }

      let envelope: EmbedEnvelope;
      try {
        envelope = (await response.json()) as EmbedEnvelope;
      } catch {
        throw new ImageEmbedError('server returned a non-JSON embed response', response.status);
      }

      const vectors = envelope.embeddings;
      const vector = Array.isArray(vectors) ? vectors[0] : undefined;
      if (
        !Array.isArray(vector) ||
        vector.length === 0 ||
        !vector.every((value) => typeof value === 'number' && Number.isFinite(value))
      ) {
        throw new ImageEmbedError('embed response has no usable vector', response.status);
      }
      const dims = typeof envelope.dims === 'number' ? envelope.dims : vector.length;

      return {
        vector: vector as number[],
        dims,
        embedMs: parseEmbedMs(response.headers.get('x-embed-ms')),
        backend: typeof envelope.backend === 'string' ? envelope.backend : 'unknown',
        model: typeof envelope.model === 'string' ? envelope.model : 'unknown',
      };
    },
  };
}
