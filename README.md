# ScanList

Shopping list from nested JSON (section → item → amount) with a **magic scanner**: point the phone at a product and
EmbeddingGemma 2 (text + image embeddings, on-device GPU/CPU/NPU or on a server) sorts the list by similarity so you tick it off fast.

Three implementations, compared: `apps/kotlin` (Compose), `apps/rn` (React Native), `apps/web` (browser + FastAPI server).

- Architecture: `docs/ARCHITECTURE.md` · Plan: `docs/PLAN.md` · List format: `docs/list.schema.json`
- Kanban: `kanban/README.md`, `python3 kanban/board.py`
- References (read-only copies): `references/embeddinggemma/RECIPE.md` (from MnemoThera / Therapy_local),
  `references/bonsai-ui/STYLE_GUIDE.md` (from Bonsai Serve), `references/REFERENCES.md`
