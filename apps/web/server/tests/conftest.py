"""Shared fixtures: app factories with the deterministic FakeEmbedder + mocked OFF."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import httpx
import pytest
from fastapi.testclient import TestClient

from app.embedder import FakeEmbedder
from app.main import create_app
from app.off import OffClient


@pytest.fixture
def embedder() -> FakeEmbedder:
    return FakeEmbedder()


@pytest.fixture
def client(embedder: FakeEmbedder) -> TestClient:
    with TestClient(create_app(embedder=embedder)) as test_client:
        yield test_client


@pytest.fixture
def api(embedder: FakeEmbedder) -> Callable[..., TestClient]:
    """Factory: TestClient wired to a mock-transport OffClient (no real network)."""
    created: list[TestClient] = []

    def _make(off_client: OffClient, **kwargs) -> TestClient:
        test_client = TestClient(create_app(embedder=embedder, off_client=off_client, **kwargs))
        created.append(test_client)
        return test_client

    yield _make

    for test_client in created:
        test_client.close()


@pytest.fixture
def off_factory() -> Callable[..., OffClient]:
    """Factory: OffClient backed by httpx.MockTransport."""

    def _make(handler: Callable[[httpx.Request], httpx.Response], **kwargs) -> OffClient:
        return OffClient(transport=httpx.MockTransport(handler), **kwargs)

    return _make


@pytest.fixture
def frontend_dist(tmp_path: Path) -> Path:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>ScanList</title>", encoding="utf-8")
    (dist / "asset.txt").write_text("asset", encoding="utf-8")
    return dist
