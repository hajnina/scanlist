"""Unit tests for the real EmbeddingGemma 2 embedder (card C3) - no weights.

These cover everything that does not need the 1.5 GB checkpoint: runtime prefix
loading from ``prompts.json``, RANK.md §2 truncate-then-normalise (compared with
the S2 oracle ``shared/ref/scanlist_ref.py``), the length cap, batching/dedupe,
the LRU cache, the lazy-load guard, the documented ``E_NO_MODEL`` 503 envelope
and the async (worker-thread) wrappers.

The real-model parity check lives in ``tests/test_golden_parity.py`` and skips
when the weights are not mounted, so CI (no torch, no weights) stays green.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import anyio
import pytest
from fastapi.testclient import TestClient

from app.embedder import FakeEmbedder
from app.main import create_app

from embedder_gemma import (
    E_NO_MODEL,
    MODEL_REVISION,
    NATIVE_DIMS,
    WEIGHTS_BYTES,
    GemmaEmbedder,
    NoModelError,
    Prefixes,
    apply_prefix,
    build_configured_embedder,
    cap_text,
    load_prompts,
    prefixes_from_prompts,
    resolve_snapshot,
    truncate_and_normalize,
)

REPO = Path(__file__).resolve().parents[4]  # tests -> server -> web -> apps -> repo
PROMPTS_JSON = REPO / "shared" / "spec" / "prompts.json"
GOLDEN_JSON = REPO / "shared" / "fixtures" / "golden.json"


# ---------------------------------------------------------------------------
# prompts.json: prefixes are read at runtime, never hard-coded
# ---------------------------------------------------------------------------
def test_prefixes_come_from_prompts_json_and_match_golden() -> None:
    prompts = load_prompts(PROMPTS_JSON)
    prefixes = prefixes_from_prompts(prompts)
    assert isinstance(prefixes, Prefixes)
    assert prefixes.active == prompts["active"]
    assert prefixes.doc == prompts[prompts["active"]]["doc"]
    assert prefixes.query == prompts[prompts["active"]]["query"]
    assert prefixes.image == prompts["imagePrefix"]

    golden = json.loads(GOLDEN_JSON.read_text(encoding="utf-8"))
    assert golden["prompts"]["active"] == prefixes.active
    assert golden["prompts"]["doc"] == prefixes.doc
    assert golden["prompts"]["query"] == prefixes.query
    assert golden["prompts"]["image"] == prefixes.image


def test_embedder_picks_up_a_changed_active_set_at_runtime(tmp_path: Path) -> None:
    prompts = json.loads(PROMPTS_JSON.read_text(encoding="utf-8"))
    prompts["active"] = "modelcard"
    custom = tmp_path / "prompts.json"
    custom.write_text(json.dumps(prompts), encoding="utf-8")

    embedder = GemmaEmbedder(prompts_path=custom, snapshot=tmp_path / "no-weights")
    assert embedder.prefixes.active == "modelcard"
    assert embedder.prefixes.doc == prompts["modelcard"]["doc"]
    assert embedder.prefixes.query == prompts["modelcard"]["query"]
    # nothing was loaded just to read the prefixes
    assert embedder.loaded is False


def test_prefixes_reject_unknown_active_set() -> None:
    prompts = load_prompts(PROMPTS_JSON)
    prompts["active"] = "nope"
    with pytest.raises(ValueError, match="no matching prefix set"):
        prefixes_from_prompts(prompts)


def test_missing_prompts_json_is_an_operator_error(tmp_path: Path) -> None:
    with pytest.raises(NoModelError) as info:
        load_prompts(tmp_path / "absent.json")
    assert info.value.code == E_NO_MODEL
    assert "prompts.json" in str(info.value)


# ---------------------------------------------------------------------------
# RANK.md §2: truncate to 256, then L2-normalise (oracle equality)
# ---------------------------------------------------------------------------
def _oracle():
    """Import the S2 oracle; skip if numpy is unavailable (CI)."""
    pytest.importorskip("numpy")
    ref_dir = REPO / "shared" / "ref"
    if str(ref_dir) not in sys.path:
        sys.path.insert(0, str(ref_dir))
    import scanlist_ref  # noqa: PLC0415

    return scanlist_ref


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_truncate_and_normalize_is_bit_identical_to_the_oracle(seed: int) -> None:
    import random

    ref = _oracle()
    rng = random.Random(seed)
    raw = [rng.uniform(-1.0, 1.0) for _ in range(NATIVE_DIMS)]
    # A tail that would dominate the norm if truncation happened after it.
    raw[300:] = [1e3] * (NATIVE_DIMS - 300)

    ours = truncate_and_normalize(raw, 256)
    oracle = ref.truncate_and_normalize(raw, ref.DIMS_ACTIVE)
    assert len(ours) == 256
    assert ours == [float(x) for x in oracle]  # exact, not approximate
    assert math.isclose(math.sqrt(sum(x * x for x in ours)), 1.0, rel_tol=1e-15)


def test_truncate_and_normalize_zero_and_invalid_vectors() -> None:
    zeros = truncate_and_normalize([0.0] * NATIVE_DIMS, 256)
    assert zeros == [0.0] * 256  # cosine 0.0, never NaN
    with pytest.raises(ValueError, match="need at least"):
        truncate_and_normalize([0.1] * 10, 256)
    with pytest.raises(ValueError, match="NaN/Inf"):
        truncate_and_normalize([float("nan")] + [0.1] * (NATIVE_DIMS - 1), 256)


# ---------------------------------------------------------------------------
# prefix + trim + cap (prompts.json rules)
# ---------------------------------------------------------------------------
def test_apply_prefix_trims_caps_and_keeps_case() -> None:
    prefix = "task: search result | text: "
    assert apply_prefix(prefix, "  Ml\u00e9ko POLOTU\u010cN\u00c9  ") == prefix + "Ml\u00e9ko POLOTU\u010cN\u00c9"
    long_text = "x" * 50
    assert apply_prefix(prefix, long_text, max_chars=10) == prefix + "x" * 10
    assert cap_text("  a  ") == "a"
    assert cap_text("abc", max_chars=0) == "abc"  # 0 disables the cap


# ---------------------------------------------------------------------------
# lazy load guard + weights resolution
# ---------------------------------------------------------------------------
def test_lazy_load_guard_raises_e_no_model(tmp_path: Path) -> None:
    embedder = GemmaEmbedder(snapshot=tmp_path / "missing")
    assert embedder.loaded is False
    assert embedder.load_count == 0
    with pytest.raises(NoModelError) as info:
        embedder.embed_docs(["milk"])
    assert info.value.code == E_NO_MODEL
    assert info.value.to_dict()["code"] == "E_NO_MODEL"
    assert info.value.hint and "EMBEDDINGGEMMA_SNAPSHOT" in info.value.hint
    assert embedder.loaded is False


def test_incomplete_weights_are_rejected_by_size(tmp_path: Path) -> None:
    snapshot = tmp_path / "snap"
    snapshot.mkdir()
    (snapshot / "model.safetensors").write_bytes(b"\0" * 64)
    with pytest.raises(NoModelError, match="expected"):
        resolve_snapshot(snapshot)


def test_resolve_snapshot_accepts_an_hf_cache_root(tmp_path: Path) -> None:
    snapshot = tmp_path / "hub" / "models--google--embeddinggemma-2" / "snapshots" / MODEL_REVISION
    snapshot.mkdir(parents=True)
    with open(snapshot / "model.safetensors", "wb") as handle:
        handle.truncate(WEIGHTS_BYTES)  # sparse: correct size, no 1.5 GB written
    assert resolve_snapshot(tmp_path) == snapshot


# ---------------------------------------------------------------------------
# E_NO_MODEL envelope on the HTTP surface (app.main wiring)
# ---------------------------------------------------------------------------
def test_embed_endpoints_return_the_e_no_model_envelope(tmp_path: Path) -> None:
    embedder = GemmaEmbedder(snapshot=tmp_path / "missing")
    with TestClient(create_app(embedder=embedder)) as client:
        text = client.post("/embed/text", json={"texts": ["milk"], "kind": "doc"})
        image = client.post(
            "/embed/image", content=b"\xff\xd8\xff\xe0" + b"\0" * 64,
            headers={"content-type": "image/jpeg"},
        )
        health = client.get("/health")

    for response in (text, image):
        assert response.status_code == 503, response.text
        body = response.json()
        assert body["error"]["code"] == E_NO_MODEL
        assert body["error"]["message"]
        assert body["error"]["hint"]

    assert health.status_code == 200
    health_body = health.json()
    assert health_body["backend"] == "gemma-cpu-fp32"
    assert health_body["model"] == "embeddinggemma-2-740m"
    assert health_body["dims"] == 256
    assert health_body["modalities"] == ["text", "image"]


# ---------------------------------------------------------------------------
# batching / dedupe / cache / normalisation, with a stub encoder (no weights)
# ---------------------------------------------------------------------------
class StubGemma(GemmaEmbedder):
    """GemmaEmbedder with the model call replaced by deterministic raw vectors."""

    def __init__(self, **kwargs) -> None:
        super().__init__(snapshot=kwargs.pop("snapshot", None), **kwargs)
        self.encoded_texts: list[list[str]] = []
        self.encoded_images: list[bytes] = []

    def _encode_texts(self, prepared):
        self.encoded_texts.append(list(prepared))
        return [self._raw(text) for text in prepared]

    def _encode_image(self, blob: bytes):
        self.encoded_images.append(blob)
        return self._raw(repr(blob))

    @staticmethod
    def _raw(material: str) -> list[float]:
        import hashlib
        import random

        seed = int.from_bytes(hashlib.sha256(material.encode("utf-8")).digest(), "big")
        rng = random.Random(seed)
        return [rng.gauss(0.0, 1.0) for _ in range(NATIVE_DIMS)]


def test_text_path_applies_prefix_batches_dedupes_and_caches(tmp_path: Path) -> None:
    embedder = StubGemma(snapshot=tmp_path / "unused", max_chars=8)
    prefixes = embedder.prefixes

    vectors = embedder.embed_docs(["  Milk  ", "Milk", "a-very-long-name"])
    assert len(vectors) == 3
    assert embedder.encoded_texts == [[
        prefixes.doc + "Milk",
        prefixes.doc + "a-very-l",  # trimmed + capped at 8 before the prefix is added
    ]]
    assert vectors[0] == vectors[1]  # duplicate input shares one encode + vector
    for vector in vectors:
        assert len(vector) == 256
        assert math.isclose(math.sqrt(sum(v * v for v in vector)), 1.0, rel_tol=1e-12)
    assert embedder.last_batch_size == 3
    assert embedder.last_cache_hits == 0
    assert embedder.last_latency_ms is not None and embedder.last_latency_ms >= 0

    again = embedder.embed_docs(["Milk"])
    assert again[0] == vectors[0]
    assert len(embedder.encoded_texts) == 1  # cache hit: no second encode
    assert embedder.last_cache_hits == 1

    query = embedder.embed_queries(["Milk"])[0]
    assert query != vectors[0]  # doc/query prefixes are different embeddings
    assert embedder.encoded_texts[-1] == [prefixes.query + "Milk"]


def test_truncation_happens_before_normalisation_in_the_text_path(tmp_path: Path) -> None:
    embedder = StubGemma(snapshot=tmp_path / "unused")
    prepared = embedder.prefixes.doc + "milk"
    expected = truncate_and_normalize(StubGemma._raw(prepared), 256)
    assert embedder.embed_docs(["milk"])[0] == expected


def test_image_path_uses_no_prefix_and_caches(tmp_path: Path) -> None:
    embedder = StubGemma(snapshot=tmp_path / "unused")
    blob = b"\xff\xd8\xffjpeg-bytes"
    first = embedder.embed_images([blob])
    second = embedder.embed_images([blob])
    assert first == second
    assert embedder.encoded_images == [blob]
    assert embedder.last_cache_hits == 1
    with pytest.raises(TypeError):
        embedder.embed_images(["not bytes"])  # type: ignore[list-item]


def test_empty_inputs_do_not_touch_the_model(tmp_path: Path) -> None:
    embedder = StubGemma(snapshot=tmp_path / "unused")
    assert embedder.embed_docs([]) == []
    assert embedder.embed_queries([]) == []
    assert embedder.embed_images([]) == []
    assert embedder.encoded_texts == []
    assert embedder.loaded is False


def test_async_wrappers_offload_and_return_the_same_vectors(tmp_path: Path) -> None:
    embedder = StubGemma(snapshot=tmp_path / "unused")
    expected = embedder.embed_docs(["milk"])
    embedder.cache_clear()
    assert anyio.run(embedder.aembed_docs, ["milk"]) == expected
    assert anyio.run(embedder.aembed_queries, ["milk"]) != expected
    image = anyio.run(embedder.aembed_images, [b"\xff\xd8\xffx"])
    assert len(image[0]) == 256


def test_dims_are_validated(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        GemmaEmbedder(snapshot=tmp_path, dims=0)
    with pytest.raises(ValueError):
        GemmaEmbedder(snapshot=tmp_path, dims=NATIVE_DIMS + 1)


# ---------------------------------------------------------------------------
# factory: SCANLIST_EMBEDDER=gemma without touching C1's build_embedder
# ---------------------------------------------------------------------------
def test_build_configured_embedder_selects_gemma_or_fake(monkeypatch) -> None:
    gemma = build_configured_embedder(backend="gemma")
    assert isinstance(gemma, GemmaEmbedder)
    assert gemma.loaded is False

    fake = build_configured_embedder(backend="fake")
    assert isinstance(fake, FakeEmbedder)

    monkeypatch.setenv("SCANLIST_EMBEDDER", "embeddinggemma-2")
    assert isinstance(build_configured_embedder(), GemmaEmbedder)

    with pytest.raises(ValueError, match="unknown embedder backend"):
        build_configured_embedder(backend="nope")


def test_fake_embedder_envelope_is_unchanged() -> None:
    """The E_NO_MODEL wiring must not change the fake envelope (C1 contract)."""
    with TestClient(create_app(embedder=FakeEmbedder())) as client:
        response = client.post("/embed/text", json={"texts": ["milk"], "kind": "doc"})
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"embeddings", "dims", "backend", "model"}
    assert body["backend"] == "fake"


def test_gemma_responses_keep_the_envelope_and_carry_latency(tmp_path: Path) -> None:
    embedder = StubGemma(snapshot=tmp_path / "unused")
    with TestClient(create_app(embedder=embedder)) as client:
        response = client.post("/embed/text", json={"texts": ["milk"], "kind": "query"})
        image = client.post(
            "/embed/image", content=b"\xff\xd8\xff\xe0" + b"\0" * 32,
            headers={"content-type": "image/jpeg"},
        )
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"embeddings", "dims", "backend", "model"}
    assert body["dims"] == 256
    assert body["backend"] == "gemma-cpu-fp32"
    assert body["model"] == "embeddinggemma-2-740m"
    assert len(body["embeddings"][0]) == 256
    assert float(response.headers["x-embed-ms"]) >= 0.0  # card X1 consumes this
    assert image.status_code == 200
    assert float(image.headers["x-embed-ms"]) >= 0.0
