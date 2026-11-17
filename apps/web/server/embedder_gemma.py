"""Real EmbeddingGemma 2 embedder for the ScanList web server (card C3).

What this module is
-------------------
A drop-in implementation of the ``app.embedder.Embedder`` protocol backed by the
real multimodal model, so ``/embed/text`` and ``/embed/image`` return vectors in
the same 256-d space as the phone and the golden fixture.

Provenance (do not "improve" these without re-running the parity test)
----------------------------------------------------------------------
* Model: HF ``google/embeddinggemma-2`` at revision
  ``f9972ac22e696a105c482202646979e33e4b5a1e`` (740M params, text + vision +
  audio). Weights sha256 ``197a3296...553d79``, 1,488,915,288 B.
* Loading/encoding recipe copied from card S3's proven producer
  ``shared/tools/make_golden.py`` (``Encoder``): CPU, **float32** (the model card
  forbids float16 - NaN / silent degradation), sentence-transformers style,
  ``truncate_dim=None`` + ``normalize_embeddings=False`` and then RANK.md §2's
  truncate-then-normalise, done here with :func:`truncate_and_normalize`.
* Prefixes come from ``shared/spec/prompts.json`` **at runtime** (active set is
  ``mnemothera`` today). They are never hard-coded: card S5's ``Prompts.kt``
  contract is the same, and the A/B winner can move without a code change.
* Images take **no prefix** (``imagePrefix`` is empty in prompts.json) and go
  through the model's vision tower exactly as S3 did it
  (``model.encode({"image": PIL.Image})``), which is what produced image top-1
  0.923 in ``shared/fixtures/PREFIX_AB.md``.

Deliberate choices
------------------
* **Lazy load**: importing this module never imports torch; the ~1.5 GB of
  weights are loaded on the first embed call (``_ensure_model``). Startup stays
  fast and CI (no weights) stays green.
* **No event-loop blocking**: ``embed_*`` are synchronous CPU calls; the server
  must await ``aembed_*``, which offloads to a worker thread via
  ``anyio.to_thread.run_sync``. A process-wide lock serialises model calls
  (one model, one call at a time - the 400 ms scan cadence must not stack
  batches). This honours the lead note on PR #5.
* **Bounded inputs**: each text is capped at ``max_chars`` (default 2048)
  before the prefix is added and the tokeniser is capped at
  ``max_seq_tokens`` (default 512). An 8192-token input is a memory/latency
  foot-gun on CPU; shopping list texts and OCR lines are far shorter.
* **Bounded cache**: an LRU of (prefix+text / image bytes) -> final vector,
  keyed by sha256 so a prefix change (from prompts.json) is a different key.

Missing weights are a *documented* error, not a crash: :class:`NoModelError`
carries ``code = "E_NO_MODEL"`` and ``app.main`` turns it into HTTP 503 with
``{"error": {"code": "E_NO_MODEL", ...}}``. The fake embedder remains the
default (``SCANLIST_EMBEDDER=fake``) for tests/CI.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import math
import os
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

logger = logging.getLogger(__name__)

# --- model identity (must match shared/fixtures/golden.json) -----------------
MODEL_ID = "embeddinggemma-2-740m"
HF_REPO = "google/embeddinggemma-2"
MODEL_REVISION = "f9972ac22e696a105c482202646979e33e4b5a1e"
WEIGHTS_SHA256 = "197a32965d4b1105faf060417baa899e193fb73cd401f42ec9295234d5553d79"
WEIGHTS_BYTES = 1_488_915_288
NATIVE_DIMS = 768

DEFAULT_DIMS = 256
DEFAULT_MAX_CHARS = 2048
DEFAULT_MAX_SEQ_TOKENS = 512
DEFAULT_BATCH_SIZE = 16
DEFAULT_CACHE_SIZE = 4096
def _env_threads() -> int | None:
    """SCANLIST_TORCH_THREADS (0/unset = torch default); bad values never crash import."""
    try:
        value = int(os.environ.get("SCANLIST_TORCH_THREADS", "0"))
    except ValueError:
        logger.warning("ignoring non-numeric SCANLIST_TORCH_THREADS=%r",
                       os.environ.get("SCANLIST_TORCH_THREADS"))
        return None
    return value or None


DEFAULT_THREADS = _env_threads()

E_NO_MODEL = "E_NO_MODEL"

# Same cache location card S3 downloaded into (weights live OUTSIDE git).
DEFAULT_SNAPSHOT = Path(
    os.path.expanduser(
        "~/models/scanlist/hf-cache/hub/models--google--embeddinggemma-2/"
        f"snapshots/{MODEL_REVISION}"
    )
)

# apps/web/server/embedder_gemma.py -> repo/shared/spec/prompts.json
# In the Docker image the module sits at /app/embedder_gemma.py and the Dockerfile
# copies prompts.json to /app/shared/spec/, so fall back to the module's own
# directory when there is no repo above it.
_SERVER_DIR = Path(__file__).resolve().parent
REPO_ROOT = _SERVER_DIR.parents[2] if len(_SERVER_DIR.parents) >= 3 else _SERVER_DIR
DEFAULT_PROMPTS_PATH = REPO_ROOT / "shared" / "spec" / "prompts.json"

GEMMA_BACKENDS = frozenset({"gemma", "embeddinggemma", "embeddinggemma-2"})


class NoModelError(RuntimeError):
    """EmbeddingGemma weights/stack unavailable -> HTTP 503 ``E_NO_MODEL``.

    ``hint`` is for operators (how to fix it); ``message`` is safe for clients.
    """

    code = E_NO_MODEL

    def __init__(self, message: str, *, hint: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint

    def to_dict(self) -> dict[str, str]:
        payload = {"code": self.code, "message": self.message}
        if self.hint:
            payload["hint"] = self.hint
        return payload


# ---------------------------------------------------------------------------
# prompts.json (runtime prefixes; never hard-code these)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Prefixes:
    """The active prefix set from ``shared/spec/prompts.json``."""

    active: str
    doc: str
    query: str
    image: str

    def for_kind(self, kind: str) -> str:
        if kind == "doc":
            return self.doc
        if kind == "query":
            return self.query
        if kind == "image":
            return self.image
        raise ValueError(f"unknown embed kind {kind!r} (expected 'doc', 'query' or 'image')")


def load_prompts(path: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """Read ``prompts.json`` (env override ``SCANLIST_PROMPTS_JSON``).

    A missing/unreadable file is an operator error, not a client error, so it
    raises :class:`NoModelError` too (same 503 envelope, different message).
    """
    resolved = Path(path or os.environ.get("SCANLIST_PROMPTS_JSON") or DEFAULT_PROMPTS_PATH)
    try:
        return json.loads(resolved.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise NoModelError(
            f"prompts.json not found at {resolved}",
            hint="set SCANLIST_PROMPTS_JSON or ship shared/spec/prompts.json "
                 "next to the server (the Dockerfile copies it to /app/shared/spec)",
        ) from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise NoModelError(
            f"cannot read prompts.json at {resolved}: {exc}",
            hint="fix the file; prefixes must never be hard-coded",
        ) from exc


def prefixes_from_prompts(prompts: dict[str, Any]) -> Prefixes:
    """Extract the active prefix set; validate instead of guessing defaults."""
    active = prompts.get("active")
    if not isinstance(active, str) or not active:
        raise ValueError("prompts.json has no 'active' prefix set name")
    if active not in prompts or not isinstance(prompts[active], dict):
        raise ValueError(f"prompts.json active={active!r} has no matching prefix set")
    chosen = prompts[active]
    doc, query = chosen.get("doc"), chosen.get("query")
    if not isinstance(doc, str) or not isinstance(query, str):
        raise ValueError(f"prompts.json set {active!r} needs string 'doc' and 'query' prefixes")
    image = prompts.get("imagePrefix", "")
    if not isinstance(image, str):
        raise ValueError("prompts.json imagePrefix must be a string (empty for this model)")
    return Prefixes(active=active, doc=doc, query=query, image=image)


# ---------------------------------------------------------------------------
# RANK.md §2: truncate to 256 then L2-normalise (float64, exact order)
# ---------------------------------------------------------------------------
def truncate_and_normalize(vec: Sequence[float], dims: int = DEFAULT_DIMS) -> list[float]:
    """First ``dims`` components in float64, then L2-normalise.

    Bit-identical to ``shared/ref/scanlist_ref.truncate_and_normalize`` (the
    oracle): same widening, same ``math.fsum`` norm, same per-component
    division, all in float64. A norm below 1e-12 yields the all-zero vector, so
    cosine is 0.0 instead of NaN. Kept dependency-free (no numpy) so the server
    unit tests run in CI where torch/numpy are not installed.
    """
    values = [float(x) for x in vec]
    if len(values) < dims:
        raise ValueError(f"vector has {len(values)} dims, need at least {dims}")
    truncated = values[:dims]
    if not all(math.isfinite(x) for x in truncated):
        raise ValueError("vector contains NaN/Inf")
    norm = math.sqrt(math.fsum(x * x for x in truncated))
    if norm < 1e-12:
        return [0.0] * dims
    return [x / norm for x in truncated]


def cap_text(text: str, max_chars: int = DEFAULT_MAX_CHARS) -> str:
    """Trim Unicode whitespace and hard-cap the code points (tokeniser guard)."""
    trimmed = text.strip()
    if max_chars > 0 and len(trimmed) > max_chars:
        return trimmed[:max_chars]
    return trimmed


def apply_prefix(prefix: str, text: str, max_chars: int = DEFAULT_MAX_CHARS) -> str:
    """``prefix + trim(text)`` per ``prompts.json`` rules, with the length cap."""
    return prefix + cap_text(text, max_chars)


def _sha256_hex(material: bytes) -> str:
    return hashlib.sha256(material).hexdigest()


# ---------------------------------------------------------------------------
# snapshot resolution
# ---------------------------------------------------------------------------
def _candidate_snapshots(root: Path) -> Iterable[Path]:
    """Accept a snapshot dir, an HF cache root or a ``models--`` repo dir."""
    yield root
    yield root / "snapshots" / MODEL_REVISION
    yield root / "hub" / "models--google--embeddinggemma-2" / "snapshots" / MODEL_REVISION
    yield root / "models--google--embeddinggemma-2" / "snapshots" / MODEL_REVISION


def resolve_snapshot(snapshot: str | os.PathLike[str] | None = None) -> Path:
    """Find the local weights and verify their size (and sha256 on request).

    Raises :class:`NoModelError` with an operator hint when the weights are
    absent or incomplete. Never downloads: the server must not fetch 1.5 GB on
    a request path (and the image must not bake weights in - licence pending).
    """
    raw = snapshot or os.environ.get("EMBEDDINGGEMMA_SNAPSHOT") or DEFAULT_SNAPSHOT
    root = Path(os.path.expanduser(str(raw)))
    for candidate in _candidate_snapshots(root):
        weights = candidate / "model.safetensors"
        if not weights.is_file():
            continue
        size = weights.stat().st_size
        if size != WEIGHTS_BYTES:
            raise NoModelError(
                f"EmbeddingGemma weights at {weights} are {size} B, expected "
                f"{WEIGHTS_BYTES} B (incomplete download?)",
                hint="re-download google/embeddinggemma-2 at revision "
                     f"{MODEL_REVISION} with the resumable downloader",
            )
        if os.environ.get("SCANLIST_VERIFY_WEIGHTS", "").lower() in {"1", "true", "yes"}:
            started = time.perf_counter()
            hasher = hashlib.sha256()
            with weights.open("rb") as handle:  # chunked: never 1.5 GB in RAM
                for chunk in iter(lambda: handle.read(64 * 1024 * 1024), b""):
                    hasher.update(chunk)
            digest = hasher.hexdigest()
            if digest != WEIGHTS_SHA256:
                raise NoModelError(
                    f"EmbeddingGemma weights sha256 {digest} != {WEIGHTS_SHA256}",
                    hint="the file is corrupt or the revision moved; re-download it",
                )
            logger.info(
                "embedder_weights_verified sha256=%s ms=%.0f",
                digest,
                (time.perf_counter() - started) * 1000,
            )
        return candidate
    raise NoModelError(
        f"EmbeddingGemma weights not found under {root}",
        hint="mount the HF snapshot at EMBEDDINGGEMMA_SNAPSHOT (see "
             "apps/web/server/README + Dockerfile) or run with SCANLIST_EMBEDDER=fake",
    )


# ---------------------------------------------------------------------------
# the embedder
# ---------------------------------------------------------------------------
class GemmaEmbedder:
    """EmbeddingGemma 2 on CPU, float32, 256-d output (Matryoshka-truncated).

    Implements the ``app.embedder.Embedder`` protocol. Model loading is lazy and
    guarded by a lock; every model call runs under a second lock so batches are
    serialised, and the async wrappers move the work off the event loop.
    """

    def __init__(
        self,
        *,
        snapshot: str | os.PathLike[str] | None = None,
        prompts_path: str | os.PathLike[str] | None = None,
        dims: int = DEFAULT_DIMS,
        batch_size: int = DEFAULT_BATCH_SIZE,
        max_chars: int = DEFAULT_MAX_CHARS,
        max_seq_tokens: int = DEFAULT_MAX_SEQ_TOKENS,
        threads: int | None = DEFAULT_THREADS,
        cache_size: int = DEFAULT_CACHE_SIZE,
    ) -> None:
        if dims <= 0 or dims > NATIVE_DIMS:
            raise ValueError(f"dims must be 1..{NATIVE_DIMS} (native 768, active 256)")
        self.dims = int(dims)
        self.batch_size = max(1, int(batch_size))
        self.max_chars = int(max_chars)
        self.max_seq_tokens = int(max_seq_tokens)
        self.threads = threads
        self.cache_size = max(0, int(cache_size))
        self.snapshot = snapshot
        self.prompts_path = prompts_path
        self._prefixes: Prefixes | None = None

        self._model: Any | None = None
        self._load_lock = threading.Lock()
        self._call_lock = threading.Lock()
        self._cache: OrderedDict[str, list[float]] = OrderedDict()

        self.load_ms: float | None = None
        self.load_count = 0
        self.last_latency_ms: float | None = None
        self.last_batch_size = 0
        self.last_cache_hits = 0
        self.total_calls = 0

    # -- protocol surface -------------------------------------------------
    @property
    def name(self) -> str:
        return MODEL_ID

    @property
    def backend(self) -> str:
        return "gemma-cpu-fp32"

    @property
    def modalities(self) -> tuple[str, ...]:
        # EmbeddingGemma 2 is text + vision (+audio, unused here). Reported even
        # before the weights load: /health describes the model, and the embed
        # endpoints answer 503 E_NO_MODEL until the weights are mounted.
        return ("text", "image")

    @property
    def prefixes(self) -> Prefixes:
        """Active prefixes from prompts.json, read on first use (runtime)."""
        if self._prefixes is None:
            self._prefixes = prefixes_from_prompts(load_prompts(self.prompts_path))
        return self._prefixes

    @property
    def loaded(self) -> bool:
        return self._model is not None

    # -- model lifecycle --------------------------------------------------
    def _ensure_model(self) -> Any:
        """Lazy-load the model once (thread-safe). Raises :class:`NoModelError`."""
        if self._model is not None:
            return self._model
        with self._load_lock:
            if self._model is not None:  # double-checked: first caller won
                return self._model
            snapshot = resolve_snapshot(self.snapshot)
            try:
                import torch  # noqa: PLC0415 - heavy, imported only when needed
                from sentence_transformers import SentenceTransformer  # noqa: PLC0415
            except ImportError as exc:  # pragma: no cover - CI never gets here
                raise NoModelError(
                    f"EmbeddingGemma Python stack is not installed: {exc}",
                    hint="pip install -r apps/web/server/requirements-gemma.txt "
                         "(torch CPU + sentence-transformers) or use SCANLIST_EMBEDDER=fake",
                ) from exc
            if self.threads:
                torch.set_num_threads(int(self.threads))
            torch.manual_seed(0)
            started = time.perf_counter()
            logger.info("embedder_load_started snapshot=%s dtype=float32", snapshot)
            # float16 is forbidden by the model card; the config's bfloat16 is
            # overridden with float32, exactly like shared/tools/make_golden.py.
            # audio_config=None skips the 300M audio encoder we never use.
            model = SentenceTransformer(
                str(snapshot),
                model_kwargs={"torch_dtype": torch.float32},
                config_kwargs={"audio_config": None},
            )
            model.eval()
            # 8192-token context is a memory foot-gun on CPU; shopping texts and
            # OCR lines fit easily in 512 tokens.
            model.max_seq_length = self.max_seq_tokens
            self._model = model
            self.load_ms = (time.perf_counter() - started) * 1000.0
            self.load_count += 1
            logger.info(
                "embedder_loaded model=%s revision=%s dims=%d load_ms=%.0f",
                MODEL_ID, MODEL_REVISION, self.dims, self.load_ms,
            )
            return model

    # -- cache ------------------------------------------------------------
    def _cache_get(self, key: str) -> list[float] | None:
        vector = self._cache.get(key)
        if vector is not None:
            self._cache.move_to_end(key)
        return vector

    def _cache_put(self, key: str, vector: list[float]) -> None:
        if self.cache_size <= 0:
            return
        self._cache[key] = vector
        self._cache.move_to_end(key)
        while len(self._cache) > self.cache_size:
            self._cache.popitem(last=False)

    def cache_clear(self) -> None:
        self._cache.clear()

    # -- encoding seams (overridden by the unit tests' stub) ---------------
    def _encode_texts(self, prepared: Sequence[str]) -> list[Sequence[float]]:
        """Raw 768-d model output for already-prefixed texts."""
        model = self._ensure_model()
        out = model.encode(
            list(prepared),
            batch_size=self.batch_size,
            truncate_dim=None,           # truncate ourselves, RANK.md §2 order
            normalize_embeddings=False,  # normalise ourselves, after truncation
            show_progress_bar=False,
            convert_to_numpy=True,
        )
        return [list(row) for row in out]

    def _encode_image(self, blob: bytes) -> Sequence[float]:
        """Raw 768-d model output for one image (no prefix, per prompts.json)."""
        # Load (and validate) the model first: missing weights are the expected
        # failure and must surface as E_NO_MODEL, not as a missing-Pillow import
        # (CI installs neither).
        model = self._ensure_model()
        try:
            from PIL import Image  # noqa: PLC0415 - pulled in by sentence-transformers
        except ImportError as exc:  # pragma: no cover - pillow ships with ST
            raise NoModelError(
                f"image embedding needs Pillow: {exc}",
                hint="pip install -r apps/web/server/requirements-gemma.txt",
            ) from exc
        with Image.open(io.BytesIO(blob)) as image:
            image = image.convert("RGB")
            out = model.encode(
                {"image": image},
                truncate_dim=None,
                normalize_embeddings=False,
                show_progress_bar=False,
                convert_to_numpy=True,
            )
        return list(out.reshape(-1))

    # -- public sync API (protocol) ---------------------------------------
    def embed_docs(self, texts: Sequence[str]) -> list[list[float]]:
        return self._embed_texts("doc", texts)

    def embed_queries(self, texts: Sequence[str]) -> list[list[float]]:
        return self._embed_texts("query", texts)

    def embed_images(self, images: Sequence[bytes]) -> list[list[float]]:
        blobs = list(images)
        if not blobs:
            return []
        prefix = self.prefixes.image
        if prefix:
            logger.warning("prompts.json imagePrefix is non-empty (%r); this model expects none", prefix)
        started = time.perf_counter()
        loaded_before = self.loaded
        hits = 0
        with self._call_lock:
            vectors: list[list[float]] = []
            for blob in blobs:
                if not isinstance(blob, (bytes, bytearray, memoryview)):
                    raise TypeError("embed_images expects raw image bytes")
                key = "image:" + _sha256_hex(bytes(blob))
                cached = self._cache_get(key)
                if cached is not None:
                    hits += 1
                    vectors.append(cached)
                    continue
                vector = truncate_and_normalize(self._encode_image(bytes(blob)), self.dims)
                self._cache_put(key, vector)
                vectors.append(vector)
        self._record_latency(started, len(blobs), hits, "image", loaded_before)
        return vectors

    def _embed_texts(self, kind: str, texts: Sequence[str]) -> list[list[float]]:
        items = list(texts)
        if not items:
            return []
        prefix = self.prefixes.for_kind(kind)
        prepared = [apply_prefix(prefix, str(text), self.max_chars) for text in items]
        keys = [f"{kind}:" + _sha256_hex(text.encode("utf-8")) for text in prepared]

        started = time.perf_counter()
        loaded_before = self.loaded
        hits = 0
        with self._call_lock:
            vectors: list[list[float]] = [None] * len(items)  # type: ignore[list-item]
            missing: list[int] = []
            for index, key in enumerate(keys):
                cached = self._cache_get(key)
                if cached is not None:
                    hits += 1
                    vectors[index] = cached
                else:
                    missing.append(index)
            if missing:
                # Batch only the uncached texts, in first-seen order; duplicates
                # inside one request share a single encode (keys are identical).
                unique: dict[str, int] = {}
                order: list[str] = []
                for index in missing:
                    key = keys[index]
                    if key not in unique:
                        unique[key] = index
                        order.append(key)
                encoded = self._encode_texts([prepared[unique[key]] for key in order])
                fresh: dict[str, list[float]] = {}
                for key, raw in zip(order, encoded):
                    vector = truncate_and_normalize(raw, self.dims)
                    self._cache_put(key, vector)
                    fresh[key] = vector
                for index in missing:
                    vectors[index] = fresh[keys[index]]
        self._record_latency(started, len(items), hits, kind, loaded_before)
        return [list(vector) for vector in vectors]

    # -- async wrappers: keep the event loop free -------------------------
    async def aembed_docs(self, texts: Sequence[str]) -> list[list[float]]:
        return await self._offload(self.embed_docs, texts)

    async def aembed_queries(self, texts: Sequence[str]) -> list[list[float]]:
        return await self._offload(self.embed_queries, texts)

    async def aembed_images(self, images: Sequence[bytes]) -> list[list[float]]:
        return await self._offload(self.embed_images, images)

    @staticmethod
    async def _offload(fn, payload):
        import anyio  # noqa: PLC0415 - FastAPI/Starlette already depend on anyio
        from functools import partial  # noqa: PLC0415

        return await anyio.to_thread.run_sync(partial(fn, payload))

    # -- bookkeeping ------------------------------------------------------
    def _record_latency(
        self, started: float, count: int, hits: int, kind: str, loaded_before: bool
    ) -> None:
        elapsed = (time.perf_counter() - started) * 1000.0
        if not loaded_before and self.loaded and self.load_ms:
            # The first call pays for the lazy load; report the embed time only
            # (`self.load_ms` is exposed separately) so X1 compares like for like.
            elapsed = max(0.0, elapsed - self.load_ms)
        self.last_latency_ms = elapsed
        self.last_batch_size = count
        self.last_cache_hits = hits
        self.total_calls += 1
        logger.info(
            "embed_call kind=%s n=%d cache_hits=%d ms=%.1f loaded=%s",
            kind, count, hits, self.last_latency_ms, self.loaded,
        )


# ---------------------------------------------------------------------------
# factory used by app.main (keeps C1's `build_embedder` untouched)
# ---------------------------------------------------------------------------
def build_configured_embedder(
    *,
    backend: str | None = None,
    dims: int = DEFAULT_DIMS,
    **kwargs: Any,
):
    """Build the embedder named by ``SCANLIST_EMBEDDER`` (default ``fake``).

    ``gemma`` / ``embeddinggemma`` / ``embeddinggemma-2`` select this module;
    everything else goes through C1's ``app.embedder.build_embedder`` so the
    fake stays the CI/test default and its error messages stay authoritative.
    """
    from app.embedder import build_embedder  # noqa: PLC0415 - avoids an import cycle

    chosen = backend if backend is not None else os.environ.get("SCANLIST_EMBEDDER", "fake")
    if str(chosen).strip().lower() in GEMMA_BACKENDS:
        return GemmaEmbedder(dims=dims, **kwargs)
    return build_embedder(backend=chosen, dims=dims)
