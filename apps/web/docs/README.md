# Web screenshots (C5 — magic Scan)

Captured from the **built** app (`npm run build`) in headless Chrome at a 420×900 phone viewport,
driven by `capture-scan-shots.mjs` (see "Re-capturing the screenshots" below). Two test-only stubs
make a headless run show the real UI rather than a server-404 state:

- `/embed/text` and `/embed/image` are answered by a deterministic local stub (item documents are
  one-hot vectors; one OCR query is 0.86 similar to `Bananas`).
- Chrome's fake camera plays a 640×480 card reading **BANANAS**, so the real Tesseract pipeline
  (CDN worker + `eng` traineddata) produces the OCR line visible in the chips.

No production code is aware of either stub. The hero is `decideTop()`'s output: 0.86 > the 0.79 text
floor and 0.86 ahead of the runner-up, and the UI shows it as "never auto-ticked" until a human
uses the tick button.

**Why `03` says 0.85 and `04` says 0.86:** the number is the ranker's EMA-smoothed score
(`EMA_ALPHA = 0.5` in `shared/ts-core/src/rank.ts`), not one frame's raw cosine. `03` is captured on
the first labelled tick (0.85); `04`, one tick later, shows the same match settled at 0.86. Neither
screenshot is retouched and the table's 0.86 is the steady value — the ramp is the smoother, not an
inconsistency.

| File | State |
| --- | --- |
| `01-scan-no-list.png` | Scan nav with no saved list → honest "NO LIST OPEN", no camera access. |
| `02-scan-camera-live.png` | Camera live, no match yet → null hero, ranked rows, live chips. |
| `03-scan-hero.png` | OCR reads BANANAS → hero card + two manual tick affordances. |
| `04-scan-ranked-list.png` | Scrolled: hero row highlighted with its 0.86 similarity. |

## Re-capturing the screenshots

`capture-scan-shots.mjs` (this directory) is the harness that produced these files: the built app in
headless Chrome at 420×900 @2, in-page `/embed/*` stubs, and Chromium's fake camera playing a
fixture of the word **BANANAS**. Its header carries the exact commands; the only required input is
`BANANAS_Y4M=/path/to/bananas.y4m`.

The fixture is **not committed** — it is ~4.4 MB of raw YUV and the project's no-large-binaries rule
keeps it out of git. It is one static scene: 640×480, 10 frames, 30 fps, `C420jpeg`, white
background, black "BANANAS" filling the frame. One way to recreate it (any ffmpeg build with
`drawtext`):

    ffmpeg -f lavfi -i color=white:s=640x480:d=10:r=30 \
      -vf "drawtext=text='BANANAS':fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontcolor=black:fontsize=150:x=(w-text_w)/2:y=(h-text_h)/2" \
      -frames:v 10 -pix_fmt yuv420p -f yuv4mpegpipe /tmp/opencode/bananas.y4m

OCR needs large, high-contrast glyphs; shrink the font and Tesseract may stop reading the frame.
