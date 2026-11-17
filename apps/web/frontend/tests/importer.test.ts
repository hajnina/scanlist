/**
 * Card C2 done-when, part 2: LIST.md §8 invalid examples are rejected with pointered errors, and
 * the three import transports (file / paste / URL) produce the same ts-core outcome.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flatten } from "@scanlist/ts-core";

import {
  MAX_IMPORT_BYTES,
  URL_IMPORT_TIMEOUT_ERROR,
  URL_IMPORT_TIMEOUT_MS,
  importFromFile,
  importFromText,
  importFromUrl,
} from "../src/core/importer";
import { samples } from "./samples";

const validSample = samples.find((sample) => sample.name === "van-weekly");
if (validSample === undefined) throw new Error("van-weekly sample missing");
const validText = validSample.text;

function fetchReturning(body: string, init: ResponseInit = {}): typeof fetch {
  return (async () => new Response(body, init)) as unknown as typeof fetch;
}

function fetchThrowing(message: string): typeof fetch {
  return (async () => {
    throw new TypeError(message);
  }) as unknown as typeof fetch;
}

describe("paste / text import — LIST.md §8 invalid examples", () => {
  const invalid: Array<{ name: string; text: string; pointer: string }> = [
    { name: "missing title", text: '{"sections": []}', pointer: "/title" },
    { name: "sections is an object", text: '{"title": "x", "sections": {}}', pointer: "/sections" },
    { name: "section name is a number", text: '{"title": "x", "sections": [{"name": 3}]}', pointer: "/sections/0/name" },
    {
      name: "item without a name",
      text: '{"title": "x", "sections": [{"name": "A", "items": [{"amount": 1}]}]}',
      pointer: "/sections/0/items/0/name",
    },
    {
      name: "amount is null",
      text: '{"title": "x", "sections": [{"name": "A", "items": [{"name": "Milk", "amount": null}]}]}',
      pointer: "/sections/0/items/0/amount",
    },
    {
      name: "aliases is a string",
      text: '{"title": "x", "sections": [{"name": "A", "items": [{"name": "Milk", "aliases": "milk"}]}]}',
      pointer: "/sections/0/items/0/aliases",
    },
    {
      name: "done is a string",
      text: '{"title": "x", "sections": [{"name": "A", "items": [{"name": "Milk", "done": "yes"}]}]}',
      pointer: "/sections/0/items/0/done",
    },
  ];

  for (const example of invalid) {
    it(`rejects ${example.name} at ${example.pointer}`, () => {
      const outcome = importFromText(example.text, "test");
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.errors.length).toBeGreaterThan(0);
      for (const error of outcome.errors) expect(error.startsWith("/")).toBe(true);
      expect(outcome.errors.join("\n")).toContain(example.pointer);
      // No partial import: a failed outcome never carries a list.
      expect("list" in outcome).toBe(false);
    });
  }

  it("rejects malformed JSON, non-object roots and empty input", () => {
    for (const text of ["{", "[]", "42", "null", "   ", ""]) {
      const outcome = importFromText(text, "test");
      expect(outcome.ok, text).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.errors[0]?.startsWith("/")).toBe(true);
    }
  });

  it("rejects 1e999 (Infinity after JSON.parse) with a pointer, never leaking Infinity into the model", () => {
    const text =
      '{"title": "x", "sections": [{"name": "A", "items": [{"name": "Milk", "amount": 1e999}]}]}';
    const outcome = importFromText(text, "test");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors[0]).toContain("/sections/0/items/0/amount");
    expect(outcome.errors.join("\n")).toContain("finite");
  });

  it("ignores unknown fields and keeps \"3\" as text (B2/S8 semantics)", () => {
    const text = JSON.stringify({
      title: "Corner shop",
      schema: "ignored",
      sections: [
        {
          name: "Tonight",
          colour: "ignored",
          items: [{ name: "Bread", amount: "3", extra: { nested: true } }],
        },
      ],
    });
    const outcome = importFromText(text, "test");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(flatten(outcome.list)[0]?.amount).toBe("3");
    expect(typeof flatten(outcome.list)[0]?.amount).toBe("string");
  });

  it("accepts the real van-weekly sample", () => {
    const outcome = importFromText(validText, "test");
    expect(outcome.ok, outcome.ok ? "" : outcome.errors.join("; ")).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.list.title).toBe("Van weekly shop");
    expect(flatten(outcome.list)).toHaveLength(validSample.itemCount);
  });
});

describe("file import", () => {
  it("reads a File through the same parser", async () => {
    const file = new File([validText], "van-weekly.json", { type: "application/json" });
    const outcome = await importFromFile(file);
    expect(outcome.ok).toBe(true);
    expect(outcome.source).toBe("file:van-weekly.json");
  });

  it("reports read failures as pointered errors", async () => {
    const outcome = await importFromFile(new File([validText], "x.json"), async () => {
      throw new Error("permission denied");
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors[0]).toContain("could not read the file");
  });

  it("refuses oversized files before reading them", async () => {
    const huge = { name: "huge.json", size: MAX_IMPORT_BYTES + 1, text: async () => validText } as File;
    const outcome = await importFromFile(huge);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors[0]).toContain("larger than");
  });
});

describe("URL import", () => {
  it("fetches and parses a same-origin URL", async () => {
    const outcome = await importFromUrl(
      "/samples/van-weekly.json",
      fetchReturning(validText, { status: 200, headers: { "content-type": "application/json" } }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.source).toBe("url:/samples/van-weekly.json");
  });

  it("reports the HTTP status of a failed fetch", async () => {
    const outcome = await importFromUrl("https://example.test/list.json", fetchReturning("nope", { status: 404 }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors[0]).toContain("HTTP 404");
  });

  it("explains CORS when fetch itself throws", async () => {
    const outcome = await importFromUrl("https://example.test/list.json", fetchThrowing("Failed to fetch"));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors[0]).toContain("CORS");
  });

  it("rejects empty and non-http(s) URLs without fetching", async () => {
    const never = (async () => {
      throw new Error("fetch must not be called");
    }) as unknown as typeof fetch;
    for (const url of ["", "   ", "file:///etc/passwd", "javascript:alert(1)"]) {
      const outcome = await importFromUrl(url, never);
      expect(outcome.ok, url).toBe(false);
    }
  });

  it("refuses a response bigger than the import cap", async () => {
    const outcome = await importFromUrl(
      "https://example.test/big.json",
      fetchReturning("{}", { status: 200, headers: { "content-length": String(MAX_IMPORT_BYTES + 1) } }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors[0]).toContain("larger than");
  });
});

/**
 * C2 follow-up: the URL fetch had no timeout, so a server that accepts the connection and stalls
 * blocked the import (and the spinner) forever. The fix is an AbortController hard cap; these tests
 * pin both halves of it — a hung request must abort and be classified, a slow-but-alive one must not.
 */
