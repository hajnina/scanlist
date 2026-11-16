# ScanList — rules for coding agents (opencode reads this automatically)

Project: shopping list app from nested JSON; the "magic scan" ranks list items by EmbeddingGemma 2 similarity to
what the phone camera sees. Built 3 times (React Native / Kotlin / Web+server) to compare. Read `docs/ARCHITECTURE.md`.

## Your job
- You get ONE kanban card (`kanban/doing/<ID>.md`). Do exactly that card. Read its `reads:` files first.
- Only edit paths listed in the card's `owns:` (plus your own card's Notes section). Never edit other tracks,
  `references/` (read-only copies of other repos), or other cards.
- When done: tests/build in "Done when" must actually pass — paste the real command output summary into Notes.
  Then commit on your branch (`card/<ID>`) with message `<ID>: <summary>` and stop. Do not merge to main;
  do not move cards (the human/lead does).
- If blocked (missing dependency, needs the phone, needs a secret): write why in Notes, commit, stop.

## Hard rules
- No secrets, keystores, API keys or model weights in git (weights live in ~/models/scanlist/, venvs and node_modules are gitignored).
- Large downloads: run in background with a log, resumable (`~/housekeeper/scripts/resumable-download.sh URL DEST SIZE SHA256`),
  verify size/sha before use.
- Never `pkill -f`/`pgrep -f` with a pattern; stop processes by PID.
- Don't install system packages with sudo; use venvs / project-local npm.
- UI is Material 3 Expressive per `references/bonsai-ui/STYLE_GUIDE.md`.
- Android builds: `source scripts/android-env.sh` (aarch64 laptop toolchain).
- Prefer copying working code from `references/` over inventing; keep a comment pointing to the source file.
