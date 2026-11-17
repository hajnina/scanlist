# ScanList — rules for coding agents (opencode reads this automatically)

Project: shopping list app from nested JSON; the "magic scan" ranks list items by EmbeddingGemma 2 similarity to
what the phone camera sees. Built 3 times (React Native / Kotlin / Web+server) to compare. Read `docs/ARCHITECTURE.md`.

## Your job
- You get ONE kanban card (`kanban/doing/<ID>.md`). Do exactly that card. Read its `reads:` files first.
- Only edit paths listed in the card's `owns:` (plus your own card's Notes section). Never edit other tracks,
  `references/` (read-only copies of other repos), or other cards.
- When done: tests/build in "Done when" must actually pass — paste the real command output summary into Notes.
  Then commit on your branch (`card/<ID>`) with message `<ID>: <summary>`, `git push -u origin card/<ID>`, and open
  a PR: `gh pr create --base main --title "<ID>: <summary>" --body "<what + Done-when evidence>"`. CI builds APKs
  on every PR (x86_64 ubuntu runner) — a red build means the card is not done; keep laptop-only overrides inside
  `scripts/android-env.sh` sourcing (never baked into gradle files) so CI can build the same code. Do not merge
  (the lead reviews + merges), do not move cards, and never edit `.github/` (lead-owned; if CI blocks you, say so
  in Notes).
- If blocked (missing dependency, needs the phone, needs a secret): write why in Notes, commit, stop.

## Hard rules
- No secrets, keystores, API keys or model weights in git (weights live in ~/models/scanlist/, venvs and node_modules are gitignored).
- Large downloads: run in background with a log, resumable (`~/housekeeper/scripts/resumable-download.sh URL DEST SIZE SHA256`),
  verify size/sha before use.
- Never `pkill -f`/`pgrep -f` with a pattern; stop processes by PID.
- NEVER use fetch/push refspecs like `main:main` (e.g. `git fetch origin main:main`, `git pull origin main:main`, `git push origin HEAD:main` from a detached worktree) — git DWIM resolves the bare `main` destination to `refs/tags/main` and silently (re)creates a tag named `main`, which shadow-aliases the branch repo-wide ("refname 'main' is ambiguous" breaks every ancestry check). Use plain `git fetch origin main` / `git pull --no-rebase`; if you ever see `warning: refname 'main' is ambiguous`, STOP and report — do not delete the tag yourself.
- Native NDK/CMake builds do not run on this aarch64 laptop (installed NDKs ship x86_64-only prebuilts) — verify
  native-dependent work through the CI PR build (x86_64 ubuntu runners), not locally.
- Don't install system packages with sudo; use venvs / project-local npm.
- UI is Material 3 Expressive per `references/bonsai-ui/STYLE_GUIDE.md`.
- Android builds: `source scripts/android-env.sh` (aarch64 laptop toolchain).
- Prefer copying working code from `references/` over inventing; keep a comment pointing to the source file.
