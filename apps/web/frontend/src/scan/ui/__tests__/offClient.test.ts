/**
 * Card C5 — `GET /off/{barcode}` client.
 *
 * OFF.md §2 is enforced by C1's server; the browser client adds ON-request validation (no request
 * for a non-product code), a page-lifetime cache so the 4 s barcode hold does not re-ask, and a
 * back-off for transient failures. `query_text` is the only text that reaches the ranker.
 */

import { describe, expect, it, vi } from "vitest";

import { createHttpOffPort, offQueryText } from "../offClient";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BARCODE = "3017620422003";

describe("offQueryText", () => {
  it("takes the server's derived text and treats blank/non-string as no text", () => {
    expect(offQueryText({ query_text: "  Nutella " })).toBe("Nutella");
    expect(offQueryText({ query_text: null })).toBeNull();
    expect(offQueryText({ query_text: "" })).toBeNull();
    expect(offQueryText({ query_text: 42 })).toBeNull();
    expect(offQueryText(null)).toBeNull();
  });
});

describe("createHttpOffPort", () => {
  it("requests the server proxy and caches the result for the page", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ barcode: BARCODE, found: true, query_text: "Nutella", source: "network" }),
    );
    const onResolved = vi.fn();
    const port = createHttpOffPort({ fetch: fetchMock as unknown as typeof fetch, onResolved });

    expect(port.lookup(BARCODE)).toEqual({ state: "pending", text: null });
    await vi.waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/off/${BARCODE}`);
    expect(onResolved.mock.calls[0]?.[1]).toEqual({ state: "found", text: "Nutella" });

    expect(port.lookup(BARCODE)).toEqual({ state: "found", text: "Nutella" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a hit with no usable name as none (no barcode text, no boost)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ found: true, query_text: null }));
    const port = createHttpOffPort({ fetch: fetchMock as unknown as typeof fetch });
    port.lookup(BARCODE);
    await vi.waitFor(() => expect(port.lookup(BARCODE).state).toBe("none"));
    expect(port.lookup(BARCODE)).toEqual({ state: "none", text: null });
  });

  it("never requests a value that is not a product barcode", () => {
    const fetchMock = vi.fn();
    const port = createHttpOffPort({ fetch: fetchMock as unknown as typeof fetch });
    expect(port.lookup("not-a-code")).toMatchObject({ state: "error", text: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a 502 as transient and retries after the back-off", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: "upstream down" }, 502))
      .mockResolvedValueOnce(jsonResponse({ found: true, query_text: "Nutella" }));
    const port = createHttpOffPort({ fetch: fetchMock as unknown as typeof fetch, retryAfterMs: 0 });

    port.lookup(BARCODE);
    await vi.waitFor(() => expect(port.lookup(BARCODE).state).toBe("found"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("survives a network rejection", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const port = createHttpOffPort({ fetch: fetchMock as unknown as typeof fetch });
    port.lookup(BARCODE);
    await vi.waitFor(() => expect(port.lookup(BARCODE).state).toBe("error"));
    expect(port.lookup(BARCODE)).toMatchObject({ state: "error", text: null });
  });
});
