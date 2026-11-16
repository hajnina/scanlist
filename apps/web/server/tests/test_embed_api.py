from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from app.embedder import FakeEmbedder
from app.main import create_app


def test_health_reports_backend_model_dims_and_modalities(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "scanlist-web-server"
    assert body["backend"] == "fake"
    assert body["model"] == "fake-embedder-256"
    assert body["dims"] == 256
    # Browser spike card C7 feature-detects on this list.
    assert body["modalities"] == ["text", "image"]
    assert body["version"] == "0.1.0"


def test_root_is_friendly_without_a_built_frontend() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/")
    assert response.status_code == 200
    assert response.json()["frontend"] == "not built"


def test_unknown_api_path_is_404_without_frontend() -> None:
    with TestClient(create_app()) as client:
        assert client.get("/nope").status_code == 404


@pytest.mark.parametrize(
    "payload",
    [
        {"texts": ["milk"], "kind": "doc"},
        {"texts": ["milk"], "kind": "query"},
        {"texts": ["milk", "bread", "eggs"], "kind": "doc"},
        {"texts": [], "kind": "doc"},
    ],
)
def test_embed_text_shapes(client: TestClient, payload: dict) -> None:
    response = client.post("/embed/text", json=payload)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["dims"] == 256
    assert body["backend"] == "fake"
    assert len(body["embeddings"]) == len(payload["texts"])
    for vector in body["embeddings"]:
        assert len(vector) == 256
        assert all(isinstance(value, float) for value in vector)
        assert math.isclose(math.sqrt(sum(v * v for v in vector)), 1.0, rel_tol=1e-9)


def test_embed_text_kind_defaults_to_doc(client: TestClient) -> None:
    explicit = client.post("/embed/text", json={"texts": ["milk"], "kind": "doc"}).json()
    default = client.post("/embed/text", json={"texts": ["milk"]}).json()
    assert explicit["embeddings"] == default["embeddings"]


def test_embed_text_is_deterministic_across_requests_and_apps(client: TestClient) -> None:
    payload = {"texts": ["milk 1 l", "Nutella", "café"], "kind": "doc"}
    expected = FakeEmbedder().embed_docs(payload["texts"])
    a = client.post("/embed/text", json=payload).json()["embeddings"]
    b = client.post("/embed/text", json=payload).json()["embeddings"]
    with TestClient(create_app()) as other_client:
        c = other_client.post("/embed/text", json=payload).json()["embeddings"]
    assert a == b == c == expected


def test_embed_text_doc_and_query_are_distinct_and_input_sensitive(client: TestClient) -> None:
    doc = client.post("/embed/text", json={"texts": ["Nutella"], "kind": "doc"}).json()
    query = client.post("/embed/text", json={"texts": ["Nutella"], "kind": "query"}).json()
    other = client.post("/embed/text", json={"texts": ["Nutella"], "kind": "doc"}).json()
    different = client.post("/embed/text", json={"texts": ["Nutella 400 g"], "kind": "doc"}).json()
    assert doc["embeddings"] == other["embeddings"]
    assert doc["embeddings"] != query["embeddings"]
    assert doc["embeddings"] != different["embeddings"]


def test_embed_text_rejects_unknown_kind(client: TestClient) -> None:
    assert client.post("/embed/text", json={"texts": ["x"], "kind": "image"}).status_code == 422


def test_embed_text_rejects_missing_texts(client: TestClient) -> None:
    assert client.post("/embed/text", json={"kind": "doc"}).status_code == 422


def test_embed_text_rejects_oversized_batch(client: TestClient) -> None:
    response = client.post("/embed/text", json={"texts": ["x"] * 257, "kind": "doc"})
    assert response.status_code == 422


# A minimal but structurally valid JPEG head: SOI + APP0/JFIF stub.
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" + b"\x00" * 32


def test_embed_image_accepts_a_raw_jpeg_body(client: TestClient) -> None:
    response = client.post("/embed/image", content=JPEG, headers={"content-type": "image/jpeg"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["dims"] == 256
    assert body["backend"] == "fake"
    assert body["model"] == "fake-embedder-256"
    assert len(body["embeddings"]) == 1
    assert len(body["embeddings"][0]) == 256


def test_embed_image_is_deterministic_and_image_sensitive(client: TestClient) -> None:
    headers = {"content-type": "image/jpeg"}
    first = client.post("/embed/image", content=JPEG, headers=headers).json()["embeddings"]
    again = client.post("/embed/image", content=JPEG, headers=headers).json()["embeddings"]
    other = client.post(
        "/embed/image", content=JPEG[:-1] + b"\x01", headers=headers
    ).json()["embeddings"]
    assert first == again
    assert first != other


def test_embed_image_accepts_octet_stream(client: TestClient) -> None:
    response = client.post(
        "/embed/image", content=JPEG, headers={"content-type": "application/octet-stream"}
    )
    assert response.status_code == 200


def test_embed_image_rejects_non_image_content_type(client: TestClient) -> None:
    response = client.post("/embed/image", content=JPEG, headers={"content-type": "text/plain"})
    assert response.status_code == 415


def test_embed_image_rejects_empty_and_non_jpeg_bodies(client: TestClient) -> None:
    empty = client.post("/embed/image", content=b"", headers={"content-type": "image/jpeg"})
    not_jpeg = client.post(
        "/embed/image", content=b"not a jpeg", headers={"content-type": "image/jpeg"}
    )
    assert empty.status_code == 400
    assert not_jpeg.status_code == 400
