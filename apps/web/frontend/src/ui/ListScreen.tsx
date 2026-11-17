/**
 * One list: nested, collapsible sections + tick/untick + export.
 *
 * Depth comes straight from the document (LIST.md §2: recursive, any depth). Every section keeps
 * its own items and sub-sections in JSON order (FLATTEN.md §2); ticking mutates `item.done` only
 * (LIST.md §3) and the whole tree is re-exported on demand.
 *
 * Collapse state is keyed by section *positions* ("0.2.1"), not names: sibling sections may share
 * a name (LIST.md §2) and names are not identifiers.
 */

import { useMemo, useState } from "preact/hooks";
import { flatten } from "@scanlist/ts-core";
import type { ScanList, ScanListItem, ScanListSection } from "@scanlist/ts-core";

import { displayName, displayNote, displayText } from "../core/display";
import { FilledButton, TickBox } from "./md";

export interface ListScreenProps {
  list: ScanList;
  onBack: () => void;
  onToggle: (item: ScanListItem) => void;
  onExport: () => void;
}

interface SectionCounts {
  total: number;
  done: number;
}

function countSection(section: ScanListSection): SectionCounts {
  let total = 0;
  let done = 0;
  for (const item of section.items ?? []) {
    total += 1;
    if (item.done === true) done += 1;
  }
  for (const child of section.sections ?? []) {
    const nested = countSection(child);
    total += nested.total;
    done += nested.done;
  }
  return { total, done };
}

interface SectionViewProps {
  section: ScanListSection;
  /** Position key, e.g. "0.2.1" (see file comment). */
  pathKey: string;
  depth: number;
  collapsed: Set<string>;
  onToggleCollapse: (key: string) => void;
  onToggleItem: ListScreenProps["onToggle"];
}

function SectionView(props: SectionViewProps) {
  const { section, pathKey, depth } = props;
  const isCollapsed = props.collapsed.has(pathKey);
  const counts = countSection(section);
  const items = section.items ?? [];
  const children = section.sections ?? [];
  const empty = items.length === 0 && children.length === 0;

  return (
    <section class={`section ${isCollapsed ? "is-collapsed" : ""}`}>
      <h3 class="section-heading">
        <button
          type="button"
          class="section-toggle"
          aria-expanded={!isCollapsed}
          onClick={() => props.onToggleCollapse(pathKey)}
        >
          <span class="section-chevron" aria-hidden="true">
            {isCollapsed ? "▸" : "▾"}
          </span>
          <span class="section-name">{section.name}</span>
          <span class="section-count">
            {counts.done}/{counts.total}
          </span>
        </button>
      </h3>

      {!isCollapsed && (
        <>
          {empty && <p class="empty-section">Empty section</p>}
          {items.length > 0 && (
            <ul class="items">
              {items.map((item, index) => {
                const amount = displayText(item);
                const note = displayNote(item);
                return (
                  <li
                    key={item.id ?? `${pathKey}/${index}`}
                    class={`item spring-in ${item.done === true ? "is-done" : ""}`}
                    style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
                  >
                    <TickBox
                      checked={item.done === true}
                      label={`${item.done === true ? "Untick" : "Tick"} ${displayName(item)}`}
                      onChange={() => props.onToggleItem(item)}
                    />
                    <span class="item-body">
                      <span class="item-line">
                        <span class="item-name">{displayName(item)}</span>
                        {amount !== "" && <span class="amount">{amount}</span>}
                      </span>
                      {note !== null && <span class="item-note">{note}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {children.length > 0 && (
            <div
              class="section-children"
              // Cumulative indent, clamped at 4 levels so a 12-deep list still reads on a phone.
              style={depth < 4 ? { marginInlineStart: "10px" } : undefined}
            >
              {children.map((child, index) => (
                <SectionView
                  key={`${pathKey}.${index}`}
                  section={child}
                  pathKey={`${pathKey}.${index}`}
                  depth={depth + 1}
                  collapsed={props.collapsed}
                  onToggleCollapse={props.onToggleCollapse}
                  onToggleItem={props.onToggleItem}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function ListScreen(props: ListScreenProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // ts-core owns traversal + counts (FLATTEN.md §2), so the hero cannot disagree with ranking.
  const totals = useMemo(() => {
    const flat = flatten(props.list);
    let done = 0;
    for (const item of flat) if (item.done) done += 1;
    return { total: flat.length, done, left: flat.length - done };
  }, [props.list]);

  const percent = totals.total === 0 ? 0 : Math.round((totals.done / totals.total) * 100);
  const sections = props.list.sections ?? [];

  function toggleCollapse(key: string): void {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div class="screen">
      <header class="app-header list-header">
        <button type="button" class="back-button" onClick={props.onBack}>
          <span aria-hidden="true">←</span> Lists
        </button>
        <h1 class="display list-title">{props.list.title}</h1>
      </header>

      <main class="stack">
        <section class="card hero-card progress-card spring-in">
          <h2 class="section-label">PROGRESS</h2>
          <p class="hero-number">
            <span class="hero-value">{totals.left}</span>
            <span class="hero-unit">LEFT</span>
          </p>
          <span class="progress-bar progress-large" aria-hidden="true">
            <span class="progress-fill" style={{ width: `${percent}%` }} />
          </span>
          <p class="hero-meta">
            {totals.total === 0
              ? "Nothing to buy"
              : `${totals.done} of ${totals.total} done · ${percent}%`}
          </p>
        </section>

        {sections.length === 0 ? (
          <p class="empty-state">This list has no sections — import another document or add one later.</p>
        ) : (
          <div class="sections spring-in">
            {sections.map((section, index) => (
              <SectionView
                key={String(index)}
                section={section}
                pathKey={String(index)}
                depth={0}
                collapsed={collapsed}
                onToggleCollapse={toggleCollapse}
                onToggleItem={props.onToggle}
              />
            ))}
          </div>
        )}

        <section class="card export-card spring-in">
          <h2 class="section-label">EXPORT</h2>
          <p class="hint">
            Downloads the same document you imported, with every tick kept. Ticks are already saved
            on this device as you go.
          </p>
          <FilledButton label="Export JSON" onClick={props.onExport} />
        </section>
      </main>
    </div>
  );
}
