/**
 * Nested shopping-list JSON model — TypeScript mirror of docs/list.schema.json, field for field
 * (`title`/`version`/`sections` at the root, recursive sections, items with optional
 * amount/unit/note/aliases/done). Card A2 (import/persist) and A4 (ranking) build against this
 * contract; card A1 only needs the shape, parsing/flattening is NOT implemented here.
 */

/** `amount` may be absent, a number (2, 0.5) or free text ("2 packs"); `unit` and `note` are their own fields. */
export type ScanListAmount = number | string;

/** Item: `name` is the only required field; `id` is optional — the app derives sha1(path) when absent. */
export interface ScanListItem {
  id?: string;
  name: string;
  amount?: ScanListAmount;
  unit?: string;
  note?: string;
  /** Extra words embedded with the item (brand, other language), e.g. "coke" -> "Coca-Cola". */
  aliases?: string[];
  /** `done: true` items sink into the collapsed "Done" group. */
  done?: boolean;
}

/** Section: only `name` is required; sub-sections nest recursively, any depth. */
export interface ScanListSection {
  name: string;
  items?: ScanListItem[];
  sections?: ScanListSection[];
}

/** List document root: `title` + `sections` required, `version` optional (schema default 1). */
export interface ScanList {
  title: string;
  version?: number;
  sections: ScanListSection[];
}

/** One item flattened out of the tree, with its section path for the embedding document. */
export interface FlatItem {
  /** Derived id — sha1(sectionPath) when the item has no `id` (docs/list.schema.json). */
  itemId: string;
  /** Section names from the root to the item's parent. */
  path: string[];
  name: string;
  done: boolean;
}
