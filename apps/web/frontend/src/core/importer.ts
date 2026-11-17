/**
 * The three import sources: file upload, paste, URL (LIST.md §6).
 *
 * Everything funnels through ts-core's `parseList`: same validation, same RFC 6901 pointer
 * errors, same "no partial import" rule as the Kotlin track. This module only handles the
 * transport (reading a File, fetching a URL) and turns transport failures into the same
 * pointer-prefixed error shape the UI already renders.
 */

import { parseList } from "@scanlist/ts-core";
import type { ScanList } from "@scanlist/ts-core";

/** 5 MiB is ~1000x a realistic shopping list; a bigger body is a mistake or an attack. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/**
 * Hard cap on a whole URL import: connect + headers + body (C2 follow-up; the review found the URL
 * fetch had no timeout, so a server that accepts the connection and then stalls blocked the import
 * — and its spinner — forever).
 *
 * Why 10 s: a list document is capped at MAX_IMPORT_BYTES (5 MiB) but realistically a few KiB, so
 * 10 s allows a very slow mobile transfer of a genuinely large list while still ending a dead
 * request inside a human's patience span. The OFF/scan client aborts at 12 s
 * (`DEFAULT_OFF_TIMEOUT_MS` in src/scan/ui/offClient.ts) for a small JSON lookup; 10 s keeps list
 * import in the same order of magnitude while the spinner makes the wait visible. Both cover the
 * body, not just connect, because a stalled body is just as fatal as a stalled connect.
 */
export const URL_IMPORT_TIMEOUT_MS = 10_000;

/**
 * The classified timeout error. It travels through the normal `ImportOutcome.errors` path, so the
 * existing inline import-error list and the "Import failed (url:…)" toast render it unchanged —
 * no new UI surface.
 */
export const URL_IMPORT_TIMEOUT_ERROR = `/url: gave up after ${URL_IMPORT_TIMEOUT_MS / 1000} s — the server accepted the request but never answered (timed out)`;

export type ImportOutcome =
  | { ok: true; list: ScanList; source: string }
  | { ok: false; errors: string[]; source: string };

/** Parse one document from pasted/typed text. */
export function importFromText(text: string, source = "paste"): ImportOutcome {
  if (text.trim() === "") {
    return { ok: false, source, errors: ["/: the document is empty"] };
  }
  // ts-core's recursive descent overflows the stack around ~1600 nesting levels
  // (C2 review: a hostile paste was a silent no-op — RangeError escaped as neither
  // ok nor errors). Catch it here so EVERY failure path returns pointered errors
  // and the UI can toast; a ts-core depth cap remains the durable fix (logged).
  let result: ReturnType<typeof parseList>;
  try {
    result = parseList(text);
  } catch (error) {
    return {
      ok: false,
      source,
      errors: [
        `/: the document is too deeply nested to parse (${error instanceof Error ? error.message : "unknown error"})`,
      ],
    };
  }
  if (!result.ok) return { ok: false, source, errors: result.errors };
  return { ok: true, list: result.list, source };
}

/** Read and parse a `<input type="file">` selection. */
export async function importFromFile(
  file: File,
  readFile: (file: File) => Promise<string> = (picked) => picked.text(),
): Promise<ImportOutcome> {
  const source = `file:${file.name}`;
  if (file.size > MAX_IMPORT_BYTES) {
    return { ok: false, source, errors: [`/: the file is larger than ${MAX_IMPORT_BYTES} bytes`] };
  }
  let text: string;
  try {
    text = await readFile(file);
  } catch (error) {
    return { ok: false, source, errors: [`/: could not read the file (${errorText(error)})`] };
  }
  return importFromText(text, source);
}

/**
 * Fetch a URL and parse it. Relative URLs resolve against the page (so `/list.json` served by
 * the same FastAPI app works). Other origins need CORS headers — that is a browser rule, not
 * something this app can work around, and the UI says so.
 */
export async function importFromUrl(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ImportOutcome> {
  const source = `url:${rawUrl}`;
  const trimmed = rawUrl.trim();
  if (trimmed === "") {
    return { ok: false, source, errors: ["/: enter a URL to import from"] };
  }

  const base = typeof globalThis.location === "object" && globalThis.location !== null
    ? globalThis.location.href
    : "http://localhost/";
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch (error) {
    return { ok: false, source, errors: [`/: not a valid URL (${errorText(error)})`] };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, source, errors: ["/: only http(s) URLs can be imported"] };
  }

  // AbortController + an explicit timer rather than a fetch option or `AbortSignal.timeout()`:
  // fetch has no timeout option, and the explicit `timedOut` flag is what lets the abort be
  // *classified* as a timeout while one signal also covers `response.text()` — a server can send
  // headers and then stall the body forever. Explicit timers also stay testable with fake timers.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, URL_IMPORT_TIMEOUT_MS);

  function timeoutOutcome(): ImportOutcome {
    return { ok: false, source, errors: [URL_IMPORT_TIMEOUT_ERROR] };
  }

  try {
    let response: Response;
    try {
      response = await fetchImpl(url.href, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) return timeoutOutcome();
      return {
        ok: false,
        source,
        errors: [`/url: could not fetch ${url.href} (${errorText(error)}; cross-origin URLs need CORS)`],
      };
    }
    if (!response.ok) {
      return { ok: false, source, errors: [`/url: ${url.href} answered HTTP ${response.status}`] };
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES) {
      return { ok: false, source, errors: [`/url: the response is larger than ${MAX_IMPORT_BYTES} bytes`] };
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // The abort lands here when the headers already arrived and the body stalled.
      if (timedOut) return timeoutOutcome();
      return { ok: false, source, errors: [`/url: could not read the response (${errorText(error)})`] };
    }
    if (text.length > MAX_IMPORT_BYTES) {
      return { ok: false, source, errors: [`/url: the response is larger than ${MAX_IMPORT_BYTES} bytes`] };
    }
    return importFromText(text, source);
  } finally {
    // Never leave a timer armed behind a finished import (tests with fake timers would hang, and a
    // long-lived page would keep the callback alive for 10 s after every import).
    clearTimeout(timer);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
