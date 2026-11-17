/**
 * The lists screen: import card + saved lists.
 *
 * Material 3 Expressive is hand-built from tokens (see styles.css and
 * references/bonsai-ui/STYLE_GUIDE.md §3): 900-weight display type, all-caps tracked labels,
 * asymmetric "leaf" corners and spring-eased transitions. Dynamic colour is an Android-only
 * feature; the web falls back to the same teal seed as the reference apps (< API 31).
 */

import type { ImportOutcome } from "../core/importer";
import type { ListIndexEntry } from "../core/storage";
import { ImportPanel } from "./ImportPanel";
import { TextButton } from "./md";

export interface HomeScreenProps {
  entries: ListIndexEntry[];
  errors: string[];
  onDismissErrors: () => void;
  onOutcome: (outcome: ImportOutcome) => void;
  onOpen: (id: string) => void;
  onDemo: () => void;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function LibraryRow(props: { entry: ListIndexEntry; onOpen: (id: string) => void }) {
  const { entry } = props;
  const total = Math.max(entry.itemCount, 0);
  const done = Math.min(Math.max(entry.doneCount, 0), total);
  const left = total - done;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <li class="library-row spring-in">
      <button type="button" class="library-button" onClick={() => props.onOpen(entry.id)}>
        <span class="library-main">
          <span class="library-title">{entry.title}</span>
          <span class="library-meta">
            {left === 0 ? "all done" : `${left} left`} · {total} {total === 1 ? "item" : "items"}
            {formatWhen(entry.updatedAt) !== "" ? ` · ${formatWhen(entry.updatedAt)}` : ""}
          </span>
          <span class="progress-bar" aria-hidden="true">
            <span class="progress-fill" style={{ width: `${percent}%` }} />
          </span>
        </span>
        <span class="library-chevron" aria-hidden="true">
          →
        </span>
      </button>
    </li>
  );
}

export function HomeScreen(props: HomeScreenProps) {
  return (
    <div class="screen">
      <header class="app-header">
        <p class="eyebrow">SCANLIST · WEB</p>
        <h1 class="display">Lists</h1>
        <p class="subtitle">Import a nested shopping list, tick it off, export it back.</p>
      </header>

      <main class="stack">
        <section class="card hero-card spring-in" style={{ animationDelay: "0ms" }}>
          <h2 class="section-label">IMPORT A LIST</h2>
          <ImportPanel
            errors={props.errors}
            onDismissErrors={props.onDismissErrors}
            onOutcome={props.onOutcome}
          />
          <div class="demo-row">
            <TextButton label="Load the demo list" onClick={props.onDemo} />
            <span class="hint">van-weekly.json from shared/spec/samples</span>
          </div>
        </section>

        <section class="saved" aria-labelledby="saved-heading">
          <h2 class="section-label" id="saved-heading">
            SAVED LISTS
          </h2>
          {props.entries.length === 0 ? (
            <p class="empty-state">
              Nothing imported yet. Your lists live in this browser only — export the JSON to keep a
              copy.
            </p>
          ) : (
            <ul class="library">
              {props.entries.map((entry) => (
                <LibraryRow key={entry.id} entry={entry} onOpen={props.onOpen} />
              ))}
            </ul>
          )}
        </section>
      </main>

      <nav class="bottom-nav" aria-label="Main">
        <button type="button" class="nav-item nav-active" aria-current="page">
          <span aria-hidden="true">☰</span> Lists
        </button>
        {/*
         * Placeholder, deliberately disabled: the magic scan screen is card C5. It is rendered
         * (not hidden) so the navigation shape is fixed now and the route can be swapped in later.
         */}
        <button
          type="button"
          class="nav-item"
          disabled
          title="The magic scan screen lands in card C5"
        >
          <span aria-hidden="true">◎</span> Scan <span class="nav-soon">C5</span>
        </button>
      </nav>
    </div>
  );
}
