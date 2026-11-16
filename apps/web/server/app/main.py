"""ScanList web server (Track C) - FastAPI skeleton with a pluggable embedder.

Card C1: GET /health, POST /embed/text, POST /embed/image, GET /off/{barcode},
and static hosting of apps/web/frontend/dist when it has been built.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import httpx
from pydantic import BaseModel, Field

from .embedder import DEFAULT_DIMS, Embedder, build_embedder
from .off import OffClient, OffUpstreamError, is_valid_barcode

VERSION = "0.1.0"
SERVICE_NAME = "scanlist-web-server"
MAX_TEXTS_PER_REQUEST = 256
MAX_IMAGE_BYTES = 12 * 1024 * 1024  # a phone JPEG is well under this

# apps/web/server/app/main.py -> apps/web/frontend/dist
DEFAULT_FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"


class TextEmbedRequest(BaseModel):
    texts: list[str] = Field(..., max_length=MAX_TEXTS_PER_REQUEST)
    kind: str = Field(default="doc", pattern="^(doc|query)$")


class EmbedResponse(BaseModel):
    """Symmetric for text and image: same keys, same dims, list-of-vectors."""

    embeddings: list[list[float]]
    dims: int
    backend: str
    model: str


class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
    backend: str
    model: str
    dims: int
    modalities: list[str]


def create_app(
    *,
    embedder: Embedder | None = None,
    off_client: OffClient | None = None,
    frontend_dist: Path | None = None,
) -> FastAPI:
    embedder = embedder or build_embedder(
        backend=os.environ.get("SCANLIST_EMBEDDER", "fake"),
        dims=int(os.environ.get("SCANLIST_DIMS", DEFAULT_DIMS)),
    )
    off_client = off_client or OffClient(
        base_url=os.environ.get("SCANLIST_OFF_BASE_URL", "https://world.openfoodfacts.org"),
    )

    async def _lifespan(_app: FastAPI):  # pragma: no cover - trivial teardown
        yield
        await off_client.aclose()

    app = FastAPI(
        title="ScanList web server",
        version=VERSION,
        description="Embedding + Open Food Facts proxy for the ScanList web app (Track C).",
        lifespan=_lifespan,
    )
    app.state.embedder = embedder
    app.state.off_client = off_client

    @app.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        """Feature detection for clients (browser spike C7 checks `modalities`)."""
        return HealthResponse(
            status="ok",
            service=SERVICE_NAME,
            version=VERSION,
            backend=embedder.backend,
            model=embedder.name,
            dims=embedder.dims,
            modalities=list(embedder.modalities),
        )

    @app.post("/embed/text", response_model=EmbedResponse)
    async def embed_text(request: TextEmbedRequest) -> EmbedResponse:
        # TODO(C3): real embedder calls must run via anyio.to_thread (sync CPU work
        # inside `async def` stalls the event loop), and each text needs a length cap.
        if request.kind == "query":
            vectors = embedder.embed_queries(request.texts)
        else:
            vectors = embedder.embed_docs(request.texts)
        return EmbedResponse(
            embeddings=vectors, dims=embedder.dims, backend=embedder.backend, model=embedder.name
        )

    @app.post("/embed/image", response_model=EmbedResponse)
    async def embed_image(
        request: Request,
        payload: bytes | None = Body(None, media_type="image/jpeg"),
    ) -> EmbedResponse:
        """Embed one image (raw JPEG body, as the phone camera produces it)."""
        content_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
        if content_type and not (
            content_type.startswith("image/") or content_type == "application/octet-stream"
        ):
            raise HTTPException(
                status_code=415,
                detail="expected a raw image/* body (e.g. image/jpeg), not multipart/form-data",
            )
        if not payload:
            raise HTTPException(status_code=400, detail="empty image body")
        if len(payload) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="image body too large")
        if "image" not in embedder.modalities:
            raise HTTPException(
                status_code=501,
                detail=f"embedder {embedder.name!r} does not support image modality",
            )
        if payload[:3] != b"\xff\xd8\xff":
            raise HTTPException(
                status_code=400,
                detail="body is not a JPEG (missing FFD8FF magic); send raw JPEG bytes",
            )
        vectors = embedder.embed_images([payload])
        return EmbedResponse(
            embeddings=vectors, dims=embedder.dims, backend=embedder.backend, model=embedder.name
        )

    @app.get("/off/{barcode}")
    async def off_lookup(barcode: str) -> JSONResponse:
        if not is_valid_barcode(barcode):
            raise HTTPException(
                status_code=422, detail="barcode must be 8-14 digits (EAN-8/UPC-A/EAN-13)"
            )
        try:
            payload = await off_client.lookup(barcode)
        except OffUpstreamError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        except (ValueError, httpx.InvalidURL) as exc:
            # Belt for the barcode validator: whatever still reaches httpx is bad
            # input (400), not a server fault. httpx.InvalidURL is NOT an
            # httpx.HTTPError subclass, so it would otherwise escape as a 500.
            raise HTTPException(status_code=400, detail="invalid barcode") from exc
        # found=false is a real answer (negative-cached), so it is a 200.
        return JSONResponse(payload)

    dist = _resolve_frontend_dist(frontend_dist)

    @app.get("/", include_in_schema=False)
    async def root():
        if dist is not None:
            return FileResponse(dist / "index.html")
        return JSONResponse(
            {
                "service": SERVICE_NAME,
                "version": VERSION,
                "docs": "/docs",
                "frontend": "not built",
                "hint": "run `npm run build` in apps/web/frontend to serve the UI from /",
            }
        )

    if dist is not None:
        # Mounted last so API routes always win; also serves /assets/* and friends.
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="frontend")

    return app


def _resolve_frontend_dist(frontend_dist: Path | None) -> Path | None:
    dist = frontend_dist if frontend_dist is not None else DEFAULT_FRONTEND_DIST
    if dist.is_dir() and (dist / "index.html").is_file():
        return dist
    return None


app = create_app()
