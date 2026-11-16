"""Pluggable embedder interface + a deterministic fake implementation.

The real EmbeddingGemma 2 backend lands in card C3 (`embedder_gemma.py`); it must
implement the same `Embedder` protocol so clients never notice the swap.
See docs/ARCHITECTURE.md ("Embedding backends", "Common interface").

Contract kept deliberately symmetric for text and image:
    embed_docs(texts)   -> list[list[float]]   # one L2-normalised vector per text
    embed_queries(texts)-> list[list[float]]
    embed_images(blobs) -> list[list[float]]
All vectors are `dims` long (Matryoshka-truncated to 256 server-side), L2-normalised,
so cosine similarity is a plain dot product.
"""

from __future__ import annotations

import hashlib
import math
import random
from typing import Protocol, Sequence, runtime_checkable

DEFAULT_DIMS = 256


@runtime_checkable
class Embedder(Protocol):
    """Minimal surface the API relies on. Implemented by FakeEmbedder now, Gemma in C3."""

    name: str
    backend: str
    dims: int
    modalities: tuple[str, ...]

    def embed_docs(self, texts: Sequence[str]) -> list[list[float]]: ...

    def embed_queries(self, texts: Sequence[str]) -> list[list[float]]: ...

    def embed_images(self, images: Sequence[bytes]) -> list[list[float]]: ...


def l2_normalise(vector: Sequence[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vector))
    if norm == 0.0:  # pragma: no cover - gaussian noise never sums to zero
        raise ValueError("cannot normalise a zero vector")
    return [v / norm for v in vector]


def _seeded_unit_vector(seed_material: bytes, dims: int) -> list[float]:
    """Deterministic pseudo-random unit vector.

    `random.Random(int)` uses a stable Mersenne-Twister stream, so the same seed
    yields the same vector on every process, machine and Python version.
    """
    seed = int.from_bytes(hashlib.sha256(seed_material).digest(), "big")
    rng = random.Random(seed)
    return l2_normalise([rng.gauss(0.0, 1.0) for _ in range(dims)])


class FakeEmbedder:
    """Deterministic stand-in: same input -> identical vector, no model weights.

    Vectors carry no semantic meaning; they only exist so the API, cache and
    frontend plumbing can be built and tested before the real model arrives.
    Text kinds are salted separately (doc vs query) so the two paths are
    distinguishable in tests and logs, matching the prefix split in the spec.
    """

    def __init__(self, dims: int = DEFAULT_DIMS) -> None:
        if dims <= 0:
            raise ValueError("dims must be positive")
        self.dims = dims
        self.name = f"fake-embedder-{dims}"
        self.backend = "fake"
        self.modalities = ("text", "image")

    def embed_docs(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._embed_text("doc", text) for text in texts]

    def embed_queries(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._embed_text("query", text) for text in texts]

    def embed_images(self, images: Sequence[bytes]) -> list[list[float]]:
        return [_seeded_unit_vector(b"image:" + image, self.dims) for image in images]

    def _embed_text(self, kind: str, text: str) -> list[float]:
        return _seeded_unit_vector(f"{kind}:{text}".encode("utf-8"), self.dims)


def build_embedder(backend: str = "fake", dims: int = DEFAULT_DIMS) -> Embedder:
    """Factory used by the app config; C3 adds the `gemma` branch."""
    if backend == "fake":
        return FakeEmbedder(dims=dims)
    raise ValueError(f"unknown embedder backend {backend!r} (only 'fake' is available until C3)")
