#!/usr/bin/env python3
"""Generate the S10 oracle-parity dump for the Kotlin rank port.

Command (from the worktree root, with a venv that has numpy):
    /tmp/opencode/dump-venv/bin/python /tmp/opencode/gen_s10_oracle.py

For every query in shared/fixtures/golden.json it runs the normative
shared/ref/scanlist_ref.py rank() twice: tick 1 with prev=None, tick 2 with the
tick-1 state/output. Image queries pass the fixture's OFF ``product`` as
``barcode_name`` (the resolved barcode name), text queries pass None. The dump
records topId (nullable), the full entries order and every raw/smoothed score.
"""
import hashlib, json, subprocess, sys, unicodedata
from pathlib import Path

ROOT = Path("/home/martin/projects/scanlist-wt/B3-sync")
sys.path.insert(0, str(ROOT / "shared/ref"))
import scanlist_ref as ref

fixture_path = ROOT / "shared/fixtures/golden.json"
golden = json.loads(fixture_path.read_text(encoding="utf-8"))
lists = {l["id"]: l for l in golden["lists"]}

def items_for(list_id):
    l = lists[list_id]
    out = []
    for item in l["items"]:
        row = dict(item)
        row["vec"] = l["itemVectors"][item["id"]]
        out.append(row)
    return out

runs = []
for q in golden["queries"]:
    items = items_for(q["list"])
    kind = q["kind"]
    queries = {kind: [q["vector"]], ("image" if kind == "text" else "text"): []}
    barcode = q.get("product") if kind == "image" else None
    tick1 = ref.rank(items, queries, prev=None, barcode_name=barcode)
    tick2 = ref.rank(items, queries, prev=tick1["state"], barcode_name=barcode,
                     prev_output=tick1)
    run = {
        "id": q["id"],
        "kind": kind,
        "list": q["list"],
        "barcodeName": barcode,
        "ticks": [],
    }
    for tick in (tick1, tick2):
        run["ticks"].append({
            "topId": tick["topId"],
            "entries": [
                {"id": e["id"], "raw": e["raw"], "smoothed": e["smoothed"], "done": e["done"]}
                for e in tick["entries"]
            ],
        })
    runs.append(run)

ref_path = ROOT / "shared/ref/scanlist_ref.py"
blob = subprocess.check_output(["git", "hash-object", str(ref_path)], cwd=ROOT, text=True).strip()
commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
fixture_sha = hashlib.sha256(fixture_path.read_bytes()).hexdigest()

out = {
    "_provenance": {
        "purpose": "RANK.md S10 oracle-parity expectations for apps/kotlin/.../rank/S10OracleParityTest",
        "script": "gen_s10_oracle.py (kept beside this file)",
        "command": "/tmp/opencode/dump-venv/bin/python /tmp/opencode/gen_s10_oracle.py",
        "ref": "shared/ref/scanlist_ref.py",
        "refBlobSha1": blob,
        "gitCommit": commit,
        "python": sys.version.split()[0],
        "unicode": unicodedata.unidata_version,
        "fixture": "shared/fixtures/golden.json",
        "fixtureSha256": fixture_sha,
        "semantics": ("58 queries x 2 ticks; tick 1 prev=None, tick 2 prev=tick-1 state/output; "
                      "image queries pass the fixture OFF product as barcode_name, text queries None; "
                      "topId is the highlight (nullable) and entries is the full ranked order"),
        "runs": len(runs),
    },
    "runs": runs,
}
dest = ROOT / "apps/kotlin/app/src/test/resources/rank/s10_oracle_runs.json"
dest.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print("wrote", dest, len(runs), "queries", len(runs) * 2, "rank-runs")
# Counts useful for the card/reviewer.
nulls1 = sum(1 for r in runs if r["ticks"][0]["topId"] is None)
img_hits = sum(1 for r in runs if r["kind"] == "image" and r["ticks"][0]["topId"])
print("tick-1 null highlights:", nulls1, "/", len(runs), "| image highlights:", img_hits)
print("ref blob", blob, "fixture sha", fixture_sha[:16])
