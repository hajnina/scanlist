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

  let response: Response;
  try {
    response = await fetchImpl(url.href, { headers: { accept: "application/json" } });
  } catch (error) {
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
    return { ok: false, source, errors: [`/url: could not read the response (${errorText(error)})`] };
  }
  if (text.length > MAX_IMPORT_BYTES) {
    return { ok: false, source, errors: [`/url: the response is larger than ${MAX_IMPORT_BYTES} bytes`] };
  }
  return importFromText(text, source);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
