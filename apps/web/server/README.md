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

Proxies Open Food Facts v2 (`fields=product_name,brands,generic_name,categories`,
`User-Agent: ScanList/0.1`, no personal data) and caches in-process: **30 days** for a
hit, **1 day** for a miss. Barcodes are 8-14 digits (EAN-8/UPC-A/EAN-13).

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
  "query_text": "Nutella, Hazelnut spread with cocoa, Ferrero, Spreads, Sweet spreads, Chocolate spreads",
  "source": "network",
  "ttl_seconds": 2592000
}
```

`found: false` (unknown barcode, `status: 0`, empty product or upstream 404) is still a
`200` and is negative-cached. `502` means OFF was unreachable/broken (not cached).

**Spec ownership:** `shared/off/` (card S4) is the source of truth for the derived
query text and caching rules. Until it merges, `derive_query_text()` in `app/off.py`
implements the generic rule above; alignment with S4 should touch only that function
(and the fixtures test).

## Tests

```bash
.venv/bin/pytest
```

`tests/` uses the deterministic `FakeEmbedder` (same input -> same vector) and
`httpx.MockTransport` for OFF, so the suite is offline and fast.
