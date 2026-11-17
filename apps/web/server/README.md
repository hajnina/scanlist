# ScanList web server (Track C)

FastAPI + uvicorn skeleton for the web app: text/image embeddings behind a pluggable
`Embedder`, an Open Food Facts barcode proxy with TTL caching, and static hosting of
`apps/web/frontend/dist` when the frontend has been built.

Card C1 ships the **fake** embedder only. Card C3 adds the real EmbeddingGemma 2
backend (`embedder_gemma.py`); the API shape below does not change when it lands.

## Setup (venv is gitignored, no global installs)

```bash
cd apps/web/server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
```

### C3: the real EmbeddingGemma 2 (card C3, merged 2026-11-17)

`SCANLIST_EMBEDDER=gemma` activates the real model. It needs:

```bash
.venv/bin/pip install -r requirements-gemma.txt   # CPU torch index, pinned
# weights OUTSIDE the repo: a HF-cache snapshot of google/embeddinggemma-2 @ f9972ac2
# (fp32 CPU, ~1.5 GB). Point HF/HF_HOME at its parent (~/models/scanlist/hf-cache works).
.venv/bin/uvicorn app.main:app --port 8000        # lazy-loads on first embed call
```

- Model-free behaviour is unchanged: without weights or with `SCANLIST_EMBEDDER=fake`,
  the fake stays default; with `gemma` set but weights absent, `/embed/*` return
  **503 `E_NO_MODEL`** (note: C3's error body shape is `{"error": {...}}`, not C1's
  `{"detail": ...}` — document-side acknowledgment, unify if it ever matters client-side).
- Parity gate: `python3 check_golden.py` reproduces all 146 golden vectors (min cos
  0.999999999996) and 58/58 `expectedTop3`; 5 parity tests skip without weights
  (`SCANLIST_SKIP_GEMMA=1` forces the skip path).
- Latency (`PERF.md`): text ~400–500 ms cold / 0 ms cached per call; **image 6.4–11.9 s
  per frame** on this fp32 CPU path — see the X1/C4 notes: treat image queries as
  on-demand/opportunistic, never per-camera-frame.
- Docker: `Dockerfile` (python:3.12-slim, non-root, healthcheck, amd64+arm64) carries
  **no weights** (licence ruling pending) — mount the HF-cache ROOT read-only
  (`/home/…/hf-cache:/hf-cache:ro`, NOT the snapshot dir — symlinks) and pass
  `HF_HOME=/hf-cache`. Verified arm64 + amd64/qemu; no-mount → `/health` 200 +
  503 `E_NO_MODEL`.

## Run

```bash
# from apps/web/server
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Serves:
- API at `/health`, `/embed/text`, `/embed/image`, `/off/{barcode}` (OpenAPI at `/docs`)
- the built frontend from `apps/web/frontend/dist` at `/` once `npm run build` has run in
  `apps/web/frontend`. Without `dist` (or without `index.html`) `/` returns a small JSON
  info document and unknown paths 404 — the API works either way.

Environment variables: `SCANLIST_EMBEDDER` (default `fake`), `SCANLIST_DIMS` (default
`256`), `SCANLIST_OFF_BASE_URL` (default `https://world.openfoodfacts.org`).

## API

Response shape is deliberately **symmetric for text and image**, so swapping the fake
embedder for the real model (C3) changes nothing client-side. Vectors are
L2-normalised, 256-d (Matryoshka), so cosine = dot product.

### `GET /health`

```json
{
  "status": "ok",
  "service": "scanlist-web-server",
  "version": "0.1.0",
  "backend": "fake",
  "model": "fake-embedder-256",
  "dims": 256,
  "modalities": ["text", "image"]
}
```

Clients feature-detect on `modalities` (the browser spike, card C7, checks whether
image embedding is available).

### `POST /embed/text`

```json
{ "texts": ["Milk 1 l; Milk, whole; Dairy > Fridge"], "kind": "doc" }
```

`kind` is `doc` (default) or `query`; it is salted separately so the doc/query prefix
split from the spec can be wired in without an API change. Max 256 texts per request.

```json
{
  "embeddings": [[0.0612, -0.0311, "... 256 floats ..."]],
  "dims": 256,
  "backend": "fake",
  "model": "fake-embedder-256"
}
```

### `POST /embed/image`

Raw JPEG body (`Content-Type: image/jpeg`; `application/octet-stream` is tolerated for
debugging). No multipart, no base64 — the phone sends the camera frame bytes as-is.
Same response shape, one vector in `embeddings`. `415` for a non-image content type,
`400` for an empty or non-JPEG body, `413` above 12 MB.

### `GET /off/{barcode}`

Proxies Open Food Facts v2 (`fields=code,product_name,brands,generic_name,categories`,
`User-Agent: ScanList/0.1`, 3 s connect / 10 s total, no personal data) and caches
in-process: **30 days** for a hit, **1 day** for a miss. Barcodes are 8-14 digits
(EAN-8/UPC-A/EAN-13).

```json
{
  "barcode": "3017620422003",
  "found": true,
  "status": 1,
  "product": {
    "product_name": "Nutella",
    "brands": "Ferrero",
    "generic_name": "Hazelnut spread with cocoa",
    "categories": "Spreads, Sweet spreads, Chocolate spreads"
  },
  "query_text": "Nutella",
  "source": "network",
  "ttl_seconds": 2592000
}
```

`query_text` is the OFF.md §3 derived text: **one** field wins (`product_name` →
`generic_name` → comma-joined `brands`), NFC composed, whitespace runs collapsed,
hard-capped at 160 code points, `null` when all three are empty. `categories` is
returned for provenance only and never contributes to the text. It is the **raw**
text — the `prompts.json` query prefix is added by the client.

`found: false` (unknown barcode, `status: 0`, upstream 404) is still a `200` and is
negative-cached for 1 day. A `200 status: 1` hit with no usable name is a *positive*
30-day hit with `query_text: null`. `502` means OFF was unreachable/broken: nothing is
cached, 5xx/timeouts are retried with backoff (1 s, 2 s; max 3 attempts), `429` honours
`Retry-After`, and an expired entry is still served as `"source": "stale"` without
extending its `fetchedAt` (stale-while-revalidate).

**Spec ownership:** `shared/off/OFF.md` (card S4) is normative for the derived query
text, request contract and cache rules; `shared/off/check_fixtures.py` is the executable
contract. `tests/test_off_parity.py` imports that checker and compares it with
`app/off.py` over every recorded fixture and a set of synthetic edge cases, so server
and spec cannot drift silently.

## Tests

```bash
.venv/bin/pytest
```

`tests/` uses the deterministic `FakeEmbedder` (same input -> same vector) and
`httpx.MockTransport` for OFF, so the suite is offline and fast.
