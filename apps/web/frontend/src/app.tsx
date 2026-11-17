/**
 * App shell: library <-> list, import application, persistence, export, toasts, error boundary.
 *
 * State model (card C2): a list is parsed ONCE on import; the parsed tree is the live model.
 * Ticking mutates `item.done` and rewrites that list's stored document (the export document), so
 * there is exactly one source of truth and reload == re-import. The library index holds metadata
 * only (see core/storage.ts for the key scheme).
 */

import { Component } from "preact";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { flatten } from "@scanlist/ts-core";
import type { ScanList, ScanListItem } from "@scanlist/ts-core";

import { demoListText } from "./demo";
import { exportFileName, exportJson } from "./core/exportDoc";
import { importFromText } from "./core/importer";
import type { ImportOutcome } from "./core/importer";
import {
  STORAGE_KEYS,
  createListId,
  readDoc,
  readIndex,
  resolveStorage,
  writeDoc,
  writeIndex,
} from "./core/storage";
import type { LibraryIndex, ListIndexEntry, ReadIndexResult } from "./core/storage";
import { HomeScreen } from "./ui/HomeScreen";
import { ListScreen } from "./ui/ListScreen";
import { FilledButton, TextButton } from "./ui/md";
import { ToastStack } from "./ui/Toast";
import type { ToastKind, ToastSpec } from "./ui/Toast";

/** Item totals via ts-core's flattener (FLATTEN.md §2), the same walk the ranker will use. */
function countsOf(list: ScanList): { total: number; done: number } {
  const flat = flatten(list);
  let done = 0;
  for (const item of flat) if (item.done) done += 1;
  return { total: flat.length, done };
}

