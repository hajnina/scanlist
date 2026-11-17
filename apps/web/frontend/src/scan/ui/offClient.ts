/**
 * `GET /off/{barcode}` client for the scan screen (card C5).
 *
 * OFF.md §2 is the normative request contract, but the browser never talks to
 * `world.openfoodfacts.org` directly: C1's server proxies it (`apps/web/server/README.md`) and hands
 * back OFF.md §3's derived `query_text` plus provenance. The server already caches (30 d hit / 1 d
 * miss), so this client's cache exists only to keep the scan loop from re-asking while a barcode stays
 * in the 4 s hold: per page load, per barcode, misses included (a hit with no usable name is a miss
 * for the ranker, exactly like the server's `query_text: null`).
 *
 * The raw barcode digits are never embedded (OFF.md §1): `queryText` is the only text that reaches
 * the query pool, and it doubles as `rank()`'s `barcodeName` for the +0.15 boost and the image
 * accept-list guard.
 */

export const DEFAULT_OFF_ENDPOINT = "/off";
export const DEFAULT_OFF_TIMEOUT_MS = 12_000;
/** A transient failure is retried after this long (the barcode hold is 4 s, chips show "error"). */
export const OFF_RETRY_MS = 10_000;

/** OFF.md §2 barcode shape (EAN-8/UPC-A/EAN-13/ITF-14); anything else is a scanner error. */
const BARCODE_PATTERN = /^[0-9]{8,14}$/;

export type OffState = "pending" | "found" | "none" | "error";

export interface OffResolution {
  state: OffState;
  /** OFF.md §3 derived query text — raw, unprefixed; `null` for misses/pending/errors. */
  text: string | null;
  /** Human-readable failure reason (chips/status only). */
  error?: string;
}

export interface OffResponseEnvelope {
  barcode?: unknown;
  found?: unknown;
  status?: unknown;
  product?: unknown;
  query_text?: unknown;
}

/**
 * Parse the server envelope. `query_text` is authoritative (the server applied OFF.md §3); a
 * missing/non-string/non-empty value is "no barcode text", never an error.
 */
export function offQueryText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as OffResponseEnvelope).query_text;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export interface OffPort {
  /** Never throws; starts the request when needed and reports `pending` until it settles. */
  lookup(barcode: string): OffResolution;
  dispose(): void;
}

export interface HttpOffPortOptions {
  fetch: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  retryAfterMs?: number;
  /** Called after a lookup settles (the controller re-ticks so the barcode query joins the pool). */
  onResolved?: (barcode: string, resolution: OffResolution) => void;
}

interface CacheEntry {
  resolution: OffResolution;
  /** Epoch ms of the last failure, for the retry back-off. */
  errorAt?: number;
}

export function createHttpOffPort({
  fetch,
  endpoint = DEFAULT_OFF_ENDPOINT,
  timeoutMs = DEFAULT_OFF_TIMEOUT_MS,
  retryAfterMs = OFF_RETRY_MS,
  onResolved,
}: HttpOffPortOptions): OffPort {
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Set<string>();
  let disposed = false;

  async function run(barcode: string): Promise<void> {
    inFlight.add(barcode);
    const settle = (resolution: OffResolution, errorAt?: number): void => {
      cache.set(barcode, { resolution, ...(errorAt === undefined ? {} : { errorAt }) });
      inFlight.delete(barcode);
      if (!disposed) onResolved?.(barcode, resolution);
    };

    try {
      const response = await fetch(`${endpoint}/${barcode}`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        // 502 = OFF unreachable (server contract); 5xx/timeout are transient, never a miss.
        const detail = response.status === 502 ? "OFF is unreachable" : `HTTP ${response.status}`;
        settle({ state: "error", text: null, error: detail }, Date.now());
        return;
      }
      const body: unknown = await response.json();
      const text = offQueryText(body);
      settle({ state: text === null ? "none" : "found", text });
    } catch (error) {
      settle(
        {
          state: "error",
          text: null,
          error: error instanceof Error ? error.message : String(error),
        },
        Date.now(),
      );
    }
  }

  return {
    lookup(barcode: string): OffResolution {
      if (!BARCODE_PATTERN.test(barcode)) {
        // OFF.md §2: a value that fails the pattern produces no request and no cache entry.
        return { state: "error", text: null, error: "not a product barcode" };
      }

      const cached = cache.get(barcode);
      if (cached !== undefined) {
        if (
          cached.resolution.state === "error" &&
          cached.errorAt !== undefined &&
          Date.now() - cached.errorAt >= retryAfterMs &&
          !inFlight.has(barcode)
        ) {
          void run(barcode);
          return { state: "pending", text: null };
        }
        return cached.resolution;
      }

      if (!disposed && !inFlight.has(barcode)) void run(barcode);
      return { state: "pending", text: null };
    },
    dispose(): void {
      disposed = true;
      cache.clear();
      inFlight.clear();
    },
  };
}