describe("URL import timeout (C2 follow-up)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  interface Captured {
    signal: AbortSignal | null;
  }

  /** A server that accepts the request and never answers. Rejects only when the signal aborts. */
  function fetchHung(captured: Captured): typeof fetch {
    return ((_input: RequestInfo | URL, init?: RequestInit) => {
      captured.signal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;
  }

  /** A slow-but-alive server: answers the body after `delayMs`. */
  function fetchAfter(delayMs: number, body: string): typeof fetch {
    return ((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(body, { status: 200 })), delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;
  }

  it("aborts a fetch that never settles at 10 s and classifies it as a timeout", async () => {
    vi.useFakeTimers();
    const captured: Captured = { signal: null };
    const pending = importFromUrl("https://example.test/hung.json", fetchHung(captured));

    // The signal goes to fetch, and nothing has fired one millisecond before the cap.
    expect(captured.signal).not.toBeNull();
    await vi.advanceTimersByTimeAsync(URL_IMPORT_TIMEOUT_MS - 1);
    expect(captured.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const outcome = await pending;

    expect(captured.signal?.aborted).toBe(true);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Classified: exactly the exported timeout error, through the normal ImportOutcome path — so
    // the UI's existing inline error list + "Import failed (…)" toast render it with no new surface.
    expect(outcome.errors).toEqual([URL_IMPORT_TIMEOUT_ERROR]);
    expect(outcome.source).toBe("url:https://example.test/hung.json");
    expect(outcome.errors[0]).toContain("timed out");
    // Not misreported as the CORS/network failure the abort also looks like from the inside.
    expect(outcome.errors.join("\n")).not.toContain("CORS");
  });

  it("aborts when the headers arrive but the body stalls", async () => {
    vi.useFakeTimers();
    // Headers resolve immediately; the body never does until the signal aborts.
    const stalledBody: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: () =>
          new Promise<string>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const pending = importFromUrl("https://example.test/stalled-body.json", stalledBody);
    await vi.advanceTimersByTimeAsync(URL_IMPORT_TIMEOUT_MS);
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors).toEqual([URL_IMPORT_TIMEOUT_ERROR]);
  });

  it("is unaffected by a fetch that settles at 9 s", async () => {
    vi.useFakeTimers();
    const pending = importFromUrl("https://example.test/slow.json", fetchAfter(9_000, validText));

    await vi.advanceTimersByTimeAsync(9_000);
    const outcome = await pending;

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.list.title).toBe("Van weekly shop");
  });

  it("clears the timer when the import finishes early", async () => {
    vi.useFakeTimers();
    const outcome = await importFromUrl("https://example.test/fast.json", fetchReturning(validText));
    expect(outcome.ok).toBe(true);
    // No timer outlives the import: otherwise every import would keep the page alive for 10 s.
    expect(vi.getTimerCount()).toBe(0);
  });
});
