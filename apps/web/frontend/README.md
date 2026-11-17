# ScanList — web frontend (Track C)

Vite + TypeScript + Preact single-page app: **import a nested shopping list → tick items off →
export it back**, with everything persisted in the browser. Material 3 Expressive look built from
CSS tokens and `@material/web` components (see `references/bonsai-ui/STYLE_GUIDE.md`).

This package is card **C2**. It deliberately contains **no ranking / magic-scan UI** — that is card
C5, which will fill in the disabled "Scan" entry in the bottom navigation.

```
src/
  main.tsx          mount + service-worker registration
  app.tsx           shell: library <-> list, import application, persistence, toasts, error boundary
  core/
    importer.ts     file / paste / URL transports -> ts-core parseList
    storage.ts      localStorage key scheme, validation, corruption recovery
    exportDoc.ts    in-memory tree -> LIST.md §1 document (the download AND the stored bytes)
    display.ts      amount/unit/note formatting rules
  ui/               HomeScreen, ListScreen, ImportPanel, Toast, md.tsx (typed @material/web wrappers)
  demo.ts           the bundled van-weekly sample used by "Load the demo list"
public/             manifest.webmanifest, sw.js, icons
tests/              vitest suites (see "Tests")
scripts/            make-icons.py, smoke-e2e.mjs (optional real-Chrome check)
```

## Commands

```bash
cd apps/web/frontend
npm ci                 # or npm install
npm run dev            # Vite dev server (serves shared/ts-core from source, see below)
npm test               # vitest run — the C2 gate
npm run build          # tsc --noEmit + vite build (the build type-checks on purpose: CI has no separate tsc step)
npm run typecheck      # tsc --noEmit alone
npm run preview        # serve dist/
```

