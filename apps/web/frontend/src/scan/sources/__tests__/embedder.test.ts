/**
 * Card C4: the `POST /embed/image` client matches C1/C3's contract exactly.
 *
 * Raw JPEG body (no multipart/base64), `{embeddings, dims, backend, model}` back, `x-embed-ms`
 * latency header, and the documented error envelopes (503 `E_NO_MODEL`, 400/413/415/501).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_IMAGE_ENDPOINT,
  ImageEmbedError,
  MAX_IMAGE_UPLOAD_BYTES,
  createServerImageEmbedder,
} from '../embedder';
import type { CapturedFrame } from '../types';

function jpegFrame(size = 64): CapturedFrame {
  return {
    jpeg: new Blob([new Uint8Array(size)], { type: 'image/jpeg' }),
    width: 384,
    height: 288,
    capturedAt: 1700,
  };
}

function envelopeResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

describe('createServerImageEmbedder', () => {
  it('posts the raw JPEG bytes to /embed/image with an image/jpeg content type', async () => {
    const fetchMock = vi.fn(async () =>
      envelopeResponse(
        { embeddings: [[0.1, 0.2, 0.3]], dims: 3, backend: 'fake', model: 'fake-256' },
        { headers: { 'x-embed-ms': '7200.4' } },
      ),
    );
    const embedder = createServerImageEmbedder({ fetch: fetchMock as unknown as typeof fetch });
    const frame = jpegFrame();

    const embedding = await embedder.embed(frame);

    expect(DEFAULT_IMAGE_ENDPOINT).toBe('/embed/image');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/embed/image');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(frame.jpeg);
    expect((init.headers as Record<string, string>)['content-type']).toBe('image/jpeg');
    expect(embedding).toEqual({
      vector: [0.1, 0.2, 0.3],
      dims: 3,
      embedMs: 7200.4,
      backend: 'fake',
      model: 'fake-256',
    });
  });

  it('reports embedMs null when the latency header is absent', async () => {
    const embedder = createServerImageEmbedder({
      fetch: (async () =>
        envelopeResponse({ embeddings: [[1]], dims: 1, backend: 'b', model: 'm' })) as typeof fetch,
    });
    await expect(embedder.embed(jpegFrame())).resolves.toMatchObject({ embedMs: null });
  });

  it('accepts a custom endpoint and extra headers', async () => {
    const fetchMock = vi.fn(async () =>
      envelopeResponse({ embeddings: [[1]], dims: 1, backend: 'b', model: 'm' }),
    );
    const embedder = createServerImageEmbedder({
      fetch: fetchMock as unknown as typeof fetch,
      endpoint: 'https://scan.example/embed/image',
      headers: { 'x-token': 't' },
    });
    await embedder.embed(jpegFrame());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://scan.example/embed/image');
    expect((init.headers as Record<string, string>)['x-token']).toBe('t');
  });

  it('surfaces the 503 E_NO_MODEL envelope as a coded ImageEmbedError', async () => {
    const embedder = createServerImageEmbedder({
      fetch: (async () =>
        envelopeResponse(
          { error: { code: 'E_NO_MODEL', message: 'EmbeddingGemma weights are not mounted' } },
          { status: 503 },
        )) as typeof fetch,
    });
    await expect(embedder.embed(jpegFrame())).rejects.toMatchObject({
      name: 'ImageEmbedError',
      status: 503,
      code: 'E_NO_MODEL',
      message: 'EmbeddingGemma weights are not mounted',
    });
  });

  it('surfaces C1-style {"detail": …} errors (400 empty body, 415 wrong type, 501 no image)', async () => {
    const embedder = createServerImageEmbedder({
      fetch: (async () => envelopeResponse({ detail: 'empty image body' }, { status: 400 })) as typeof fetch,
    });
    const error = await embedder.embed(jpegFrame()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImageEmbedError);
    expect((error as ImageEmbedError).message).toBe('empty image body');
    expect((error as ImageEmbedError).status).toBe(400);
  });

  it('handles a non-JSON error body', async () => {
    const embedder = createServerImageEmbedder({
      fetch: (async () => new Response('<html>502</html>', { status: 502 })) as typeof fetch,
    });
    await expect(embedder.embed(jpegFrame())).rejects.toMatchObject({
      status: 502,
      message: 'HTTP 502',
    });
  });

  it('rejects an envelope without a usable vector', async () => {
    for (const body of [
      {},
      { embeddings: [] },
      { embeddings: [[]] },
      { embeddings: [['a', 'b']] },
      { embeddings: [[1, null]] },
    ]) {
      const embedder = createServerImageEmbedder({
        fetch: (async () => envelopeResponse(body)) as typeof fetch,
      });
      const error = await embedder.embed(jpegFrame()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ImageEmbedError);
      expect((error as ImageEmbedError).message).toMatch(/no usable vector/);
    }
  });

  it('guards empty and oversized frames locally (no round trip)', async () => {
    const fetchMock = vi.fn();
    const embedder = createServerImageEmbedder({ fetch: fetchMock as unknown as typeof fetch });

    const empty: CapturedFrame = {
      ...jpegFrame(),
      jpeg: new Blob([], { type: 'image/jpeg' }),
    };
    await expect(embedder.embed(empty)).rejects.toMatchObject({ code: 'E_EMPTY_FRAME' });

    const oversized: CapturedFrame = {
      ...jpegFrame(),
      jpeg: { size: MAX_IMAGE_UPLOAD_BYTES + 1, type: 'image/jpeg' } as Blob,
    };
    await expect(embedder.embed(oversized)).rejects.toMatchObject({ code: 'E_FRAME_TOO_LARGE' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('wraps a transport failure in E_UPLOAD', async () => {
    const embedder = createServerImageEmbedder({
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch,
    });
    await expect(embedder.embed(jpegFrame())).rejects.toMatchObject({
      code: 'E_UPLOAD',
      message: expect.stringContaining('Failed to fetch'),
    });
  });
});
