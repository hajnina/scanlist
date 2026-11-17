/**
 * Card C5 — `POST /embed/text` client and the synchronous `EmbedPort` seam.
 *
 * The port is what makes a rank tick synchronous even though embedding is not: `resolve*` answers
 * from cache and starts at most one batch per kind; the controller ranks with what it has and ticks
 * again when `onSettled` fires. These tests pin the envelope, the prefixes (from prompts.json, never
 * hard-coded), single-flight, caching and the failure back-off.
 */

import { describe, expect, it, vi } from "vitest";

import { embedTexts, createHttpEmbedPort, MAX_TEXTS_PER_REQUEST, TextEmbedError } from "../textEmbedder";
import { PROMPT_PREFIXES } from "../prompts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function envelope(count: number, value = 0.5): unknown {
  return {
    embeddings: Array.from({ length: count }, () => [value, 0, 0, 0]),
    dims: 4,
    backend: "fake",
    model: "fake-256",
  };
}

describe("embedTexts", () => {
  it("posts JSON texts + kind and returns one vector per text", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(envelope(2)));
    const vectors = await embedTexts(fetchMock as unknown as typeof fetch, ["a", "b"], { kind: "doc" });

    expect(vectors).toHaveLength(2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/embed/text");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ texts: ["a", "b"], kind: "doc" });
  });

  it("rejects an envelope with the wrong number of vectors", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(envelope(1)));
    await expect(embedTexts(fetchMock as unknown as typeof fetch, ["a", "b"])).rejects.toBeInstanceOf(
      TextEmbedError,
    );
  });

  it("surfaces the server's E_NO_MODEL code", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: "E_NO_MODEL", message: "no weights" } }, { status: 503 }),
    );
    await expect(embedTexts(fetchMock as unknown as typeof fetch, ["a"])).rejects.toMatchObject({
      status: 503,
      code: "E_NO_MODEL",
      message: "no weights",
    });
  });

  it("refuses more texts than the server cap", async () => {
    const fetchMock = vi.fn();
    await expect(
      embedTexts(fetchMock as unknown as typeof fetch, Array.from({ length: MAX_TEXTS_PER_REQUEST + 1 }, (_, i) => `t${i}`)),
    ).rejects.toMatchObject({ code: "E_TOO_MANY_TEXTS" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createHttpEmbedPort", () => {
  it("applies the prompts.json prefixes and caches by raw text", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(envelope(1)));
    const port = createHttpEmbedPort({ fetch: fetchMock as unknown as typeof fetch });

    const first = port.resolveQueries(["Nutella"]);
    expect(first.pending).toEqual(["Nutella"]);
    expect(first.vectors.size).toBe(0);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as {
      texts: string[];
      kind: string;
    };
    expect(body.texts).toEqual([`${PROMPT_PREFIXES.query}Nutella`]);
    expect(body.kind).toBe("query");

    await vi.waitFor(() => expect(port.resolveQueries(["Nutella"]).vectors.size).toBe(1));
    expect(port.resolveQueries(["Nutella"]).vectors.get("Nutella")).toEqual([0.5, 0, 0, 0]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // second resolve is a cache hit
  });

  it("uses the doc prefix and kind for item documents", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(envelope(1)));
    const port = createHttpEmbedPort({ fetch: fetchMock as unknown as typeof fetch });
    port.resolveDocs(["Milk; Dairy"]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as {
      texts: string[];
      kind: string;
    };
    expect(body.kind).toBe("doc");
    expect(body.texts[0]).toBe(`${PROMPT_PREFIXES.doc}Milk; Dairy`);
  });

  it("keeps one batch in flight and dedupes duplicate texts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      await gate;
      const texts = (JSON.parse(String(init.body)) as { texts: string[] }).texts;
      return jsonResponse(envelope(texts.length));
    });
    const port = createHttpEmbedPort({ fetch: fetchMock as unknown as typeof fetch });

    const first = port.resolveQueries(["Milk", "Milk", "Bread"]);
    expect(first.pending).toEqual(["Milk", "Bread"]);
    // A second tick while the first is in the air must not stack another POST.
    port.resolveQueries(["Milk", "Bread"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(() => expect(port.resolveQueries(["Milk", "Bread"]).vectors.size).toBe(2));
  });

  it("marks a failed batch as failed and waits out the back-off", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: "E_NO_MODEL", message: "no weights" } }, { status: 503 }),
    );
    const onSettled = vi.fn();
    const port = createHttpEmbedPort({
      fetch: fetchMock as unknown as typeof fetch,
      onSettled,
    });

    port.resolveQueries(["Milk"]);
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(port.lastError()).toContain("no weights");

    // Inside the 5 s back-off: failed, and no new POST is started.
    const afterFailure = port.resolveQueries(["Milk"]);
    expect(afterFailure.failed).toEqual(["Milk"]);
    expect(afterFailure.pending).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries after the back-off (retryAfterMs 0 in this fake)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: "E_NO_MODEL", message: "no weights" } }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(envelope(1)));
    const onSettled = vi.fn();
    const port = createHttpEmbedPort({
      fetch: fetchMock as unknown as typeof fetch,
      retryAfterMs: 0,
      onSettled,
    });

    port.resolveQueries(["Milk"]);
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));

    const retried = port.resolveQueries(["Milk"]);
    expect(retried.pending).toEqual(["Milk"]);
    await vi.waitFor(() => expect(port.resolveQueries(["Milk"]).vectors.size).toBe(1));
    expect(port.lastError()).toBeNull();
  });

  it("chunks large item lists at the server cap", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const texts = (JSON.parse(String(init.body)) as { texts: string[] }).texts;
      return jsonResponse(envelope(texts.length));
    });
    const port = createHttpEmbedPort({ fetch: fetchMock as unknown as typeof fetch });
    const texts = Array.from({ length: MAX_TEXTS_PER_REQUEST + 2 }, (_, index) => `item ${index}`);

    port.resolveDocs(texts);
    await vi.waitFor(() => expect(port.resolveDocs(texts).vectors.size).toBe(texts.length));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
