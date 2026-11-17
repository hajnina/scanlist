/**
 * Import card: file upload / paste / URL (LIST.md §6).
 *
 * All three paths end in the same `ImportOutcome` (ts-core `parseList` underneath), so validation
 * errors look identical no matter where the bytes came from. The panel is uncontrolled on purpose:
 * a partially typed paste or URL is not app state and does not need to survive a re-render.
 */

import { useRef, useState } from "preact/hooks";

import { importFromFile, importFromText, importFromUrl } from "../core/importer";
import type { ImportOutcome } from "../core/importer";
import { FilledButton, OutlinedButton, TextButton, UrlField } from "./md";
import type { TextFieldElement } from "./md";

type Tab = "file" | "paste" | "url";

export interface ImportPanelProps {
  /** Errors from the last failed import, rendered with their RFC 6901 pointers. */
  errors: string[];
  onDismissErrors: () => void;
  onOutcome: (outcome: ImportOutcome) => void;
}

export function ImportPanel(props: ImportPanelProps) {
  const [tab, setTab] = useState<Tab>("file");
  const [busy, setBusy] = useState<string | null>(null);
  const urlRef = useRef<TextFieldElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);

  async function pickFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // let the same file be picked again
    if (!file) return;
    setBusy(`Reading ${file.name}…`);
    try {
      props.onOutcome(await importFromFile(file));
    } finally {
      setBusy(null);
    }
  }

  async function submitUrl() {
    setBusy("Fetching…");
    try {
      props.onOutcome(await importFromUrl(urlRef.current?.value ?? ""));
    } finally {
      setBusy(null);
    }
  }

  function submitPaste() {
    props.onOutcome(importFromText(pasteRef.current?.value ?? "", "paste"));
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "file", label: "File" },
    { id: "paste", label: "Paste" },
    { id: "url", label: "URL" },
  ];

  return (
    <div class="import-panel">
      <div class="tabs" role="group" aria-label="Import source">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            class={`chip ${tab === entry.id ? "chip-selected" : ""}`}
            aria-pressed={tab === entry.id}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "file" && (
        <div class="tab-body">
          <p class="hint">
            Pick a <code>.json</code> list in the LIST.md shape. Nothing is uploaded — the file is
            read in the browser.
          </p>
          <label class="file-button">
            <span>Choose a file…</span>
            <input
              type="file"
              accept="application/json,.json,text/json"
              aria-label="Choose a list JSON file"
              onChange={pickFile}
            />
          </label>
        </div>
      )}

      {tab === "paste" && (
        <div class="tab-body">
          <label class="field-label" for="paste-json">
            List JSON
          </label>
          <textarea
            id="paste-json"
            ref={pasteRef}
            class="paste-area"
            rows={8}
            spellcheck={false}
            placeholder={'{"title": "Corner shop", "sections": […]}'}
          />
          <FilledButton label="Import pasted JSON" onClick={submitPaste} disabled={busy !== null} />
        </div>
      )}

      {tab === "url" && (
        <div class="tab-body">
          <UrlField
            label="List URL"
            placeholder="/sample.json or https://…/list.json"
            fieldRef={urlRef}
            onEnter={submitUrl}
            disabled={busy !== null}
          />
          <p class="hint">
            Same-origin paths such as <code>/list.json</code> always work. Other origins must send
            CORS headers (<code>Access-Control-Allow-Origin</code>) — the browser enforces that.
          </p>
          <OutlinedButton label="Fetch and import" onClick={submitUrl} disabled={busy !== null} />
        </div>
      )}

      {busy !== null && (
        <div class="busy" role="status">
          <span class="progress-bar progress-indeterminate" aria-hidden="true" />
          <span>{busy}</span>
        </div>
      )}

      {props.errors.length > 0 && (
        <div class="import-errors" role="alert">
          <p class="errors-title">Import failed — nothing was saved.</p>
          <ul class="errors-list">
            {props.errors.map((error) => (
              <li key={error}>
                <code>{error}</code>
              </li>
            ))}
          </ul>
          <TextButton label="Dismiss" onClick={props.onDismissErrors} />
        </div>
      )}
    </div>
  );
}
