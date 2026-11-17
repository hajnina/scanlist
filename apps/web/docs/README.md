# Web screenshots (C5 — magic Scan)

Captured from the **built** app (`npm run build`) in headless Chrome at a 420×900 phone viewport,
driven by `scripts/smoke-e2e.mjs`'s harness conventions. Two test-only stubs make a headless run
show the real UI rather than a server-404 state:

- `/embed/text` and `/embed/image` are answered by a deterministic local stub (item documents are
  one-hot vectors; one OCR query is 0.86 similar to `Bananas`).
- Chrome's fake camera plays a 640×480 card reading **BANANAS**, so the real Tesseract pipeline
  (CDN worker + `eng` traineddata) produces the OCR line visible in the chips.

No production code is aware of either stub. The hero is `decideTop()`'s output: 0.86 > the 0.79 text
floor and 0.86 ahead of the runner-up, and the UI shows it as "never auto-ticked" until a human
uses the tick button.

| File | State |
| --- | --- |
| `01-scan-no-list.png` | Scan nav with no saved list → honest "NO LIST OPEN", no camera access. |
| `02-scan-camera-live.png` | Camera live, no match yet → null hero, ranked rows, live chips. |
| `03-scan-hero.png` | OCR reads BANANAS → hero card + two manual tick affordances. |
| `04-scan-ranked-list.png` | Scrolled: hero row highlighted with its 0.86 similarity. |