function Workspace() {
  // Resolve storage once: private-mode browsers throw on localStorage.setItem, and we must not
  // crash on that (the toast explains the degraded mode).
  const [resolved] = useState(resolveStorage);
  const [library, setLibrary] = useState<ReadIndexResult>(() => readIndex(resolved.storage));
  const [openId, setOpenId] = useState<string | null>(null);
  const [list, setList] = useState<ScanList | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [toasts, setToasts] = useState<ToastSpec[]>([]);
  const nextToastId = useRef(0);

  function pushToast(kind: ToastKind, message: string): void {
    nextToastId.current += 1;
    const toast: ToastSpec = { id: nextToastId.current, kind, message };
    setToasts((previous) => [...previous, toast]);
  }

  function dismissToast(id: number): void {
    setToasts((previous) => previous.filter((toast) => toast.id !== id));
  }

  // Startup recovery messages: storage degraded, or a corrupt index removed (see core/storage.ts).
  useEffect(() => {
    if (resolved.warning !== null) pushToast("error", resolved.warning);
    if (library.error !== null) pushToast("error", library.error);
    // Runs once: startup diagnostics must not repeat on every tick.
  }, []);

  function applyOutcome(outcome: ImportOutcome): void {
    if (!outcome.ok) {
      // Errors already carry RFC 6901 pointers from ts-core; no partial import happens.
      setImportErrors(outcome.errors);
      pushToast("error", `Import failed (${outcome.source})`);
      return;
    }

    const imported = outcome.list;
    const id = createListId();
    const now = new Date().toISOString();
    const counts = countsOf(imported);
    const entry: ListIndexEntry = {
      id,
      title: imported.title,
      itemCount: counts.total,
      doneCount: counts.done,
      importedAt: now,
      updatedAt: now,
    };
    const nextIndex: LibraryIndex = { version: 1, lists: [entry, ...library.index.lists] };

    const savedDoc = writeDoc(resolved.storage, id, imported);
    const savedIndex = writeIndex(resolved.storage, nextIndex);

    setLibrary({ index: nextIndex, error: null });
    setImportErrors([]);
    setList(imported);
    setOpenId(id);

    if (savedDoc && savedIndex) {
      pushToast("success", `Imported “${imported.title}”`);
    } else {
      pushToast("error", "Imported, but this browser refused to save it (storage full or blocked).");
    }
  }

  function openList(id: string): void {
    const result = readDoc(resolved.storage, id);
    if (!result.ok) {
      // Corrupt document: fall back to the import screen (library) with an error toast.
      pushToast("error", result.error);
      const nextIndex: LibraryIndex = {
        version: 1,
        lists: library.index.lists.filter((entry) => entry.id !== id),
      };
      writeIndex(resolved.storage, nextIndex);
      setLibrary({ index: nextIndex, error: null });
      return;
    }
    setImportErrors([]);
    setList(result.list);
    setOpenId(id);
  }

  function toggleItem(item: ScanListItem): void {
    if (list === null || openId === null) return;

    // LIST.md §3: `done` is the only mutable per-item state; never remove a ticked item.
    item.done = item.done !== true;
    // New root reference so Preact re-renders; nested objects are shared and mutated deliberately.
    const next: ScanList = { ...list, sections: [...(list.sections ?? [])] };
    setList(next);

    const saved = writeDoc(resolved.storage, openId, next);
    const counts = countsOf(next);
    const updatedAt = new Date().toISOString();
    const nextIndex: LibraryIndex = {
      version: 1,
      lists: library.index.lists.map((entry) =>
        entry.id === openId
          ? { ...entry, itemCount: counts.total, doneCount: counts.done, updatedAt }
          : entry,
      ),
    };
    writeIndex(resolved.storage, nextIndex);
    setLibrary({ index: nextIndex, error: null });

    if (!saved) pushToast("error", "Could not save the tick — storage is full or blocked.");
  }

  function exportCurrent(): void {
    if (list === null) return;
    const json = exportJson(list);
    const blob = new Blob([json], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = exportFileName(list.title);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // Revoke on the next task: some browsers read the blob after the click event returns.
    setTimeout(() => URL.revokeObjectURL(href), 0);
    pushToast("success", `Exported ${exportFileName(list.title)}`);
  }

  function goHome(): void {
    setOpenId(null);
    setList(null);
    setImportErrors([]);
  }

  const showingList = openId !== null && list !== null;

  return (
    <>
      {showingList ? (
        <ListScreen list={list} onBack={goHome} onToggle={toggleItem} onExport={exportCurrent} />
      ) : (
        <HomeScreen
          entries={library.index.lists}
          errors={importErrors}
          onDismissErrors={() => setImportErrors([])}
          onOutcome={applyOutcome}
          onOpen={openList}
          onDemo={() => applyOutcome(importFromText(demoListText, "demo"))}
        />
      )}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

interface BoundaryProps {
  children: ComponentChildren;
}

interface BoundaryState {
  error: Error | null;
}

/** Never a white screen: a render crash lands here, with a way back to the import screen. */
class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  override componentDidCatch(error: unknown): void {
    this.setState({ error: error instanceof Error ? error : new Error(String(error)) });
  }

  override render() {
    if (this.state.error === null) return this.props.children;

    return (
      <div class="screen recovery-screen">
        <header class="app-header">
          <p class="eyebrow">SCANLIST · WEB</p>
          <h1 class="display">Something broke</h1>
          <p class="subtitle">Your saved lists are still on this device.</p>
        </header>
        <main class="stack">
          <section class="card hero-card" role="alert">
            <h2 class="section-label">ERROR</h2>
            <pre class="error-pre">{this.state.error.message}</pre>
            <FilledButton label="Try again" onClick={() => this.setState({ error: null })} />
            <TextButton
              label="Clear saved data and reload"
              onClick={() => {
                if (!window.confirm("Delete all ScanList data saved in this browser?")) return;
                try {
                  const doomed: string[] = [];
                  for (let index = 0; index < window.localStorage.length; index += 1) {
                    const key = window.localStorage.key(index);
                    if (
                      key !== null &&
                      (key === STORAGE_KEYS.index ||
                        key === STORAGE_KEYS.corrupt ||
                        key.startsWith(STORAGE_KEYS.docPrefix))
                    ) {
                      doomed.push(key);
                    }
                  }
                  for (const key of doomed) window.localStorage.removeItem(key);
                } catch {
                  // Blocked storage: nothing to clear, reloading is still the right move.
                }
                window.location.reload();
              }}
            />
          </section>
        </main>
      </div>
    );
  }
}

export function App() {
  return (
    <ErrorBoundary>
      <Workspace />
    </ErrorBoundary>
  );
}
