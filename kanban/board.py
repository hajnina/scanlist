#!/usr/bin/env python3
"""ScanList kanban. Cards are files in kanban/<status>/<ID>.md (status = todo|doing|review|done|blocked).
  board.py                 show the board
  board.py ready [track]   cards whose depends are all done and are still in todo
  board.py claim ID AGENT  move todo->doing, set claimed_by, commit on main (locked)
  board.py move ID STATUS  move a card (e.g. review, done, blocked), commit on main (locked)
Run from the MAIN checkout (~/projects/scanlist), not from a worktree."""
import os, re, sys, subprocess, fcntl
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
K = os.path.join(ROOT, "kanban"); ST = ["todo", "doing", "review", "done", "blocked"]
def cards():
    out = {}
    for s in ST:
        for f in sorted(os.listdir(os.path.join(K, s))):
            if f.endswith(".md"):
                t = open(os.path.join(K, s, f)).read()
                m = lambda k: (re.search(rf"^{k}:\s*(.*)$", t, re.M) or [None, ""])[1].strip()
                deps = [d.strip() for d in m("depends").strip("[]").split(",") if d.strip()]
                out[f[:-3]] = dict(status=s, title=m("title"), track=m("track"), diff=m("difficulty"), deps=deps, who=m("claimed_by"), path=os.path.join(K, s, f))
    return out
def ready(c, track=None):
    return [i for i, v in c.items() if v["status"] == "todo" and all(c.get(d, {}).get("status") == "done" for d in v["deps"]) and (not track or v["track"] == track)]
def git(*a): subprocess.run(["git", "-C", ROOT, *a], check=True, stdout=subprocess.DEVNULL)
def locked(fn):
    with open(os.path.join(K, ".lock"), "w") as l:
        fcntl.flock(l, fcntl.LOCK_EX); return fn()
def move(cid, status, who=None):
    def go():
        c = cards()
        if cid not in c: sys.exit(f"no card {cid}")
        v = c[cid]
        if who and v["status"] != "todo": sys.exit(f"{cid} is {v['status']} (claimed_by {v['who']}), pick another")
        dst = os.path.join(K, status, cid + ".md")
        git("mv", v["path"], dst)
        if who:
            t = open(dst).read().replace("claimed_by:\n", f"claimed_by: {who}\n", 1); open(dst, "w").write(t)
            git("add", dst)
        git("commit", "-q", "-m", f"kanban: {cid} -> {status}" + (f" ({who})" if who else ""), "--", os.path.join(K))
        print(f"{cid} -> {status}")
    locked(go)
a = sys.argv[1:]
if not a:
    c = cards()
    for s in ST:
        print(f"\n== {s.upper()} ==")
        for i, v in c.items():
            if v["status"] == s: print(f"  {i:4} [{v['track']:7}] {v['diff']:6} {v['title'][:70]}" + (f"  <{v['who']}>" if v["who"] else ""))
    print("\nREADY:", " ".join(ready(c)) or "-")
elif a[0] == "ready": print(" ".join(ready(cards(), a[1] if len(a) > 1 else None)))
elif a[0] == "claim": move(a[1], "doing", a[2])
elif a[0] == "move": move(a[1], a[2])
else: print(__doc__)
