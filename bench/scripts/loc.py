#!/usr/bin/env python3
"""X1 — lines of code per track (a `cloc` stand-in; the laptop has no cloc and we can't sudo-install).

Counts only hand-written source in the five areas the comparison cares about, and splits **source**
from **test** because that ratio is itself a result: the Kotlin track's golden/parity tests are a large
fraction of its bytes.

    python3 bench/scripts/loc.py            # -> bench/results/fragments/loc.json

Rules (documented in the README):
  * include: .kt .kts .java .ts .tsx .js .jsx .mjs .css .html .py .sh .kts
  * exclude directories: build, dist, node_modules, .venv, venv, .gradle, __pycache__, .cache,
    coverage, .signing, generated, android/app/build
  * a file counts as TEST when any path segment is `test`, `tests`, `__tests__`, `androidTest`, or the
    name ends with `Test.kt` / `.test.ts(x)` / `.spec.ts(x)`
  * `code` = non-blank, not a line-leading comment (`//`, `#`, `/*`, `*`, `<!--`); block comments are
    not tracked, so `code` is slightly high. `lines` is the raw wc -l.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
REPO = BENCH.parent

INCLUDE_EXT = {
    ".kt", ".kts", ".java", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".css", ".html", ".py", ".sh",
}
EXCLUDE_DIRS = {
    "build", "dist", "node_modules", ".venv", "venv", ".gradle", "__pycache__",
    ".cache", "coverage", ".signing", "generated", ".pytest_cache", "Pods",
}
TEST_SEGMENTS = {"test", "tests", "__tests__", "androidtest"}
COMMENT_PREFIXES = ("//", "#", "/*", "*", "<!--", "--")

# label -> (path relative to repo, what it is)
AREAS = {
    "kotlin": ("apps/kotlin", "Kotlin/Compose app (track B)"),
    "rn": ("apps/rn", "React Native app (track A), excluding android/ Gradle glue counted separately"),
    "web.frontend": ("apps/web/frontend", "Web frontend (track C, Preact + ts-core)"),
    "web.server": ("apps/web/server", "Web embedding server (track C, Python/torch)"),
    "shared": ("shared", "Shared spec, fixtures, ts-core, oracle, android-embed (S-cards)"),
    "bench": ("bench", "This harness (card X1)"),
}


def is_test(rel: Path, name: str) -> bool:
    if any(seg.lower() in TEST_SEGMENTS for seg in rel.parts):
        return True
    return (
        name.endswith("Test.kt")
        or name.endswith("Tests.kt")
        or ".test." in name
        or ".spec." in name
    )


def count(root: Path) -> dict:
    files = 0
    lines = 0
    code = 0
    src_files = src_code = 0
    test_files = test_code = 0
    by_ext: dict[str, int] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for name in filenames:
            ext = Path(name).suffix
            if ext not in INCLUDE_EXT:
                continue
            path = Path(dirpath) / name
            rel = path.relative_to(root)
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            file_lines = text.splitlines()
            n_code = sum(
                1
                for ln in file_lines
                if ln.strip() and not ln.strip().startswith(COMMENT_PREFIXES)
            )
            files += 1
            lines += len(file_lines)
            code += n_code
            by_ext[ext] = by_ext.get(ext, 0) + n_code
            if is_test(rel, name):
                test_files += 1
                test_code += n_code
            else:
                src_files += 1
                src_code += n_code
    return {
        "files": files,
        "lines": lines,
        "code": code,
        "source": {"files": src_files, "code": src_code},
        "test": {"files": test_files, "code": test_code},
        "byExt": dict(sorted(by_ext.items(), key=lambda kv: -kv[1])),
    }


def main() -> None:
    out: dict[str, dict] = {}
    for label, (rel, what) in AREAS.items():
        root = REPO / rel
        if not root.is_dir():
            out[label] = {"status": "n/a", "reason": f"{rel}/ does not exist on this branch"}
            continue
        out[label] = {"path": rel, "what": what, **count(root)}

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "method": "bench/scripts/loc.py — cloc stand-in (find+read, blank/comment-line excluded); see README",
        "note": "`code` excludes blank lines and line-leading comments but does not track block comments, "
        "so it is slightly higher than cloc's code count. `test` is split out because the Kotlin track's "
        "parity suite is a large share of its bytes.",
        "areas": out,
    }
    frag = BENCH / "results" / "fragments"
    frag.mkdir(parents=True, exist_ok=True)
    (frag / "loc.json").write_text(json.dumps(payload, indent=2) + "\n")

    print(f"{'area':<14} {'files':>6} {'code':>7} {'src':>7} {'test':>7} {'test%':>6}")
    for label, v in out.items():
        if v.get("status") == "n/a":
            print(f"{label:<14} {'n/a':>6}   {v['reason']}")
            continue
        pct = 100 * v["test"]["code"] / v["code"] if v["code"] else 0
        print(
            f"{label:<14} {v['files']:>6} {v['code']:>7} {v['source']['code']:>7} "
            f"{v['test']['code']:>7} {pct:>5.1f}%"
        )
    print("-> bench/results/fragments/loc.json")


if __name__ == "__main__":
    main()
