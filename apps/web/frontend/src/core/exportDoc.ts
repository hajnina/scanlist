/**
 * Export: turn the in-memory parsed tree back into the normative LIST.md §1 document.
 *
 * Note the asymmetry with `parseList`: parsing normalises (drops unknown fields, defaults for
 * `items`/`sections`/`aliases`/`done`), so the exported document is the *normalised* list. LIST.md
 * §7 allows exactly that: "unknown fields MAY be dropped", the round trip must be equal apart from
 * `done` and formatting. `done: false` is omitted for cleanliness (exporting it is also allowed).
 */

import type { ScanList, ScanListItem, ScanListSection } from "@scanlist/ts-core";

/** One item, field order stable for readable diffs. */
function exportItem(item: ScanListItem): ScanListItem {
  const out: ScanListItem = { name: item.name };
  const id = item.id?.trim();
  if (id) out.id = id;

  const amount = item.amount;
  if (typeof amount === "number" && Number.isFinite(amount)) {
    out.amount = amount;
  } else if (typeof amount === "string" && amount.trim() !== "") {
    out.amount = amount; // free text verbatim (trimmed by the parser on import)
  }

  const unit = item.unit?.trim();
  if (unit) out.unit = unit;

  if (typeof item.note === "string" && item.note !== "") out.note = item.note;

  const aliases = (item.aliases ?? []).filter((alias) => alias.trim() !== "");
  if (aliases.length > 0) out.aliases = aliases;

  // Boolean is the only mutable per-item state (LIST.md §3); omit the default.
  if (item.done === true) out.done = true;
  return out;
}

function exportSection(section: ScanListSection): ScanListSection {
  const out: ScanListSection = { name: section.name };
  const items = (section.items ?? []).map(exportItem);
  if (items.length > 0) out.items = items;
  const sections = (section.sections ?? []).map(exportSection);
  if (sections.length > 0) out.sections = sections;
  return out;
}

/** A fresh, spec-shaped copy of the list (safe to serialise, never aliases the live tree). */
export function toExportDocument(list: ScanList): ScanList {
  return {
    title: list.title,
    version: list.version ?? 1,
    sections: (list.sections ?? []).map(exportSection),
  };
}

/** Pretty JSON: this exact string is both the download and the localStorage document. */
export function exportJson(list: ScanList, space = 2): string {
  return `${JSON.stringify(toExportDocument(list), null, space)}\n`;
}

/** `<title>.json` slug for the download, ASCII-safe and never path-like. */
export function exportFileName(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug === "" ? "scanlist" : slug}.json`;
}
