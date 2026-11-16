"""Static hosting of apps/web/frontend/dist (absent = 404-friendly, API still works)."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app


def test_dist_is_served_when_present(frontend_dist: Path) -> None:
    with TestClient(create_app(frontend_dist=frontend_dist)) as client:
        index = client.get("/")
        asset = client.get("/asset.txt")
        missing = client.get("/does-not-exist")

    assert index.status_code == 200
    assert "ScanList" in index.text
    assert asset.status_code == 200
    assert asset.text == "asset"
    assert missing.status_code == 404


def test_api_routes_win_over_the_static_mount(frontend_dist: Path) -> None:
    with TestClient(create_app(frontend_dist=frontend_dist)) as client:
        health = client.get("/health")
        embed = client.post("/embed/text", json={"texts": ["milk"], "kind": "doc"})
        docs = client.get("/docs")

    assert health.status_code == 200
    assert health.json()["dims"] == 256
    assert embed.status_code == 200
    assert docs.status_code == 200


def test_missing_dist_keeps_the_api_usable(tmp_path: Path) -> None:
    with TestClient(create_app(frontend_dist=tmp_path / "nope")) as client:
        assert client.get("/").status_code == 200
        assert client.get("/").json()["frontend"] == "not built"
        assert client.post("/embed/text", json={"texts": ["x"]}).status_code == 200
        assert client.get("/anything").status_code == 404


def test_dist_without_index_html_is_not_mounted(tmp_path: Path) -> None:
    empty = tmp_path / "dist"
    empty.mkdir()
    with TestClient(create_app(frontend_dist=empty)) as client:
        assert client.get("/").json()["frontend"] == "not built"
