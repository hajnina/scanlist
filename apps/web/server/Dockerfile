# syntax=docker/dockerfile:1
#
# ScanList web server (+ real EmbeddingGemma 2) - card C3.
#
# Build from the REPO ROOT so shared/spec/prompts.json can be copied in:
#
#   docker build -f apps/web/server/Dockerfile -t scanlist-web .
#   docker buildx build --platform linux/amd64,linux/arm64 \
#       -f apps/web/server/Dockerfile -t scanlist-web .
#
# Run (weights are a READ-ONLY MOUNT, never part of the image). Mount the HF
# CACHE ROOT, not the snapshot dir: HF snapshots are symlinks into
# ../../blobs/... and a single mounted snapshot leaves them dangling.
#
#   docker run --rm -p 8000:8000 \
#     -e EMBEDDINGGEMMA_SNAPSHOT=/models/hf-cache \
#     -v ~/models/scanlist/hf-cache:/models/hf-cache:ro \
#     scanlist-web
#
# (EMBEDDINGGEMMA_SNAPSHOT may also point at a snapshot directory, a
# models--google--embeddinggemma-2 repo dir, or a cache root; the resolver tries
# all four layouts. The default inside the image is /models/embeddinggemma-2.)
#
# WEIGHTS ARE DELIBERATELY NOT BAKED INTO THE IMAGE. google/embeddinggemma-2's
# licence is unresolved inside the project (the HF card says Apache-2.0, the
# MediaPipe model card says the Gemma licence; Martin's ruling is pending), so
# the image carries code only and the 1.5 GB snapshot is mounted at
# EMBEDDINGGEMMA_SNAPSHOT. That also keeps the image ~1.6 GB smaller and makes
# a weight update a restart instead of a rebuild.
#
# Without a mount the server still starts and /health answers 200, but the
# embed endpoints return the documented 503 E_NO_MODEL envelope (C7 can
# feature-detect with modalities). `-e SCANLIST_EMBEDDER=fake` swaps in C1's
# deterministic fake, e.g. for a frontend-only demo.
#
# Multi-arch: python:3.12-slim is published for amd64+arm64 and the PyTorch CPU
# index ships cp312 wheels for both (torch 2.13.0+cpu / torchvision 0.28.0+cpu),
# so the same Dockerfile builds on an x86 runner and on an arm64 host.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    SCANLIST_EMBEDDER=gemma \
    SCANLIST_PROMPTS_JSON=/app/shared/spec/prompts.json \
    EMBEDDINGGEMMA_SNAPSHOT=/models/embeddinggemma-2 \
    HF_HUB_OFFLINE=1 \
    # One model resident; the embedder serialises calls, so more uvicorn
    # workers would only duplicate ~1.5 GB of weights.
    SCANLIST_TORCH_THREADS=4

WORKDIR /app

# C1/C8 runtime deps first (their layer cache is reused while only C3 code
# changes). requirements.txt is small; requirements-gemma.txt pulls torch.
COPY apps/web/server/requirements.txt apps/web/server/requirements-gemma.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt

# torch/torchvision from the explicit CPU index (the default PyPI linux/amd64
# wheels carry ~2 GB of CUDA); everything else from PyPI.
RUN pip install -r requirements-gemma.txt \
        --index-url https://download.pytorch.org/whl/cpu \
        --extra-index-url https://pypi.org/simple

# Unprivileged runtime user. A mounted weight file must be readable by it
# (HF snapshots are 0644 by default).
RUN useradd --create-home --uid 10001 appuser

COPY --chown=appuser:appuser apps/web/server/app ./app
COPY --chown=appuser:appuser apps/web/server/embedder_gemma.py ./embedder_gemma.py
# Prefixes are read at runtime from prompts.json (S5 contract); never hard-code.
COPY --chown=appuser:appuser shared/spec/prompts.json ./shared/spec/prompts.json

USER appuser

EXPOSE 8000

# /health is cheap and does not touch the weights (lazy load on first embed).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"

# Single worker: one model in RAM, embed calls serialised in embedder_gemma.py.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
