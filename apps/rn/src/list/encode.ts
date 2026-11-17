/**
 * Export — the normative JSON document (LIST.md §7), the RN counterpart of B2's `ListJson.encode`.
 *
 * The persisted document IS an export: `ListRepository` writes this exact string (same fields, same
 * order, same formatting), so "persist then export" cannot drift (card A2 / B2 precedent).
 *
 * Rules kept from LIST.md §7:
 * - `{title, version, sections:[{name, items, sections}]}`, section and item order preserved;
 * - every item always has `name`; `id`, `amount`, `unit`, `note`, `aliases` only when present;
 * - `done` is exported only when true (`"done": false` is also allowed, this drops it);
 * - `amount` keeps its JSON type: a number is emitted as a number (shortest round-trip decimal via
 *   `JSON.stringify`), a quoted `"3"` is emitted as the STRING `"3"` — never coerced.
 * Unknown fields were already dropped by `parseList` (LIST.md §1: allowed to drop).
 */
import type {ScanList, ScanListItem, ScanListSection} from './core';

/** Plain JSON value of one item, field order fixed: id, name, amount, unit, note, aliases, done. */
function itemDoc(item: ScanListItem): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  if (item.id !== undefined && item.id.trim() !== '') {
    doc.id = item.id.trim();
  }
  doc.name = item.name;
  if (item.amount !== undefined && item.amount !== null) {
    // Numbers go through as numbers; `JSON.stringify` prints them as the shortest round-trip
    // decimal (LIST.md §4), so display (`formatJsonNumber`) and export can never disagree.
    doc.amount = item.amount;
  }
  if (item.unit !== undefined && item.unit.trim() !== '') {
    doc.unit = item.unit.trim();
  }
  if (item.note !== undefined) {
    doc.note = item.note;
  }
  if (item.aliases !== undefined && item.aliases.length > 0) {
    doc.aliases = [...item.aliases];
  }
  if (item.done === true) {
    doc.done = true;
  }
  return doc;
}

function sectionDoc(section: ScanListSection): Record<string, unknown> {
  const doc: Record<string, unknown> = {name: section.name};
  if (section.items !== undefined && section.items.length > 0) {
    doc.items = section.items.map(itemDoc);
  }
  if (section.sections !== undefined && section.sections.length > 0) {
    doc.sections = section.sections.map(sectionDoc);
  }
  return doc;
}

/** The exported document as an object (handy for tests and for a future "diff" view). */
export function toDocument(list: ScanList): Record<string, unknown> {
  return {
    title: list.title,
    version: list.version ?? 1,
    sections: (list.sections ?? []).map(sectionDoc),
  };
}

/** The exported JSON text: 2-space pretty print, exactly the LIST.md §7 shape. */
export function encodeList(list: ScanList): string {
  return JSON.stringify(toDocument(list), null, 2);
}

/** `"Van weekly shop"` -> `"van-weekly-shop.json"` (the suggested file name on save/share). */
export function fileNameFor(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug === '' ? 'scanlist' : slug}.json`;
}