Node 22 (CI's version). `node_modules/` and `dist/` are gitignored by the repo-root `.gitignore`
(`node_modules/`, `dist/`) and by this package's `.gitignore`.

## How `@scanlist/ts-core` is imported (no workspace, no publish, no build step)

The shared core lives at `shared/ts-core/` and is consumed **as TypeScript source**:

| Consumer | Mechanism |
|---|---|
| bundler + vitest | `resolve.alias` in `vite.config.ts` → `../../../shared/ts-core/src/index.ts` |
| `tsc` | `compilerOptions.paths` in `tsconfig.json` → the same file |
| `npm run dev` | `server.fs.allow: [repoRoot]`, so the dev server may serve files outside this package |

Why this and not an npm workspace: the repo has no root `package.json`, and a workspace/publish step
would need one (plus a build artefact and a `dist/` to keep in sync). Aliasing the source means the
web app and `shared/ts-core/tests` always run the *same bytes*: a change in the core is picked up
immediately by `npm test` here, with no version bump and no stale copy. `shared/ts-core` is
typechecked separately by its own `npx tsc --noEmit` and by CI's `shared` job.

The fixtures are imported the same way: `../../../../shared/spec/samples/*.json?raw` (tests) and
`../../../../shared/spec/samples/van-weekly.json?raw` (`src/demo.ts`). Nothing under `shared/` is
copied into this package, so the demo and the golden tests cannot drift from the spec.

Because the alias points **outside** the package root, `vite.config.ts` must stay the single place
that maps it — adding an `imports` map or a local copy of ts-core would silently fork the contract.

## Data contract and persistence

`shared/ts-core` owns validation and semantics (`parseList`, `flatten`, `docText`); this app adds no
parsing rules of its own. That means, for free:

- RFC 6901 pointer errors (`/sections/0/items/0/amount`) and **no partial import**;
- `"3"` stays text while `3` is a number; `1e999` (Infinity after `JSON.parse`) is rejected;
- unknown fields are ignored, and `parseList` normalisation is what gets exported (LIST.md §7).

**Persisted format = the export document.** The bytes in localStorage are exactly what
"Export JSON" downloads (card B2's Kotlin precedent: the stored file *is* the list, so "reload" is
just a re-import through the same validator).

| key | contents |
|---|---|
| `scanlist.v1.lists` | index: `{version: 1, lists: [{id, title, itemCount, doneCount, importedAt, updatedAt}]}` |
| `scanlist.v1.list.<id>` | one LIST.md document (pretty JSON, the export document) |
| `scanlist.v1.corrupt` | the last payload that had to be dropped (raw text, forensic only) |

Corruption policy — **never a white screen**: a bad index or a bad document is dropped (raw text
quarantined under `scanlist.v1.corrupt`), the index entry is removed, and the app returns to the
import screen with an error toast. If `localStorage` itself is unusable (Safari private mode, quota),
the app keeps working in memory for the session and says so in a toast. A render crash is caught by
an error boundary that offers "try again" and "clear saved data and reload".

## PWA

`public/manifest.webmanifest` (standalone, teal theme colour, 192/512 + maskable icons) and a ~90
line `public/sw.js`: stale-while-revalidate for the app shell (Vite's hashed filenames make a stale
chunk unreachable from a fresh `index.html`), network-only for data (`/embed/*`, `/off/*`, `/health`,
`/docs`, cross-origin), cached `index.html` as the offline navigation fallback. `src/main.tsx`
registers it only in production builds. Icons are generated by `scripts/make-icons.py`.

## Tests

`npm test` (vitest):

| file | proves |
|---|---|
| `golden.test.ts` | the four `shared/spec/samples` replayed **through this app's import alias**: flattened items/ids and `docText` byte-identical to `shared/fixtures/golden.json` (44 items), plus FLATTEN.md §4 literals |
| `importer.test.ts` | LIST.md §8 invalid examples rejected with pointers, `1e999`, `"3"` stays text, and the three transports (file / paste / URL) share one outcome |
| `export.test.ts` | import → tick → export round-trips for every sample; export is a fixed point; defaults omitted |
| `storage.test.ts` | key scheme, partial-index repair, corrupt document/index quarantine, blocked storage |
| `display.test.ts` | amount/unit/note text rules |
| `app.test.ts` | mounts the real `<App/>` in happy-dom: demo/paste/URL import, tick reaches localStorage, remount re-imports, export download name, every corruption fallback — i.e. the "never a white screen" requirement |

`app.test.ts` runs in `happy-dom` because `@material/web` is Lit-based (it needs custom elements and
shadow DOM). happy-dom has no `ElementInternals`, so the test installs a minimal `attachInternals`
shim before mounting; nothing about the vendor components is asserted there (the build and the
real-Chrome script cover that).

### Optional real-browser check

`scripts/smoke-e2e.mjs` drives the **built** app in real Chrome: real `md-*` elements, download to
disk, reload, both corruption paths, manifest + service worker, dark scheme. It is not part of
`npm test` or CI (it needs a Chrome binary and `puppeteer-core`, deliberately not a dependency):

```bash
npm run build
npx vite preview --port 8412 --strictPort &
npm i --no-save puppeteer-core
node scripts/smoke-e2e.mjs          # exits non-zero on failure; screenshots in /tmp/opencode/c2
```

## Look and motion

Material 3 Expressive per `references/bonsai-ui/STYLE_GUIDE.md` §0/§3, hand-built the same way the
reference Android apps do it (the Expressive theme API does not exist on the web either):

- colour roles as CSS custom properties on `:root`, teal seed `#006B5F`, automatic dark scheme via
  `prefers-color-scheme`; no hard-coded colours in components;
- Black-weight (900) display type, all-caps letter-spaced labels, huge progress numerals;
- asymmetric "leaf" corner radii and pill-shaped chips/amounts;
- spatial spring easing for anything that moves (`spring-in`), effects easing for colour/opacity, all
  disabled under `prefers-reduced-motion`.

## Deviations / not in this card

- **No ranking UI** (card C5): the "Scan" bottom-nav entry is rendered but `disabled`, labelled `C5`.
- No server integration: URL import fetches same-origin paths (or CORS-enabled URLs) only.
- URL import is limited to 5 MiB, as is file import.
