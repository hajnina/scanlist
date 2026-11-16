# ScanList kanban

One card = one file. Folder = status: `todo/ → doing/ → review/ → done/` (or `blocked/`).
`python3 kanban/board.py` shows the board and the READY list (todo cards whose dependencies are all done).

## Running agents in parallel (cheap: `opencode/deepseek-v4.1-flash-free`)
One agent per card, each in its own git worktree so they never step on each other:

```bash
cd ~/projects/scanlist
python3 kanban/board.py ready              # e.g. S1 S7
python3 kanban/board.py claim S1 ds-1      # locked + committed on main
git worktree add ../scanlist-wt/S1 -b card/S1
cd ../scanlist-wt/S1 && opencode -m opencode/deepseek-v4.1-flash-free \
   --prompt "You are agent ds-1. Do kanban card S1 (kanban/doing/S1.md). Follow AGENTS.md."
```
When the agent finishes: review the diff, then on main `git merge --no-ff card/S1`,
`python3 kanban/board.py move S1 done`, `git worktree remove ../scanlist-wt/S1`.

Tracks: `shared` (S*), `kotlin` (B*), `rn` (A*), `web` (C*), `compare` (X*). The three app tracks are independent
after the shared foundation, so up to ~6 agents can run at once (one per track lane).

Start order: **S1, S7** now → S2, S4, S5, C1, B1, A1 → S3, S6, S8 → everything else as it becomes READY.
Hard cards (S5, A1, A3, B0, C3): give a stronger model if DeepSeek fails twice.
