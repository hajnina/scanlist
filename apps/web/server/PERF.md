# EmbeddingGemma 2 server latency (card C3)

Measured on the ScanList dev laptop, 2026-11-17, with the real model behind
`embedder_gemma.py`. This is the **reference-quality CPU path** (740M params,
**float32**, full precision), not the on-device LiteRT path and not the GGUF
Q8_0 path — numbers are not comparable across those.

## Machine / stack

| | |
|---|---|
| Host | Linux 7.0.0 aarch64 (glibc 2.43), 8 cores, 30 GB RAM (12-17 GB in use by other work) |
| Python | 3.14.4, project venv `apps/web/server/.venv` |
| torch | 2.13.0 (PyPI aarch64, CPU), `torchvision` 0.28.0, sentence-transformers 6.3.0, transformers 5.23.0 |
| Model | `google/embeddinggemma-2` @ `f9972ac22e696a105c482202646979e33e4b5a1e`, `model.safetensors` 1,488,915,288 B, sha256 `197a3296…553d79` |
| Output | 256-d (truncated from 768, L2-normalised, RANK.md §2) |
| Threads | `torch.set_num_threads(8)` on the host; the container caps at 4 (`SCANLIST_TORCH_THREADS=4`) |

The laptop is a shared, loaded machine (12-17 GB of RAM in use, other services
running), so spread is large. Numbers below are medians with the observed range;
re-measure on the Oracle box for the X1 comparison before quoting absolute values.

## Host, in-process (`GemmaEmbedder`, no HTTP)

| Operation | n | Median | Range / notes |
|---|---|---|---|
| Model load (`SentenceTransformer(...)`, lazy) | 1 | **2.3 s** | 2.1–2.8 s across runs |
| Load + first embed call (cold process) | 1 | **4.4 s** | 4.1–4.7 s (load + first-encode warmup) |
| 1 text, cache miss, model warm | 30 | **295 ms** | min 88, p90 475, max 573; one run under heavier load: median 1.0 s |
| 8 texts, cache miss | 8 | 65–223 ms/text | 0.5–1.8 s per request |
| 16 texts, cache miss | 16 | 31–95 ms/text | 0.5–1.5 s per request |
| 43 texts, cache miss | 43 | **44–83 ms/text** | 1.9–3.6 s per request (amortised: batching is what makes CPU usable) |
| 1 text, cache hit | 1 | **0.04 ms** | pure dict + sha256, no model call |
| 1 product JPEG (Open Food Facts 400 px), cache miss | 4 | **7.2 s** | 6.4 / 6.7 / 7.7 / 7.9 s (second run 8.3–11.9 s) |
| HTTP `POST /embed/text` (1 text, cold) | 2 | **110–155 ms** | wall ≈ `x-embed-ms`; includes thread offload, not model load if already warm |
| HTTP `POST /embed/image` (1 JPEG, cold) | 2 | **6.8–8.0 s** | wall ≈ `x-embed-ms` |

`x-embed-ms` is the per-call embed time (the lazy model load is subtracted and
reported separately via `GemmaEmbedder.load_ms`); cache hits report ~0.

## Container (Dockerfile in this folder, linux/arm64, 4 threads)

Image `scanlist-web:c3`, 1.93 GB (torch + torchvision CPU wheels; **no weights**,
`/app` is 152 KB). Weights mounted read-only from the HF cache.

| Operation | Result |
|---|---|
| `GET /health` without weights | 200, `backend: gemma-cpu-fp32`, `modalities: [text, image]` |
| `POST /embed/text` without weights | 503 `{"error": {"code": "E_NO_MODEL", ...}}` |
| `POST /embed/text` "olive oil" (cache miss) | 200, `x-embed-ms` 524 ms |
| `POST /embed/text` "toilet paper" / "eggs" | 396–454 ms |
| `POST /embed/text` repeated ("bananas") | 200, `x-embed-ms` 0.0 ms (cache hit) |
| `POST /embed/image` milk.jpg (cache miss) | 200, `x-embed-ms` 10.7 s |
| First text call in a fresh container | 3.8 s embed time: container cold-start warmup on top of the 2.3 s load |

Container vectors match the fixture end-to-end: text t01 cos 0.9999999999999
(max|diff| 8.8e-08), image `imilk` cos 0.9999999999992 (max|diff| 2.6e-07).

## What this means for the scan loop (400 ms cadence)

- **Text is fine, batched and cached.** Item docVectors are embedded once per
  list (44 items ≈ 2–3.6 s on this laptop) and then cost nothing; a query is
  0.1–0.5 s warm. A single 400 ms scan tick cannot afford an uncached batch, so
  the client should embed the list on change, not per tick.
- **Images are not interactive on this CPU path.** 6.4–11.9 s per JPEG cannot
  drive a 400 ms scan. Options for X1/lead: (a) embed an image only on demand
  (barcode fallback / "identify this product"), (b) use the GGUF Q8_0 path
  (`ggml-org/embeddinggemma-2-GGUF`, ~200 ms/image on a small x86 CPU per the
  research digest) or the on-device LiteRT path, (c) keep this server as the
  reference/ground-truth implementation. Cache by image sha256 is already in
  place, so repeated frames of the same shelf are free — but a live camera
  stream is not.
- Text/image norm: every returned vector is 256-d unit length (cosine = dot
  product), 88 item + 43 text-query + 15 image vectors reproduce
  `shared/fixtures/golden.json` with min cos 0.999999999996 and max|diff|
  6.4e-07.

## Reproduce

```bash
cd apps/web/server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-gemma.txt

# parity + ranking over all 146 golden vectors (~2 min)
.venv/bin/python check_golden.py
.venv/bin/python -m pytest tests/test_golden_parity.py -q -s

# latency (host, in-process)
.venv/bin/python - <<'PY'
import time, json, statistics, sys
sys.path.insert(0, ".")
from embedder_gemma import GemmaEmbedder
g = GemmaEmbedder()
t0 = time.perf_counter(); g.embed_docs(["warmup"]); print("load+first", (time.perf_counter()-t0)*1000)
q = [x["text"] for x in json.load(open("../../../shared/fixtures/golden.json"))["queries"] if x["kind"] == "text"]
xs = []
for text in q[:30]:
    t0 = time.perf_counter(); g.embed_docs([text]); xs.append((time.perf_counter()-t0)*1000)
print("1 text median", statistics.median(xs))
t0 = time.perf_counter(); g.embed_docs(q[:43]); print("43 texts", (time.perf_counter()-t0)*1000)
PY

# container
docker build -f apps/web/server/Dockerfile -t scanlist-web .            # from the repo root
docker run --rm -p 8000:8000 -e EMBEDDINGGEMMA_SNAPSHOT=/models/hf-cache \
  -v ~/models/scanlist/hf-cache:/models/hf-cache:ro scanlist-web
```
